import { withImmediateTx } from "../db/connection";
import { BadFlagError, ConflictError, NotFoundError } from "../lib/errors";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import {
  fetchAskGroupForTicket,
  fetchDocsForAskGroup,
  fetchDocsForTicket,
  fetchTicket,
  insertThreadMessage,
} from "../lib/queries";
import { serializeDoc, serializeTicket } from "../lib/serialize";
import { nowIso } from "../lib/time";
import { AtixError, EXIT } from "../lib/exit";

import type { Ctx, Meta } from "../types";

interface TicketClaimRow {
  id: string;
  status: string;
  claimer_agent: string | null;
  claimer_session: string | null;
  claimed_at: string | null;
  claim_token: string | null;
}

interface TakenTicket {
  id: string;
  claimed_at: string;
  receipt: string;
}

class TakeInvariantError extends AtixError {
  constructor(id: string, changes: number) {
    super(
      "internal",
      `take invariant violated: conditional UPDATE for ticket '${id}' changed ${changes} rows (expected exactly 1)`,
      EXIT.FAIL,
    );
    this.name = "TakeInvariantError";
  }
}

function sameActor(meta: Meta, row: TicketClaimRow): boolean {
  return meta.agent === row.claimer_agent && meta.session === row.claimer_session;
}

function appendClaimedMessages(ctx: Ctx, ticketId: string, claimedAt: string): void {
  const db = ctx.db;
  if (db === null) throw new Error("take: database connection was not provided");

  const ticketMessage = insertThreadMessage(db, {
    rootKind: "ticket",
    rootId: ticketId,
    kind: "claimed",
    actorKind: ctx.meta.kind,
    actorRole: "claimer",
    actorAgent: ctx.meta.agent,
    actorProject: ctx.meta.project,
    actorCwd: ctx.meta.cwd,
    actorSession: ctx.meta.session,
    actorPid: ctx.meta.pid,
    ticketId,
    createdAt: claimedAt,
  });

  const group = fetchAskGroupForTicket(db, ticketId);
  if (group === null) return;

  insertThreadMessage(db, {
    rootKind: "ask_group",
    rootId: group.id,
    kind: "claimed",
    actorKind: ctx.meta.kind,
    actorRole: "claimer",
    actorAgent: ctx.meta.agent,
    actorProject: ctx.meta.project,
    actorCwd: ctx.meta.cwd,
    actorSession: ctx.meta.session,
    actorPid: ctx.meta.pid,
    ticketId,
    causedByMessageId: ticketMessage.id,
    createdAt: claimedAt,
  });
}

export function run(ctx: Ctx): number {
  const db = ctx.db;
  if (db === null) throw new Error("take: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new BadFlagError("take requires a ticket ID");

  const taken = withImmediateTx<TakenTicket>(db, () => {
    const row = db
      .query(
        `SELECT id, status, claimer_agent, claimer_session, claimed_at, claim_token
           FROM tickets WHERE id = ?`,
      )
      .get(id) as TicketClaimRow | null;

    if (row === null) throw new NotFoundError(`ticket '${id}' not found`);

    if (row.status === "claimed") {
      if (sameActor(ctx.meta, row) && row.claimed_at !== null && row.claim_token !== null) {
        return { id, claimed_at: row.claimed_at, receipt: row.claim_token };
      }
      throw new ConflictError(`ticket '${id}' already claimed`);
    }
    if (row.status === "done" || row.status === "canceled") {
      throw new ConflictError(`ticket '${id}' already closed`);
    }

    const claimedAt = nowIso();
    const receipt = crypto.randomUUID();
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
        receipt,
        ctx.meta.agent,
        ctx.meta.project,
        ctx.meta.cwd,
        ctx.meta.session,
        ctx.meta.pid,
        id,
      );

    if (res.changes !== 1) throw new TakeInvariantError(id, res.changes);
    appendClaimedMessages(ctx, id, claimedAt);
    return { id, claimed_at: claimedAt, receipt };
  });

  return emitSuccess(ctx, taken);
}

function emitSuccess(ctx: Ctx, taken: TakenTicket): number {
  const db = ctx.db;
  if (db === null) throw new Error("take: database connection was not provided");

  const row = fetchTicket(db, taken.id);
  if (row === null) throw new Error(`take: claimed ticket '${taken.id}' disappeared`);

  const ticket = serializeTicket(row, { docs: fetchDocsForTicket(db, taken.id) });
  const group = fetchAskGroupForTicket(db, taken.id);
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
      type: "take_item",
      ticket,
      receipt: taken.receipt,
      claimed_at: taken.claimed_at,
    });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  printLine(`${statusIcon("claimed")} took ${colorize(mode, "cyan", taken.id)}`);
  printLine(`receipt: ${taken.receipt}`);
  printLine(`done:    atix done ${taken.id} --receipt ${taken.receipt}`);
  return EXIT.OK;
}
