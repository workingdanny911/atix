import { flagBool } from "../lib/args";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { NotFoundError } from "../lib/errors";
import { EXIT } from "../lib/exit";
import { fetchTicket, fetchReplies } from "../lib/queries";
import { serializeTicket } from "../lib/serialize";

import type { Ctx } from "../types";

const BODY_TRUNCATE = 200;

/**
 * Render a single ticket. JSON emits the canonical object (replies key present
 * only with --with-replies). Human mode shows header + metadata + reply timeline.
 */
export function run(ctx: Ctx): number {
  const db = ctx.db;
  if (db === null) throw new Error("show: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new NotFoundError("show requires a ticket ID");

  const row = fetchTicket(db, id);
  if (row === null) throw new NotFoundError(`ticket '${id}' not found`);

  const withReplies = flagBool(ctx.args, "with-replies");
  const showFullBody = flagBool(ctx.args, "full");

  if (ctx.json) {
    const replies = withReplies ? fetchReplies(db, id) : undefined;
    printJson({ ok: true, ...serializeTicket(row, { replies }) });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  const dim = (s: string) => colorize(mode, "dim", s);

  printLine(`${statusIcon(row.status)} ${colorize(mode, "cyan", row.id)} ${row.title}`);
  printLine(`${dim("channel:")} ${row.channel}   ${dim("status:")} ${row.status}`);
  printLine(`${dim("from:   ")} ${row.producer_agent ?? "-"} (${row.producer_project ?? "-"})`);
  printLine(`${dim("created:")} ${row.created_at}`);
  if (row.claimed_at !== null) {
    printLine(`${dim("claimed:")} ${row.claimed_at} by ${row.claimer_agent ?? "-"}`);
  }
  if (row.closed_at !== null) {
    printLine(`${dim("closed: ")} ${row.closed_at}`);
  }

  const body =
    showFullBody || row.body.length <= BODY_TRUNCATE
      ? row.body
      : `${row.body.slice(0, BODY_TRUNCATE)}…`;
  if (body.length > 0) {
    printLine("");
    printLine(body);
  }

  if (withReplies) {
    const replies = fetchReplies(db, id);
    printLine("");
    printLine(dim(`replies (${replies.length}):`));
    for (const reply of replies) {
      const finalMark = reply.is_final === 1 ? " [final]" : "";
      printLine(
        `  ${dim(reply.created_at)} ${reply.author_role}/${reply.author_agent ?? "-"}${finalMark}: ${reply.body}`,
      );
    }
  }

  return EXIT.OK;
}
