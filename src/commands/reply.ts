import { withImmediateTx } from "../db/connection";
import { resolveBody } from "../lib/body";
import { resolveDocs } from "../lib/docs";
import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError, NotFoundError } from "../lib/errors";
import { authorRole } from "../lib/author";
import { fetchDocsForReply, fetchReply, insertDoc, insertReply } from "../lib/queries";
import { serializeReply } from "../lib/serialize";

import type { Ctx } from "../types";

interface TicketRow {
  id: string;
  producer_agent: string | null;
  producer_session: string | null;
  claimer_agent: string | null;
  claimer_session: string | null;
}

/**
 * Append a reply to any ticket (no token, anyone) — including closed tickets
 * (Patch 4a). Replies are always non-final (is_final=0); only `done` writes a
 * final reply. A reply needs either a non-empty body or at least one doc; docs
 * allow an empty body because the attachment is the content.
 */
export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("reply: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new BadFlagError("reply requires a ticket ID");

  const row = db
    .query(
      "SELECT id, producer_agent, producer_session, claimer_agent, claimer_session FROM tickets WHERE id = ?",
    )
    .get(id) as TicketRow | null;
  if (row === null) throw new NotFoundError(`ticket '${id}' not found`);

  if (ctx.args.flags["body-stdin"] === true && typeof ctx.args.flags["doc-stdin"] === "string") {
    throw new BadFlagError("reply cannot read both --body-stdin and --doc-stdin");
  }

  const docs = await resolveDocs(ctx.args);
  const hasBodyFlag =
    typeof ctx.args.flags["body"] === "string" ||
    typeof ctx.args.flags["body-file"] === "string" ||
    ctx.args.flags["body-stdin"] === true;
  const text = hasBodyFlag ? (await resolveBody({ args: ctx.args, allowEmpty: true })).text : "";
  if (text.length === 0 && docs.length === 0) {
    throw new BadFlagError("reply requires a non-empty body or at least one doc");
  }

  const role = authorRole(ctx.meta, row);
  const replyId = withImmediateTx(db, () => {
    const inserted = insertReply(db, {
      ticketId: id,
      meta: ctx.meta,
      role,
      isFinal: false,
      body: text,
    });
    for (const doc of docs) {
      insertDoc(db, { ownerKind: "reply", ownerId: inserted, ...doc });
    }
    return inserted;
  });
  const reply = fetchReply(db, replyId);
  if (reply === null) throw new Error(`reply: inserted reply '${replyId}' disappeared`);

  if (ctx.json) {
    const replyObj = serializeReply(reply, { docs: fetchDocsForReply(db, replyId) });
    printJson({ ok: true, id: replyId, ticket_id: id, is_final: 0, reply: replyObj });
    return EXIT.OK;
  }
  const mode = resolveOutputMode(false);
  printLine(`replied ${colorize(mode, "cyan", replyId)} → ${id} (${role})`);
  return EXIT.OK;
}
