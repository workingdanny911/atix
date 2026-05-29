import type { Kind, TicketStatus } from "../types";

/**
 * Row shape carrying every column the canonical ticket object needs. Commands
 * that serialize a ticket must SELECT all of these (see TICKET_SELECT_COLUMNS).
 */
export interface TicketRow {
  id: string;
  channel: string;
  status: TicketStatus;
  title: string;
  body: string;
  producer_kind: Kind;
  producer_agent: string | null;
  producer_project: string | null;
  producer_cwd: string | null;
  producer_session: string | null;
  producer_pid: number | null;
  claimer_agent: string | null;
  claimer_project: string | null;
  claimer_cwd: string | null;
  claimer_session: string | null;
  claimer_pid: number | null;
  created_at: string;
  claimed_at: string | null;
  closed_at: string | null;
  claim_token: string | null;
}

export interface ReplyRow {
  id: string;
  author_kind: Kind;
  author_role: string;
  author_agent: string | null;
  is_final: number;
  body: string;
  created_at: string;
}

/**
 * The exact column list a query must SELECT before handing a row to
 * `serializeTicket`. Centralized so show/wait/list stay in lockstep.
 */
export const TICKET_SELECT_COLUMNS = `id, channel, status, title, body,
  producer_kind, producer_agent, producer_project, producer_cwd, producer_session, producer_pid,
  claimer_agent, claimer_project, claimer_cwd, claimer_session, claimer_pid,
  created_at, claimed_at, closed_at, claim_token`;

export const REPLY_SELECT_COLUMNS = `id, author_kind, author_role, author_agent, is_final, body, created_at`;

interface SerializeTicketOptions {
  /** Append a `replies` key with the serialized array (omit the key otherwise). */
  replies?: ReplyRow[];
}

/**
 * Build the canonical ticket object defined in SPEC §3.3 (show OUTPUT). This is
 * the single source of truth reused by `show`, successful `wait`, and `list`.
 *
 * NULL policy (SPEC §3.2): nullable fields emit JSON `null` (key present).
 * `replies` is omitted entirely unless `opts.replies` is supplied (key absent),
 * matching the "--with-replies → key present, else missing" contract.
 */
export function serializeTicket(
  row: TicketRow,
  opts: SerializeTicketOptions = {},
): Record<string, unknown> {
  const claimer =
    row.claimer_agent === null && row.claimer_session === null && row.claimer_pid === null
      ? null
      : {
          agent: row.claimer_agent,
          project: row.claimer_project,
          cwd: row.claimer_cwd,
          session: row.claimer_session,
          pid: row.claimer_pid,
        };

  const obj: Record<string, unknown> = {
    id: row.id,
    channel: row.channel,
    status: row.status,
    title: row.title,
    body: row.body,
    size_bytes: Buffer.byteLength(row.body, "utf8"),
    producer: {
      kind: row.producer_kind,
      agent: row.producer_agent,
      project: row.producer_project,
      cwd: row.producer_cwd,
      session: row.producer_session,
      pid: row.producer_pid,
    },
    claimer,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    closed_at: row.closed_at,
    claim_token: row.claim_token,
  };

  if (opts.replies !== undefined) {
    obj.replies = opts.replies.map(serializeReply);
  }

  return obj;
}

/** Serialize one reply row to the canonical reply object (is_final → bool). */
export function serializeReply(reply: ReplyRow): Record<string, unknown> {
  return {
    id: reply.id,
    author_kind: reply.author_kind,
    author_role: reply.author_role,
    author_agent: reply.author_agent,
    is_final: reply.is_final === 1,
    body: reply.body,
    created_at: reply.created_at,
  };
}
