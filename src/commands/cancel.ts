import { withImmediateTx } from "../db/connection";
import { flagString } from "../lib/args";
import { nowIso } from "../lib/time";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError, NotFoundError, ConflictError } from "../lib/errors";
import { authorRole } from "../lib/author";
import { insertReply } from "../lib/queries";

import type { Ctx } from "../types";

interface TicketRow {
  id: string;
  status: string;
  producer_agent: string | null;
  producer_session: string | null;
  claimer_agent: string | null;
  claimer_session: string | null;
}

/**
 * Producer/human cancel. Force-cancels open OR claimed tickets (a claimed
 * ticket racing a `done` may lose — see done.ts salvage). Already-closed
 * tickets conflict. A `--reason`, if given, is saved as a final reply.
 */
export function run(ctx: Ctx): number {
  const db = ctx.db;
  if (db === null) throw new Error("cancel: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new BadFlagError("cancel requires a ticket ID");

  const reason = flagString(ctx.args, "reason");

  return withImmediateTx(db, () => {
    const closedAt = nowIso();
    const res = db
      .query(
        "UPDATE tickets SET status = 'canceled', closed_at = ? WHERE id = ? AND status IN ('open','claimed')",
      )
      .run(closedAt, id);

    if (res.changes === 1) {
      if (reason !== undefined && reason.length > 0) {
        const row = db
          .query(
            "SELECT id, status, producer_agent, producer_session, claimer_agent, claimer_session FROM tickets WHERE id = ?",
          )
          .get(id) as TicketRow;
        insertReply(db, {
          ticketId: id,
          meta: ctx.meta,
          role: authorRole(ctx.meta, row),
          isFinal: true,
          body: reason,
        });
      }
      return emit(ctx, id);
    }

    const row = db.query("SELECT id, status FROM tickets WHERE id = ?").get(id) as TicketRow | null;
    if (row === null) throw new NotFoundError(`ticket '${id}' not found`);
    throw new ConflictError(`ticket '${id}' already closed`);
  });
}

function emit(ctx: Ctx, id: string): number {
  if (ctx.json) {
    printJson({ ok: true, id, status: "canceled" });
    return EXIT.OK;
  }
  const mode = resolveOutputMode(false);
  printLine(`${statusIcon("canceled")} canceled ${colorize(mode, "cyan", id)}`);
  return EXIT.OK;
}
