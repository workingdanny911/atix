import schemaSql from "./schema.sql" with { type: "text" };

import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

/**
 * Apply the schema (idempotent — all DDL uses IF NOT EXISTS) and record the
 * schema version. Safe to call repeatedly. `schema.sql` is bundled via a Bun
 * text import so it works inside the compiled single-file binary.
 */
export function initDb(db: Database): void {
  db.run(schemaSql);
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");

  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | null;
  if (row === null) {
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  }
}
