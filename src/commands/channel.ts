import { flagString, flagBool } from "../lib/args";
import { nowIso } from "../lib/time";
import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import { AtixError, EXIT } from "../lib/exit";
import { BadFlagError } from "../lib/errors";
import { findChannel } from "../lib/queries";

import type { Ctx } from "../types";
import type { Database } from "bun:sqlite";

const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

class ChannelConflictError extends AtixError {
  constructor(message: string) {
    super("conflict", message, EXIT.INPUT);
    this.name = "ChannelConflictError";
  }
}

class ChannelNotFoundError extends AtixError {
  constructor(name: string) {
    super("not_found", `channel '${name}' not found`, EXIT.NOT_FOUND);
    this.name = "ChannelNotFoundError";
  }
}

interface ChannelRow {
  name: string;
  description: string | null;
  created_at: string;
  archived_at: string | null;
}

interface ChannelStats {
  last_claim_at: string | null;
  open_count: number;
  claimed_count: number;
}

/** Route channel subcommands: add / ls / archive / unarchive. */
export function run(ctx: Ctx): number {
  const db = ctx.db;
  if (db === null) throw new Error("channel: database connection was not provided");

  const sub = ctx.args.positionals[0];
  switch (sub) {
    case "add":
      return runAdd(ctx, db);
    case "ls":
      return runList(ctx, db);
    case "archive":
      return runArchive(ctx, db);
    case "unarchive":
      return runUnarchive(ctx, db);
    default:
      throw new BadFlagError(
        `channel requires a subcommand: add | ls | archive | unarchive (got '${sub ?? ""}')`,
      );
  }
}

function requireName(ctx: Ctx, sub: string): string {
  const name = ctx.args.positionals[1];
  if (name === undefined) throw new BadFlagError(`channel ${sub} requires a NAME`);
  return name;
}

function runAdd(ctx: Ctx, db: Database): number {
  const name = requireName(ctx, "add");
  if (!CHANNEL_NAME_PATTERN.test(name)) {
    throw new BadFlagError(
      `invalid channel name '${name}' — must match ^[a-z0-9][a-z0-9._-]{0,63}$`,
    );
  }

  const existing = findChannel(db, name);
  if (existing !== null) {
    const hint =
      existing.archived_at !== null
        ? ` (archived — use 'atix channel unarchive ${name}')`
        : "";
    throw new ChannelConflictError(`channel '${name}' already exists${hint}`);
  }

  const description = flagString(ctx.args, "desc") ?? "";
  const createdAt = nowIso();
  db.query(
    "INSERT INTO channels (name, description, created_at, archived_at) VALUES (?, ?, ?, NULL)",
  ).run(name, description, createdAt);

  if (ctx.json) {
    printJson({ ok: true, name, created_at: createdAt });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  printLine(`created channel ${colorize(mode, "cyan", name)}`);
  return EXIT.OK;
}

function runList(ctx: Ctx, db: Database): number {
  const includeArchived = flagBool(ctx.args, "include-archived");
  const withStats = flagBool(ctx.args, "stats");

  const sql = includeArchived
    ? "SELECT name, description, created_at, archived_at FROM channels ORDER BY name"
    : "SELECT name, description, created_at, archived_at FROM channels WHERE archived_at IS NULL ORDER BY name";
  const rows = db.query(sql).all() as ChannelRow[];

  const statsByChannel = withStats ? computeStats(db) : null;

  if (ctx.json) {
    const payload = rows.map((row) => ({
      name: row.name,
      description: row.description ?? null,
      created_at: row.created_at,
      archived_at: row.archived_at ?? null,
      stats: statsByChannel ? statsByChannel.get(row.name) ?? emptyStats() : null,
    }));
    printJson(payload);
    return EXIT.OK;
  }

  return renderHuman(rows, statsByChannel);
}

function emptyStats(): ChannelStats {
  return { last_claim_at: null, open_count: 0, claimed_count: 0 };
}

/**
 * Aggregate ticket counts per channel in one pass. Only invoked under --stats
 * so the common `channel ls` path never scans the tickets table.
 */
function computeStats(db: Database): Map<string, ChannelStats> {
  const rows = db
    .query(
      `SELECT channel,
              MAX(claimed_at) AS last_claim_at,
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed_count
         FROM tickets
        GROUP BY channel`,
    )
    .all() as Array<{
    channel: string;
    last_claim_at: string | null;
    open_count: number;
    claimed_count: number;
  }>;

  const map = new Map<string, ChannelStats>();
  for (const row of rows) {
    map.set(row.channel, {
      last_claim_at: row.last_claim_at,
      open_count: row.open_count,
      claimed_count: row.claimed_count,
    });
  }
  return map;
}

function renderHuman(rows: ChannelRow[], statsByChannel: Map<string, ChannelStats> | null): number {
  const mode = resolveOutputMode(false);

  if (rows.length === 0) {
    printLine(colorize(mode, "dim", "no channels"));
    return EXIT.OK;
  }

  const header = statsByChannel
    ? "NAME\tDESC\tCREATED\tSTATS"
    : "NAME\tDESC\tCREATED";
  printLine(colorize(mode, "dim", header));

  for (const row of rows) {
    const archived = row.archived_at !== null;
    const name = archived ? `${row.name} (archived)` : row.name;
    const desc = row.description ?? "";
    const base = `${name}\t${desc}\t${row.created_at}`;

    let line = base;
    if (statsByChannel) {
      const s = statsByChannel.get(row.name) ?? emptyStats();
      line = `${base}\t${s.open_count}o/${s.claimed_count}c\tlast_claim:${s.last_claim_at ?? "-"}`;
    }
    printLine(archived ? colorize(mode, "dim", line) : line);
  }
  return EXIT.OK;
}

function runArchive(ctx: Ctx, db: Database): number {
  const name = requireName(ctx, "archive");
  if (findChannel(db, name) === null) throw new ChannelNotFoundError(name);

  const archivedAt = nowIso();
  db.query("UPDATE channels SET archived_at = ? WHERE name = ?").run(archivedAt, name);

  if (ctx.json) {
    printJson({ ok: true, name, archived_at: archivedAt });
    return EXIT.OK;
  }
  printLine(`archived channel ${name}`);
  return EXIT.OK;
}

function runUnarchive(ctx: Ctx, db: Database): number {
  const name = requireName(ctx, "unarchive");
  if (findChannel(db, name) === null) throw new ChannelNotFoundError(name);

  db.query("UPDATE channels SET archived_at = NULL WHERE name = ?").run(name);

  if (ctx.json) {
    printJson({ ok: true, name, archived_at: null });
    return EXIT.OK;
  }
  printLine(`unarchived channel ${name}`);
  return EXIT.OK;
}
