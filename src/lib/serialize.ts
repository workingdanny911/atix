import type { Kind, TicketStatus } from "../types";

export type DocOwnerKind = "ask_group" | "ticket" | "reply" | "message";
export type ThreadRootKind = "ticket" | "ask_group";
export type ThreadMessageKind =
  | "opened"
  | "claimed"
  | "progress"
  | "question"
  | "answer"
  | "note"
  | "result"
  | "canceled"
  | "released"
  | "system";
export type ThreadActorKind = Kind | "system";
export type ThreadActorRole = "producer" | "claimer" | "other" | "system";

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

export interface DocRow {
  id: string;
  owner_kind: DocOwnerKind;
  ask_group_id: string | null;
  ticket_id: string | null;
  reply_id: string | null;
  thread_message_id: string | null;
  position: number;
  title: string;
  content_type: string;
  content: string;
  size_bytes: number;
  created_at: string;
}

export interface ThreadMessageRow {
  id: string;
  root_kind: ThreadRootKind;
  root_id: string;
  seq: number;
  kind: ThreadMessageKind;
  body: string;
  actor_kind: ThreadActorKind;
  actor_role: ThreadActorRole;
  actor_agent: string | null;
  actor_project: string | null;
  actor_cwd: string | null;
  actor_session: string | null;
  actor_pid: number | null;
  ticket_id: string | null;
  caused_by_message_id: string | null;
  correlation_id: string | null;
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

export const DOC_SELECT_COLUMNS = `id, owner_kind, ask_group_id, ticket_id, reply_id, thread_message_id,
  position, title, content_type, content, size_bytes, created_at`;

export const THREAD_MESSAGE_SELECT_COLUMNS = `id, root_kind, root_id, seq, kind, body,
  actor_kind, actor_role, actor_agent, actor_project, actor_cwd, actor_session, actor_pid,
  ticket_id, caused_by_message_id, correlation_id, created_at`;

interface SerializeTicketOptions {
  /** Append a `replies` key with the serialized array (omit the key otherwise). */
  replies?: ReplyRow[];
  /** Append a `docs` key with the serialized array (omit the key otherwise). */
  docs?: DocRow[];
  /** Attach docs to serialized replies by reply id when replies are supplied. */
  replyDocs?: Record<string, DocRow[]>;
}

interface SerializeReplyOptions {
  /** Append a `docs` key with the serialized array (omit the key otherwise). */
  docs?: DocRow[];
}

interface SerializeThreadMessageOptions {
  /** Append a `docs` key with the serialized array (omit the key otherwise). */
  docs?: DocRow[];
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
    obj.replies = opts.replies.map((reply) =>
      serializeReply(reply, { docs: opts.replyDocs?.[reply.id] }),
    );
  }

  if (opts.docs !== undefined) {
    obj.docs = opts.docs.map(serializeDoc);
  }

  return obj;
}

/** Serialize one reply row to the canonical reply object (is_final → bool). */
export function serializeReply(
  reply: ReplyRow,
  opts: SerializeReplyOptions = {},
): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: reply.id,
    author_kind: reply.author_kind,
    author_role: reply.author_role,
    author_agent: reply.author_agent,
    is_final: reply.is_final === 1,
    body: reply.body,
    created_at: reply.created_at,
  };

  if (opts.docs !== undefined) {
    obj.docs = opts.docs.map(serializeDoc);
  }

  return obj;
}

export function serializeDoc(doc: DocRow): Record<string, unknown> {
  return {
    id: doc.id,
    owner_kind: doc.owner_kind,
    ask_group_id: doc.ask_group_id,
    ticket_id: doc.ticket_id,
    reply_id: doc.reply_id,
    thread_message_id: doc.thread_message_id,
    position: doc.position,
    title: doc.title,
    content_type: doc.content_type,
    content: doc.content,
    size_bytes: doc.size_bytes,
    created_at: doc.created_at,
  };
}

export function serializeThreadMessage(
  message: ThreadMessageRow,
  opts: SerializeThreadMessageOptions = {},
): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: message.id,
    root_kind: message.root_kind,
    root_id: message.root_id,
    seq: message.seq,
    cursor: String(message.seq),
    kind: message.kind,
    body: message.body,
    actor: {
      kind: message.actor_kind,
      role: message.actor_role,
      agent: message.actor_agent,
      project: message.actor_project,
      cwd: message.actor_cwd,
      session: message.actor_session,
      pid: message.actor_pid,
    },
    ticket_id: message.ticket_id,
    caused_by_message_id: message.caused_by_message_id,
    correlation_id: message.correlation_id,
    created_at: message.created_at,
  };

  if (opts.docs !== undefined) {
    obj.docs = opts.docs.map(serializeDoc);
  }

  return obj;
}
