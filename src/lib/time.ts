/**
 * ISO-8601 timestamp with millisecond precision, e.g. `2026-05-29T14:23:11.456Z`.
 * `Date.prototype.toISOString` always renders exactly `.NNNZ`, so it is used
 * directly. Stored as the canonical sortable time string across all tables.
 */
export function nowIso(): string {
  return new Date().toISOString();
}
