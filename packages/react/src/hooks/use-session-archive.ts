import type {
  SessionArchiveAction,
  SessionArchiveApplyResponse,
  SessionArchivePlanResponse,
  SessionArchivePlanRoot,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner } from "./internal";

const ARCHIVE_CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type UseSessionArchiveOptions = ClientOverride & {
  /** Required for unarchive; identifies the exact immutable seal to release. */
  targetSealId?: string | null | undefined;
};

export type UseSessionArchiveResult = {
  plan: SessionArchivePlanResponse | null;
  planning: boolean;
  applying: boolean;
  error: Error | null;
  prepare: () => Promise<SessionArchivePlanResponse | null>;
  apply: () => Promise<SessionArchiveApplyResponse | null>;
  reset: () => void;
  clearError: () => void;
};

type ExpectedArchiveTarget = {
  workspaceId: string;
  sessionId: string;
  action: SessionArchiveAction;
  targetSealId: string | null;
};

function expectedTargetSealId(
  action: SessionArchiveAction,
  targetSealId: string | null | undefined,
): string | null {
  if (action === "archive") {
    if (targetSealId !== undefined && targetSealId !== null) {
      throw new Error("Archive creates a new seal and cannot release an existing seal.");
    }
    return null;
  }
  if (!targetSealId) {
    throw new Error("Unarchive requires the exact archive seal to release.");
  }
  return targetSealId;
}

/**
 * Fail closed if a browser receives a plan for another workspace, action,
 * root, or seal. The API remains authoritative for checksum canonicalization;
 * this check prevents a stale/misrouted response from reaching confirmation.
 */
export function validateSingleRootSessionArchivePlan(
  plan: SessionArchivePlanResponse,
  expected: ExpectedArchiveTarget,
): SessionArchivePlanRoot {
  if (plan.manifest.workspaceId !== expected.workspaceId) {
    throw new Error("Archive plan workspace does not match the current workspace.");
  }
  if (plan.manifest.action !== expected.action) {
    throw new Error("Archive plan action does not match the requested action.");
  }
  if (!ARCHIVE_CHECKSUM_PATTERN.test(plan.manifestChecksum)) {
    throw new Error("Archive plan has an invalid manifest checksum.");
  }
  if (plan.manifest.roots.length !== 1 || plan.roots.length !== 1) {
    throw new Error("The session archive dialog accepts exactly one recursive root.");
  }

  const manifestRoot = plan.manifest.roots[0]!;
  const plannedRoot = plan.roots[0]!;
  if (
    manifestRoot.rootSessionId !== expected.sessionId ||
    plannedRoot.rootSessionId !== expected.sessionId
  ) {
    throw new Error("Archive plan root does not match the selected session.");
  }
  if (
    manifestRoot.targetSealId !== expected.targetSealId ||
    plannedRoot.targetSealId !== expected.targetSealId
  ) {
    throw new Error("Archive plan seal does not match the selected archive state.");
  }
  if (!ARCHIVE_CHECKSUM_PATTERN.test(plannedRoot.rootChecksum)) {
    throw new Error("Archive plan has an invalid root checksum.");
  }
  if (
    manifestRoot.memberCount !== manifestRoot.members.length ||
    plannedRoot.memberCount !== manifestRoot.memberCount ||
    plan.manifest.totalMemberCount !== manifestRoot.memberCount
  ) {
    throw new Error("Archive plan member coverage is inconsistent.");
  }
  const rootMember = manifestRoot.members.find((member) => member.sessionId === expected.sessionId);
  if (!rootMember || rootMember.parentSessionId !== null || rootMember.depth !== 0) {
    throw new Error("Archive plan does not contain the selected root at depth zero.");
  }
  const blockerFree = plannedRoot.blockers.length === 0;
  if (plannedRoot.canApply !== blockerFree || plan.canApply !== plannedRoot.canApply) {
    throw new Error("Archive plan blocker state is inconsistent.");
  }
  return plannedRoot;
}

