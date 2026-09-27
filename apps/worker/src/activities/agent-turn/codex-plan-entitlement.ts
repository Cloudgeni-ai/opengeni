// ChatGPT plan entitlement for Codex-billed turns.
//
// A connected ChatGPT account can move to a plan that no longer includes the
// requested model (production: Pro to Free, then every request answered with
// an empty HTTP 400). This module turns that evidence into a typed decision:
// re-check the account's current plan, and either exclude that credential for
// this model and let the normal failover protocol move the SAME turn, or fail
// with a typed, plain-language payload. It never retries the request itself.

import { productLabelForModelId } from "@opengeni/config";
import {
  codexPlanDisplayName,
  codexPlanEntitlementLost,
  codexPlanIsUpgrade,
  codexPlanKey,
  type CodexEntitlementRejection,
} from "@opengeni/codex";
import {
  codexPlanExcludesModel,
  codexPlanPreviouslyExcludedModel,
  connectionModelAllowed,
  type CodexCredentialPlanRecheck,
  type CodexPlanEntitlementExclusion,
} from "@opengeni/db";

export const CODEX_PLAN_ENTITLEMENT_CODE = "codex_plan_entitlement";
export const CODEX_REQUEST_REJECTED_CODE = "codex_request_rejected";

export type CodexPlanEntitlementFailurePayload = {
  error: string;
  code: typeof CODEX_PLAN_ENTITLEMENT_CODE;
  retryable: false;
  planType: string | null;
  model: string | null;
  detail?: string;
};

export type CodexRequestRejectedFailurePayload = {
  error: string;
  code: typeof CODEX_REQUEST_REJECTED_CODE;
  retryable: false;
  planType: string | null;
  detail?: string;
};

/**
 * The user-set label of one connected ChatGPT account. The account email is
 * deliberately never used: this text lands in the durable `turn.failed` event
 * that every session reader (including embedding-host end users) can see, and
 * an inherited organization credential's email may be a member's personal
 * address. Without a label the copy says "The connected ChatGPT account".
 */
export function codexAccountDisplayLabel(
  account: { label: string | null } | null | undefined,
): string | null {
  const label = account?.label?.trim() || null;
  return label ? label.slice(0, 120) : null;
}

function accountPhrase(accountLabel: string | null): string {
  return accountLabel ? `The ChatGPT account "${accountLabel}"` : "The connected ChatGPT account";
}

function rejectionDetail(rejection: CodexEntitlementRejection | null): string | undefined {
  if (!rejection) return undefined;
  return rejection.evidence === "empty_body"
    ? `The Codex backend answered HTTP ${rejection.status} with no error body.`
    : `The Codex backend refused the model for this plan (HTTP ${rejection.status}).`;
}

