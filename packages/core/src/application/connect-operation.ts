import type { ConnectAttempt } from "@opengeni/contracts/connect";
import {
  claimConnectOperation,
  finishConnectOperation,
  type ConnectActorScope,
  type ConnectOperationAuthorization,
  type Database,
} from "@opengeni/db";

/** Provider result is deliberately not serializable: secrets can remain in its
 * closure until encrypted credential persistence. Do not retain/log this value. */
export type PreparedConnectOperation = {
  commit: (tx: Database, current: ConnectAttempt) => Promise<ConnectAttempt>;
};

/** Internal provider-adapter boundary, not an HTTP authentication adapter.
 *
 * authorize is mandatory, including for a receipt replay. It must validate the
 * exact saved key/actor/link authority and current permission under database
 * locks. execute owns provider-specific proof, destination and cancellation.
 * No remote effects may occur inside authorize or commit.
 *
 * A failed execute/authorization/commit keeps the durable claim occupied. It
 * does not release or retry work whose provider outcome may be unknown.
 */
export async function executeConnectOperation(input: {
  db: Database;
  scope: ConnectActorScope;
  attemptId: string;
  expectedRevision: number;
  operationId: string;
  /** Caller computes a stable keyed digest if input contains low-entropy secrets. */
  inputDigest: string;
  authorize: ConnectOperationAuthorization;
  execute: (attempt: ConnectAttempt) => Promise<PreparedConnectOperation>;
}): Promise<ConnectAttempt> {
  // Snapshot caller-controlled identity before the first asynchronous boundary.
  const { db, authorize, execute } = input;
  const scope = { ...input.scope };
  const operation = {
    attemptId: input.attemptId,
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
    inputDigest: input.inputDigest,
    authorize,
  };
  const claim = await claimConnectOperation(db, scope, operation);
  if (claim.status === "replayed") return claim.attempt;
  const prepared = await execute(structuredClone(claim.attempt));
  return finishConnectOperation(db, scope, { ...operation, commit: prepared.commit });
}
