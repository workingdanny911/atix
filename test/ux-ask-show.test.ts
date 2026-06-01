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
      ATIX_AGENT: "ask-agent",
      ATIX_PROJECT: "atix-project",
      ATIX_SESSION: "sess-ask",
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

async function addChannel(dbPath: string, name: string): Promise<void> {
  const channel = await atix(dbPath, ["channel", "add", name, "--json"]);
  expect(channel.exitCode).toBe(0);
}

async function receiveAndDone(dbPath: string, channel: string, body: string): Promise<string> {
  const inbox = await atix(dbPath, ["inbox", "--from", channel, "--json"]);
  expect(inbox.exitCode).toBe(0);
  const item = parseJson(inbox.stdout);
  expect(item.ok).toBe(true);

  const done = await atix(dbPath, [
    "done",
    item.ticket.id,
    "--receipt",
    item.receipt,
    "--body",
    body,
    "--json",
  ]);
  expect(done.exitCode).toBe(0);
  return item.ticket.id;
}

let dbPath: string;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "atix-ux-ask-"));
  dbPath = join(tmpDir, "atix.db");

  const init = await atix(dbPath, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  await addChannel(dbPath, "review.codex");
  await addChannel(dbPath, "design.codex");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ask and show UX", () => {
  test("ask creates a group and show aggregates child status", async () => {
    const ask = await atix(dbPath, [
      "ask",
      "--to",
      "review.codex",
      "--to",
      "design.codex",
      "--title",
      "Need two opinions",
      "--body",
      "Please review from your lane.",
      "--doc",
      "context.md=shared context",
      "--json",
    ]);

    expect(ask.exitCode).toBe(0);
    const created = parseJson(ask.stdout);
    const groupId = created.ask_group.id;
    expect(created.ok).toBe(true);
    expect(created.type).toBe("ask_group");
    expect(created.commands.read).toBe(`atix thread ${groupId} --with-docs`);
    expect(created.commands.read).not.toContain("show --with-replies");
    expect(created.commands.snapshot).toBe(`atix show ${groupId} --with-docs`);
    expect(created.ask_group.status).toBe("open");
    expect(created.ask_group.counts).toMatchObject({ total: 2, open: 2, claimed: 0, done: 0, canceled: 0 });
    expect(created.ask_group.children.map((child: any) => child.ticket.channel)).toEqual([
      "review.codex",
      "design.codex",
    ]);

    const initialShow = await atix(dbPath, ["show", groupId, "--with-docs", "--json"]);
    expect(initialShow.exitCode).toBe(0);
    const initialGroup = parseJson(initialShow.stdout).ask_group;
    expect(initialGroup.docs[0]).toMatchObject({
      owner_kind: "ask_group",
      title: "context.md",
      content: "shared context",
    });
    expect(initialGroup.counts).toMatchObject({ total: 2, open: 2, done: 0 });

    const reviewTicketId = await receiveAndDone(dbPath, "review.codex", "review done");
    const partialShow = await atix(dbPath, ["show", groupId, "--json"]);
    const partialGroup = parseJson(partialShow.stdout).ask_group;
    expect(partialGroup.status).toBe("open");
    expect(partialGroup.counts).toMatchObject({ total: 2, open: 1, done: 1 });
    expect(partialGroup.children.find((child: any) => child.ticket.id === reviewTicketId).ticket.status).toBe("done");

    await receiveAndDone(dbPath, "design.codex", "design done");
    const finalShow = await atix(dbPath, ["show", groupId, "--json"]);
    const finalGroup = parseJson(finalShow.stdout).ask_group;
    expect(finalGroup.status).toBe("closed");
    expect(finalGroup.counts).toMatchObject({ total: 2, open: 0, done: 2 });
  });

  test("show --wait returns timeout exit 5 for a pending ask group", async () => {
    const ask = await atix(dbPath, [
      "ask",
      "--to",
      "review.codex",
      "--to",
      "design.codex",
      "--title",
      "Pending group",
      "--json",
    ]);
    expect(ask.exitCode).toBe(0);
    const groupId = parseJson(ask.stdout).ask_group.id;

    const show = await atix(dbPath, ["show", groupId, "--wait", "0", "--json"]);

    expect(show.exitCode).toBe(5);
    expect(show.stderr).toBe("");
    expect(parseJson(show.stdout)).toMatchObject({
      ok: false,
      type: "timeout",
      timeout: true,
      id: groupId,
    });
  });

  test("ask --wait 0 accepts bare zero and returns timeout for an open group", async () => {
    const ask = await atix(dbPath, [
      "ask",
      "--to",
      "review.codex,design.codex",
      "--title",
      "Wait zero group",
      "--wait",
      "0",
      "--json",
    ]);

    expect(ask.exitCode).toBe(5);
    expect(ask.stderr).toBe("");
    const json = parseJson(ask.stdout);
    expect(json).toMatchObject({
      ok: false,
      type: "timeout",
      timeout: true,
    });
    expect(json.ask_group.title).toBe("Wait zero group");
  });

  test("ask rejects a single recipient and points users to send", async () => {
    const ask = await atix(dbPath, [
      "ask",
      "--to",
      "review.codex",
      "--title",
      "One opinion",
      "--json",
    ]);

    expect(ask.exitCode).toBe(2);
    const json = parseJson(ask.stdout);
    expect(json.error).toBe("bad_flag");
    expect(json.message).toContain("at least 2 recipients");
    expect(json.message).toContain("send");
  });
});
