import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect, describe, beforeEach, afterEach } from "bun:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
}

/**
 * Run the atix CLI as a real subprocess and capture its observable contract:
 * exit code + stdout + stderr. This is the only seam the tests touch — no
 * importing of command internals.
 */
async function atix(dbPath: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      ATIX_DB: dbPath,
      // Force deterministic identity so meta resolution never shells out.
      ATIX_AGENT: opts.env?.ATIX_AGENT ?? "tester",
      ATIX_PROJECT: opts.env?.ATIX_PROJECT ?? "atix-project",
      ATIX_SESSION: opts.env?.ATIX_SESSION ?? "sess-default",
      ...opts.env,
    },
    // Always pass a byte buffer (empty when no input) so the generic stays a
    // single concrete type instead of widening to a union.
    stdin: new TextEncoder().encode(opts.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout, stderr };
}

/** Parse the last non-empty JSON line of stdout (commands emit one object). */
function parseJson(stdout: string): any {
  const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]!);
}

/** Parse every JSON line of stdout (list emits JSONL). */
function parseJsonLines(stdout: string): any[] {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "atix-test-"));
  dbPath = join(tmpDir, "atix.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Common fixture: initialized DB with a single channel. */
async function initWithChannel(channel = "review.codex"): Promise<void> {
  const init = await atix(dbPath, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  const add = await atix(dbPath, ["channel", "add", channel, "--json"]);
  expect(add.exitCode).toBe(0);
}

/** Push an open ticket and return its id. */
async function pushTicket(
  channel: string,
  title: string,
  body = "",
  env?: Record<string, string>,
): Promise<string> {
  const args = ["push", "--to", channel, "--title", title, "--json"];
  if (body.length > 0) args.push("--body", body);
  const res = await atix(dbPath, args, { env });
  expect(res.exitCode).toBe(0);
  return parseJson(res.stdout).id;
}

describe("1. full lifecycle (sync dispatch)", () => {
  test("init → channel → push → claim → done → show ends in done with final reply", async () => {
    await initWithChannel();

    const id = await pushTicket("review.codex", "do the thing", "payload");

    const claim = await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);
    expect(claim.exitCode).toBe(0);
    const claimJson = parseJson(claim.stdout);
    expect(claimJson.id).toBe(id);
    const token = claimJson.claim_token;
    expect(typeof token).toBe("string");

    const done = await atix(dbPath, ["done", id, "--token", token, "--body", "all done"]);
    expect(done.exitCode).toBe(0);

    const show = await atix(dbPath, ["show", id, "--with-replies", "--json"]);
    expect(show.exitCode).toBe(0);
    const showJson = parseJson(show.stdout);
    expect(showJson.status).toBe("done");

    const finalReplies = showJson.replies.filter((r: any) => r.is_final === true);
    expect(finalReplies.length).toBe(1);
    expect(finalReplies[0].body).toBe("all done");
  });
});

describe("2. race-safe claim", () => {
  test("two claims return distinct ids; third claim --wait 0 reports timeout (exit 0)", async () => {
    await initWithChannel();
    const id1 = await pushTicket("review.codex", "t1");
    const id2 = await pushTicket("review.codex", "t2");

    const c1 = await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);
    const c2 = await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);
    expect(c1.exitCode).toBe(0);
    expect(c2.exitCode).toBe(0);

    const got1 = parseJson(c1.stdout).id;
    const got2 = parseJson(c2.stdout).id;
    expect(got1).not.toBe(got2);
    expect(new Set([got1, got2])).toEqual(new Set([id1, id2]));

    const c3 = await atix(dbPath, ["claim", "--from", "review.codex", "--wait", "0", "--json"]);
    expect(c3.exitCode).toBe(0);
    const c3Json = parseJson(c3.stdout);
    expect(c3Json.ok).toBe(false);
    expect(c3Json.timeout).toBe(true);
    expect(c3Json.channel).toBe("review.codex");
  });
});

