import { resolveBody } from "../lib/body";
import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError, NotFoundError } from "../lib/errors";
import { authorRole } from "../lib/author";
import { insertReply } from "../lib/queries";

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
 * final reply. Empty body is rejected (resolveBody without allowEmpty + DDL
 * CHECK length>0).
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

  const { text } = await resolveBody({ args: ctx.args });
  // reply forbids an empty body (the DDL also enforces length>0); validate at
  // the boundary so callers get the standard envelope, not a raw constraint error.
  if (text.length === 0) throw new BadFlagError("reply requires a non-empty body");

  const role = authorRole(ctx.meta, row);
  const replyId = insertReply(db, {
    ticketId: id,
    meta: ctx.meta,
    role,
    isFinal: false,
    body: text,
  });

  if (ctx.json) {
    printJson({ ok: true, id: replyId, ticket_id: id, is_final: 0 });
    return EXIT.OK;
  }
  const mode = resolveOutputMode(false);
  printLine(`replied ${colorize(mode, "cyan", replyId)} → ${id} (${role})`);
  return EXIT.OK;
}
