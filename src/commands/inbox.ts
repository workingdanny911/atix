import { withImmediateTx } from "../db/connection";
import { flagBool, flagString } from "../lib/args";
import { parseDuration } from "../lib/duration";
import { BadFlagError, UnknownChannelError } from "../lib/errors";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import {
  fetchAskGroupForTicket,
  fetchDocsForAskGroup,
  fetchDocsForTicket,
  fetchTicket,
  findChannel,
  insertThreadMessage,
} from "../lib/queries";
import { serializeDoc, serializeTicket } from "../lib/serialize";
import { nowIso } from "../lib/time";
import { normalizePollSeconds, shouldKeepPolling } from "../lib/claim-policy";
import { isSqliteBusy } from "../lib/sqlite";
import { AtixError, EXIT } from "../lib/exit";

import type { Database } from "bun:sqlite";
import type { Ctx, Meta } from "../types";

interface OpenTicketRow {
  id: string;
}

interface ClaimedTicketRow {
  id: string;
  claimed_at: string;
  claim_token: string;
}

class ClaimInvariantError extends AtixError {
  constructor(id: string, changes: number) {
    super(
      "internal",
      `inbox invariant violated: conditional UPDATE for ticket '${id}' changed ${changes} rows (expected exactly 1)`,
      EXIT.FAIL,
    );
    this.name = "ClaimInvariantError";
  }
}

function parseWaitable(raw: string): number {
  return raw === "0" ? 0 : parseDuration(raw);
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

function tryClaimOnce(db: Database, channel: string, meta: Meta): ClaimedTicketRow | null {
  return withImmediateTx(db, () => {
    const candidate = db
      .query(
        "SELECT id FROM tickets WHERE channel = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1",
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
    return { id: candidate.id, claimed_at: claimedAt, claim_token: token };
  });
}

export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("inbox: database connection was not provided");
  if (flagBool(ctx.args, "notify")) throw new BadFlagError("inbox --notify is not supported yet");

  const channel = flagString(ctx.args, "from") ?? flagString(ctx.args, "watch");
  if (channel === undefined) throw new BadFlagError("inbox requires --from <channel>");

  const channelRow = findChannel(db, channel);
  if (channelRow === null) throw new UnknownChannelError(channel);

  const waitRaw = flagString(ctx.args, "wait");
  const waitSeconds = waitRaw === undefined ? null : parseWaitable(waitRaw);
  const pollRaw = flagString(ctx.args, "poll");
  const pollSeconds = normalizePollSeconds(pollRaw === undefined ? 1 : parseWaitable(pollRaw));
  const deadline = waitSeconds === null ? 0 : Date.now() + waitSeconds * 1000;

  let attempts = 0;
  for (;;) {
    attempts++;
    let claimed: ClaimedTicketRow | null;
    try {
      claimed = tryClaimOnce(db, channel, ctx.meta);
    } catch (err) {
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

function emitSuccess(ctx: Ctx, channel: string, claimed: ClaimedTicketRow): number {
  const db = ctx.db;
  if (db === null) throw new Error("inbox: database connection was not provided");
  const row = fetchTicket(db, claimed.id);
  if (row === null) throw new Error(`inbox: claimed ticket '${claimed.id}' disappeared`);

  const group = fetchAskGroupForTicket(db, claimed.id);
  const ticket = serializeTicket(row, { docs: fetchDocsForTicket(db, claimed.id) });
  if (group !== null) {
    ticket.ask_group = {
      id: group.id,
      title: group.title,
      body: group.body,
      docs: fetchDocsForAskGroup(db, group.id).map(serializeDoc),
    };
  }

  if (ctx.json) {
    printJson({
      ok: true,
      type: "inbox_item",
      ticket,
      receipt: claimed.claim_token,
      claimed_at: claimed.claimed_at,
    });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  printLine(`${statusIcon("claimed")} received ${colorize(mode, "cyan", claimed.id)} <- ${channel}`);
  printLine(`receipt: ${claimed.claim_token}`);
  printLine(`done:    atix done ${claimed.id} --receipt ${claimed.claim_token}`);
  return EXIT.OK;
}

function emitEmpty(ctx: Ctx, channel: string): number {
  if (ctx.json) {
    printJson({ ok: false, type: "empty", empty: true, timeout: false, channel });
  }
  return EXIT.OK;
}
