import { withImmediateTx } from "../db/connection";
import { flagString } from "../lib/args";
import { parseDuration } from "../lib/duration";
import { nowIso } from "../lib/time";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { AtixError, EXIT } from "../lib/exit";
import { BadFlagError, UnknownChannelError } from "../lib/errors";
import { fetchAskGroupForTicket, findChannel, insertThreadMessage } from "../lib/queries";
import { normalizePollSeconds, shouldKeepPolling } from "../lib/claim-policy";
import { isSqliteBusy } from "../lib/sqlite";

import type { Database } from "bun:sqlite";
import type { Ctx, Meta } from "../types";

interface OpenTicketRow {
  id: string;
  created_at: string;
}

interface ClaimedTicketRow {
  id: string;
  title: string;
  body: string;
  producer_agent: string | null;
  producer_project: string | null;
  producer_cwd: string | null;
  producer_session: string | null;
  producer_pid: number | null;
  claimed_at: string;
  claim_token: string;
}

/**
 * Raised when the conditional claim UPDATE matches a row count other than 1
 * after the SELECT already found a candidate under the same `BEGIN IMMEDIATE`
 * lock. Under IMMEDIATE serialization this is unreachable (see `tryClaimOnce`);
 * surfacing it as an explicit error makes the broken invariant loud instead of
 * silently looping forever should the transaction semantics ever change.
 */
class ClaimInvariantError extends AtixError {
  constructor(id: string, changes: number) {
    super(
      "internal",
      `claim invariant violated: conditional UPDATE for ticket '${id}' under BEGIN IMMEDIATE changed ${changes} rows (expected exactly 1)`,
      EXIT.FAIL,
    );
    this.name = "ClaimInvariantError";
  }
}

function appendClaimedMessages(db: Database, ticketId: string, meta: Meta, claimedAt: string): void {
  const ticketMessage = insertThreadMessage(db, {
    rootKind: "ticket",
    rootId: ticketId,
    kind: "claimed",
    actorKind: meta.kind,
    actorRole: "claimer",
    actorAgent: meta.agent,
    actorProject: meta.project,
    actorCwd: meta.cwd,
    actorSession: meta.session,
    actorPid: meta.pid,
    ticketId,
    createdAt: claimedAt,
  });

  const group = fetchAskGroupForTicket(db, ticketId);
  if (group === null) return;

  insertThreadMessage(db, {
    rootKind: "ask_group",
    rootId: group.id,
    kind: "claimed",
    actorKind: meta.kind,
    actorRole: "claimer",
    actorAgent: meta.agent,
    actorProject: meta.project,
    actorCwd: meta.cwd,
    actorSession: meta.session,
    actorPid: meta.pid,
    ticketId,
    causedByMessageId: ticketMessage.id,
    createdAt: claimedAt,
  });
}

/**
 * Atomically claim the oldest open ticket on a channel. The conditional UPDATE
 * (`... AND status='open'`) is the race-safety guarantee.
 *
 * E1 (F1): the previous `for(;;)` retry loop was dead code. `BEGIN IMMEDIATE`
 * takes the write lock up-front, so the SELECT and UPDATE run serialized against
 * every other writer; the row this transaction selects as `open` cannot be
 * claimed by anyone else before our own UPDATE. Therefore a single SELECT+UPDATE
 * is sufficient and `res.changes` is always 1 on a found candidate. The loop is
 * flattened, and the (now impossible) `changes !== 1` path is an explicit
 * invariant violation rather than a continue that could spin forever.
 *
 * Returns the claimed row, or null if the queue was empty.
 */
