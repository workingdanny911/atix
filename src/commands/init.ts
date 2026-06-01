import { resolveDbPath } from "../db/connection";
import { initDb, SCHEMA_VERSION } from "../db/migrate";
import { printJson, printLine } from "../lib/output";
import { EXIT } from "../lib/exit";

import type { Ctx } from "../types";

/**
 * Create (if needed) the DB file, apply schema + indexes, and stamp the
 * schema version. Reference implementation for DB-touching commands.
 */
export function run(ctx: Ctx): number {
  if (ctx.db === null) {
    // The router opens the DB for init; null here is a wiring bug, fail loud.
    throw new Error("init: database connection was not provided");
  }

  initDb(ctx.db);
  const path = resolveDbPath(ctx.args);

  if (ctx.json) {
    printJson({ ok: true, action: "init", db: path, schema_version: SCHEMA_VERSION });
  } else {
    printLine(`initialized atix database at ${path}`);
  }
  return EXIT.OK;
}
