export const EXIT = {
  OK: 0,
  FAIL: 1,
  INPUT: 2,
  CONFLICT: 3,
  NOT_FOUND: 4,
  TIMEOUT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Stable error keywords. Phase 2 must reuse these — never invent ad-hoc
 * strings, since the SKILL layer matches on them.
 */
export type ErrorKeyword =
  | "unknown_channel"
  | "channel_archived"
  | "invalid_utf8"
  | "nul_byte"
  | "body_too_large"
  | "invalid_duration"
  | "multiple_body_inputs"
  | "conflict"
  | "not_found"
  | "timeout"
  | "db_busy"
  | "session_mismatch"
  | "bad_flag"
  | "internal";

export interface ErrorJson {
  ok: false;
  error: ErrorKeyword;
  message: string;
  exit: number;
}

/**
 * Base class for errors that carry an exit code + keyword so that command
 * boundaries can convert them into the standard error envelope via `fail`.
 */
export class AtixError extends Error {
  readonly keyword: ErrorKeyword;
  readonly exitCode: ExitCode;

  constructor(keyword: ErrorKeyword, message: string, exitCode: ExitCode) {
    super(message);
    this.name = "AtixError";
    this.keyword = keyword;
    this.exitCode = exitCode;
  }
}

/**
 * Emit the standard error representation and terminate the process.
 * - json mode: error envelope to stdout.
 * - otherwise: `error: <message>` to stderr.
 */
export function fail(
  keyword: ErrorKeyword,
  message: string,
  exitCode: ExitCode,
  isJson: boolean,
): never {
  if (isJson) {
    const payload: ErrorJson = { ok: false, error: keyword, message, exit: exitCode };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(exitCode);
}

/** Convert any thrown AtixError into a `fail` call. Re-throws unknown errors. */
export function failFromError(err: unknown, isJson: boolean): never {
  if (err instanceof AtixError) {
    fail(err.keyword, err.message, err.exitCode, isJson);
  }
  throw err;
}
