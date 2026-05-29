import { flagString, flagBool } from "../lib/args";
import { parseDuration } from "../lib/duration";
import { nowIso } from "../lib/time";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError, NotFoundError } from "../lib/errors";
import { fetchTicket, fetchReplies } from "../lib/queries";
import { serializeTicket } from "../lib/serialize";

import type { Ctx } from "../types";

const CLOSED_STATUSES = new Set(["done", "canceled"]);

type UntilMode = "done" | "reply";

// wait --since is an absolute ISO-8601 timestamp (UTC). Duration grammar
// (e.g. '1h') belongs to list --since only — accepting it here would produce a
// silent lexical mis-comparison against stored ISO timestamps. See SPEC §3.3.
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Validate that --since is an ISO-8601 timestamp; reject durations/garbage. */
function parseSince(raw: string): string {
  if (!ISO_TIMESTAMP_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new BadFlagError(
      `invalid --since '${raw}'. wait --since takes an ISO-8601 timestamp ` +
        `(e.g. '2026-05-27T14:00:00.000Z'); use list --since for durations`,
    );
  }
  return raw;
}

/** Latest reply created_at (ULID tie-break) for a ticket, or null when none. */
function latestReplyAt(db: NonNullable<Ctx["db"]>, ticketId: string): string | null {
  const row = db
    .query(
      `SELECT created_at FROM replies WHERE ticket_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(ticketId) as { created_at: string } | null;
  return row?.created_at ?? null;
}

/** True once a reply newer than `since` (ISO) exists for the ticket. */
function hasReplyAfter(db: NonNullable<Ctx["db"]>, ticketId: string, since: string): boolean {
  const row = db
    .query("SELECT 1 FROM replies WHERE ticket_id = ? AND created_at > ? LIMIT 1")
    .get(ticketId, since) as unknown | null;
  return row !== null;
}

/**
 * Block until the ticket reaches the desired condition or the timeout elapses.
 * - --until done: status becomes done/canceled.
 * - --until reply: a reply newer than --since (or wait start) appears.
 * On success emits the canonical ticket object (replies with --with-replies).
 * On timeout emits {ok:false,timeout:true,...} and returns exit 5 (still pending).
 */
export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("wait: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new NotFoundError("wait requires a ticket ID");

  if (fetchTicket(db, id) === null) throw new NotFoundError(`ticket '${id}' not found`);

  const untilRaw = flagString(ctx.args, "until") ?? "done";
  if (untilRaw !== "done" && untilRaw !== "reply") {
    throw new BadFlagError(`invalid --until '${untilRaw}'. Use 'done' or 'reply'`);
  }
  const until: UntilMode = untilRaw;

  const timeoutSec = parseDuration(flagString(ctx.args, "timeout") ?? "30m");
  const pollSec = parseDuration(flagString(ctx.args, "poll") ?? "1s");
  const pollMs = Math.max(1, pollSec * 1000);

  const sinceRaw = flagString(ctx.args, "since");
  const sinceBaseline = sinceRaw === undefined ? nowIso() : parseSince(sinceRaw);

  const deadline = Date.now() + timeoutSec * 1000;

  for (;;) {
    const row = fetchTicket(db, id);
    if (row === null) throw new NotFoundError(`ticket '${id}' not found`);

    const satisfied =
      until === "done"
        ? CLOSED_STATUSES.has(row.status)
        : hasReplyAfter(db, id, sinceBaseline);

    if (satisfied) {
      return emitSuccess(ctx, db, id);
    }

    if (Date.now() >= deadline) {
      return emitTimeout(ctx, db, id);
    }

    const remaining = deadline - Date.now();
    await Bun.sleep(Math.min(pollMs, Math.max(1, remaining)));
  }
}

function emitSuccess(ctx: Ctx, db: NonNullable<Ctx["db"]>, id: string): number {
  const row = fetchTicket(db, id);
  if (row === null) throw new NotFoundError(`ticket '${id}' not found`);

  if (ctx.json) {
    const replies = flagBool(ctx.args, "with-replies") ? fetchReplies(db, id) : undefined;
    printJson({ ok: true, ...serializeTicket(row, { replies }) });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  printLine(`${statusIcon(row.status)} ${colorize(mode, "cyan", row.id)} ${row.status}`);
  return EXIT.OK;
}

/** Timeout is "still pending", not a failure: exit 5 with timeout:true envelope. */
function emitTimeout(ctx: Ctx, db: NonNullable<Ctx["db"]>, id: string): number {
  const row = fetchTicket(db, id);
  const status = row?.status ?? "open";
  const lastReplyAt = latestReplyAt(db, id);

  if (ctx.json) {
    printJson({ ok: false, timeout: true, status, id, last_reply_at: lastReplyAt });
  } else {
    process.stderr.write(`timeout: ticket '${id}' still pending (status=${status})\n`);
  }
  return EXIT.TIMEOUT;
}
