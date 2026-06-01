import { flagBool, flagString } from "../lib/args";
import { parseWaitDuration } from "../lib/duration";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { NotFoundError } from "../lib/errors";
import { EXIT } from "../lib/exit";
import {
  fetchAskGroup,
  fetchAskGroupForTicket,
  fetchAskGroupMembers,
  fetchDocsForAskGroup,
  fetchDocsForReply,
  fetchDocsForTicket,
  fetchReplies,
  fetchTicket,
} from "../lib/queries";
import { serializeDoc, serializeTicket } from "../lib/serialize";

import type { Ctx } from "../types";
import type { AskGroupRow } from "../lib/queries";
import type { ReplyRow, TicketRow } from "../lib/serialize";

const BODY_TRUNCATE = 200;

function closed(status: string): boolean {
  return status === "done" || status === "canceled";
}

function replyDocs(ctx: Ctx, replies: ReplyRow[]): Record<string, ReturnType<typeof fetchDocsForReply>> {
  const db = ctx.db;
  if (db === null) throw new Error("show: database connection was not provided");
  return Object.fromEntries(replies.map((reply) => [reply.id, fetchDocsForReply(db, reply.id)]));
}

function serializeTicketForShow(ctx: Ctx, row: TicketRow): Record<string, unknown> {
  const db = ctx.db;
  if (db === null) throw new Error("show: database connection was not provided");
  const withReplies = flagBool(ctx.args, "with-replies");
  const withDocs = flagBool(ctx.args, "with-docs");
  const replies = withReplies ? fetchReplies(db, row.id) : undefined;
  const ticket = serializeTicket(row, {
    replies,
    docs: withDocs ? fetchDocsForTicket(db, row.id) : undefined,
    replyDocs: withDocs && replies !== undefined ? replyDocs(ctx, replies) : undefined,
  });

  if (withDocs) {
    const group = fetchAskGroupForTicket(db, row.id);
    if (group !== null) {
      ticket.ask_group = {
        id: group.id,
        title: group.title,
        body: group.body,
        docs: fetchDocsForAskGroup(db, group.id).map(serializeDoc),
      };
    }
  }

  return ticket;
}

function serializeAskGroupForShow(ctx: Ctx, group: AskGroupRow): Record<string, unknown> {
  const db = ctx.db;
  if (db === null) throw new Error("show: database connection was not provided");
  const withDocs = flagBool(ctx.args, "with-docs");

  const members = fetchAskGroupMembers(db, group.id);
  const children = members.map((member) => {
    const row = fetchTicket(db, member.ticket_id);
    if (row === null) throw new Error(`show: child ticket '${member.ticket_id}' disappeared`);
    return {
      position: member.position,
      role: member.member_role,
      ticket: serializeTicketForShow(ctx, row),
    };
  });

  const counts = { total: children.length, open: 0, claimed: 0, done: 0, canceled: 0 };
  for (const child of children) {
    const ticket = child.ticket as { status: "open" | "claimed" | "done" | "canceled" };
    counts[ticket.status] += 1;
  }

  const obj: Record<string, unknown> = {
    id: group.id,
    title: group.title,
    body: group.body,
    producer: {
      kind: group.producer_kind,
      agent: group.producer_agent,
      project: group.producer_project,
      cwd: group.producer_cwd,
      session: group.producer_session,
      pid: group.producer_pid,
    },
    created_at: group.created_at,
    status: counts.done + counts.canceled === counts.total ? "closed" : "open",
    counts,
    children,
  };

  if (withDocs) {
    obj.docs = fetchDocsForAskGroup(db, group.id).map(serializeDoc);
  }

  return obj;
}

