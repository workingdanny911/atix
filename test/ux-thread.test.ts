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
}

async function atix(dbPath: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      ATIX_DB: dbPath,
      ATIX_AGENT: opts.env?.ATIX_AGENT ?? "thread-agent",
      ATIX_PROJECT: "atix-project",
      ATIX_SESSION: opts.env?.ATIX_SESSION ?? "sess-thread",
      ...opts.env,
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
  tmpDir = mkdtempSync(join(tmpdir(), "atix-ux-thread-"));
  dbPath = join(tmpDir, "atix.db");

  const init = await atix(dbPath, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  expect((await atix(dbPath, ["channel", "add", "review.a", "--json"])).exitCode).toBe(0);
  expect((await atix(dbPath, ["channel", "add", "review.b", "--json"])).exitCode).toBe(0);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("take and thread UX", () => {
  test("take claims an exact ticket idempotently and writes one claimed message", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.a",
      "--title",
      "Exact work",
      "--body",
      "open body",
      "--doc",
      "brief.md=details",
      "--json",
    ]);
    expect(send.exitCode).toBe(0);
    const ticketId = parseJson(send.stdout).ticket.id;

    const workerEnv = { ATIX_AGENT: "worker", ATIX_SESSION: "same-session" };
    const first = await atix(dbPath, ["take", ticketId, "--json"], { env: workerEnv });
    const second = await atix(dbPath, ["take", ticketId, "--json"], { env: workerEnv });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const firstJson = parseJson(first.stdout);
    const secondJson = parseJson(second.stdout);
    expect(firstJson.type).toBe("take_item");
    expect(secondJson.receipt).toBe(firstJson.receipt);

    const thread = await atix(dbPath, ["thread", ticketId, "--with-docs", "--json"]);
    expect(thread.exitCode).toBe(0);
    const messages = parseJson(thread.stdout).messages;

    expect(messages.map((message: any) => message.kind)).toEqual(["opened", "claimed"]);
    expect(messages.filter((message: any) => message.kind === "claimed")).toHaveLength(1);
    expect(messages[0].docs[0]).toMatchObject({
      owner_kind: "message",
      title: "brief.md",
      content: "details",
    });
  });

  test("ask group thread projects child ticket messages behind one cursor", async () => {
    const ask = await atix(dbPath, [
      "ask",
      "--to",
      "review.a",
      "--to",
      "review.b",
      "--title",
      "Group thread",
      "--body",
      "compare",
      "--json",
    ]);
    expect(ask.exitCode).toBe(0);
    const askJson = parseJson(ask.stdout);
    const groupId = askJson.ask_group.id;
    const ticketId = askJson.ask_group.children[0].ticket.id;

    const workerEnv = { ATIX_AGENT: "worker", ATIX_SESSION: "child-session" };
    const take = await atix(dbPath, ["take", ticketId, "--json"], { env: workerEnv });
    expect(take.exitCode).toBe(0);
    const reply = await atix(
      dbPath,
      ["reply", ticketId, "--kind", "answer", "--body", "yes", "--json"],
      { env: workerEnv },
    );
    expect(reply.exitCode).toBe(0);

    const delta = await atix(dbPath, ["thread", groupId, "--after", "3", "--json"]);
    expect(delta.exitCode).toBe(0);
    const payload = parseJson(delta.stdout);

    expect(payload.thread).toEqual({ root_kind: "ask_group", root_id: groupId });
    expect(payload.cursor).toBe("3");
    expect(payload.next_cursor).toBe("5");
    expect(payload.messages.map((message: any) => message.kind)).toEqual(["claimed", "answer"]);
    expect(payload.messages.map((message: any) => message.ticket_id)).toEqual([ticketId, ticketId]);
  });

  test("thread rejects invalid cursors", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.a",
      "--title",
      "Cursor validation",
      "--json",
    ]);
    expect(send.exitCode).toBe(0);
    const ticketId = parseJson(send.stdout).ticket.id;

    const invalid = await atix(dbPath, ["thread", ticketId, "--after", "-1", "--json"]);
    expect(invalid.exitCode).toBe(2);
    expect(parseJson(invalid.stdout)).toMatchObject({
      ok: false,
      error: "bad_flag",
      exit: 2,
    });
  });

  test("thread --wait returns exit 0 with timeout true when no new messages arrive", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.a",
      "--title",
      "Thread timeout",
      "--json",
    ]);
    expect(send.exitCode).toBe(0);
    const ticketId = parseJson(send.stdout).ticket.id;

    const timeout = await atix(dbPath, ["thread", ticketId, "--after", "1", "--wait", "0", "--json"]);

    expect(timeout.exitCode).toBe(0);
    expect(timeout.stderr).toBe("");
    expect(parseJson(timeout.stdout)).toMatchObject({
      ok: true,
      type: "thread_delta",
      cursor: "1",
      next_cursor: "1",
      messages: [],
      timeout: true,
    });
  });

  test("recover returns receipt while preserving claim_token compatibility", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.a",
      "--title",
      "Recover receipt",
      "--json",
    ]);
    expect(send.exitCode).toBe(0);
    const ticketId = parseJson(send.stdout).ticket.id;
    const workerEnv = { ATIX_AGENT: "worker", ATIX_SESSION: "recover-session" };

    const take = await atix(dbPath, ["take", ticketId, "--json"], { env: workerEnv });
    expect(take.exitCode).toBe(0);
    const recover = await atix(dbPath, ["recover", ticketId, "--json"], { env: workerEnv });

    expect(recover.exitCode).toBe(0);
    const payload = parseJson(recover.stdout);
    expect(payload.receipt).toEqual(expect.any(String));
    expect(payload.claim_token).toBe(payload.receipt);
  });
});
