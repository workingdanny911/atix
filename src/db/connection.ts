import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import { flagString } from "../lib/args";

import type { ParsedArgs } from "../types";

/**
 * Resolve the DB file path by precedence:
 *   1. --db PATH
 *   2. $ATIX_DB
 *   3. $XDG_DATA_HOME/atix/atix.db
 *   4. ~/.local/share/atix/atix.db
 */
export function resolveDbPath(args: ParsedArgs): string {
  const fromFlag = flagString(args, "db");
  if (fromFlag) return fromFlag;

  const fromEnv = process.env.ATIX_DB;
  if (fromEnv) return fromEnv;

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "atix", "atix.db");

  return join(homedir(), ".local", "share", "atix", "atix.db");
}

/** Open (and pragma-configure) the SQLite connection, creating its dir. */
export function openDb(args: ParsedArgs): Database {
  const path = resolveDbPath(args);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");
  db.run("PRAGMA foreign_keys=ON");
  return db;
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction so that concurrent writers
 * (e.g. racing claims) acquire the write lock up-front and fail fast on
 * contention rather than mid-transaction. Commits on success, rolls back on
 * throw, then re-throws.
 */
export function withImmediateTx<T>(db: Database, fn: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.run("COMMIT");
    return result;
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Rollback failure must not mask the original error.
    }
    throw err;
  }
}
