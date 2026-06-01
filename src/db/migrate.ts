import schemaSql from "./schema.sql" with { type: "text" };

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 2;

interface SchemaVersionRow {
  version: number;
}

interface ForeignKeyViolation {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

/**
 * Apply the schema (idempotent — all DDL uses IF NOT EXISTS) and record the
 * schema version. Safe to call repeatedly. `schema.sql` is bundled via a Bun
 * text import so it works inside the compiled single-file binary.
 */
export function initDb(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");

  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as
    | SchemaVersionRow
    | null;
  if (row === null) {
    db.run(schemaSql);
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    assertForeignKeys(db);
    return;
  }

  if (row.version > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${row.version} is newer than supported ${SCHEMA_VERSION}`,
    );
  }

  if (row.version === 1) {
    migrateV1ToV2(db);
    return;
  }

  db.run(schemaSql);
  db.query("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  assertForeignKeys(db);
}

function migrateV1ToV2(db: Database): void {
  db.run("BEGIN IMMEDIATE");
  try {
    rebuildRepliesWithoutBodyCheck(db);
    db.run(schemaSql);
    db.run("DELETE FROM schema_version");
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    db.run("COMMIT");
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw err;
  }

  assertForeignKeys(db);
}

function rebuildRepliesWithoutBodyCheck(db: Database): void {
  db.run(`
    CREATE TABLE replies_next (
      id              TEXT PRIMARY KEY,
      ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_kind     TEXT NOT NULL CHECK (author_kind IN ('human','agent')),
      author_role     TEXT NOT NULL CHECK (author_role IN ('claimer','producer','other')),
      author_agent    TEXT,
      author_project  TEXT,
      author_cwd      TEXT,
      author_session  TEXT,
      author_pid      INTEGER,
      is_final        INTEGER NOT NULL DEFAULT 0,
      body            TEXT NOT NULL,
      created_at      TEXT NOT NULL
    )
  `);

  db.run(`
    INSERT INTO replies_next
      (id, ticket_id, author_kind, author_role, author_agent, author_project,
       author_cwd, author_session, author_pid, is_final, body, created_at)
    SELECT
      id, ticket_id, author_kind, author_role, author_agent, author_project,
      author_cwd, author_session, author_pid, is_final, body, created_at
      FROM replies
  `);

  db.run("DROP TABLE replies");
  db.run("ALTER TABLE replies_next RENAME TO replies");
}

function assertForeignKeys(db: Database): void {
  const violations = db.query("PRAGMA foreign_key_check").all() as ForeignKeyViolation[];
  if (violations.length === 0) return;

  const detail = violations
    .slice(0, 5)
    .map((v) => `${v.table}:${v.rowid}->${v.parent}#${v.fkid}`)
    .join(", ");
  throw new Error(`foreign_key_check failed (${violations.length}): ${detail}`);
}
