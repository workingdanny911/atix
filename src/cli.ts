#!/usr/bin/env bun
import { openDb } from "./db/connection";
import { parseArgs, flagBool } from "./lib/args";
import { resolveMeta } from "./lib/meta";
import { AtixError, failFromError, fail, EXIT } from "./lib/exit";
import { isSqliteBusy } from "./lib/sqlite";

import type { Database } from "bun:sqlite";
import type { Command, Ctx, ParsedArgs } from "./types";

/**
 * Convert an unexpected (non-AtixError, non-busy) failure into the standard
 * `internal` error envelope.
 */
function failGeneric(err: unknown, isJson: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  return fail("internal", message, EXIT.FAIL, isJson);
}

type CommandModule = { run: Command["run"] };

/**
 * Static import map. Each entry is a literal-string `import()` so the bundler
 * can statically trace and embed every command module into the
 * `bun build --compile` binary. A template-literal `import()` is NOT traceable
 * and silently drops the modules from the binary.
 */
const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  init: () => import("./commands/init.ts"),
  push: () => import("./commands/push.ts"),
  claim: () => import("./commands/claim.ts"),
  release: () => import("./commands/release.ts"),
  done: () => import("./commands/done.ts"),
  cancel: () => import("./commands/cancel.ts"),
  reply: () => import("./commands/reply.ts"),
  wait: () => import("./commands/wait.ts"),
  list: () => import("./commands/list.ts"),
  show: () => import("./commands/show.ts"),
  channel: () => import("./commands/channel.ts"),
  whoami: () => import("./commands/whoami.ts"),
  recover: () => import("./commands/recover.ts"),
};

/** Commands that operate on the SQLite store. whoami is identity-only. */
const DB_COMMANDS = new Set<string>([
  "init",
  "push",
  "claim",
  "release",
  "done",
  "cancel",
  "reply",
  "wait",
  "list",
  "show",
  "channel",
  "recover",
]);

const COMMAND_NAMES = Object.keys(COMMANDS);

function usageCommandList(): string {
  return COMMAND_NAMES.join(", ");
}

function usage(): string {
  return `usage: atix <command> [options]\n\ncommands: ${usageCommandList()}`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const commandToken = argv[0];

  const isJsonGlobal = flagBool(parseArgs(argv.slice(1)), "json");

  if (commandToken === undefined || commandToken === "--help" || commandToken === "help") {
    process.stdout.write(`${usage()}\n`);
    return EXIT.OK;
  }

  const loader = COMMANDS[commandToken];
  if (loader === undefined) {
    fail("bad_flag", `unknown command '${commandToken}'\n${usage()}`, EXIT.INPUT, isJsonGlobal);
  }

  const args: ParsedArgs = parseArgs(argv.slice(1));
  const json = flagBool(args, "json");
  const meta = resolveMeta(args);

  let db: Database | null = null;

  try {
    if (DB_COMMANDS.has(commandToken)) {
      db = openDb(args);
    }
    const ctx: Ctx = { db, args, json, meta };
    const command = await loader();
    return await command.run(ctx);
  } catch (err) {
    if (err instanceof AtixError) {
      return failFromError(err, json);
    }
    if (isSqliteBusy(err)) {
      const message = err instanceof Error ? err.message : String(err);
      return fail("db_busy", message, EXIT.FAIL, json);
    }
    return failGeneric(err, json);
  } finally {
    db?.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT.FAIL);
  });
