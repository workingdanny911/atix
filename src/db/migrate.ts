import schemaSql from "./schema.sql" with { type: "text" };

import type { Database } from "bun:sqlite";

import { ulid } from "../lib/ulid";

export const SCHEMA_VERSION = 3;
const V2_SCHEMA_VERSION = 2;

interface SchemaVersionRow {
  version: number;
}

interface ForeignKeyViolation {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

interface TicketBackfillRow {
  id: string;
  body: string;
  producer_kind: "human" | "agent";
  producer_agent: string | null;
  producer_project: string | null;
  producer_cwd: string | null;
  producer_session: string | null;
  producer_pid: number | null;
  created_at: string;
}

interface AskGroupBackfillRow {
  id: string;
  body: string;
  producer_kind: "human" | "agent";
  producer_agent: string | null;
  producer_project: string | null;
  producer_cwd: string | null;
  producer_session: string | null;
  producer_pid: number | null;
  created_at: string;
}

interface ReplyBackfillRow {
  id: string;
  ticket_id: string;
  author_kind: "human" | "agent";
  author_role: "producer" | "claimer" | "other";
  author_agent: string | null;
  author_project: string | null;
  author_cwd: string | null;
  author_session: string | null;
  author_pid: number | null;
  is_final: number;
  body: string;
  created_at: string;
  ticket_status: "open" | "claimed" | "done" | "canceled";
  group_id: string | null;
}

interface TicketLifecycleBackfillRow {
  id: string;
  status: "open" | "claimed" | "done" | "canceled";
  claimer_agent: string | null;
  claimer_project: string | null;
  claimer_cwd: string | null;
  claimer_session: string | null;
  claimer_pid: number | null;
  claimed_at: string | null;
  closed_at: string | null;
  group_id: string | null;
}

interface LegacyDocRow {
  id: string;
  owner_kind: "ask_group" | "ticket" | "reply";
  ask_group_id: string | null;
  ticket_id: string | null;
  reply_id: string | null;
  position: number;
  title: string;
  content_type: string;
  content: string;
  size_bytes: number;
  created_at: string;
}

interface BackfillMaps {
  askGroupOpenedMessageIds: Map<string, string>;
  ticketOpenedMessageIds: Map<string, string>;
  replyMessageIds: Map<string, string[]>;
}

/**
 * Apply the schema (idempotent — all DDL uses IF NOT EXISTS) and record the
 * schema version. Safe to call repeatedly. `schema.sql` is bundled via a Bun
 * text import so it works inside the compiled single-file binary.
 */
export function initDb(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");

  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as
    | SchemaVersionRow
    | null;
  if (row === null) {
    db.run(schemaSql);
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    assertForeignKeys(db);
    return;
  }

  if (row.version > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${row.version} is newer than supported ${SCHEMA_VERSION}`,
    );
  }

  let version = row.version;
  if (row.version === 1) {
    migrateV1ToV2(db);
    version = V2_SCHEMA_VERSION;
  }

  if (version === V2_SCHEMA_VERSION) {
    migrateV2ToV3(db);
    return;
  }

  db.run(schemaSql);
  db.query("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  assertForeignKeys(db);
}

function migrateV1ToV2(db: Database): void {
  db.run("BEGIN IMMEDIATE");
  try {
    rebuildRepliesWithoutBodyCheck(db);
    createV2CompatibilityTables(db);
    db.run("CREATE INDEX IF NOT EXISTS idx_replies_ticket ON replies(ticket_id, created_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_replies_final ON replies(ticket_id) WHERE is_final = 1");
    db.run("DELETE FROM schema_version");
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(V2_SCHEMA_VERSION);
    db.run("COMMIT");
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw err;
  }

  assertForeignKeys(db);
}

function migrateV2ToV3(db: Database): void {
  db.run("BEGIN IMMEDIATE");
  try {
    createThreadMessagesTable(db);
    const maps = backfillThreadMessages(db);
    rebuildDocsForV3(db, maps);
    db.run(schemaSql);
    db.run("DELETE FROM schema_version");
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    db.run("COMMIT");
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw err;
  }

  assertForeignKeys(db);
}

function rebuildRepliesWithoutBodyCheck(db: Database): void {
  db.run(`
    CREATE TABLE replies_next (
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
    )
  `);

  db.run(`
    INSERT INTO replies_next
      (id, ticket_id, author_kind, author_role, author_agent, author_project,
       author_cwd, author_session, author_pid, is_final, body, created_at)
    SELECT
      id, ticket_id, author_kind, author_role, author_agent, author_project,
      author_cwd, author_session, author_pid, is_final, body, created_at
      FROM replies
  `);

  db.run("DROP TABLE replies");
  db.run("ALTER TABLE replies_next RENAME TO replies");
}

function createV2CompatibilityTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ask_groups (
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ask_group_members (
      group_id     TEXT NOT NULL REFERENCES ask_groups(id) ON DELETE CASCADE,
      ticket_id    TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      member_role  TEXT NOT NULL DEFAULT 'opinion' CHECK (member_role IN ('opinion')),
      position     INTEGER NOT NULL CHECK (position >= 0),
      created_at   TEXT NOT NULL,
      PRIMARY KEY (group_id, ticket_id),
      UNIQUE (ticket_id),
      UNIQUE (group_id, position)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_ask_group_members_group
      ON ask_group_members(group_id, position, ticket_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS docs (
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
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_docs_ask_group
      ON docs(ask_group_id, position, id)
      WHERE owner_kind = 'ask_group'
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_docs_ticket
      ON docs(ticket_id, position, id)
      WHERE owner_kind = 'ticket'
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_docs_reply
      ON docs(reply_id, position, id)
      WHERE owner_kind = 'reply'
  `);
}

function createThreadMessagesTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS thread_messages (
      id                    TEXT PRIMARY KEY,
      root_kind             TEXT NOT NULL CHECK (root_kind IN ('ticket','ask_group')),
      root_id               TEXT NOT NULL,
      seq                   INTEGER NOT NULL CHECK (seq > 0),
      kind                  TEXT NOT NULL CHECK (kind IN ('opened','claimed','progress','question','answer','note','result','canceled','released','system')),
      body                  TEXT NOT NULL DEFAULT '',
      actor_kind            TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
      actor_role            TEXT NOT NULL CHECK (actor_role IN ('producer','claimer','other','system')),
      actor_agent           TEXT,
      actor_project         TEXT,
      actor_cwd             TEXT,
      actor_session         TEXT,
      actor_pid             INTEGER,
      ticket_id             TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      caused_by_message_id  TEXT REFERENCES thread_messages(id) ON DELETE SET NULL,
      correlation_id        TEXT,
      created_at            TEXT NOT NULL,
      UNIQUE(root_kind, root_id, seq)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_thread_messages_root_seq
      ON thread_messages(root_kind, root_id, seq)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_thread_messages_ticket_seq
      ON thread_messages(ticket_id, seq)
      WHERE ticket_id IS NOT NULL
  `);
}

function backfillThreadMessages(db: Database): BackfillMaps {
  const maps: BackfillMaps = {
    askGroupOpenedMessageIds: new Map(),
    ticketOpenedMessageIds: new Map(),
    replyMessageIds: new Map(),
  };

  const tickets = db
    .query(
      `SELECT id, body,
              producer_kind, producer_agent, producer_project, producer_cwd,
              producer_session, producer_pid, created_at
         FROM tickets
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as TicketBackfillRow[];

  for (const ticket of tickets) {
    const messageId = insertBackfilledThreadMessage(db, {
      rootKind: "ticket",
      rootId: ticket.id,
      kind: "opened",
      body: ticket.body,
      actorKind: ticket.producer_kind,
      actorRole: "producer",
      actorAgent: ticket.producer_agent,
      actorProject: ticket.producer_project,
      actorCwd: ticket.producer_cwd,
      actorSession: ticket.producer_session,
      actorPid: ticket.producer_pid,
      ticketId: ticket.id,
      causedByMessageId: null,
      createdAt: ticket.created_at,
    });
    maps.ticketOpenedMessageIds.set(ticket.id, messageId);
  }

  const askGroups = db
    .query(
      `SELECT id, body,
              producer_kind, producer_agent, producer_project, producer_cwd,
              producer_session, producer_pid, created_at
         FROM ask_groups
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as AskGroupBackfillRow[];

  for (const group of askGroups) {
    const messageId = insertBackfilledThreadMessage(db, {
      rootKind: "ask_group",
      rootId: group.id,
      kind: "opened",
      body: group.body,
      actorKind: group.producer_kind,
      actorRole: "producer",
      actorAgent: group.producer_agent,
      actorProject: group.producer_project,
      actorCwd: group.producer_cwd,
      actorSession: group.producer_session,
      actorPid: group.producer_pid,
      ticketId: null,
      causedByMessageId: null,
      createdAt: group.created_at,
    });
    maps.askGroupOpenedMessageIds.set(group.id, messageId);
  }

  backfillClaimedMessages(db);
  const ticketsWithLegacyTerminal = new Set<string>();

  const replies = db
    .query(
      `SELECT r.id, r.ticket_id,
              r.author_kind, r.author_role, r.author_agent, r.author_project,
              r.author_cwd, r.author_session, r.author_pid, r.is_final,
              r.body, r.created_at, t.status AS ticket_status, m.group_id
         FROM replies r
         JOIN tickets t ON t.id = r.ticket_id
         LEFT JOIN ask_group_members m ON m.ticket_id = r.ticket_id
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all() as ReplyBackfillRow[];

  for (const reply of replies) {
    const kind = legacyReplyMessageKind(reply);
    if (kind === "result" || kind === "canceled") {
      ticketsWithLegacyTerminal.add(reply.ticket_id);
    }
    const ticketMessageId = insertBackfilledThreadMessage(db, {
      rootKind: "ticket",
      rootId: reply.ticket_id,
      kind,
      body: reply.body,
      actorKind: reply.author_kind,
      actorRole: reply.author_role,
      actorAgent: reply.author_agent,
      actorProject: reply.author_project,
      actorCwd: reply.author_cwd,
      actorSession: reply.author_session,
      actorPid: reply.author_pid,
      ticketId: reply.ticket_id,
      causedByMessageId: null,
      createdAt: reply.created_at,
    });

    const messageIds = [ticketMessageId];
    if (reply.group_id !== null) {
      messageIds.push(
        insertBackfilledThreadMessage(db, {
          rootKind: "ask_group",
          rootId: reply.group_id,
          kind,
          body: reply.body,
          actorKind: reply.author_kind,
          actorRole: reply.author_role,
          actorAgent: reply.author_agent,
          actorProject: reply.author_project,
          actorCwd: reply.author_cwd,
          actorSession: reply.author_session,
          actorPid: reply.author_pid,
          ticketId: reply.ticket_id,
          causedByMessageId: ticketMessageId,
          createdAt: reply.created_at,
        }),
      );
    }

    maps.replyMessageIds.set(reply.id, messageIds);
  }

  backfillTerminalMessages(db, ticketsWithLegacyTerminal);

  return maps;
}

function legacyReplyMessageKind(reply: ReplyBackfillRow): "note" | "result" | "canceled" {
  if (reply.is_final !== 1) return "note";
  if (reply.ticket_status === "done") return "result";
  if (reply.ticket_status === "canceled") return "canceled";
  return "note";
}

interface BackfilledThreadMessageInput {
  rootKind: "ticket" | "ask_group";
  rootId: string;
  kind: "opened" | "claimed" | "note" | "result" | "canceled";
  body: string;
  actorKind: "human" | "agent" | "system";
  actorRole: "producer" | "claimer" | "other" | "system";
  actorAgent: string | null;
  actorProject: string | null;
  actorCwd: string | null;
  actorSession: string | null;
  actorPid: number | null;
  ticketId: string | null;
  causedByMessageId: string | null;
  createdAt: string;
}

function backfillClaimedMessages(db: Database): void {
  const tickets = db
    .query(
      `SELECT t.id, t.status,
              t.claimer_agent, t.claimer_project, t.claimer_cwd,
              t.claimer_session, t.claimer_pid, t.claimed_at, t.closed_at,
              m.group_id
         FROM tickets t
         LEFT JOIN ask_group_members m ON m.ticket_id = t.id
        WHERE t.claimed_at IS NOT NULL
          AND t.claimer_agent IS NOT NULL
        ORDER BY t.claimed_at ASC, t.id ASC`,
    )
    .all() as TicketLifecycleBackfillRow[];

  for (const ticket of tickets) {
    if (ticket.claimed_at === null) continue;

    const ticketMessageId = insertBackfilledThreadMessage(db, {
      rootKind: "ticket",
      rootId: ticket.id,
      kind: "claimed",
      body: "",
      actorKind: "agent",
      actorRole: "claimer",
      actorAgent: ticket.claimer_agent,
      actorProject: ticket.claimer_project,
      actorCwd: ticket.claimer_cwd,
      actorSession: ticket.claimer_session,
      actorPid: ticket.claimer_pid,
      ticketId: ticket.id,
      causedByMessageId: null,
      createdAt: ticket.claimed_at,
    });

    if (ticket.group_id === null) continue;
    insertBackfilledThreadMessage(db, {
      rootKind: "ask_group",
      rootId: ticket.group_id,
      kind: "claimed",
      body: "",
      actorKind: "agent",
      actorRole: "claimer",
      actorAgent: ticket.claimer_agent,
      actorProject: ticket.claimer_project,
      actorCwd: ticket.claimer_cwd,
      actorSession: ticket.claimer_session,
      actorPid: ticket.claimer_pid,
      ticketId: ticket.id,
      causedByMessageId: ticketMessageId,
      createdAt: ticket.claimed_at,
    });
  }
}

function backfillTerminalMessages(db: Database, ticketsWithLegacyTerminal: Set<string>): void {
  const tickets = db
    .query(
      `SELECT t.id, t.status,
              t.claimer_agent, t.claimer_project, t.claimer_cwd,
              t.claimer_session, t.claimer_pid, t.claimed_at, t.closed_at,
              m.group_id
         FROM tickets t
         LEFT JOIN ask_group_members m ON m.ticket_id = t.id
        WHERE t.status IN ('done','canceled')
          AND t.closed_at IS NOT NULL
        ORDER BY t.closed_at ASC, t.id ASC`,
    )
    .all() as TicketLifecycleBackfillRow[];

  for (const ticket of tickets) {
    if (ticket.closed_at === null || ticketsWithLegacyTerminal.has(ticket.id)) continue;
    const kind = ticket.status === "done" ? "result" : "canceled";

    const ticketMessageId = insertBackfilledThreadMessage(db, {
      rootKind: "ticket",
      rootId: ticket.id,
      kind,
      body: "",
      actorKind: "system",
      actorRole: "system",
      actorAgent: null,
      actorProject: null,
      actorCwd: null,
      actorSession: null,
      actorPid: null,
      ticketId: ticket.id,
      causedByMessageId: null,
      createdAt: ticket.closed_at,
    });

    if (ticket.group_id === null) continue;
    insertBackfilledThreadMessage(db, {
      rootKind: "ask_group",
      rootId: ticket.group_id,
      kind,
      body: "",
      actorKind: "system",
      actorRole: "system",
      actorAgent: null,
      actorProject: null,
      actorCwd: null,
      actorSession: null,
      actorPid: null,
      ticketId: ticket.id,
      causedByMessageId: ticketMessageId,
      createdAt: ticket.closed_at,
    });
  }
}

function insertBackfilledThreadMessage(
  db: Database,
  input: BackfilledThreadMessageInput,
): string {
  const id = ulid();
  const seq = nextThreadSeq(db, input.rootKind, input.rootId);

  db.query(
    `INSERT INTO thread_messages
       (id, root_kind, root_id, seq, kind, body,
        actor_kind, actor_role, actor_agent, actor_project, actor_cwd,
        actor_session, actor_pid, ticket_id, caused_by_message_id,
        correlation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    input.rootKind,
    input.rootId,
    seq,
    input.kind,
    input.body,
    input.actorKind,
    input.actorRole,
    input.actorAgent,
    input.actorProject,
    input.actorCwd,
    input.actorSession,
    input.actorPid,
    input.ticketId,
    input.causedByMessageId,
    input.createdAt,
  );

  return id;
}

function nextThreadSeq(db: Database, rootKind: string, rootId: string): number {
  const row = db
    .query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
         FROM thread_messages
        WHERE root_kind = ? AND root_id = ?`,
    )
    .get(rootKind, rootId) as { seq: number };
  return row.seq;
}

function rebuildDocsForV3(db: Database, maps: BackfillMaps): void {
  const docs = db
    .query(
      `SELECT id, owner_kind, ask_group_id, ticket_id, reply_id,
              position, title, content_type, content, size_bytes, created_at
         FROM docs
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as LegacyDocRow[];

  db.run(`
    CREATE TABLE docs_next (
      id                 TEXT PRIMARY KEY,
      owner_kind         TEXT NOT NULL CHECK (owner_kind IN ('ask_group','ticket','reply','message')),
      ask_group_id       TEXT REFERENCES ask_groups(id) ON DELETE CASCADE,
      ticket_id          TEXT REFERENCES tickets(id) ON DELETE CASCADE,
      reply_id           TEXT REFERENCES replies(id) ON DELETE CASCADE,
      thread_message_id  TEXT REFERENCES thread_messages(id) ON DELETE CASCADE,
      position           INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
      title              TEXT NOT NULL,
      content_type       TEXT NOT NULL DEFAULT 'text/markdown; charset=utf-8',
      content            TEXT NOT NULL DEFAULT '',
      size_bytes         INTEGER NOT NULL CHECK (size_bytes >= 0),
      created_at         TEXT NOT NULL,
      CHECK (
           (owner_kind = 'ask_group' AND ask_group_id IS NOT NULL AND ticket_id IS NULL AND reply_id IS NULL AND thread_message_id IS NULL)
        OR (owner_kind = 'ticket'    AND ask_group_id IS NULL AND ticket_id IS NOT NULL AND reply_id IS NULL AND thread_message_id IS NULL)
        OR (owner_kind = 'reply'     AND ask_group_id IS NULL AND ticket_id IS NULL AND reply_id IS NOT NULL AND thread_message_id IS NULL)
        OR (owner_kind = 'message'   AND ask_group_id IS NULL AND ticket_id IS NULL AND reply_id IS NULL AND thread_message_id IS NOT NULL)
      )
    )
  `);

  const insertDoc = db.query(
    `INSERT INTO docs_next
       (id, owner_kind, ask_group_id, ticket_id, reply_id, thread_message_id,
        position, title, content_type, content, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const doc of docs) {
    insertDoc.run(
      doc.id,
      doc.owner_kind,
      doc.ask_group_id,
      doc.ticket_id,
      doc.reply_id,
      null,
      doc.position,
      doc.title,
      doc.content_type,
      doc.content,
      doc.size_bytes,
      doc.created_at,
    );

    for (const messageId of messageIdsForLegacyDoc(doc, maps)) {
      insertDoc.run(
        ulid(),
        "message",
        null,
        null,
        null,
        messageId,
        doc.position,
        doc.title,
        doc.content_type,
        doc.content,
        doc.size_bytes,
        doc.created_at,
      );
    }
  }

  db.run("DROP TABLE docs");
  db.run("ALTER TABLE docs_next RENAME TO docs");
}

function messageIdsForLegacyDoc(doc: LegacyDocRow, maps: BackfillMaps): string[] {
  if (doc.owner_kind === "ask_group" && doc.ask_group_id !== null) {
    const messageId = maps.askGroupOpenedMessageIds.get(doc.ask_group_id);
    return messageId === undefined ? [] : [messageId];
  }

  if (doc.owner_kind === "ticket" && doc.ticket_id !== null) {
    const messageId = maps.ticketOpenedMessageIds.get(doc.ticket_id);
    return messageId === undefined ? [] : [messageId];
  }

  if (doc.owner_kind === "reply" && doc.reply_id !== null) {
    return maps.replyMessageIds.get(doc.reply_id) ?? [];
  }

  return [];
}

function assertForeignKeys(db: Database): void {
  const violations = db.query("PRAGMA foreign_key_check").all() as ForeignKeyViolation[];
  if (violations.length === 0) return;

  const detail = violations
    .slice(0, 5)
    .map((v) => `${v.table}:${v.rowid}->${v.parent}#${v.fkid}`)
    .join(", ");
  throw new Error(`foreign_key_check failed (${violations.length}): ${detail}`);
}
