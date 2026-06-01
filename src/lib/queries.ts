import { nowIso } from "./time";
import { ulid } from "./ulid";
import {
  TICKET_SELECT_COLUMNS,
  REPLY_SELECT_COLUMNS,
  DOC_SELECT_COLUMNS,
  THREAD_MESSAGE_SELECT_COLUMNS,
} from "./serialize";

import type { Database } from "bun:sqlite";
import type { Meta } from "../types";
import type { AuthorRole } from "./author";
import type {
  DocOwnerKind,
  DocRow,
  ReplyRow,
  ThreadActorKind,
  ThreadActorRole,
  ThreadMessageKind,
  ThreadMessageRow,
  ThreadRootKind,
  TicketRow,
} from "./serialize";

/**
 * Shared read queries for the canonical (full-column) ticket object. Lives in
 * `lib` rather than a command module so that show/wait no longer import each
 * other (the previous wait → show import was a layering inversion).
 *
 * NOTE: this is the full-column fetch consumed by show/wait/serializeTicket.
 * Commands that need only a few columns for diagnosis (release/done/cancel/
 * recover/reply) deliberately keep their narrow inline SELECTs — see
 * REFACTOR_PLAN B1: forcing them onto this full fetch adds wasted reads and
 * type friction for no gain.
 */

export interface ChannelRow {
  name: string;
  archived_at: string | null;
}

export interface AskGroupRow {
  id: string;
  title: string;
  body: string;
  producer_kind: Meta["kind"];
  producer_agent: string | null;
  producer_project: string | null;
  producer_cwd: string | null;
  producer_session: string | null;
  producer_pid: number | null;
  created_at: string;
}

export interface AskGroupMemberRow {
  group_id: string;
  ticket_id: string;
  member_role: "opinion";
  position: number;
  created_at: string;
}

export interface InsertDocInput {
  ownerKind: DocOwnerKind;
  ownerId: string;
  position: number;
  title: string;
  contentType: string;
  content: string;
  sizeBytes: number;
}

export interface InsertThreadMessageInput {
  rootKind: ThreadRootKind;
  rootId: string;
  kind: ThreadMessageKind;
  body?: string;
  actorKind: ThreadActorKind;
  actorRole: ThreadActorRole;
  actorAgent?: string | null;
  actorProject?: string | null;
  actorCwd?: string | null;
  actorSession?: string | null;
  actorPid?: number | null;
  ticketId?: string | null;
  causedByMessageId?: string | null;
  correlationId?: string | null;
  createdAt?: string;
}

export interface ThreadMessageWithDocs extends ThreadMessageRow {
  docs?: DocRow[];
}

/**
 * Fetch a channel by name (name + archived_at only), or null when absent.
 * Returns the raw row; the existence/archived *policy* stays in each command
 * because it differs per command (push rejects archived, claim drains archived,
 * channel only needs existence) — see REFACTOR_PLAN C1.
 */
export function findChannel(db: Database, name: string): ChannelRow | null {
  return db
    .query("SELECT name, archived_at FROM channels WHERE name = ?")
    .get(name) as ChannelRow | null;
}

/** Fetch a single ticket row by id, or null when absent. */
export function fetchTicket(db: Database, id: string): TicketRow | null {
  return db
    .query(`SELECT ${TICKET_SELECT_COLUMNS} FROM tickets WHERE id = ?`)
    .get(id) as TicketRow | null;
}

/** Fetch replies for a ticket, ordered by created_at ASC then id ASC (ULID tie-break). */
export function fetchReplies(db: Database, ticketId: string): ReplyRow[] {
  return db
    .query(
      `SELECT ${REPLY_SELECT_COLUMNS}
         FROM replies WHERE ticket_id = ?
         ORDER BY created_at ASC, id ASC`,
    )
    .all(ticketId) as ReplyRow[];
}

export function fetchReply(db: Database, replyId: string): ReplyRow | null {
  return db
    .query(`SELECT ${REPLY_SELECT_COLUMNS} FROM replies WHERE id = ?`)
    .get(replyId) as ReplyRow | null;
}

export function fetchAskGroup(db: Database, id: string): AskGroupRow | null {
  return db
    .query(
      `SELECT id, title, body,
              producer_kind, producer_agent, producer_project, producer_cwd,
              producer_session, producer_pid, created_at
         FROM ask_groups WHERE id = ?`,
    )
    .get(id) as AskGroupRow | null;
}

export function fetchAskGroupMembers(db: Database, groupId: string): AskGroupMemberRow[] {
  return db
    .query(
      `SELECT group_id, ticket_id, member_role, position, created_at
         FROM ask_group_members
        WHERE group_id = ?
        ORDER BY position ASC, ticket_id ASC`,
    )
    .all(groupId) as AskGroupMemberRow[];
}

export function fetchAskGroupForTicket(db: Database, ticketId: string): AskGroupRow | null {
  return db
    .query(
      `SELECT g.id, g.title, g.body,
              g.producer_kind, g.producer_agent, g.producer_project, g.producer_cwd,
              g.producer_session, g.producer_pid, g.created_at
         FROM ask_group_members m
         JOIN ask_groups g ON g.id = m.group_id
        WHERE m.ticket_id = ?`,
    )
    .get(ticketId) as AskGroupRow | null;
}

export function fetchDocsForAskGroup(db: Database, groupId: string): DocRow[] {
  return fetchDocsByOwner(db, "ask_group", groupId);
}

export function fetchDocsForTicket(db: Database, ticketId: string): DocRow[] {
  return fetchDocsByOwner(db, "ticket", ticketId);
}

