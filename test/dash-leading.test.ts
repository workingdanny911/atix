import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect, describe, beforeEach, afterEach } from "bun:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run atix as a real subprocess; capture exit code + stdout + stderr. Mirrors
 * the seam used by contract.test.ts so these regression cases exercise the same
 * observable contract (no importing of command internals).
 */
async function atix(dbPath: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      ATIX_DB: dbPath,
      ATIX_AGENT: "tester",
      ATIX_PROJECT: "atix-project",
      ATIX_SESSION: "sess-default",
    },
    stdin: new TextEncoder().encode(""),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function parseJson(stdout: string): any {
  const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
  return JSON.parse(lines[lines.length - 1]!);
}

let dbPath: string;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "atix-dash-"));
  dbPath = join(tmpDir, "atix.db");
  const init = await atix(dbPath, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  const add = await atix(dbPath, ["channel", "add", "c1", "--json"]);
  expect(add.exitCode).toBe(0);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("dash-leading flag values (silent data-loss regression)", () => {
  test("push --body '-hello' preserves the body (size_bytes > 0)", async () => {
    const res = await atix(dbPath, [
      "push", "--to", "c1", "--title", "t", "--body", "-hello", "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const json = parseJson(res.stdout);
    expect(json.size_bytes).toBe(6);

    const show = await atix(dbPath, ["show", json.id, "--json"]);
    expect(parseJson(show.stdout).body).toBe("-hello");
  });

  test("push --body with an inline diff (leading '-' / '+') is preserved verbatim", async () => {
    const diff = "-removed line\n+added line";
    const res = await atix(dbPath, [
      "push", "--to", "c1", "--title", "diff", "--body", diff, "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const json = parseJson(res.stdout);
    expect(json.size_bytes).toBe(Buffer.byteLength(diff));

    const show = await atix(dbPath, ["show", json.id, "--json"]);
    expect(parseJson(show.stdout).body).toBe(diff);
  });

  test("push --title '-x' preserves the title (no spurious bad_flag)", async () => {
    const res = await atix(dbPath, [
      "push", "--to", "c1", "--title", "-x", "--body", "body", "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const json = parseJson(res.stdout);
    const show = await atix(dbPath, ["show", json.id, "--json"]);
    expect(parseJson(show.stdout).title).toBe("-x");
  });

  test("claim --wait '-5s' is rejected as invalid_duration (exit 2), not silently dropped", async () => {
    const res = await atix(dbPath, ["claim", "--from", "c1", "--wait", "-5s", "--json"]);
    expect(res.exitCode).toBe(2);
    expect(parseJson(res.stdout).error).toBe("invalid_duration");
  });

  test("reply --body '-note' is preserved on a ticket", async () => {
    const push = await atix(dbPath, [
      "push", "--to", "c1", "--title", "t", "--json",
    ]);
    const id = parseJson(push.stdout).id;
    const reply = await atix(dbPath, ["reply", id, "--body", "-note", "--json"]);
    expect(reply.exitCode).toBe(0);

    const show = await atix(dbPath, ["show", id, "--with-replies", "--json"]);
    const bodies = parseJson(show.stdout).replies.map((r: any) => r.body);
    expect(bodies).toContain("-note");
  });
});

describe("show --full (renamed from --body)", () => {
  test("show --full renders the complete body untruncated (human mode)", async () => {
    const longBody = "L".repeat(500);
    const push = await atix(dbPath, [
      "push", "--to", "c1", "--title", "long", "--body", longBody, "--json",
    ]);
    const id = parseJson(push.stdout).id;

    const truncated = await atix(dbPath, ["show", id]);
    expect(truncated.exitCode).toBe(0);
    expect(truncated.stdout).toContain("…");

    const full = await atix(dbPath, ["show", id, "--full"]);
    expect(full.exitCode).toBe(0);
    expect(full.stdout).toContain(longBody);
    expect(full.stdout).not.toContain("…");
  });
});
