import { withImmediateTx } from "../db/connection";
import { flagString, flagBool } from "../lib/args";
import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError, NotFoundError, ConflictError } from "../lib/errors";

import type { Database } from "bun:sqlite";
import type { Ctx } from "../types";

interface TicketRow {
  id: string;
  status: string;
  claim_token: string | null;
}

/**
 * Return a claimed ticket to the open queue. Two paths:
 *  --token TOK : owner releasing; token must match a claimed ticket.
 *  --force     : orphan cleanup; bypasses token (warns in human mode).
 * Either way the ticket reverts to a clean open row (all claim_* nulled).
 */
function reopen(db: Database, id: string): void {
  db.query(
    `UPDATE tickets
       SET status = 'open',
           claimed_at = NULL,
           claim_token = NULL,
           claimer_agent = NULL,
           claimer_project = NULL,
           claimer_cwd = NULL,
           claimer_session = NULL,
           claimer_pid = NULL
     WHERE id = ?`,
  ).run(id);
}

export function run(ctx: Ctx): number {
  const db = ctx.db;
  if (db === null) throw new Error("release: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new BadFlagError("release requires a ticket ID");

  const force = flagBool(ctx.args, "force");
  const token = flagString(ctx.args, "token");

  if (!force && token === undefined) {
    throw new BadFlagError("release requires --token <token> or --force");
  }

  return withImmediateTx(db, () => {
    const row = db
      .query("SELECT id, status, claim_token FROM tickets WHERE id = ?")
      .get(id) as TicketRow | null;
    if (row === null) throw new NotFoundError(`ticket '${id}' not found`);

    if (force) {
      if (row.status !== "claimed") {
        throw new ConflictError(`ticket '${id}' is not claimed (status: ${row.status})`);
      }
      reopen(db, id);
      return emit(ctx, id, true);
    }

    // Token path.
    if (row.status !== "claimed" || row.claim_token !== token) {
      throw new ConflictError(`ticket '${id}': wrong token or not claimed`);
    }
    reopen(db, id);
    return emit(ctx, id, false);
  });
}

function emit(ctx: Ctx, id: string, forced: boolean): number {
  if (ctx.json) {
    printJson({ ok: true, id, status: "open", forced });
    return EXIT.OK;
  }
  const mode = resolveOutputMode(false);
  if (forced) {
    printLine(colorize(mode, "yellow", `warning: force-released ${id} (token bypassed)`));
  }
  printLine(`released ${colorize(mode, "cyan", id)} → open`);
  return EXIT.OK;
}
