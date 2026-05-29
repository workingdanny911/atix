import { withImmediateTx } from "../db/connection";
import { resolveOutputMode, printJson, printLine, colorize } from "../lib/output";
import { AtixError, EXIT } from "../lib/exit";
import { NotFoundError } from "../lib/errors";

import type { Ctx } from "../types";

class NotClaimedError extends AtixError {
  constructor() {
    super("conflict", "ticket is not claimed", EXIT.CONFLICT);
    this.name = "NotClaimedError";
  }
}

class SessionMismatchError extends AtixError {
  constructor() {
    super("session_mismatch", "session_mismatch — use atix release --force", EXIT.CONFLICT);
    this.name = "SessionMismatchError";
  }
}

/**
 * Raised when the conditional recover UPDATE matches a row count other than 1
 * after the in-tx SELECT already confirmed status='claimed' and a session match
 * under the same `BEGIN IMMEDIATE` lock. Under IMMEDIATE serialization this is
 * unreachable; surfacing it as an explicit invariant violation is honest about
 * the broken assumption, instead of the prior re-diagnose block that
 * misclassified the (impossible) case as SessionMismatchError.
 */
class RecoverInvariantError extends AtixError {
  constructor(id: string, changes: number) {
    super(
      "internal",
      `recover invariant violated: conditional UPDATE for ticket '${id}' under BEGIN IMMEDIATE changed ${changes} rows (expected exactly 1 after in-tx ownership check)`,
      EXIT.FAIL,
    );
    this.name = "RecoverInvariantError";
  }
}

interface TicketRow {
  id: string;
  status: string;
  claimer_agent: string | null;
  claimer_session: string | null;
}

/**
 * Reissue a claim token for a ticket when its claimer lost the original. Only
 * the same session (agent + session match) may recover; otherwise the holder
 * must explicitly release with --force.
 */
export function run(ctx: Ctx): number {
  const db = ctx.db;
  if (db === null) throw new Error("recover: database connection was not provided");

  const id = ctx.args.positionals[0];
  if (id === undefined) throw new NotFoundError("recover requires a ticket id");

  const { meta } = ctx;
  const newToken = crypto.randomUUID();

  // Atomic recover: the SELECT (existence/ownership check) and the token
  // reissue must share one BEGIN IMMEDIATE tx, else a `release --force` +
  // re-claim by another agent could slip in between and have its fresh token
  // clobbered (TOCTOU). The conditional UPDATE also pins claimer_agent/session
  // so a stale recover can never overwrite a new claimer's token.
  // The tx only mutates + validates; recover emits *after* the tx commits (so a
  // failed reissue never prints success), hence the return value is intentionally
  // discarded rather than threaded out like release does.
  void withImmediateTx(db, () => {
    const ticket = db
      .query("SELECT id, status, claimer_agent, claimer_session FROM tickets WHERE id = ?")
      .get(id) as TicketRow | null;
    if (ticket === null) throw new NotFoundError(`ticket '${id}' not found`);
    if (ticket.status !== "claimed") throw new NotClaimedError();

    const sessionMatches =
      meta.agent === ticket.claimer_agent && meta.session === ticket.claimer_session;
    if (!sessionMatches) throw new SessionMismatchError();

    const res = db
      .query(
        "UPDATE tickets SET claim_token = ? WHERE id = ? AND status = 'claimed' AND claimer_agent = ? AND claimer_session = ?",
      )
      .run(newToken, id, meta.agent, meta.session);

    // E2 (R1): the in-tx SELECT above already validated existence + status +
    // session ownership, and BEGIN IMMEDIATE holds the write lock, so no other
    // writer can mutate this row between the check and the conditional UPDATE.
    // `changes` is therefore always 1 here. The prior re-diagnose block dropped
    // the impossible case onto SessionMismatchError, which was semantically
    // wrong; we now make the broken invariant explicit instead.
    if (res.changes !== 1) throw new RecoverInvariantError(id, res.changes);
  });

  if (ctx.json) {
    printJson({ ok: true, id, claim_token: newToken, status: "claimed" });
    return EXIT.OK;
  }

  const mode = resolveOutputMode(false);
  printLine(`recovered ${colorize(mode, "cyan", id)} — new claim token issued`);
  return EXIT.OK;
}
