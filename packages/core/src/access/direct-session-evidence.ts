import type { AccessContext } from "@opengeni/contracts";

/** Exact Better Auth evidence for one direct managed request.
 *
 * This module is intentionally not re-exported from the package entry point.
 * Evidence is populated only by the successful direct Better Auth path in
 * access/index.ts and is kept request-local in a WeakMap.
 */
export type DirectManagedSessionEvidence = {
  userId: string;
  sessionId: string;
};

const evidenceByContext = new WeakMap<object, DirectManagedSessionEvidence>();

export function evidenceFor(context: AccessContext): DirectManagedSessionEvidence | null {
  return evidenceByContext.get(context as unknown as object) ?? null;
}

export function recordEvidence(
  context: AccessContext,
  evidence: DirectManagedSessionEvidence,
): void {
  if (!evidence.userId.trim() || !evidence.sessionId.trim()) {
    throw new Error("direct managed session evidence requires userId and sessionId");
  }
  evidenceByContext.set(context as unknown as object, { ...evidence });
}

export function copyEvidence(from: AccessContext, to: AccessContext): void {
  const evidence = evidenceFor(from);
  if (evidence) evidenceByContext.set(to as unknown as object, evidence);
}
