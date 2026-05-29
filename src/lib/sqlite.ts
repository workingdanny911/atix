/**
 * SQLite write-lock contention surfaces as a raw bun:sqlite error whose message
 * carries `SQLITE_BUSY` / `database is locked`. The loop agent contract requires
 * this to be reported as the stable `db_busy` keyword, and the claim polling
 * loop needs the same predicate to decide whether a `BEGIN IMMEDIATE` failure is
 * a retryable contention rather than a fatal fault. Detect it on the message
 * rather than letting the raw error escape.
 */
export function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}
