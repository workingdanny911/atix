import { withImmediateTx } from "../db/connection";
import { flagBool, flagString } from "../lib/args";
import { resolveBody } from "../lib/body";
import { parseWaitDuration } from "../lib/duration";
import { resolveDocs } from "../lib/docs";
import { BadFlagError, UnknownChannelError } from "../lib/errors";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import {
  findChannel,
  fetchDocsForTicket,
  fetchTicket,
  insertDoc,
  insertThreadMessage,
} from "../lib/queries";
import { serializeTicket } from "../lib/serialize";
import { nowIso } from "../lib/time";
import { validateTitle } from "../lib/title";
import { ulid } from "../lib/ulid";
import { AtixError, EXIT } from "../lib/exit";

import type { Ctx } from "../types";

class ChannelArchivedError extends AtixError {
  constructor(channel: string) {
    super("channel_archived", `channel '${channel}' is archived`, EXIT.INPUT);
    this.name = "ChannelArchivedError";
  }
}

function commands(id: string, channel: string): Record<string, string> {
  return {
    read: `atix thread ${id} --with-docs`,
    snapshot: `atix show ${id} --with-docs`,
    receive: `atix inbox --from ${channel}`,
    wait: `atix show ${id} --wait 30m`,
    done: `atix done ${id} --receipt <receipt>`,
  };
}

function isClosed(status: string): boolean {
  return status === "done" || status === "canceled";
}

async function waitUntilClosed(ctx: Ctx, id: string, waitSeconds: number): Promise<boolean> {
  const db = ctx.db;
  if (db === null) throw new Error("send: database connection was not provided");

  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const row = fetchTicket(db, id);
    if (row !== null && isClosed(row.status)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
}

function emitTicket(ctx: Ctx, id: string, channel: string, ok: boolean): number {
  const db = ctx.db;
  if (db === null) throw new Error("send: database connection was not provided");
  const row = fetchTicket(db, id);
  if (row === null) throw new Error(`send: inserted ticket '${id}' disappeared`);
  const docs = fetchDocsForTicket(db, id);
  const ticket = serializeTicket(row, { docs });
  const usefulCommands = commands(id, channel);

  if (ctx.json) {
    printJson({ ok, type: ok ? "ticket" : "timeout", timeout: !ok, ticket, commands: usefulCommands });
    return ok ? EXIT.OK : EXIT.TIMEOUT;
  }

  const mode = resolveOutputMode(false);
  if (ok) {
    printLine(`${statusIcon(row.status)} sent ${colorize(mode, "cyan", id)} -> ${channel}`);
  } else {
    process.stderr.write(`timeout: ticket '${id}' still pending (status=${row.status})\n`);
  }
  printLine(`read:    ${usefulCommands.read}`);
  printLine(`receive: ${usefulCommands.receive}`);
  printLine(`wait:    ${usefulCommands.wait}`);
  return ok ? EXIT.OK : EXIT.TIMEOUT;
}

export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("send: database connection was not provided");
  if (flagBool(ctx.args, "notify")) {
    throw new BadFlagError("send --notify is not supported yet");
  }

  const channel = flagString(ctx.args, "to");
  if (channel === undefined) throw new BadFlagError("send requires --to <channel>");
  const title = flagString(ctx.args, "title");
  if (title === undefined) throw new BadFlagError("send requires --title <title>");
  validateTitle(title);

  const { text } = await resolveBody({ args: ctx.args, allowEmpty: true });
  const docs = await resolveDocs(ctx.args);
  const id = ulid();
  const createdAt = nowIso();
  const { meta } = ctx;

  withImmediateTx(db, () => {
    const channelRow = findChannel(db, channel);
    if (channelRow === null) throw new UnknownChannelError(channel);
    if (channelRow.archived_at !== null) throw new ChannelArchivedError(channel);

    db.query(
      `INSERT INTO tickets
         (id, channel, status, title, body,
          producer_kind, producer_agent, producer_project, producer_cwd, producer_session, producer_pid,
          created_at)
       VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      channel,
      title,
      text,
      meta.kind,
      meta.agent,
      meta.project,
      meta.cwd,
      meta.session,
      meta.pid,
      createdAt,
    );

    const opened = insertThreadMessage(db, {
      rootKind: "ticket",
      rootId: id,
      kind: "opened",
      body: text,
      actorKind: meta.kind,
      actorRole: "producer",
      actorAgent: meta.agent,
      actorProject: meta.project,
      actorCwd: meta.cwd,
      actorSession: meta.session,
      actorPid: meta.pid,
      ticketId: id,
      createdAt,
    });

    for (const doc of docs) {
      insertDoc(db, { ownerKind: "ticket", ownerId: id, ...doc });
      insertDoc(db, { ownerKind: "message", ownerId: opened.id, ...doc });
    }
  });

  const waitRaw = flagString(ctx.args, "wait");
  if (waitRaw !== undefined) {
    const closed = await waitUntilClosed(ctx, id, parseWaitDuration(waitRaw));
    return emitTicket(ctx, id, channel, closed);
  }

  return emitTicket(ctx, id, channel, true);
}