/** Terminal copy when the serving account's plan does not include the model. */
export function codexPlanEntitlementFailurePayload(input: {
  accountLabel: string | null;
  planType: string | null;
  planChanged: boolean;
  modelId: string | null;
  rejection?: CodexEntitlementRejection | null;
  /** The same turn waits for another connected account instead of failing. */
  waiting?: boolean;
}): CodexPlanEntitlementFailurePayload {
  const plan = codexPlanDisplayName(input.planType);
  const model = input.modelId ? productLabelForModelId(input.modelId) : "this model";
  const lead = accountPhrase(input.accountLabel);
  const next = input.waiting
    ? "OpenGeni is waiting for another connected account to become available."
    : "Upgrade it, use another connected account, or choose another model.";
  const error = plan
    ? `${lead} ${input.planChanged ? "is now" : "is"} on the ${plan} plan, which doesn't include ${model}. ${next}`
    : `${lead} no longer has access to ${model} on its current plan. ${next}`;
  const detail = rejectionDetail(input.rejection ?? null);
  return {
    error,
    code: CODEX_PLAN_ENTITLEMENT_CODE,
    retryable: false,
    planType: plan ? codexPlanKey(input.planType) : null,
    model: input.modelId,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Terminal copy for an empty Codex rejection. With `planChecked`, the account's
 * plan was re-read and did not explain it, so OpenGeni kept the account.
 */
export function codexRequestRejectedFailurePayload(input: {
  accountLabel: string | null;
  planType: string | null;
  rejection: CodexEntitlementRejection;
  planChecked?: boolean;
}): CodexRequestRejectedFailurePayload {
  const plan = codexPlanDisplayName(input.planType);
  const lead = accountPhrase(input.accountLabel);
  const planClause =
    input.planChecked === false
      ? ""
      : plan
        ? `${lead} still reports the ${plan} plan, so OpenGeni did not switch accounts. `
        : `OpenGeni could not confirm the current plan of ${lead.charAt(0).toLowerCase()}${lead.slice(1)}, so it did not switch accounts. `;
  return {
    error:
      `The Codex backend rejected this request (HTTP ${input.rejection.status}) without an error message. ` +
      `${planClause}Try again, or choose another model if it keeps failing.`,
    code: CODEX_REQUEST_REJECTED_CODE,
    retryable: false,
    planType: plan ? codexPlanKey(input.planType) : null,
    ...(rejectionDetail(input.rejection) ? { detail: rejectionDetail(input.rejection)! } : {}),
  };
}

/**
 * Admission-time refusal: the only accounts that could serve this turn were
 * already proven not to include its model on their current plan.
 */
export class CodexPlanEntitlementError extends Error {
  readonly code = CODEX_PLAN_ENTITLEMENT_CODE;
  constructor(readonly payload: CodexPlanEntitlementFailurePayload) {
    super(payload.error);
    this.name = "CodexPlanEntitlementError";
  }
}

export type CodexPlanEntitlementAssessment =
  | {
      kind: "entitlement_lost";
      /**
       * Plan the exclusion binds to: the freshly observed plan, or the
       * recorded plan when the provider reported none.
       */
      planType: string | null;
      /** The provider reported the current plan during this re-check. */
      planObserved: boolean;
      /** The observed plan was reached by a recorded (non-upgrade) plan change. */
      planChanged: boolean;
      credentialVersion: number | null;
    }
  | { kind: "unexplained"; planType: string | null };

/** Pure decision over one plan re-check (see `codexPlanEntitlementLost`). */
export function assessCodexPlanEntitlement(
  rejection: CodexEntitlementRejection,
  recheck: CodexCredentialPlanRecheck,
  modelId: string | null,
): CodexPlanEntitlementAssessment {
  const planObserved = recheck.planType !== null;
  // The persisted change record, or (if that write did not land) the plan
  // recorded just before this re-check when the fresh observation differs.
  const planChangedFrom =
    planObserved &&
    recheck.previousPlanType !== null &&
    codexPlanKey(recheck.previousPlanType) !== codexPlanKey(recheck.planType)
      ? recheck.previousPlanType
      : recheck.planChangedFrom;
  const planChanged =
    planObserved &&
    planChangedFrom !== null &&
    codexPlanKey(planChangedFrom) !== codexPlanKey(recheck.planType) &&
    !codexPlanIsUpgrade(planChangedFrom, recheck.planType);
  if (
    codexPlanEntitlementLost({
      evidence: rejection.evidence,
      currentPlanType: recheck.planType,
      planChangedFrom,
      previouslyExcluded:
        planObserved &&
        codexPlanPreviouslyExcludedModel(
          { planType: recheck.planType, planEntitlementExclusion: recheck.exclusion },
          modelId,
        ),
    })
  ) {
    return {
      kind: "entitlement_lost",
      planType: planObserved ? recheck.planType : recheck.previousPlanType,
      planObserved,
      planChanged,
      credentialVersion: recheck.credentialVersion,
    };
  }
  return { kind: "unexplained", planType: recheck.planType };
}

type AdmissionAccount = {
  id: string;
  label: string | null;
  planType: string | null;
  allocatorEnabled: boolean;
  allowedModelIds?: string[] | null;
  planEntitlementExclusion?: CodexPlanEntitlementExclusion | null;
};

/**
 * Pure admission check after credential selection found no account. Returns
 * the plan-excluded accounts that alone explain it, or null when capacity,
 * health, or policy (not plan entitlement) is the reason:
 *
 * - a manual pin (user intent) whose account's plan excludes the model;
 * - with rotation off, the active account's plan excludes the model;
 * - with rotation on, every allocatable account permitted for the model is
 *   plan-excluded.
 */
export function codexPlanEntitlementAdmissionBlock<T extends AdmissionAccount>(input: {
  accounts: readonly T[];
  modelId: string;
  credentialId: string | null;
  rotationEnabled: boolean;
  activeCredentialId: string | null;
  pinnedCredentialId: string | null;
  pinSource: "manual" | "policy" | null;
  now: Date;
}): T[] | null {
  if (input.credentialId !== null) return null;
  const permitted = input.accounts.filter((account) =>
    connectionModelAllowed(account.allowedModelIds, input.modelId),
  );
  const excluded = permitted.filter((account) =>
    codexPlanExcludesModel(account, input.modelId, input.now),
  );
  if (excluded.length === 0) return null;
  if (input.pinnedCredentialId && input.pinSource !== "policy") {
    const pinned = excluded.find((account) => account.id === input.pinnedCredentialId);
    return pinned ? [pinned] : null;
  }
  if (!input.rotationEnabled) {
    const active = excluded.find((account) => account.id === input.activeCredentialId);
    return active ? [active] : null;
  }
  const allocatable = permitted.filter((account) => account.allocatorEnabled);
  const allocatableExcluded = allocatable.filter((account) =>
    codexPlanExcludesModel(account, input.modelId, input.now),
  );
  return allocatable.length > 0 && allocatableExcluded.length === allocatable.length
    ? allocatableExcluded
    : null;
}
