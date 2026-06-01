import { flagBool, flagString } from "../lib/args";
import { parseWaitDuration } from "../lib/duration";
import { BadFlagError, NotFoundError } from "../lib/errors";
import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import { fetchAskGroup, fetchThreadMessages, fetchTicket } from "../lib/queries";
import { serializeThreadMessage } from "../lib/serialize";
import { EXIT } from "../lib/exit";

import type { Ctx } from "../types";
import type { ThreadMessageWithDocs } from "../lib/queries";
import type { ThreadRootKind } from "../lib/serialize";

interface ResolvedThread {
  rootKind: ThreadRootKind;
  rootId: string;
}

interface ThreadDelta {
  messages: ThreadMessageWithDocs[];
  timeout: boolean;
}

function parseCursor(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new BadFlagError(`invalid --after '${raw}'. Use a non-negative integer cursor`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new BadFlagError(`invalid --after '${raw}'. Cursor is too large`);
  }
  return value;
}

function resolveThread(ctx: Ctx, id: string): ResolvedThread {
  const db = ctx.db;
  if (db === null) throw new Error("thread: database connection was not provided");

  if (fetchAskGroup(db, id) !== null) return { rootKind: "ask_group", rootId: id };
  if (fetchTicket(db, id) !== null) return { rootKind: "ticket", rootId: id };
  throw new NotFoundError(`thread root '${id}' not found`);
}

function readDelta(ctx: Ctx, thread: ResolvedThread, afterSeq: number): ThreadMessageWithDocs[] {
  const db = ctx.db;
  if (db === null) throw new Error("thread: database connection was not provided");
  return fetchThreadMessages(db, thread.rootKind, thread.rootId, afterSeq, flagBool(ctx.args, "with-docs"));
}

async function waitForDelta(
  ctx: Ctx,
  thread: ResolvedThread,
  afterSeq: number,
  waitSeconds: number | null,
): Promise<ThreadDelta> {
  const first = readDelta(ctx, thread, afterSeq);
  if (first.length > 0 || waitSeconds === null) return { messages: first, timeout: false };

  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    if (Date.now() >= deadline) return { messages: [], timeout: true };
    await Bun.sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
    const messages = readDelta(ctx, thread, afterSeq);
    if (messages.length > 0) return { messages, timeout: false };
  }
}

export async function run(ctx: Ctx): Promise<number> {
  const id = ctx.args.positionals[0];
  if (id === undefined) throw new BadFlagError("thread requires a root ID");

  const afterFlag = ctx.args.flags["after"];
  if (afterFlag !== undefined && typeof afterFlag !== "string") {
    throw new BadFlagError("thread --after requires a cursor");
  }
  const cursor = flagString(ctx.args, "after") ?? "0";
  const afterSeq = parseCursor(cursor);
  const waitRaw = flagString(ctx.args, "wait");
  const waitSeconds = waitRaw === undefined ? null : parseWaitDuration(waitRaw);
  const thread = resolveThread(ctx, id);
  const delta = await waitForDelta(ctx, thread, afterSeq, waitSeconds);
  const nextCursor =
    delta.messages.length === 0 ? cursor : String(delta.messages[delta.messages.length - 1]!.seq);

  if (ctx.json) {
    printJson({
      ok: true,
      type: "thread_delta",
      thread: { root_kind: thread.rootKind, root_id: thread.rootId },
      cursor,
      next_cursor: nextCursor,
      messages: delta.messages.map((message) =>
        serializeThreadMessage(message, { docs: flagBool(ctx.args, "with-docs") ? message.docs : undefined }),
      ),
      timeout: delta.timeout,
    });
    return EXIT.OK;
  }

  emitHuman(thread, cursor, nextCursor, delta);
  return EXIT.OK;
}

function emitHuman(
  thread: ResolvedThread,
  cursor: string,
  nextCursor: string,
  delta: ThreadDelta,
): void {
  const mode = resolveOutputMode(false);
  if (delta.messages.length === 0) {
    const label = delta.timeout ? "timeout" : "no new messages";
    printLine(`${label}: ${thread.rootKind} ${thread.rootId} after ${cursor}`);
    return;
  }

  for (const message of delta.messages) {
    const actor = message.actor_agent ?? message.actor_kind;
    const ticket = message.ticket_id === null ? "" : ` ticket=${message.ticket_id}`;
    const body = message.body.length === 0 ? "" : ` ${message.body}`;
    printLine(
      `${colorize(mode, "cyan", String(message.seq))} ${message.created_at} ${message.kind}${ticket} ${actor}:${body}`,
    );
  }
  printLine(`next: atix thread ${thread.rootId} --after ${nextCursor}`);
}
