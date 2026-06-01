import { withImmediateTx } from "../db/connection";
import { flagBool, flagString, flagStrings } from "../lib/args";
import { resolveBody } from "../lib/body";
import { parseWaitDuration } from "../lib/duration";
import { resolveDocs } from "../lib/docs";
import { BadFlagError, UnknownChannelError } from "../lib/errors";
import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import {
  fetchAskGroup,
  fetchAskGroupMembers,
  fetchDocsForAskGroup,
  fetchTicket,
  findChannel,
  insertDoc,
  insertThreadMessage,
} from "../lib/queries";
import { serializeDoc, serializeTicket } from "../lib/serialize";
import { nowIso } from "../lib/time";
import { validateTitle } from "../lib/title";
import { ulid } from "../lib/ulid";
import { AtixError, EXIT } from "../lib/exit";

import type { Ctx } from "../types";
import type { AskGroupRow } from "../lib/queries";

class ChannelArchivedError extends AtixError {
  constructor(channel: string) {
    super("channel_archived", `channel '${channel}' is archived`, EXIT.INPUT);
    this.name = "ChannelArchivedError";
  }
}

function parseChannels(args: Ctx["args"]): string[] {
  const channels = flagStrings(args, "to").flatMap((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
  if (channels.length === 0) throw new BadFlagError("ask requires --to <channel>");
  if (channels.length === 1) {
    throw new BadFlagError("ask requires at least 2 recipients; use send for one recipient");
  }
  return channels;
}

function commands(groupId: string, channels: string[]): Record<string, unknown> {
  return {
    read: `atix thread ${groupId} --with-docs`,
    snapshot: `atix show ${groupId} --with-docs`,
    receive: channels.map((channel) => `atix inbox --from ${channel}`),
    wait: `atix show ${groupId} --wait 30m`,
  };
}

function closed(status: string): boolean {
  return status === "done" || status === "canceled";
}

function serializeAskGroup(ctx: Ctx, group: AskGroupRow, withDocs: boolean): Record<string, unknown> {
  const db = ctx.db;
  if (db === null) throw new Error("ask: database connection was not provided");

  const members = fetchAskGroupMembers(db, group.id);
  const children = members.map((member) => {
    const ticket = fetchTicket(db, member.ticket_id);
    if (ticket === null) throw new Error(`ask: child ticket '${member.ticket_id}' disappeared`);
    return {
      position: member.position,
      role: member.member_role,
      ticket: serializeTicket(ticket),
    };
  });
  const counts = { total: children.length, open: 0, claimed: 0, done: 0, canceled: 0 };
  for (const child of children) {
    const ticket = child.ticket as { status: keyof typeof counts };
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

async function waitUntilAllClosed(ctx: Ctx, groupId: string, waitSeconds: number): Promise<boolean> {
  const db = ctx.db;
  if (db === null) throw new Error("ask: database connection was not provided");

  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const members = fetchAskGroupMembers(db, groupId);
    const done = members.every((member) => {
      const ticket = fetchTicket(db, member.ticket_id);
      return ticket !== null && closed(ticket.status);
    });
    if (done) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
  }
}

function emitGroup(ctx: Ctx, groupId: string, channels: string[], ok: boolean): number {
  const db = ctx.db;
  if (db === null) throw new Error("ask: database connection was not provided");
  const group = fetchAskGroup(db, groupId);
  if (group === null) throw new Error(`ask: inserted group '${groupId}' disappeared`);
  const askGroup = serializeAskGroup(ctx, group, true);
  const usefulCommands = commands(groupId, channels);

  if (ctx.json) {
    printJson({
      ok,
      type: ok ? "ask_group" : "timeout",
      timeout: !ok,
      ask_group: askGroup,
      commands: usefulCommands,
    });
    return ok ? EXIT.OK : EXIT.TIMEOUT;
  }

  const mode = resolveOutputMode(false);
  if (ok) {
    printLine(`asked ${colorize(mode, "cyan", groupId)} -> ${channels.join(", ")}`);
  } else {
    process.stderr.write(`timeout: ask group '${groupId}' still pending\n`);
  }
  printLine(`read:    ${String(usefulCommands.read)}`);
  for (const receive of usefulCommands.receive as string[]) {
    printLine(`receive: ${receive}`);
  }
  printLine(`wait:    ${String(usefulCommands.wait)}`);
  return ok ? EXIT.OK : EXIT.TIMEOUT;
}

export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("ask: database connection was not provided");
  if (flagBool(ctx.args, "notify")) throw new BadFlagError("ask --notify is not supported yet");

  const channels = parseChannels(ctx.args);
  const title = flagString(ctx.args, "title");
  if (title === undefined) throw new BadFlagError("ask requires --title <title>");
  validateTitle(title);

  const { text } = await resolveBody({ args: ctx.args, allowEmpty: true });
  const docs = await resolveDocs(ctx.args);
  const groupId = ulid();
  const createdAt = nowIso();
  const ticketIds = channels.map(() => ulid());
  const { meta } = ctx;

  withImmediateTx(db, () => {
    for (const channel of channels) {
      const channelRow = findChannel(db, channel);
      if (channelRow === null) throw new UnknownChannelError(channel);
      if (channelRow.archived_at !== null) throw new ChannelArchivedError(channel);
    }

    db.query(
      `INSERT INTO ask_groups
         (id, title, body,
          producer_kind, producer_agent, producer_project, producer_cwd, producer_session, producer_pid,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      groupId,
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

    const groupOpened = insertThreadMessage(db, {
      rootKind: "ask_group",
      rootId: groupId,
      kind: "opened",
      body: text,
      actorKind: meta.kind,
      actorRole: "producer",
      actorAgent: meta.agent,
      actorProject: meta.project,
      actorCwd: meta.cwd,
      actorSession: meta.session,
      actorPid: meta.pid,
      createdAt,
    });

    for (const doc of docs) {
      insertDoc(db, { ownerKind: "ask_group", ownerId: groupId, ...doc });
      insertDoc(db, { ownerKind: "message", ownerId: groupOpened.id, ...doc });
    }

    for (let position = 0; position < channels.length; position++) {
      const ticketId = ticketIds[position]!;
      const channel = channels[position]!;
      db.query(
        `INSERT INTO tickets
           (id, channel, status, title, body,
            producer_kind, producer_agent, producer_project, producer_cwd, producer_session, producer_pid,
            created_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ticketId,
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
      db.query(
        `INSERT INTO ask_group_members
           (group_id, ticket_id, member_role, position, created_at)
         VALUES (?, ?, 'opinion', ?, ?)`,
      ).run(groupId, ticketId, position, createdAt);

      const childOpened = insertThreadMessage(db, {
        rootKind: "ticket",
        rootId: ticketId,
        kind: "opened",
        body: text,
        actorKind: meta.kind,
        actorRole: "producer",
        actorAgent: meta.agent,
        actorProject: meta.project,
        actorCwd: meta.cwd,
        actorSession: meta.session,
        actorPid: meta.pid,
        ticketId,
        createdAt,
      });

      insertThreadMessage(db, {
        rootKind: "ask_group",
        rootId: groupId,
        kind: "opened",
        body: text,
        actorKind: meta.kind,
        actorRole: "producer",
        actorAgent: meta.agent,
        actorProject: meta.project,
        actorCwd: meta.cwd,
        actorSession: meta.session,
        actorPid: meta.pid,
        ticketId,
        causedByMessageId: childOpened.id,
        createdAt,
      });
    }
  });

  const waitRaw = flagString(ctx.args, "wait");
  if (waitRaw !== undefined) {
    const done = await waitUntilAllClosed(ctx, groupId, parseWaitDuration(waitRaw));
    return emitGroup(ctx, groupId, channels, done);
  }

  return emitGroup(ctx, groupId, channels, true);
}
