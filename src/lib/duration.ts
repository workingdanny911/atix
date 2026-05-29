import { AtixError, EXIT } from "./exit";

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export class InvalidDurationError extends AtixError {
  constructor(input: string) {
    super(
      "invalid_duration",
      `invalid duration '${input}'. Use <N>(s|m|h|d), e.g., '30s', '5m', '2h', '7d'`,
      EXIT.INPUT,
    );
    this.name = "InvalidDurationError";
  }
}

/**
 * Parse a strict duration into seconds.
 * Accepts only `^(\d+)(s|m|h|d)$`. Composite (`1h30m`), decimal (`2.5h`) and
 * natural-language inputs are rejected.
 *
 * Applies to: --timeout, --wait, --since, --older-than, ATIX_ORPHAN_TTL.
 */
export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input);
  if (!match) throw new InvalidDurationError(input);
  const value = Number(match[1]);
  const unit = match[2]!;
  return value * UNIT_SECONDS[unit]!;
}
