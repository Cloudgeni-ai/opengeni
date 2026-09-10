import type { ScheduledTask } from "@opengeni/contracts";
import { ExternalLinkWorkSnapshot } from "@opengeni/contracts/external-identities";
import {
  captureExternalLinkTurnAuthority,
  captureExternalLinkTaskAuthority,
  getExternalLinkTurnSnapshot,
  getSessionTurnForAttempt,
  type Database,
} from "@opengeni/db";
import {
  externalActorContinuationForAuthorization,
  hasVerifiedOwningUserAuthorization,
  type AccessGrantAuthorization,
} from "../access";
import { externalContinuationCommitAuthorizer } from "./external-continuation";

function snapshotFor(authorization: AccessGrantAuthorization | undefined) {
  const continuation = authorization
    ? externalActorContinuationForAuthorization(authorization)
    : null;
  return continuation?.actor.actingMode === "linked_native"
    ? ExternalLinkWorkSnapshot.parse({
        ...continuation,
        permissions: [...authorization!.grant.permissions],
      })
    : null;
}

/** Closure is created only from the access resolver's object-identity proof.
 * JSON metadata and an ordinary named native subject can never enter it. */
export function prepareExternalLinkTurnAdmission(
  authorization: AccessGrantAuthorization | undefined,
) {
  const snapshot = snapshotFor(authorization);
  if (!snapshot || !authorization) return undefined;
  const workspaceId = authorization.grant.workspaceId;
  const accountId = authorization.grant.accountId;
  const commit = externalContinuationCommitAuthorizer(authorization)!;
  return async (tx: Database, sessionId: string, turnId: string) => {
    await commit(tx);
    await captureExternalLinkTurnAuthority(tx, {
      accountId,
      workspaceId,
      sessionId,
      turnId,
      snapshot,
    });
  };
}

export function prepareExternalLinkTaskAdmission(
  authorization: AccessGrantAuthorization | undefined,
  actor?: {
    sessionId: string;
    turnId: string;
    attemptId: string;
    executionGeneration: number;
  } | null,
): ((tx: Database, task: ScheduledTask) => Promise<void>) | undefined {
  const snapshot = snapshotFor(authorization);
  const commit = externalContinuationCommitAuthorizer(authorization);
  if (snapshot)
    return async (tx, task) => {
      await commit?.(tx);
      await captureExternalLinkTaskAuthority(tx, task, snapshot);
    };
  if (!actor) {
    // A fresh, explicitly authenticated owning-user revision uses that user's
    // own lane. It does not inherit a previous editor's link by accident.
    // Service lifecycle edits and internal promotion still clone old provenance.
    return authorization && hasVerifiedOwningUserAuthorization(authorization)
      ? async () => {}
      : undefined;
  }
  return async (tx, task) => {
    const turn = await getSessionTurnForAttempt(
      tx,
      task.workspaceId,
      actor.sessionId,
      actor.attemptId,
    );
    if (!turn || turn.id !== actor.turnId || turn.executionGeneration !== actor.executionGeneration)
      throw new Error("Linked task creator attempt is no longer active");
    const inherited = await getExternalLinkTurnSnapshot(tx, task, actor.turnId);
    if (inherited) await captureExternalLinkTaskAuthority(tx, task, inherited);
  };
}
