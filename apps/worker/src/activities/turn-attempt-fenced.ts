/**
 * The activity lost ownership of its exact turn generation/attempt.
 *
 * This is an ordinary stale-writer outcome, not a Temporal cancellation. The
 * current owner or control transaction already holds authoritative state, so
 * the losing activity must stop locally without asking the workflow to settle
 * or fail the turn again.
 */
export class TurnAttemptFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnAttemptFencedError";
  }
}
