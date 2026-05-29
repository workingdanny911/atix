import type { ParsedArgs } from "../types";

/**
 * Value-flags ALWAYS consume the next token as their value, regardless of
 * whether it begins with `-`. This is the data-loss guard: `push --body "-x"`,
 * `--title "-x"`, inline diffs, and `claim --wait "-5s"` must not silently lose
 * the value to the old "next token starts with `-` ⇒ treat flag as boolean"
 * heuristic. Out-of-range values (e.g. a negative duration) are now rejected by
 * each command's own validator (parseDuration ⇒ invalid_duration, exit 2)
 * instead of vanishing.
 */
const KNOWN_VALUE_FLAGS = new Set<string>([
  // push / reply / done — body sources & metadata.
  "to",
  "from",
  "title",
  "body",
  "body-file",
  "agent",
  "project",
  "session",
  "desc",
  "token",
  "reason",
  // wait / claim / list — time & filter values.
  "until",
  "since",
  "timeout",
  "poll",
  "wait",
  "older-than",
  "limit",
  "channel",
  "status",
  "db",
]);

/**
 * Boolean flags take no value (the next token is never consumed). `show --full`
 * (the renamed full-body display flag) lives here so that `body` can be a pure
 * value-flag without `show` swallowing the following token.
 */
const KNOWN_BOOLEAN_FLAGS = new Set<string>([
  "json",
  "body-stdin",
  "final",
  "all",
  "archived",
  "force",
  "help",
  "full", // show — render the full (untruncated) body
  // Phase 2 boolean flags.
  "mine", // list
  "orphaned", // list
  "has-replies", // list
  "with-replies", // wait, show
  "stats", // channel ls
  "include-archived", // channel ls
  "abandon", // release
]);

function normalizeKey(raw: string): string {
  return raw.replace(/^--?/, "");
}

/**
 * Dependency-free flag parser.
 * - `--key value` / `--key=value` → string flag
 * - `--bool` (in KNOWN_BOOLEAN_FLAGS) → true
 * - bare tokens → positionals
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[normalizeKey(token.slice(0, eq))] = token.slice(eq + 1);
      continue;
    }

    const key = normalizeKey(token);
    if (KNOWN_BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }

    const next = argv[i + 1];

    // Known value-flags consume the next token unconditionally — even a
    // `-`-leading value (diff line, negative duration). This is the data-loss
    // fix: validation of the value's *content* belongs to each command, not the
    // parser. A trailing value-flag with no following token stays `true` so the
    // command can report a clear "requires <value>" error.
    if (KNOWN_VALUE_FLAGS.has(key)) {
      if (next !== undefined) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }

    // Unknown flag: keep the conservative heuristic (a following non-dash token
    // is its value, otherwise it is a bare boolean).
    if (next !== undefined && !next.startsWith("-")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { positionals, flags };
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}
