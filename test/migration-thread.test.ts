import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

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
      ATIX_AGENT: "migration-test",
      ATIX_PROJECT: "atix-project",
      ATIX_SESSION: "sess-migration",
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

function createV2Db(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (2);

    CREATE TABLE channels (
      name         TEXT PRIMARY KEY,
      description  TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      archived_at  TEXT
    );

    CREATE TABLE tickets (
      id                TEXT PRIMARY KEY,
      channel           TEXT NOT NULL REFERENCES channels(name) ON UPDATE CASCADE,
      status            TEXT NOT NULL CHECK (status IN ('open','claimed','done','canceled')),
      title             TEXT NOT NULL,
      body              TEXT NOT NULL DEFAULT '',
      producer_kind     TEXT NOT NULL CHECK (producer_kind IN ('human','agent')),
      producer_agent    TEXT,
      producer_project  TEXT,
      producer_cwd      TEXT,
      producer_session  TEXT,
      producer_pid      INTEGER,
      claimer_agent     TEXT,
      claimer_project   TEXT,
      claimer_cwd       TEXT,
      claimer_session   TEXT,
      claimer_pid       INTEGER,
      created_at        TEXT NOT NULL,
      claimed_at        TEXT,
      closed_at         TEXT,
      claim_token       TEXT,
      CHECK ((status = 'open'      AND claimed_at IS NULL AND claimer_agent IS NULL AND claim_token IS NULL)
          OR (status = 'claimed'   AND claimed_at IS NOT NULL AND claim_token IS NOT NULL)
          OR (status IN ('done','canceled') AND closed_at IS NOT NULL))
    );

    CREATE TABLE ask_groups (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      body              TEXT NOT NULL DEFAULT '',
      producer_kind     TEXT NOT NULL CHECK (producer_kind IN ('human','agent')),
      producer_agent    TEXT,
      producer_project  TEXT,
      producer_cwd      TEXT,
      producer_session  TEXT,
      producer_pid      INTEGER,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE ask_group_members (
      group_id     TEXT NOT NULL REFERENCES ask_groups(id) ON DELETE CASCADE,
      ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      member_role  TEXT NOT NULL DEFAULT 'opinion' CHECK (member_role IN ('opinion')),
      position     INTEGER NOT NULL CHECK (position >= 0),
      created_at   TEXT NOT NULL,
      PRIMARY KEY (group_id, ticket_id),
      UNIQUE (ticket_id),
      UNIQUE (group_id, position)
    );

    CREATE TABLE replies (
      id              TEXT PRIMARY KEY,
      ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_kind     TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
      author_role     TEXT NOT NULL CHECK (author_role IN ('claimer','producer','other')),
      author_agent    TEXT,
      author_project  TEXT,
      author_cwd      TEXT,
      author_session  TEXT,
      author_pid      INTEGER,
      is_final        INTEGER NOT NULL DEFAULT 0,
      body            TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    CREATE TABLE docs (
      id            TEXT PRIMARY KEY,
      owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('ask_group','ticket','reply')),
      ask_group_id  TEXT REFERENCES ask_groups(id) ON DELETE CASCADE,
      ticket_id     TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      reply_id      TEXT REFERENCES replies(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
      title         TEXT NOT NULL,
      content_type  TEXT NOT NULL DEFAULT 'text/markdown; charset=utf-8',
      content       TEXT NOT NULL DEFAULT '',
      size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
      created_at    TEXT NOT NULL,
      CHECK (
           (owner_kind = 'ask_group' AND ask_group_id IS NOT NULL AND ticket_id IS NULL AND reply_id IS NULL)
        OR (owner_kind = 'ticket'    AND ask_group_id IS NULL AND ticket_id IS NOT NULL AND reply_id IS NULL)
        OR (owner_kind = 'reply'     AND ask_group_id IS NULL AND ticket_id IS NULL AND reply_id IS NOT NULL)
      )
    );

    INSERT INTO channels (name, description, created_at)
    VALUES ('review.codex', '', '2025-01-01T00:00:00.000Z');
  `);
  return db;
}

function insertTicket(
  db: Database,
  input: {
    id: string;
    status: "claimed" | "done" | "canceled";
    createdAt?: string;
    claimedAt?: string;
    closedAt?: string | null;
  },
): void {
  db.query(
    `INSERT INTO tickets
       (id, channel, status, title, body,
        producer_kind, producer_agent, producer_project, producer_cwd, producer_session, producer_pid,
        claimer_agent, claimer_project, claimer_cwd, claimer_session, claimer_pid,
        created_at, claimed_at, closed_at, claim_token)
     VALUES (?, 'review.codex', ?, ?, ?, 'agent', 'producer', 'atix-project', '/tmp/project', 'sess-producer', 100,
             'worker', 'atix-project', '/tmp/project', 'sess-worker', 200,
             ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.status,
    input.id,
    `${input.id} body`,
    input.createdAt ?? "2025-01-01T00:00:00.000Z",
    input.claimedAt ?? "2025-01-01T00:01:00.000Z",
    input.closedAt ?? null,
    `${input.id}-receipt`,
  );
}

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir !== null) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function nextDbPath(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "atix-migration-thread-"));
  return join(tmpDir, "atix.db");
}