export function fetchDocsForReply(db: Database, replyId: string): DocRow[] {
  return fetchDocsByOwner(db, "reply", replyId);
}

export function fetchDocsForMessage(db: Database, messageId: string): DocRow[] {
  return fetchDocsByOwner(db, "message", messageId);
}

export function fetchDocsByOwner(
  db: Database,
  ownerKind: DocOwnerKind,
  ownerId: string,
): DocRow[] {
  const ownerColumn = docOwnerColumn(ownerKind);
  return db
    .query(
      `SELECT ${DOC_SELECT_COLUMNS}
         FROM docs
        WHERE owner_kind = ? AND ${ownerColumn} = ?
        ORDER BY position ASC, id ASC`,
    )
    .all(ownerKind, ownerId) as DocRow[];
}

export function fetchThreadMessages(
  db: Database,
  rootKind: ThreadRootKind,
  rootId: string,
  afterSeq = 0,
  withDocs = false,
): ThreadMessageWithDocs[] {
  const messages = db
    .query(
      `SELECT ${THREAD_MESSAGE_SELECT_COLUMNS}
         FROM thread_messages
        WHERE root_kind = ? AND root_id = ? AND seq > ?
        ORDER BY seq ASC`,
    )
    .all(rootKind, rootId, afterSeq) as ThreadMessageRow[];

  if (!withDocs) return messages;

  return messages.map((message) => ({
    ...message,
    docs: fetchDocsForMessage(db, message.id),
  }));
}

export function fetchThreadMessage(db: Database, messageId: string): ThreadMessageRow | null {
  return db
    .query(`SELECT ${THREAD_MESSAGE_SELECT_COLUMNS} FROM thread_messages WHERE id = ?`)
    .get(messageId) as ThreadMessageRow | null;
}

export interface InsertReplyInput {
  ticketId: string;
  meta: Meta;
  role: AuthorRole;
  /** done writes a final reply (is_final=1) and so does the cancel reason; plain replies are non-final. */
  isFinal: boolean;
  body: string;
}

/**
 * Insert one reply row (12 columns) and return its generated ULID. The single
 * write path shared by done (role 'claimer', final), cancel reason (computed
 * role, final) and reply (computed role, non-final). The caller owns role and
 * isFinal because they encode command-specific semantics.
 */
export function insertReply(db: Database, input: InsertReplyInput): string {
  const replyId = ulid();
  const { meta } = input;
  db.query(
    `INSERT INTO replies
       (id, ticket_id, author_kind, author_role, author_agent, author_project, author_cwd, author_session, author_pid, is_final, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    replyId,
    input.ticketId,
    meta.kind,
    input.role,
    meta.agent,
    meta.project,
    meta.cwd,
    meta.session,
    meta.pid,
    input.isFinal ? 1 : 0,
    input.body,
    nowIso(),
  );
  return replyId;
}

export function insertDoc(db: Database, input: InsertDocInput): string {
  const docId = ulid();
  const askGroupId = input.ownerKind === "ask_group" ? input.ownerId : null;
  const ticketId = input.ownerKind === "ticket" ? input.ownerId : null;
  const replyId = input.ownerKind === "reply" ? input.ownerId : null;
  const threadMessageId = input.ownerKind === "message" ? input.ownerId : null;

  db.query(
    `INSERT INTO docs
       (id, owner_kind, ask_group_id, ticket_id, reply_id, thread_message_id, position,
        title, content_type, content, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    docId,
    input.ownerKind,
    askGroupId,
    ticketId,
    replyId,
    threadMessageId,
    input.position,
    input.title,
    input.contentType,
    input.content,
    input.sizeBytes,
    nowIso(),
  );

  return docId;
}

export function insertThreadMessage(
  db: Database,
  input: InsertThreadMessageInput,
): ThreadMessageRow {
  const messageId = ulid();
  const createdAt = input.createdAt ?? nowIso();
  const seq = nextThreadSeq(db, input.rootKind, input.rootId);

  db.query(
    `INSERT INTO thread_messages
       (id, root_kind, root_id, seq, kind, body,
        actor_kind, actor_role, actor_agent, actor_project, actor_cwd,
        actor_session, actor_pid, ticket_id, caused_by_message_id,
        correlation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    input.rootKind,
    input.rootId,
    seq,
    input.kind,
    input.body ?? "",
    input.actorKind,
    input.actorRole,
    input.actorAgent ?? null,
    input.actorProject ?? null,
    input.actorCwd ?? null,
    input.actorSession ?? null,
    input.actorPid ?? null,
    input.ticketId ?? null,
    input.causedByMessageId ?? null,
    input.correlationId ?? null,
    createdAt,
  );

  const row = fetchThreadMessage(db, messageId);
  if (row === null) {
    throw new Error(`insertThreadMessage: inserted message '${messageId}' disappeared`);
  }
  return row;
}

function nextThreadSeq(db: Database, rootKind: ThreadRootKind, rootId: string): number {
  const row = db
    .query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
         FROM thread_messages
        WHERE root_kind = ? AND root_id = ?`,
    )
    .get(rootKind, rootId) as { seq: number };
  return row.seq;
}

function docOwnerColumn(
  ownerKind: DocOwnerKind,
): "ask_group_id" | "ticket_id" | "reply_id" | "thread_message_id" {
  if (ownerKind === "ask_group") return "ask_group_id";
  if (ownerKind === "ticket") return "ticket_id";
  if (ownerKind === "reply") return "reply_id";
  return "thread_message_id";
}
