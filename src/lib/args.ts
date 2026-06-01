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
  "watch",
  "title",
  "body",
  "body-file",
  "doc",
  "doc-file",
  "doc-stdin",
  "agent",
  "project",
  "session",
  "desc",
  "token",
  "receipt",
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
  "with-docs", // show
  "stats", // channel ls
  "include-archived", // channel ls
  "abandon", // release
  "notify", // public UX placeholder, rejected by commands for now
]);

const REPEATABLE_VALUE_FLAGS = new Set<string>(["to", "doc", "doc-file", "doc-stdin"]);

export interface ParsedFlagOccurrence {
  key: string;
  value: string | boolean;
}

const flagOccurrencesByArgs = new WeakMap<ParsedArgs, ParsedFlagOccurrence[]>();

function normalizeKey(raw: string): string {
  return raw.replace(/^--?/, "");
}

function setFlag(
  flags: Record<string, string | boolean>,
  key: string,
  value: string | boolean,
): void {
  if (!REPEATABLE_VALUE_FLAGS.has(key)) {
    flags[key] = value;
    return;
  }

  const repeatableFlags = flags as Record<string, string | boolean | string[]>;
  const current = repeatableFlags[key];
  if (current === undefined) {
    repeatableFlags[key] = value;
  } else if (Array.isArray(current)) {
    current.push(String(value));
  } else {
    repeatableFlags[key] = [String(current), String(value)];
  }
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
  const occurrences: ParsedFlagOccurrence[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    if (eq !== -1) {
      const key = normalizeKey(token.slice(0, eq));
      const value = token.slice(eq + 1);
      setFlag(flags, key, value);
      occurrences.push({ key, value });
      continue;
    }

    const key = normalizeKey(token);
    if (KNOWN_BOOLEAN_FLAGS.has(key)) {
      setFlag(flags, key, true);
      occurrences.push({ key, value: true });
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
        setFlag(flags, key, next);
        occurrences.push({ key, value: next });
        i++;
      } else {
        setFlag(flags, key, true);
        occurrences.push({ key, value: true });
      }
      continue;
    }

    // Unknown flag: keep the conservative heuristic (a following non-dash token
    // is its value, otherwise it is a bare boolean).
    if (next !== undefined && !next.startsWith("-")) {
      setFlag(flags, key, next);
      occurrences.push({ key, value: next });
      i++;
    } else {
      setFlag(flags, key, true);
      occurrences.push({ key, value: true });
    }
  }

  const parsed = { positionals, flags };
  flagOccurrencesByArgs.set(parsed, occurrences);
  return parsed;
}

export function flagString(args: ParsedArgs, key: string): string | undefined {
  const v = (args.flags as Record<string, string | boolean | string[] | undefined>)[key];
  if (Array.isArray(v)) return v.at(-1);
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}

export function flagStrings(args: ParsedArgs, key: string): string[] {
  const v = (args.flags as Record<string, string | boolean | string[] | undefined>)[key];
  if (Array.isArray(v)) return v;
  return typeof v === "string" ? [v] : [];
}

export function flagOccurrences(args: ParsedArgs, keys: ReadonlySet<string>): ParsedFlagOccurrence[] {
  const occurrences = flagOccurrencesByArgs.get(args);
  if (occurrences !== undefined) {
    return occurrences.filter((entry) => keys.has(entry.key));
  }

  const fallback: ParsedFlagOccurrence[] = [];
  for (const key of keys) {
    const value = (args.flags as Record<string, string | boolean | string[] | undefined>)[key];
    if (Array.isArray(value)) {
      fallback.push(...value.map((item) => ({ key, value: item })));
    } else if (value !== undefined) {
      fallback.push({ key, value });
    }
  }
  return fallback;
}
