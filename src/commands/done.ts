import { withImmediateTx } from "../db/connection";
import { resolveBody } from "../lib/body";
import { flagString } from "../lib/args";
import { nowIso } from "../lib/time";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError, NotFoundError, ConflictError } from "../lib/errors";
import { insertReply } from "../lib/queries";

import type { Ctx } from "../types";

interface TicketRow {
  id: string;
  status: string;
  claim_token: string | null;
}

/**
 * Resolve the final-reply body for a successful done. --body wins; otherwise
 * --reason becomes the body. Returns null when neither is present (no reply).
 */
async function resolveFinalBody(ctx: Ctx): Promise<string | null> {
  const hasBodyFlag =
    typeof ctx.args.flags["body"] === "string" ||
    typeof ctx.args.flags["body-file"] === "string" ||
    ctx.args.flags["body-stdin"] === true;

  if (hasBodyFlag) {
    const { text } = await resolveBody({ args: ctx.args, allowEmpty: true });
    if (text.length > 0) return text;
    // Empty body but reason present → fall through to reason.
  }
  const reason = flagString(ctx.args, "reason");
  if (reason !== undefined && reason.length > 0) return reason;
  return null;
}

export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("done: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new BadFlagError("done requires a ticket ID");
  const token = flagString(ctx.args, "token");
  if (token === undefined) throw new BadFlagError("done requires --token <token>");

  // Resolve the body outside the tx (may read stdin/file); we still need it for
  // both the success-final-reply and the canceled-salvage paths.
  const finalBody = await resolveFinalBody(ctx);

  // The close itself runs in a tx; the salvage reply (Patch 4c) must NOT share
  // it, since salvage commits the reply but still reports conflict. We compute
  // the outcome here, then act on it after the tx closes.
  type Outcome =
    | { kind: "done" }
    | { kind: "salvage"; body: string }
    | { kind: "conflict"; message: string }
    | { kind: "not_found" };

  const outcome = withImmediateTx<Outcome>(db, () => {
    const closedAt = nowIso();
    const res = db
      .query(
        "UPDATE tickets SET status = 'done', closed_at = ? WHERE id = ? AND claim_token = ? AND status = 'claimed'",
      )
      .run(closedAt, id, token);

    if (res.changes === 1) {
      if (finalBody !== null) {
        insertReply(db, { ticketId: id, meta: ctx.meta, role: "claimer", isFinal: true, body: finalBody });
      }
      return { kind: "done" };
    }

    // changes === 0 → diagnose.
    const row = db
      .query("SELECT id, status, claim_token FROM tickets WHERE id = ?")
      .get(id) as TicketRow | null;
    if (row === null) return { kind: "not_found" };

    if (row.status === "canceled") {
      // Patch 4c salvage: lost a cancel race. Only the legitimate claimer (token
      // match) may salvage — otherwise a forged/stale token could plant a
      // claimer reply on a canceled ticket. Token mismatch is a wrong-token
      // conflict, never a salvage.
      if (row.claim_token !== token) {
        return { kind: "conflict", message: `ticket '${id}': wrong token` };
      }
      // Preserve the worker's --body as a non-final reply (committed below) so
      // the effort isn't dropped.
      if (finalBody !== null) return { kind: "salvage", body: finalBody };
      return { kind: "conflict", message: `ticket '${id}' was canceled` };
    }
    if (row.status === "done") {
      return { kind: "conflict", message: `ticket '${id}' already closed` };
    }
    // Still claimed (or open) but token mismatch.
    return { kind: "conflict", message: `ticket '${id}': wrong token` };
  });

  if (outcome.kind === "done") return emitSuccess(ctx, id);
  if (outcome.kind === "not_found") throw new NotFoundError(`ticket '${id}' not found`);
  if (outcome.kind === "conflict") throw new ConflictError(outcome.message);

  // salvage: persist the preserved reply in its own committed tx, then conflict.
  withImmediateTx(db, () => {
    insertReply(db, { ticketId: id, meta: ctx.meta, role: "claimer", isFinal: false, body: outcome.body });
  });
  throw new ConflictError("ticket was canceled — your --body preserved as reply");
}

function emitSuccess(ctx: Ctx, id: string): number {
  if (ctx.json) {
    printJson({ ok: true, id, status: "done" });
    return EXIT.OK;
  }
  const mode = resolveOutputMode(false);
  printLine(`${statusIcon("done")} done ${colorize(mode, "cyan", id)}`);
  return EXIT.OK;
}