describe("2b. claim polling robustness (Phase E — E3/E4)", () => {
  test("E3 (F5): --poll 0 on an empty queue does not spin; bounded --wait exits cleanly", async () => {
    await initWithChannel();

    // With the 100ms poll floor, `--wait 1s --poll 0` must terminate near the
    // deadline rather than busy-looping. Allow generous slack for subprocess
    // startup; the point is "finite, not a CPU-pegged spin".
    const start = Date.now();
    const res = await atix(dbPath, [
      "claim",
      "--from",
      "review.codex",
      "--wait",
      "1s",
      "--poll",
      "0",
      "--json",
    ]);
    const elapsed = Date.now() - start;

    expect(res.exitCode).toBe(0);
    const json = parseJson(res.stdout);
    expect(json.ok).toBe(false);
    expect(json.timeout).toBe(true);
    expect(elapsed).toBeLessThan(8000);
  });

  test("E4 (F4): --wait actually polls and picks up a ticket pushed after claim starts", async () => {
    await initWithChannel();

    // Start a blocking claim with a 5s window, then push a ticket ~300ms later.
    // The min-one-poll guarantee + polling loop must catch the delayed ticket.
    // `--poll 0` clamps to the 100ms floor (E3), giving fast polling without a spin.
    const claimPromise = atix(dbPath, [
      "claim",
      "--from",
      "review.codex",
      "--wait",
      "5s",
      "--poll",
      "0",
      "--json",
    ]);

    await Bun.sleep(300);
    const pushedId = await pushTicket("review.codex", "delayed arrival");

    const res = await claimPromise;
    expect(res.exitCode).toBe(0);
    const json = parseJson(res.stdout);
    expect(json.ok).toBe(true);
    expect(json.id).toBe(pushedId);
  });
});

describe("3. cancel race salvage (Patch 4c)", () => {
  test("done on a canceled-claimed ticket exits 3 but preserves --body as non-final reply", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "salvage me");

    const claim = await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);
    const token = parseJson(claim.stdout).claim_token;

    const cancel = await atix(dbPath, ["cancel", id, "--json"]);
    expect(cancel.exitCode).toBe(0);

    const done = await atix(dbPath, ["done", id, "--token", token, "--body", "work result"]);
    expect(done.exitCode).toBe(3);

    const show = await atix(dbPath, ["show", id, "--with-replies", "--json"]);
    const replies = parseJson(show.stdout).replies;
    const salvaged = replies.filter((r: any) => r.body === "work result");
    expect(salvaged.length).toBe(1);
    expect(salvaged[0].is_final).toBe(false);
  });
});

describe("4. session matching — recover (Patch 3d)", () => {
  test("same (agent,session) recovers with new token; different session → exit 3 session_mismatch", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "recover me");

    const claimEnv = { ATIX_AGENT: "a1", ATIX_SESSION: "s1" };
    const claim = await atix(dbPath, ["claim", "--from", "review.codex", "--json"], {
      env: claimEnv,
    });
    expect(claim.exitCode).toBe(0);
    const firstToken = parseJson(claim.stdout).claim_token;

    const recoverSame = await atix(dbPath, ["recover", id, "--json"], { env: claimEnv });
    expect(recoverSame.exitCode).toBe(0);
    const newToken = parseJson(recoverSame.stdout).claim_token;
    expect(typeof newToken).toBe("string");
    expect(newToken).not.toBe(firstToken);

    const recoverOther = await atix(dbPath, ["recover", id, "--json"], {
      env: { ATIX_AGENT: "a1", ATIX_SESSION: "s2" },
    });
    expect(recoverOther.exitCode).toBe(3);
    expect(parseJson(recoverOther.stdout).error).toBe("session_mismatch");
  });
});