async function waitForId(ctx: Ctx, id: string, waitSeconds: number): Promise<boolean> {
  const db = ctx.db;
  if (db === null) throw new Error("show: database connection was not provided");
  const deadline = Date.now() + waitSeconds * 1000;

  for (;;) {
    const group = fetchAskGroup(db, id);
    if (group !== null) {
      const members = fetchAskGroupMembers(db, id);
      const allClosed = members.every((member) => {
        const row = fetchTicket(db, member.ticket_id);
        return row !== null && closed(row.status);
      });
      if (allClosed) return true;
    } else {
      const row = fetchTicket(db, id);
      if (row === null) throw new NotFoundError(`ticket or ask group '${id}' not found`);
      if (closed(row.status)) return true;
    }

    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Render a ticket or ask group. JSON emits a single object. Replies are included
 * only with --with-replies; docs are included only with --with-docs.
 */
export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("show: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new NotFoundError("show requires a ticket or ask group ID");

  const waitRaw = flagString(ctx.args, "wait");
  if (waitRaw !== undefined) {
    const satisfied = await waitForId(ctx, id, parseWaitDuration(waitRaw));
    if (!satisfied) return emitTimeout(ctx, id);
  }

  const group = fetchAskGroup(db, id);
  if (group !== null) return emitAskGroup(ctx, group);

  const row = fetchTicket(db, id);
  if (row === null) throw new NotFoundError(`ticket or ask group '${id}' not found`);
  return emitTicket(ctx, row);
}

function emitTicket(ctx: Ctx, row: TicketRow): number {
  if (ctx.json) {
    const ticket = serializeTicketForShow(ctx, row);
    printJson({ ok: true, type: "ticket", ticket });
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
    flagBool(ctx.args, "full") || row.body.length <= BODY_TRUNCATE
      ? row.body
      : `${row.body.slice(0, BODY_TRUNCATE)}…`;
  if (body.length > 0) {
    printLine("");
    printLine(body);
  }

  if (flagBool(ctx.args, "with-docs")) {
    const db = ctx.db;
    if (db === null) throw new Error("show: database connection was not provided");
    const docs = fetchDocsForTicket(db, row.id);
    if (docs.length > 0) {
      printLine("");
      printLine(dim(`docs (${docs.length}):`));
      for (const doc of docs) printLine(`  ${doc.title} (${doc.size_bytes} bytes)`);
    }
    const group = fetchAskGroupForTicket(db, row.id);
    if (group !== null) {
      const groupDocs = fetchDocsForAskGroup(db, group.id);
      if (groupDocs.length > 0) {
        printLine("");
        printLine(dim(`ask group docs (${groupDocs.length}):`));
        for (const doc of groupDocs) printLine(`  ${doc.title} (${doc.size_bytes} bytes)`);
      }
    }
  }

  if (flagBool(ctx.args, "with-replies")) {
    const db = ctx.db;
    if (db === null) throw new Error("show: database connection was not provided");
    const replies = fetchReplies(db, row.id);
    printLine("");
    printLine(dim(`replies (${replies.length}):`));
    for (const reply of replies) {
      const finalMark = reply.is_final === 1 ? " [final]" : "";
      printLine(
        `  ${dim(reply.created_at)} ${reply.author_role}/${reply.author_agent ?? "-"}${finalMark}: ${reply.body}`,
      );
      if (flagBool(ctx.args, "with-docs")) {
        const docs = fetchDocsForReply(db, reply.id);
        for (const doc of docs) {
          printLine(`    ${doc.title} (${doc.size_bytes} bytes)`);
        }
      }
    }
  }

  return EXIT.OK;
}

function emitAskGroup(ctx: Ctx, group: AskGroupRow): number {
  const askGroup = serializeAskGroupForShow(ctx, group);
  if (ctx.json) {
    printJson({ ok: true, type: "ask_group", ask_group: askGroup });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  const dim = (s: string) => colorize(mode, "dim", s);
  const counts = askGroup.counts as { total: number; open: number; claimed: number; done: number; canceled: number };
  printLine(`ask ${colorize(mode, "cyan", group.id)} ${group.title}`);
  printLine(
    `${dim("status:")} ${String(askGroup.status)}   ${dim("children:")} ${counts.total} ` +
      `(open ${counts.open}, claimed ${counts.claimed}, done ${counts.done}, canceled ${counts.canceled})`,
  );
  if (group.body.length > 0) {
    printLine("");
    printLine(group.body);
  }
  printLine("");
  printLine(dim("children:"));
  for (const child of askGroup.children as Array<{ position: number; ticket: { id: string; channel: string; status: string; title: string } }>) {
    printLine(`  ${child.position}. ${child.ticket.status} ${child.ticket.id} ${child.ticket.channel} - ${child.ticket.title}`);
  }
  return EXIT.OK;
}

function emitTimeout(ctx: Ctx, id: string): number {
  if (ctx.json) {
    printJson({ ok: false, type: "timeout", timeout: true, id });
  } else {
    process.stderr.write(`timeout: '${id}' still pending\n`);
  }
  return EXIT.TIMEOUT;
}