function tryClaimOnce(db: Database, channel: string, meta: Meta): ClaimedTicketRow | null {
  return withImmediateTx(db, () => {
    const candidate = db
      .query(
        "SELECT id, created_at FROM tickets WHERE channel = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1",
      )
      .get(channel) as OpenTicketRow | null;
    if (candidate === null) return null;

    const claimedAt = nowIso();
    const token = crypto.randomUUID();
    const res = db
      .query(
        `UPDATE tickets
           SET status = 'claimed',
               claimed_at = ?,
               claim_token = ?,
               claimer_agent = ?,
               claimer_project = ?,
               claimer_cwd = ?,
               claimer_session = ?,
               claimer_pid = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(
        claimedAt,
        token,
        meta.agent,
        meta.project,
        meta.cwd,
        meta.session,
        meta.pid,
        candidate.id,
      );

    if (res.changes !== 1) throw new ClaimInvariantError(candidate.id, res.changes);
    appendClaimedMessages(db, candidate.id, meta, claimedAt);

    return db
      .query(
        `SELECT id, title, body,
                producer_agent, producer_project, producer_cwd, producer_session, producer_pid,
                claimed_at, claim_token
           FROM tickets WHERE id = ?`,
      )
      .get(candidate.id) as ClaimedTicketRow;
  });
}

export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("claim: database connection was not provided");

  const channel = flagString(ctx.args, "from");
  if (channel === undefined) throw new BadFlagError("claim requires --from <channel>");

  // Existence-only check; claim deliberately drains archived channels (Patch 4b),
  // so archived_at is ignored here. (TOCTOU note F2: this lookup is outside the
  // claim tx — left as-is, addressed separately.)
  const channelRow = findChannel(db, channel);
  if (channelRow === null) throw new UnknownChannelError(channel);

  // `0` is accepted as a bare zero (immediate single attempt) even though the
  // strict duration grammar requires a unit; any other value must be a duration.
  const parseWaitable = (raw: string): number => (raw === "0" ? 0 : parseDuration(raw));

  const waitRaw = flagString(ctx.args, "wait");
  const waitSeconds = waitRaw === undefined ? null : parseWaitable(waitRaw);
  const pollRaw = flagString(ctx.args, "poll");
  // E3 (F5): clamp the poll interval to a 100ms floor so `--poll 0` cannot
  // busy-spin the CPU via `Bun.sleep(0)`.
  const pollSeconds = normalizePollSeconds(pollRaw === undefined ? 1 : parseWaitable(pollRaw));

  const deadline = waitSeconds === null ? 0 : Date.now() + waitSeconds * 1000;

  // attempts counts claim tries (including the one that throws SQLITE_BUSY) so
  // E4 (F4) can guarantee at least one poll on `--wait > 0`, and E5 (F6) can
  // retry busy contention within the wait window instead of crashing.
  let attempts = 0;
  for (;;) {
    attempts++;
    let claimed: ClaimedTicketRow | null;
    try {
      claimed = tryClaimOnce(db, channel, ctx.meta);
    } catch (err) {
      // E5 (F6): `BEGIN IMMEDIATE` can throw SQLITE_BUSY once busy_timeout is
      // exceeded under write contention. While we are still inside a `--wait`
      // window, treat it as transient and retry on the next poll; otherwise let
      // it propagate so cli.ts converts it to the standard `db_busy` envelope.
      if (isSqliteBusy(err) && shouldKeepPolling({ waitSeconds, attempts, now: Date.now(), deadline })) {
        await Bun.sleep(pollSeconds * 1000);
        continue;
      }
      throw err;
    }
    if (claimed !== null) return emitSuccess(ctx, channel, claimed);

    if (!shouldKeepPolling({ waitSeconds, attempts, now: Date.now(), deadline })) break;

    await Bun.sleep(pollSeconds * 1000);
  }

  return emitEmpty(ctx, channel);
}

function emitSuccess(ctx: Ctx, channel: string, row: ClaimedTicketRow): number {
  if (ctx.json) {
    printJson({
      ok: true,
      id: row.id,
      channel,
      claim_token: row.claim_token,
      title: row.title,
      body: row.body,
      producer: {
        agent: row.producer_agent,
        project: row.producer_project,
        cwd: row.producer_cwd,
        session: row.producer_session,
        pid: row.producer_pid,
      },
      claimed_at: row.claimed_at,
      status: "claimed",
    });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  printLine(`${statusIcon("claimed")} claimed ${colorize(mode, "cyan", row.id)} ← ${channel}`);
  return EXIT.OK;
}

function emitEmpty(ctx: Ctx, channel: string): number {
  // Empty queue / wait expiry is not a failure → exit 0.
  if (ctx.json) {
    printJson({ ok: false, timeout: true, channel });
    return EXIT.OK;
  }
  const mode = resolveOutputMode(false);
  printLine(colorize(mode, "dim", "no open tickets"));
  return EXIT.OK;
}