describe("5. body validation (Patch 1)", () => {
  test("NUL byte in body → exit 2 with nul_byte / invalid_utf8 keyword", async () => {
    await initWithChannel();
    const file = join(tmpDir, "nul.txt");
    writeFileSync(file, Buffer.from("before after", "binary"));

    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "nul",
      "--body-file",
      file,
      "--json",
    ]);
    expect(res.exitCode).toBe(2);
    expect(["nul_byte", "invalid_utf8"]).toContain(parseJson(res.stdout).error);
  });

  test("body over 256 KiB → stderr warning but exit 0 (stored)", async () => {
    await initWithChannel();
    const file = join(tmpDir, "big.txt");
    writeFileSync(file, "x".repeat(300 * 1024));

    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "big",
      "--body-file",
      file,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("warning");
    expect(parseJson(res.stdout).status).toBe("open");
  });

  test("ATIX_MAX_BODY_BYTES smaller than body → exit 2 body_too_large", async () => {
    await initWithChannel();
    const res = await atix(
      dbPath,
      ["push", "--to", "review.codex", "--title", "cap", "--body", "x".repeat(500), "--json"],
      { env: { ATIX_MAX_BODY_BYTES: "100" } },
    );
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("body_too_large");
  });
});

describe("5b. title validation (usability backlog)", () => {
  test("control char (newline) in title → exit 2 bad_flag", async () => {
    await initWithChannel();
    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "bad\ntitle",
      "--body",
      "x",
      "--json",
    ]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("bad_flag");
  });

  test("tab char in title → exit 2 bad_flag (would break list table)", async () => {
    await initWithChannel();
    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "col1\tcol2",
      "--body",
      "x",
      "--json",
    ]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("bad_flag");
  });

  test("empty title → exit 2 bad_flag (not an identifier)", async () => {
    await initWithChannel();
    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "",
      "--body",
      "x",
      "--json",
    ]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("bad_flag");
  });

  test("title over 500 chars → exit 2 bad_flag", async () => {
    await initWithChannel();
    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "x".repeat(501),
      "--body",
      "x",
      "--json",
    ]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("bad_flag");
  });

  test("ordinary single-line title at the 500-char limit → exit 0", async () => {
    await initWithChannel();
    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "x".repeat(500),
      "--body",
      "x",
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    expect(parseJson(res.stdout).status).toBe("open");
  });
});

describe("5c. ATIX_MAX_BODY_BYTES invalid value (usability backlog)", () => {
  test("non-numeric env value → stderr warning, push still succeeds with default", async () => {
    await initWithChannel();
    const res = await atix(
      dbPath,
      ["push", "--to", "review.codex", "--title", "t", "--body", "x", "--json"],
      { env: { ATIX_MAX_BODY_BYTES: "abc" } },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("ATIX_MAX_BODY_BYTES");
    expect(res.stderr.toLowerCase()).toContain("warning");
  });

  test("zero env value → stderr warning, default applies", async () => {
    await initWithChannel();
    const res = await atix(
      dbPath,
      ["push", "--to", "review.codex", "--title", "t", "--body", "x", "--json"],
      { env: { ATIX_MAX_BODY_BYTES: "0" } },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("ATIX_MAX_BODY_BYTES");
  });

  test("negative env value → stderr warning, default applies", async () => {
    await initWithChannel();
    const res = await atix(
      dbPath,
      ["push", "--to", "review.codex", "--title", "t", "--body", "x", "--json"],
      { env: { ATIX_MAX_BODY_BYTES: "-5" } },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("ATIX_MAX_BODY_BYTES");
  });

  test("valid env value → no warning", async () => {
    await initWithChannel();
    const res = await atix(
      dbPath,
      ["push", "--to", "review.codex", "--title", "t", "--body", "x", "--json"],
      { env: { ATIX_MAX_BODY_BYTES: "1048576" } },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain("ATIX_MAX_BODY_BYTES");
  });
});

describe("6. duration grammar (Patch 5)", () => {
  test("composite duration 1h30m → exit 2 invalid_duration", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "dur");
    const res = await atix(dbPath, ["wait", id, "--timeout", "1h30m", "--json"]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("invalid_duration");
  });

  test("decimal duration 2.5h → exit 2 invalid_duration", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "dur");
    const res = await atix(dbPath, ["wait", id, "--timeout", "2.5h", "--json"]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("invalid_duration");
  });

  test("2s is a valid duration (wait times out cleanly, not a parse error)", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "dur");
    const res = await atix(dbPath, ["wait", id, "--until", "done", "--timeout", "2s", "--json"]);
    // open ticket → wait expires with timeout exit 5, NOT input exit 2.
    expect(res.exitCode).toBe(5);
  });
});

