import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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

async function atix(dbPath: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      ATIX_DB: dbPath,
      ATIX_AGENT: opts.env?.ATIX_AGENT ?? "sender",
      ATIX_PROJECT: opts.env?.ATIX_PROJECT ?? "atix-project",
      ATIX_SESSION: opts.env?.ATIX_SESSION ?? "sess-send",
      ...opts.env,
    },
    stdin: new TextEncoder().encode(opts.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function parseJson(stdout: string): any {
  const lines = stdout.trim().split("\n").filter((line) => line.length > 0);
  return JSON.parse(lines[lines.length - 1]!);
}

let dbPath: string;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "atix-ux-send-"));
  dbPath = join(tmpDir, "atix.db");

  const init = await atix(dbPath, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  const channel = await atix(dbPath, ["channel", "add", "review.codex", "--json"]);
  expect(channel.exitCode).toBe(0);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("send and show UX", () => {
  test("send creates a ticket that show can read", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.codex",
      "--title",
      "Review the patch",
      "--body",
      "Please review the latest changes.",
      "--json",
    ]);

    expect(send.exitCode).toBe(0);
    expect(send.stderr).toBe("");

    const sent = parseJson(send.stdout);
    expect(sent.ok).toBe(true);
    expect(sent.type).toBe("ticket");
    expect(sent.ticket.channel).toBe("review.codex");
    expect(sent.ticket.status).toBe("open");
    expect(sent.ticket.title).toBe("Review the patch");
    expect(sent.ticket.body).toBe("Please review the latest changes.");
    expect(typeof sent.ticket.id).toBe("string");
    expect(sent.commands.read).toBe(`atix thread ${sent.ticket.id} --with-docs`);
    expect(sent.commands.read).not.toContain("show --with-replies");
    expect(sent.commands.snapshot).toBe(`atix show ${sent.ticket.id} --with-docs`);

    const show = await atix(dbPath, ["show", sent.ticket.id, "--json"]);
    expect(show.exitCode).toBe(0);
    expect(show.stderr).toBe("");

    const shown = parseJson(show.stdout);
    expect(shown.ok).toBe(true);
    expect(shown.type).toBe("ticket");
    expect(shown.ticket.id).toBe(sent.ticket.id);
    expect(shown.ticket.title).toBe("Review the patch");
    expect(shown.ticket.body).toBe("Please review the latest changes.");
  });

  test("send --wait 0 accepts bare zero and returns timeout for an open ticket", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.codex",
      "--title",
      "Wait zero",
      "--wait",
      "0",
      "--json",
    ]);

    expect(send.exitCode).toBe(5);
    expect(send.stderr).toBe("");
    const json = parseJson(send.stdout);
    expect(json).toMatchObject({
      ok: false,
      type: "timeout",
      timeout: true,
    });
    expect(json.ticket.title).toBe("Wait zero");
  });

  test("show --wait returns timeout exit 5 for a pending ticket", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.codex",
      "--title",
      "Pending work",
      "--json",
    ]);
    expect(send.exitCode).toBe(0);
    const id = parseJson(send.stdout).ticket.id;

    const show = await atix(dbPath, ["show", id, "--wait", "0", "--json"]);

    expect(show.exitCode).toBe(5);
    expect(show.stderr).toBe("");
    expect(parseJson(show.stdout)).toMatchObject({
      ok: false,
      type: "timeout",
      timeout: true,
      id,
    });
  });
});
