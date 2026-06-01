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

async function atix(dbPath: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      ATIX_DB: dbPath,
      ATIX_AGENT: "inbox-agent",
      ATIX_PROJECT: "atix-project",
      ATIX_SESSION: "sess-inbox",
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
  const lines = stdout.trim().split("\n").filter((line) => line.length > 0);
  return JSON.parse(lines[lines.length - 1]!);
}

let dbPath: string;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "atix-ux-inbox-"));
  dbPath = join(tmpDir, "atix.db");

  const init = await atix(dbPath, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  const channel = await atix(dbPath, ["channel", "add", "review.codex", "--json"]);
  expect(channel.exitCode).toBe(0);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("inbox UX", () => {
  test("empty inbox returns JSON empty contract and quiet human output", async () => {
    const json = await atix(dbPath, ["inbox", "--from", "review.codex", "--json"]);

    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(parseJson(json.stdout)).toMatchObject({
      ok: false,
      type: "empty",
      empty: true,
      timeout: false,
      channel: "review.codex",
    });

    const human = await atix(dbPath, ["inbox", "--from", "review.codex"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe("");
  });

  test("inbox claims one ticket and returns a receipt", async () => {
    const first = await atix(dbPath, [
      "send",
      "--to",
      "review.codex",
      "--title",
      "First ticket",
      "--json",
    ]);
    const second = await atix(dbPath, [
      "send",
      "--to",
      "review.codex",
      "--title",
      "Second ticket",
      "--json",
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const firstId = parseJson(first.stdout).ticket.id;
    const secondId = parseJson(second.stdout).ticket.id;

    const inbox = await atix(dbPath, ["inbox", "--from", "review.codex", "--json"]);
    expect(inbox.exitCode).toBe(0);
    const item = parseJson(inbox.stdout);

    expect(item.ok).toBe(true);
    expect(item.type).toBe("inbox_item");
    expect(item.ticket.id).toBe(firstId);
    expect(item.ticket.status).toBe("claimed");
    expect(typeof item.receipt).toBe("string");
    expect(item.receipt.length).toBeGreaterThan(0);

    const claimed = await atix(dbPath, ["show", firstId, "--json"]);
    const stillOpen = await atix(dbPath, ["show", secondId, "--json"]);
    expect(parseJson(claimed.stdout).ticket.status).toBe("claimed");
    expect(parseJson(stillOpen.stdout).ticket.status).toBe("open");
  });
});
