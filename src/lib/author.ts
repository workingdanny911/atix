import type { Meta } from "../types";

export type AuthorRole = "producer" | "claimer" | "other";

/**
 * The producer/claimer identity fields needed to attribute a reply. Intentionally
 * narrow (4 nullable columns) so callers can pass any row that SELECTed them,
 * regardless of the other columns they carry.
 */
export interface AuthorRoleRow {
  producer_agent: string | null;
  producer_session: string | null;
  claimer_agent: string | null;
  claimer_session: string | null;
}

/**
 * Match by (agent + session): the same logical actor. Producer takes
 * precedence over claimer if both happen to match (rare self-claim).
 */
export function authorRole(meta: Meta, row: AuthorRoleRow): AuthorRole {
  if (row.producer_agent === meta.agent && row.producer_session === meta.session) {
    return "producer";
  }
  if (row.claimer_agent === meta.agent && row.claimer_session === meta.session) {
    return "claimer";
  }
  return "other";
}
