import { flagString, flagBool } from "../lib/args";
import { parseDuration } from "../lib/duration";
import { nowIso } from "../lib/time";
import { resolveOutputMode, printJson, printLine, colorize, statusIcon } from "../lib/output";
import { EXIT } from "../lib/exit";
import { BadFlagError } from "../lib/errors";
import { serializeTicket, TICKET_SELECT_COLUMNS } from "../lib/serialize";

import type { Ctx, TicketStatus } from "../types";
import type { TicketRow } from "../lib/serialize";

const VALID_STATUSES = new Set<TicketStatus>(["open", "claimed", "done", "canceled"]);

const DEFAULT_LIMIT = 20;
const DEFAULT_ORPHAN_TTL_SEC = 1800;

/** Canonical ticket columns plus the two computed view flags. */
interface ListRow extends TicketRow {
  has_replies: number;
  is_orphan: number;
}

/**
 * Resolve the orphan TTL (seconds) from $ATIX_ORPHAN_TTL via the strict
 * duration parser; defaults to 30m. Invalid values surface as a bad_flag error.
 */
function resolveOrphanTtlSec(): number {
  const raw = process.env.ATIX_ORPHAN_TTL;
  if (raw === undefined || raw.length === 0) return DEFAULT_ORPHAN_TTL_SEC;
  return parseDuration(raw);
}

/** Split a comma-separated multi-value flag into trimmed, non-empty tokens. */
function multiValues(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function isoFromSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

/**
 * List tickets matching the AND-combined filters, newest first
 * (created_at DESC, id DESC tie-break). JSON output is JSONL: one ticket object
 * per line carrying computed view fields (age_sec, has_replies, is_orphan).
 */
export function run(ctx: Ctx): number {
  const db = ctx.db;
  if (db === null) throw new Error("list: database connection was not provided");

  const now = nowIso();
  const orphanTtlSec = resolveOrphanTtlSec();
  const orphanCutoff = isoFromSecondsAgo(orphanTtlSec);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const channels = multiValues(flagString(ctx.args, "channel"));
  if (channels.length > 0) {
    conditions.push(`channel IN (${channels.map(() => "?").join(", ")})`);
    params.push(...channels);
  }

  const statuses = multiValues(flagString(ctx.args, "status"));
  if (statuses.length > 0) {
    for (const status of statuses) {
      if (!VALID_STATUSES.has(status as TicketStatus)) {
        throw new BadFlagError(
          `invalid status '${status}'. Use one of: open, claimed, done, canceled`,
        );
      }
    }
    conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  const agent = flagString(ctx.args, "agent");
  if (agent !== undefined) {
    conditions.push("producer_agent = ?");
    params.push(agent);
  }

  if (flagBool(ctx.args, "mine")) {
    // Patch 3c: recover-after-restart semantics — match on agent + project only
    // (producer OR claimer side); session/cwd/pid are deliberately excluded.
    conditions.push(
      `((producer_agent = ? OR claimer_agent = ?) AND (producer_project = ? OR claimer_project = ?))`,
    );
    params.push(ctx.meta.agent, ctx.meta.agent, ctx.meta.project, ctx.meta.project);
  }

  const since = flagString(ctx.args, "since");
  if (since !== undefined) {
    conditions.push("created_at > ?");
    params.push(isoFromSecondsAgo(parseDuration(since)));
  }

  const olderThan = flagString(ctx.args, "older-than");
  if (olderThan !== undefined) {
    conditions.push("created_at < ?");
    params.push(isoFromSecondsAgo(parseDuration(olderThan)));
  }

  if (flagBool(ctx.args, "has-replies")) {
    conditions.push("EXISTS (SELECT 1 FROM replies r WHERE r.ticket_id = tickets.id)");
  }

  if (flagBool(ctx.args, "orphaned")) {
    conditions.push("status = 'claimed' AND claimed_at < ?");
    params.push(orphanCutoff);
  }

  let limit = DEFAULT_LIMIT;
  const limitRaw = flagString(ctx.args, "limit");
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadFlagError(`invalid --limit '${limitRaw}'. Use a non-negative integer`);
    }
    limit = parsed;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.map((c) => `(${c})`).join(" AND ")}` : "";

  const sql = `
    SELECT ${TICKET_SELECT_COLUMNS},
           EXISTS (SELECT 1 FROM replies r WHERE r.ticket_id = tickets.id) AS has_replies,
           CASE WHEN status = 'claimed' AND claimed_at < ? THEN 1 ELSE 0 END AS is_orphan
      FROM tickets
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`;

  const rows = db.query(sql).all(orphanCutoff, ...params, limit) as ListRow[];

  if (ctx.json) {
    // SPEC §3.3: each line is the canonical ticket object (JSONL). list adds
    // view-only extension fields (age_sec / has_replies / is_orphan, and the
    // claimed_by alias) on top — never replacing canonical keys.
    for (const row of rows) {
      printJson({
        ...serializeTicket(row),
        age_sec: ageSec(now, row.created_at),
        has_replies: row.has_replies === 1,
        is_orphan: row.is_orphan === 1,
        claimed_by: row.claimer_agent,
      });
    }
    return EXIT.OK;
  }

  return renderHuman(rows, now);
}

function ageSec(now: string, createdAt: string): number {
  const diffMs = Date.parse(now) - Date.parse(createdAt);
  return Math.max(0, Math.floor(diffMs / 1000));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function renderHuman(rows: ListRow[], now: string): number {
  const mode = resolveOutputMode(false);
  const dim = (s: string) => colorize(mode, "dim", s);

  printLine(dim(`${"STATUS".padEnd(10)}${"AGE".padEnd(6)}${"ID".padEnd(28)}${"FROM".padEnd(12)}TITLE`));
  for (const row of rows) {
    const labels: string[] = [];
    if (row.has_replies === 1) labels.push(colorize(mode, "cyan", "*"));
    if (row.is_orphan === 1) labels.push(statusIcon("orphaned"));
    const labelSuffix = labels.length > 0 ? ` ${labels.join("")}` : "";

    const age = formatAge(ageSec(now, row.created_at));
    printLine(
      `${statusIcon(row.status)} ${row.status.padEnd(8)}` +
        `${age.padEnd(6)}` +
        `${row.id.padEnd(28)}` +
        `${(row.producer_agent ?? "-").padEnd(12)}` +
        `${truncate(row.title, 50)}${labelSuffix}`,
    );
  }
  if (rows.length === 0) printLine(dim("(no tickets)"));
  return EXIT.OK;
}
