import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";

/** Structural V2 correlation scope. This is deliberately NOT an actor/grant. */
export type ModalNativeLiveOriginScope = Readonly<{
  version: 2;
  declarationId: string;
  planId: string;
  creatorId: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  triggerEventId: string;
  sandboxGroupId: string;
  routeKind: "home";
  routeTargetId: null;
  routeEpoch: number;
}>;

export type ModalNativeLiveOriginProjection = Readonly<{
  version: 1;
  scope: ModalNativeLiveOriginScope;
  initiator: {
    kind: "subject" | "service";
    subjectId: string;
    initiatingHumanSubjectId: string;
  };
  membership: {
    id: string;
    authorizationRevision: string;
    basis: "workspace_membership" | "personal_workspace";
  };
  acceptedAuthority: {
    epoch: number;
    visibility: "user_private" | "workspace_shared";
    ownerOrganizationMembershipId: string | null;
  };
  currentAuthority: {
    epoch: number;
    executionEpoch: number;
    visibility: "user_private" | "workspace_shared";
    ownerSubjectId: string | null;
    ownerOrganizationMembershipId: string | null;
  };
  control: { workspaceRevision: string; sessionVersion: string };
  execution: { workflowId: string; workflowRunId: string; activityId: string };
  providerRecoveryCount: 0 | 1 | 2 | 3 | 4 | 5;
  checkedAt: string;
}>;

export type ModalNativeLiveOriginResult =
  | { kind: "live"; projection: ModalNativeLiveOriginProjection }
  | { kind: "fenced" }
  | {
      kind: "unsupported";
      reason: "invalid_scope" | "human_unavailable" | "external_authority" | "not_premodel";
    };

const keys = [
  "version",
  "declarationId",
  "planId",
  "creatorId",
  "accountId",
  "workspaceId",
  "sessionId",
  "turnId",
  "attemptId",
  "executionGeneration",
  "triggerEventId",
  "sandboxGroupId",
  "routeKind",
  "routeTargetId",
  "routeEpoch",
] as const;
const ids = [
  "declarationId",
  "planId",
  "creatorId",
  "accountId",
  "workspaceId",
  "sessionId",
  "turnId",
  "attemptId",
  "triggerEventId",
  "sandboxGroupId",
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function scopeSnapshot(value: ModalNativeLiveOriginScope): ModalNativeLiveOriginScope | null {
  if (!value || typeof value !== "object") return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  if (ids.some((key) => typeof copy[key] !== "string" || !uuid.test(copy[key] as string)))
    return null;
  if (
    copy.version !== 2 ||
    copy.routeKind !== "home" ||
    copy.routeTargetId !== null ||
    copy.creatorId === copy.attemptId ||
    copy.creatorId === copy.planId ||
    !Number.isSafeInteger(copy.executionGeneration) ||
    (copy.executionGeneration as number) < 1 ||
    (copy.executionGeneration as number) > 2_147_483_647 ||
    !Number.isSafeInteger(copy.routeEpoch) ||
    (copy.routeEpoch as number) < 0 ||
    (copy.routeEpoch as number) > 2_147_483_647
  )
    return null;
  return Object.freeze(copy) as ModalNativeLiveOriginScope;
}

/**
 * Private-server integration primitive, NOT host authentication or a grant.
 * The caller must authenticate the exact host request separately and consume
 * this projection in this SAME transaction. No native/provider awaits here.
 * Enter before taking any tenancy/control/session/lease lock: SQL acquires the
 * organization-membership -> tenancy -> canonical control/row prefix itself.
 * Preserves all subject and tenant GUCs. SQL uncertainty propagates (including
 * 55P03); no failed/aborted transaction is reported as successful admission.
 */
export async function lockLiveNativeOriginalOriginTx(
  scopedTx: Database,
  scope: ModalNativeLiveOriginScope,
): Promise<ModalNativeLiveOriginResult> {
  if (typeof (scopedTx as Database & { rollback?: unknown }).rollback !== "function") {
    throw new Error("LIVE native origin projection requires an existing transaction");
  }
  const snapshot = scopeSnapshot(scope);
  if (!snapshot) return { kind: "unsupported", reason: "invalid_scope" };
  const [row] = await rawRows<{ result: ModalNativeLiveOriginResult }>(
    scopedTx,
    sql`select lock_live_native_original_origin_v2(${JSON.stringify(snapshot)}::jsonb) as result`,
  );
  if (!row || !["live", "fenced", "unsupported"].includes(row.result?.kind)) {
    throw new Error("Invalid LIVE native origin database projection");
  }
  return row.result;
}
