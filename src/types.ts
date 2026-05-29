import type { Database } from "bun:sqlite";

export type Kind = "human" | "agent";

export type OutputMode = "json" | "human" | "plain";

export type TicketStatus = "open" | "claimed" | "done" | "canceled";

export interface Meta {
  kind: Kind;
  agent: string;
  project: string;
  cwd: string;
  session: string;
  pid: number;
}

export interface ParsedArgs {
  /** Positional tokens after the command name (e.g. subcommand, ids). */
  positionals: string[];
  /** Flags keyed by their long name without leading dashes. */
  flags: Record<string, string | boolean>;
}

export interface Ctx {
  /** Open connection. Commands that do not need the DB (whoami) receive null. */
  db: Database | null;
  args: ParsedArgs;
  json: boolean;
  /** Lazily resolved process/identity metadata. */
  meta: Meta;
}

export interface Command {
  run(ctx: Ctx): number | Promise<number>;
}
