import { withImmediateTx } from "../db/connection";
import { resolveBody } from "../lib/body";
import { resolveDocs } from "../lib/docs";
import { flagString } from "../lib/args";
import { nowIso } from "../lib/time";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError, NotFoundError, ConflictError } from "../lib/errors";
import { fetchDocsForReply, fetchReply, fetchTicket, insertDoc, insertReply } from "../lib/queries";
import { serializeReply, serializeTicket } from "../lib/serialize";

import type { Ctx } from "../types";

interface TicketRow {
  id: string;
  status: string;
  claim_token: string | null;
}

interface FinalReplyInput {
  body: string;
  docs: Awaited<ReturnType<typeof resolveDocs>>;
  shouldInsert: boolean;
}

/**
 * Resolve the final reply for a successful done. --body wins; otherwise
 * --reason becomes the body. Docs can stand alone with an empty body.
 */
async function resolveFinalReply(ctx: Ctx): Promise<FinalReplyInput> {
  if (ctx.args.flags["body-stdin"] === true && typeof ctx.args.flags["doc-stdin"] === "string") {
    throw new BadFlagError("done cannot read both --body-stdin and --doc-stdin");
  }

  const docs = await resolveDocs(ctx.args);
  const hasBodyFlag =
    typeof ctx.args.flags["body"] === "string" ||
    typeof ctx.args.flags["body-file"] === "string" ||
    ctx.args.flags["body-stdin"] === true;

  let body = "";
  if (hasBodyFlag) {
    const { text } = await resolveBody({ args: ctx.args, allowEmpty: true });
    body = text;
    // Empty body but reason present → fall through to reason.
  }
  if (body.length === 0) {
    const reason = flagString(ctx.args, "reason");
    if (reason !== undefined && reason.length > 0) body = reason;
  }

  return { body, docs, shouldInsert: body.length > 0 || docs.length > 0 };
}

export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("done: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new BadFlagError("done requires a ticket ID");
  const token = flagString(ctx.args, "token") ?? flagString(ctx.args, "receipt");
  if (token === undefined) throw new BadFlagError("done requires --receipt <receipt> (or --token <token>)");

  // Resolve the body outside the tx (may read stdin/file); we still need it for
  // both the success-final-reply and the canceled-salvage paths.
  const finalReply = await resolveFinalReply(ctx);

  // The close itself runs in a tx; the salvage reply (Patch 4c) must NOT share
  // it, since salvage commits the reply but still reports conflict. We compute
  // the outcome here, then act on it after the tx closes.
  type Outcome =
    | { kind: "done"; replyId: string | null }
    | { kind: "salvage"; body: string; docs: FinalReplyInput["docs"] }
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
      if (finalReply.shouldInsert) {
        const replyId = insertReply(db, {
          ticketId: id,
          meta: ctx.meta,
          role: "claimer",
          isFinal: true,
          body: finalReply.body,
        });
        for (const doc of finalReply.docs) {
          insertDoc(db, { ownerKind: "reply", ownerId: replyId, ...doc });
        }
        return { kind: "done", replyId };
      }
      return { kind: "done", replyId: null };
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
      if (finalReply.shouldInsert) {
        return { kind: "salvage", body: finalReply.body, docs: finalReply.docs };
      }
      return { kind: "conflict", message: `ticket '${id}' was canceled` };
    }
    if (row.status === "done") {
      return { kind: "conflict", message: `ticket '${id}' already closed` };
    }
    // Still claimed (or open) but token mismatch.
    return { kind: "conflict", message: `ticket '${id}': wrong token` };
  });

  if (outcome.kind === "done") return emitSuccess(ctx, id, outcome.replyId);
  if (outcome.kind === "not_found") throw new NotFoundError(`ticket '${id}' not found`);
  if (outcome.kind === "conflict") throw new ConflictError(outcome.message);

  // salvage: persist the preserved reply in its own committed tx, then conflict.
  withImmediateTx(db, () => {
    const replyId = insertReply(db, {
      ticketId: id,
      meta: ctx.meta,
      role: "claimer",
      isFinal: false,
      body: outcome.body,
    });
    for (const doc of outcome.docs) {
      insertDoc(db, { ownerKind: "reply", ownerId: replyId, ...doc });
    }
  });
  throw new ConflictError("ticket was canceled — your --body preserved as reply");
}

function emitSuccess(ctx: Ctx, id: string, replyId: string | null): number {
  const db = ctx.db;
  if (db === null) throw new Error("done: database connection was not provided");
  const ticketRow = fetchTicket(db, id);
  if (ticketRow === null) throw new Error(`done: closed ticket '${id}' disappeared`);

  if (ctx.json) {
    const payload: Record<string, unknown> = {
      ok: true,
      id,
      status: "done",
      ticket: serializeTicket(ticketRow),
    };
    if (replyId !== null) {
      const reply = fetchReply(db, replyId);
      if (reply === null) throw new Error(`done: inserted reply '${replyId}' disappeared`);
      payload.reply = serializeReply(reply, { docs: fetchDocsForReply(db, replyId) });
    }
    printJson(payload);
    return EXIT.OK;
  }
  const mode = resolveOutputMode(false);
  printLine(`${statusIcon("done")} done ${colorize(mode, "cyan", id)}`);
  return EXIT.OK;
}
