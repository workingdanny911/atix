import { nowIso } from "./time";
import { ulid } from "./ulid";
import { TICKET_SELECT_COLUMNS, REPLY_SELECT_COLUMNS } from "./serialize";

import type { Database } from "bun:sqlite";
import type { Meta } from "../types";
import type { AuthorRole } from "./author";
import type { TicketRow, ReplyRow } from "./serialize";

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