function validateApplyResponse(
  response: SessionArchiveApplyResponse,
  plan: SessionArchivePlanResponse,
  expected: ExpectedArchiveTarget,
  operationKey: string,
): void {
  const plannedRoot = validateSingleRootSessionArchivePlan(plan, expected);
  const receipt = response.receipt;
  if (
    receipt.workspaceId !== expected.workspaceId ||
    receipt.action !== expected.action ||
    receipt.rootSessionId !== expected.sessionId ||
    receipt.operationKey !== operationKey ||
    receipt.idempotencyKey !== operationKey ||
    receipt.manifestChecksum !== plan.manifestChecksum ||
    receipt.rootChecksum !== plannedRoot.rootChecksum ||
    receipt.targetSealId !== expected.targetSealId ||
    receipt.memberCount !== plannedRoot.memberCount ||
    receipt.precondition.blockerCount !== 0 ||
    receipt.precondition.memberCount !== plannedRoot.memberCount
  ) {
    throw new Error("Archive receipt does not match the confirmed plan.");
  }
  if (
    !ARCHIVE_CHECKSUM_PATTERN.test(receipt.requestHash) ||
    !ARCHIVE_CHECKSUM_PATTERN.test(receipt.precondition.checksum) ||
    !ARCHIVE_CHECKSUM_PATTERN.test(receipt.coverageChecksum)
  ) {
    throw new Error("Archive receipt has invalid evidence checksums.");
  }
  if (
    !receipt.authority.actorSubjectId ||
    !receipt.authority.grantSubjectId ||
    !receipt.authority.grantAuthority
  ) {
    throw new Error("Archive receipt is missing authority evidence.");
  }
  if (
    expected.action === "archive" &&
    (receipt.targetSealId !== null ||
      receipt.resultingSealId === null ||
      receipt.sealId !== receipt.resultingSealId)
  ) {
    throw new Error("Archive receipt did not bind the resulting archive seal.");
  }
  if (
    expected.action === "unarchive" &&
    (receipt.targetSealId !== expected.targetSealId ||
      receipt.resultingSealId !== null ||
      receipt.sealId !== expected.targetSealId)
  ) {
    throw new Error("Unarchive receipt released a different archive seal.");
  }
  if (expected.action === "archive" && !response.rootArchive.archived) {
    throw new Error("Archive receipt did not produce an archived root projection.");
  }
}

/**
 * Plan and apply one recursive session-tree archive/unarchive operation.
 * Failed apply retries retain the same idempotency key; a new plan resets it.
 */
export function useSessionArchive(
  sessionId: string | null | undefined,
  action: SessionArchiveAction,
  options: UseSessionArchiveOptions = {},
): UseSessionArchiveResult {
  const { client, workspaceId } = useOpenGeni(options);
  const targetSealId = options.targetSealId;
  const [plan, setPlan] = useState<SessionArchivePlanResponse | null>(null);
  const generation = useRef(0);
  const idempotencyKey = useRef<string | null>(null);
  const {
    run: runPlan,
    mutating: planning,
    mutationError: planError,
    clearMutationError: clearPlanError,
  } = useMutationRunner();
  const {
    run: runApply,
    mutating: applying,
    mutationError: applyError,
    clearMutationError: clearApplyError,
  } = useMutationRunner();

  useEffect(() => {
    generation.current += 1;
    idempotencyKey.current = null;
    setPlan(null);
    clearPlanError();
    clearApplyError();
  }, [client, workspaceId, sessionId, action, targetSealId, clearPlanError, clearApplyError]);

  const prepare = useCallback(async (): Promise<SessionArchivePlanResponse | null> => {
    if (!sessionId) {
      return null;
    }
    const ticket = ++generation.current;
    idempotencyKey.current = null;
    setPlan(null);
    clearApplyError();
    const response = await runPlan(async () => {
      if (!client.planSessionArchive) {
        throw new Error("This OpenGeni client does not support session archival.");
      }
      const expectedSealId = expectedTargetSealId(action, targetSealId);
      const next = await client.planSessionArchive(workspaceId, {
        action,
        roots: [
          {
            rootSessionId: sessionId,
            ...(expectedSealId ? { targetSealId: expectedSealId } : {}),
          },
        ],
      });
      validateSingleRootSessionArchivePlan(next, {
        workspaceId,
        sessionId,
        action,
        targetSealId: expectedSealId,
      });
      return next;
    });
    if (response && ticket === generation.current) {
      setPlan(response);
    }
    return response;
  }, [action, clearApplyError, client, runPlan, sessionId, targetSealId, workspaceId]);

  const apply = useCallback(async (): Promise<SessionArchiveApplyResponse | null> => {
    return await runApply(async () => {
      if (!sessionId || !plan) {
        throw new Error("Prepare a current archive plan before applying it.");
      }
      if (!client.applySessionArchive) {
        throw new Error("This OpenGeni client does not support session archival.");
      }
      const expectedSealId = expectedTargetSealId(action, targetSealId);
      const expected = {
        workspaceId,
        sessionId,
        action,
        targetSealId: expectedSealId,
      };
      const plannedRoot = validateSingleRootSessionArchivePlan(plan, expected);
      if (!plan.canApply) {
        throw new Error("Settle every listed blocker, then prepare a new archive plan.");
      }
      const operationKey = idempotencyKey.current ?? globalThis.crypto.randomUUID();
      idempotencyKey.current = operationKey;
      const response = await client.applySessionArchive(workspaceId, {
        manifest: plan.manifest,
        manifestChecksum: plan.manifestChecksum,
        rootSessionId: sessionId,
        rootChecksum: plannedRoot.rootChecksum,
        idempotencyKey: operationKey,
      });
      validateApplyResponse(response, plan, expected, operationKey);
      return response;
    });
  }, [action, client, plan, runApply, sessionId, targetSealId, workspaceId]);

  const clearError = useCallback(() => {
    clearPlanError();
    clearApplyError();
  }, [clearApplyError, clearPlanError]);
  const reset = useCallback(() => {
    generation.current += 1;
    idempotencyKey.current = null;
    setPlan(null);
    clearError();
  }, [clearError]);

  return {
    plan,
    planning,
    applying,
    error: applyError ?? planError,
    prepare,
    apply,
    reset,
    clearError,
  };
}