describe("7. wait timeout = exit 5 (Patch 2/5)", () => {
  test("wait --until done on open ticket → exit 5 with timeout envelope", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "still open");

    const res = await atix(dbPath, ["wait", id, "--until", "done", "--timeout", "1s", "--json"]);
    expect(res.exitCode).toBe(5);
    const json = parseJson(res.stdout);
    expect(json.ok).toBe(false);
    expect(json.timeout).toBe(true);
    expect(json.status).toBe("open");
    expect(json.id).toBe(id);
    expect(json.last_reply_at).toBeNull();
  });
});

describe("8. --mine matching (Patch 3c)", () => {
  test("--mine matches by agent+project across sessions, excludes other agents", async () => {
    await initWithChannel();

    const mineId = await pushTicket("review.codex", "mine", "", {
      ATIX_AGENT: "me",
      ATIX_SESSION: "s-push",
    });
    const otherId = await pushTicket("review.codex", "theirs", "", {
      ATIX_AGENT: "someone-else",
      ATIX_SESSION: "s-other",
    });

    // Different session than push, same agent — must still match (session excluded).
    const list = await atix(dbPath, ["list", "--mine", "--json"], {
      env: { ATIX_AGENT: "me", ATIX_SESSION: "s-list" },
    });
    expect(list.exitCode).toBe(0);
    const ids = parseJsonLines(list.stdout).map((r) => r.id);
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(otherId);
  });
});

describe("9. archived channel matrix (Patch 4b)", () => {
  test("push to archived channel → exit 2 channel_archived; claim of pre-existing open ticket → exit 0", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "before archive");

    const archive = await atix(dbPath, ["channel", "archive", "review.codex", "--json"]);
    expect(archive.exitCode).toBe(0);

    const push = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "after archive",
      "--json",
    ]);
    expect(push.exitCode).toBe(2);
    expect(parseJson(push.stdout).error).toBe("channel_archived");

    const claim = await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);
    expect(claim.exitCode).toBe(0);
    expect(parseJson(claim.stdout).id).toBe(id);
  });
});

describe("10. reply allowed on closed ticket (Patch 4a)", () => {
  test("reply to a done ticket → exit 0, is_final=0", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "close then reply");

    const claim = await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);
    const token = parseJson(claim.stdout).claim_token;
    const done = await atix(dbPath, ["done", id, "--token", token]);
    expect(done.exitCode).toBe(0);

    const reply = await atix(dbPath, ["reply", id, "--body", "late note", "--json"]);
    expect(reply.exitCode).toBe(0);
    expect(parseJson(reply.stdout).is_final).toBe(0);
  });
});

describe("11. exit code table", () => {
  test("push to unknown channel → exit 2 unknown_channel", async () => {
    await atix(dbPath, ["init", "--json"]);
    const res = await atix(dbPath, [
      "push",
      "--to",
      "no-such-channel",
      "--title",
      "x",
      "--json",
    ]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("unknown_channel");
  });

  test("show missing id → exit 4 not_found", async () => {
    await atix(dbPath, ["init", "--json"]);
    const res = await atix(dbPath, ["show", "01NONEXISTENTNONEXISTENT00", "--json"]);
    expect(res.exitCode).toBe(4);
    expect(parseJson(res.stdout).error).toBe("not_found");
  });

  test("done with wrong token → exit 3 conflict", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "wrong token");
    await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);

    const res = await atix(dbPath, ["done", id, "--token", "not-the-real-token", "--json"]);
    expect(res.exitCode).toBe(3);
    expect(parseJson(res.stdout).error).toBe("conflict");
  });
});

