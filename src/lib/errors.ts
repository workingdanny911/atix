import { AtixError, EXIT } from "./exit";

/**
 * Shared AtixError subclasses, previously redefined verbatim in nearly every
 * command. Each preserves the exact keyword + exit code its callers relied on.
 *
 * Important contract nuance (do NOT collapse): a missing id is `bad_flag`/exit 2
 * for release/done/cancel (use BadFlagError), but `not_found`/exit 4 for
 * show/wait/recover (use NotFoundError). The keyword/exit differ by command, so
 * callers must pick the right class — they are intentionally not merged.
 */

/** Input/usage error: keyword `bad_flag`, exit 2. */
export class BadFlagError extends AtixError {
  constructor(message: string) {
    super("bad_flag", message, EXIT.INPUT);
    this.name = "BadFlagError";
  }
}

/** Missing/absent resource: keyword `not_found`, exit 4. */
export class NotFoundError extends AtixError {
  constructor(message: string) {
    super("not_found", message, EXIT.NOT_FOUND);
    this.name = "NotFoundError";
  }
}

/** State conflict (wrong token, already closed, etc.): keyword `conflict`, exit 3. */
export class ConflictError extends AtixError {
  constructor(message: string) {
    super("conflict", message, EXIT.CONFLICT);
    this.name = "ConflictError";
  }
}

/** Unknown channel name: keyword `unknown_channel`, exit 2. */
export class UnknownChannelError extends AtixError {
  constructor(channel: string) {
    super("unknown_channel", `unknown channel '${channel}'`, EXIT.INPUT);
    this.name = "UnknownChannelError";
  }
}