describe("v2 to v3 thread migration", () => {
  test("backfills opened and claimed messages for a claimed ticket", async () => {
    const dbPath = nextDbPath();
    const db = createV2Db(dbPath);
    insertTicket(db, { id: "ticket-claimed", status: "claimed" });
    db.close();

    const thread = await atix(dbPath, ["thread", "ticket-claimed", "--json"]);

    expect(thread.exitCode).toBe(0);
    expect(thread.stderr).toBe("");
    const messages = parseJson(thread.stdout).messages;
    expect(messages.map((message: any) => message.kind)).toEqual(["opened", "claimed"]);
    expect(messages[1]).toMatchObject({
      kind: "claimed",
      ticket_id: "ticket-claimed",
      actor: { role: "claimer", agent: "worker" },
      created_at: "2025-01-01T00:01:00.000Z",
    });
  });

  test("backfills child claimed messages into ask group threads", async () => {
    const dbPath = nextDbPath();
    const db = createV2Db(dbPath);
    insertTicket(db, { id: "ticket-child", status: "claimed" });
    db.query(
      `INSERT INTO ask_groups
         (id, title, body, producer_kind, producer_agent, producer_project,
          producer_cwd, producer_session, producer_pid, created_at)
       VALUES ('group-claimed', 'group-claimed', 'group body', 'agent', 'producer',
               'atix-project', '/tmp/project', 'sess-producer', 100,
               '2025-01-01T00:00:00.000Z')`,
    ).run();
    db.query(
      `INSERT INTO ask_group_members (group_id, ticket_id, member_role, position, created_at)
       VALUES ('group-claimed', 'ticket-child', 'opinion', 0, '2025-01-01T00:00:00.000Z')`,
    ).run();
    db.close();

    const thread = await atix(dbPath, ["thread", "group-claimed", "--json"]);

    expect(thread.exitCode).toBe(0);
    const messages = parseJson(thread.stdout).messages;
    const claimed = messages.find((message: any) => message.kind === "claimed");
    expect(claimed).toMatchObject({
      kind: "claimed",
      ticket_id: "ticket-child",
      actor: { role: "claimer", agent: "worker" },
    });
    expect(claimed.caused_by_message_id).toEqual(expect.any(String));
  });

  test("backfills terminal messages for closed tickets without final replies", async () => {
    const dbPath = nextDbPath();
    const db = createV2Db(dbPath);
    insertTicket(db, {
      id: "ticket-done",
      status: "done",
      closedAt: "2025-01-01T00:02:00.000Z",
    });
    insertTicket(db, {
      id: "ticket-canceled",
      status: "canceled",
      closedAt: "2025-01-01T00:03:00.000Z",
    });
    db.close();

    const doneThread = await atix(dbPath, ["thread", "ticket-done", "--json"]);
    const canceledThread = await atix(dbPath, ["thread", "ticket-canceled", "--json"]);

    expect(doneThread.exitCode).toBe(0);
    expect(canceledThread.exitCode).toBe(0);
    const doneMessages = parseJson(doneThread.stdout).messages;
    const canceledMessages = parseJson(canceledThread.stdout).messages;
    expect(doneMessages.map((message: any) => message.kind)).toEqual(["opened", "claimed", "result"]);
    expect(doneMessages[2]).toMatchObject({
      kind: "result",
      actor: { kind: "system", role: "system" },
      created_at: "2025-01-01T00:02:00.000Z",
    });
    expect(canceledMessages.map((message: any) => message.kind)).toEqual([
      "opened",
      "claimed",
      "canceled",
    ]);
    expect(canceledMessages[2]).toMatchObject({
      kind: "canceled",
      actor: { kind: "system", role: "system" },
      created_at: "2025-01-01T00:03:00.000Z",
    });
  });

  test("does not duplicate a terminal message from a final legacy reply", async () => {
    const dbPath = nextDbPath();
    const db = createV2Db(dbPath);
    insertTicket(db, {
      id: "ticket-final-reply",
      status: "done",
      closedAt: "2025-01-01T00:03:00.000Z",
    });
    db.query(
      `INSERT INTO replies
         (id, ticket_id, author_kind, author_role, author_agent, author_project,
          author_cwd, author_session, author_pid, is_final, body, created_at)
       VALUES ('reply-final', 'ticket-final-reply', 'agent', 'claimer', 'worker',
               'atix-project', '/tmp/project', 'sess-worker', 200, 1,
               'legacy final body', '2025-01-01T00:02:00.000Z')`,
    ).run();
    db.close();

    const thread = await atix(dbPath, ["thread", "ticket-final-reply", "--json"]);

    expect(thread.exitCode).toBe(0);
    const messages = parseJson(thread.stdout).messages;
    expect(messages.filter((message: any) => message.kind === "result")).toHaveLength(1);
    expect(messages.map((message: any) => message.kind)).toEqual(["opened", "claimed", "result"]);
    expect(messages[2].body).toBe("legacy final body");
  });
});