describe("12. JSON schema fields (Patch 2)", () => {
  test("push JSON carries id, channel, status, size_bytes, last_claim_at", async () => {
    await initWithChannel();
    const res = await atix(dbPath, [
      "push",
      "--to",
      "review.codex",
      "--title",
      "schema",
      "--body",
      "abc",
      "--json",
    ]);
    const json = parseJson(res.stdout);
    expect(json).toMatchObject({
      ok: true,
      channel: "review.codex",
      status: "open",
      size_bytes: 3,
      last_claim_at: null,
    });
    expect(typeof json.id).toBe("string");
  });

  test("claim JSON carries id, channel, claim_token, producer, status", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "schema-claim");
    const res = await atix(dbPath, ["claim", "--from", "review.codex", "--json"]);
    const json = parseJson(res.stdout);
    expect(json.ok).toBe(true);
    expect(json.id).toBe(id);
    expect(json.channel).toBe("review.codex");
    expect(typeof json.claim_token).toBe("string");
    expect(json.status).toBe("claimed");
    expect(json.producer).toBeDefined();
    expect("agent" in json.producer).toBe(true);
  });

  test("show JSON carries id, channel, status, title, body, producer, closed_at", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "schema-show", "the body");
    const res = await atix(dbPath, ["show", id, "--json"]);
    const json = parseJson(res.stdout);
    expect(json).toMatchObject({
      id,
      channel: "review.codex",
      status: "open",
      title: "schema-show",
      body: "the body",
      closed_at: null,
    });
    expect(json.producer).toBeDefined();
  });

  test("list JSON line carries id, channel, status, age_sec, has_replies, is_orphan, claimed_by", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "schema-list");
    const res = await atix(dbPath, ["list", "--json"]);
    const lines = parseJsonLines(res.stdout);
    const row = lines.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id,
      channel: "review.codex",
      status: "open",
      has_replies: false,
      is_orphan: false,
      claimed_by: null,
    });
    expect(typeof row.age_sec).toBe("number");
  });

  test("wait timeout JSON carries ok, timeout, status, id, last_reply_at", async () => {
    await initWithChannel();
    const id = await pushTicket("review.codex", "schema-wait");
    const res = await atix(dbPath, ["wait", id, "--timeout", "1s", "--json"]);
    const json = parseJson(res.stdout);
    expect(json).toMatchObject({
      ok: false,
      timeout: true,
      status: "open",
      id,
      last_reply_at: null,
    });
  });

  test("channel ls JSON carries name, description, created_at, archived_at, stats", async () => {
    await initWithChannel();
    const res = await atix(dbPath, ["channel", "ls", "--json"]);
    const arr = parseJson(res.stdout);
    expect(Array.isArray(arr)).toBe(true);
    const ch = arr.find((c: any) => c.name === "review.codex");
    expect(ch).toBeDefined();
    expect("description" in ch).toBe(true);
    expect("created_at" in ch).toBe(true);
    expect("archived_at" in ch).toBe(true);
    expect("stats" in ch).toBe(true);
  });

  test("error JSON carries ok:false, error keyword, message, exit code", async () => {
    await atix(dbPath, ["init", "--json"]);
    const res = await atix(dbPath, ["push", "--to", "ghost", "--title", "x", "--json"]);
    const json = parseJson(res.stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toBe("unknown_channel");
    expect(typeof json.message).toBe("string");
    expect(json.exit).toBe(2);
  });
});
