import { withImmediateTx } from "../db/connection";
import { resolveBody } from "../lib/body";
import { validateTitle } from "../lib/title";
import { flagString } from "../lib/args";
import { nowIso } from "../lib/time";
import { ulid } from "../lib/ulid";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { AtixError, EXIT } from "../lib/exit";
import { BadFlagError, UnknownChannelError } from "../lib/errors";
import { findChannel, insertThreadMessage } from "../lib/queries";

import type { Ctx } from "../types";

class ChannelArchivedError extends AtixError {
  constructor(channel: string) {
    super("channel_archived", `channel '${channel}' is archived`, EXIT.INPUT);
    this.name = "ChannelArchivedError";
  }
}

/** Most recent claim time on a channel (SPEC push.last_claim_at), or null. */
function lastClaimAt(db: NonNullable<Ctx["db"]>, channel: string): string | null {
  const row = db
    .query(
      `SELECT claimed_at FROM tickets
         WHERE channel = ? AND claimed_at IS NOT NULL
         ORDER BY claimed_at DESC, id DESC LIMIT 1`,
    )
    .get(channel) as { claimed_at: string } | null;
  return row?.claimed_at ?? null;
}

/**
 * Create an open ticket on a channel. Archived channels reject new pushes
 * (claim still drains them). Empty body is allowed (default '').
 */
export async function run(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  if (db === null) throw new Error("push: database connection was not provided");

  const channel = flagString(ctx.args, "to");
  if (channel === undefined) throw new BadFlagError("push requires --to <channel>");
  const title = flagString(ctx.args, "title");
  if (title === undefined) throw new BadFlagError("push requires --title <title>");
  validateTitle(title);

  // Resolve/validate the body outside the tx (may read stdin/file): a validation
  // failure must not hold the write lock.
  const { text, sizeBytes } = await resolveBody({ args: ctx.args, allowEmpty: true });

  const id = ulid();
  const createdAt = nowIso();
  const { meta } = ctx;

  // Atomic push: the channel check (exists + not archived) and the INSERT share
  // one BEGIN IMMEDIATE tx, else `channel archive` could slip in between and we
  // would insert into a just-archived channel (race).
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

    insertThreadMessage(db, {
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
  });

  if (ctx.json) {
    printJson({
      ok: true,
      id,
      channel,
      status: "open",
      size_bytes: sizeBytes,
      last_claim_at: lastClaimAt(db, channel),
    });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  printLine(`${statusIcon("open")} pushed ${colorize(mode, "cyan", id)} → ${channel}`);
  return EXIT.OK;
}
