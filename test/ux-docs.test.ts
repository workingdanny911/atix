import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      ATIX_AGENT: opts.env?.ATIX_AGENT ?? "docs-agent",
      ATIX_PROJECT: opts.env?.ATIX_PROJECT ?? "atix-project",
      ATIX_SESSION: opts.env?.ATIX_SESSION ?? "sess-docs",
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
  tmpDir = mkdtempSync(join(tmpdir(), "atix-ux-docs-"));
  dbPath = join(tmpDir, "atix.db");

  const init = await atix(dbPath, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  const channel = await atix(dbPath, ["channel", "add", "review.codex", "--json"]);
  expect(channel.exitCode).toBe(0);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("document attachment UX", () => {
  test("--doc, --doc-file, and --doc-stdin are stored and shown immutably", async () => {
    const docFile = join(tmpDir, "source.md");
    writeFileSync(docFile, "file doc v1", "utf8");

    const send = await atix(
      dbPath,
      [
        "send",
        "--to",
        "review.codex",
        "--title",
        "Ticket with docs",
        "--doc",
        "inline.md=inline doc",
        "--doc-file",
        `file.md=${docFile}`,
        "--doc-stdin",
        "stdin.md",
        "--json",
      ],
      { stdin: "stdin doc" },
    );

    expect(send.exitCode).toBe(0);
    const id = parseJson(send.stdout).ticket.id;

    writeFileSync(docFile, "file doc v2", "utf8");

    const show = await atix(dbPath, ["show", id, "--with-docs", "--json"]);
    expect(show.exitCode).toBe(0);
    const docs = parseJson(show.stdout).ticket.docs;

    expect(docs.map((doc: any) => doc.title)).toEqual(["inline.md", "file.md", "stdin.md"]);
    expect(docs.map((doc: any) => doc.position)).toEqual([0, 1, 2]);
    expect(docs.map((doc: any) => doc.owner_kind)).toEqual(["ticket", "ticket", "ticket"]);
    expect(docs.map((doc: any) => doc.content)).toEqual(["inline doc", "file doc v1", "stdin doc"]);
  });

  test("reply docs and done docs are attached to non-final and final replies", async () => {
    const send = await atix(dbPath, [
      "send",
      "--to",
      "review.codex",
      "--title",
      "Needs response docs",
      "--json",
    ]);
    expect(send.exitCode).toBe(0);
    const id = parseJson(send.stdout).ticket.id;

    const inbox = await atix(dbPath, ["inbox", "--from", "review.codex", "--json"]);
    expect(inbox.exitCode).toBe(0);
    const receipt = parseJson(inbox.stdout).receipt;

    const reply = await atix(dbPath, [
      "reply",
      id,
      "--doc",
      "reply.md=reply attachment",
      "--json",
    ]);
    expect(reply.exitCode).toBe(0);
    const replyJson = parseJson(reply.stdout);
    expect(replyJson.reply.is_final).toBe(false);
    expect(replyJson.reply.docs[0].content).toBe("reply attachment");

    const finalFile = join(tmpDir, "final.md");
    writeFileSync(finalFile, "final attachment", "utf8");
    const done = await atix(dbPath, [
      "done",
      id,
      "--receipt",
      receipt,
      "--doc-file",
      `final.md=${finalFile}`,
      "--json",
    ]);
    expect(done.exitCode).toBe(0);
    const doneJson = parseJson(done.stdout);
    expect(doneJson.reply.is_final).toBe(true);
    expect(doneJson.reply.docs[0].content).toBe("final attachment");

    const show = await atix(dbPath, ["show", id, "--with-replies", "--with-docs", "--json"]);
    expect(show.exitCode).toBe(0);
    const replies = parseJson(show.stdout).ticket.replies;
    expect(replies).toHaveLength(2);

    const nonFinal = replies.find((item: any) => item.is_final === false);
    const final = replies.find((item: any) => item.is_final === true);
    expect(nonFinal.docs[0]).toMatchObject({
      owner_kind: "reply",
      title: "reply.md",
      content: "reply attachment",
    });
    expect(final.docs[0]).toMatchObject({
      owner_kind: "reply",
      title: "final.md",
      content: "final attachment",
    });

    const humanShow = await atix(dbPath, ["show", id, "--with-replies", "--with-docs"]);
    expect(humanShow.exitCode).toBe(0);
    expect(humanShow.stdout).toContain("[final]");
    expect(humanShow.stdout).toContain("final.md (16 bytes)");
  });
});
