/**
 * Pure decision logic for the `claim` polling loop, factored out of the command
 * so the (otherwise timing-dependent) behavior can be unit-tested deterministically.
 *
 * Two robustness fixes live here:
 *   - F5 (--poll 0 spin-loop): `normalizePollSeconds` clamps the poll interval to
 *     a non-zero floor so `Bun.sleep(0)` can never busy-spin the CPU.
 *   - F4 (deadline early-fire): `shouldKeepPolling` guarantees at least one poll
 *     when `--wait > 0`, so a slow first attempt (e.g. one that consumed the whole
 *     busy_timeout) cannot exit without honoring the requested wait window.
 */

/** Minimum poll interval (100ms). Below this, claim would burn CPU on `Bun.sleep(0)`. */
export const MIN_POLL_SECONDS = 0.1;

/**
 * Clamp a requested poll interval (seconds) to the {@link MIN_POLL_SECONDS} floor.
 * `0`, negatives, NaN and any sub-floor value all normalize to the floor.
 */
export function normalizePollSeconds(seconds: number): number {
  if (!(seconds > MIN_POLL_SECONDS)) return MIN_POLL_SECONDS;
  return seconds;
}

export interface PollState {
  /** Parsed `--wait` in seconds: `null` = flag absent, `0` = bare immediate single attempt. */
  waitSeconds: number | null;
  /** How many claim attempts have already run (>= 1 once the loop body has executed). */
  attempts: number;
  /** Current clock (ms), e.g. `Date.now()`. */
  now: number;
  /** Absolute deadline (ms) computed as loop-entry time + waitSeconds*1000. */
  deadline: number;
}

/**
 * Decide whether the claim loop should sleep and attempt again.
 *
 * Policy:
 *   - No `--wait` (null) or `--wait 0` → single attempt, never poll.
 *   - `--wait > 0` → poll until the deadline passes, BUT always allow at least one
 *     poll (F4): if only the first attempt has run we keep going even past the
 *     deadline, so a slow first attempt still yields the promised retry.
 */
export function shouldKeepPolling(state: PollState): boolean {
  const { waitSeconds, attempts, now, deadline } = state;
  if (waitSeconds === null || waitSeconds === 0) return false;
  if (attempts <= 1) return true; // F4: guarantee a minimum of one poll.
  return now < deadline;
}
