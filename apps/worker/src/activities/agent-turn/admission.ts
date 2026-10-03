import {
  checkWorkspaceAllowance,
  getBillingBalance,
  openUsageReservationQuantity,
  sumUsageQuantity,
  tryReserveUsageBudget,
  type UsageEventWriteInput,
} from "@opengeni/db";
import {
  estimateAgentToolSchemaTokens,
  estimateSerializedValueTokens,
  estimateTokensBreakdown,
  type CompactionItem,
} from "@opengeni/runtime";
import {
  calculateModelUsageCostBreakdown,
  configuredModelPricingSchedules,
  configuredStaticUsageLimits,
  resolveTurnExecutionPolicyV1,
  type Settings,
} from "@opengeni/config";
import { selectCodexCredentialId } from "@opengeni/codex";
import { directPersonalConnectionSubjectId } from "@opengeni/core";
import type { TurnActivityServices as ActivityServices } from "../types";
import {
  type LatencyMode,
  type AllowanceExhaustedRefusal,
  type SessionEvent,
  type SessionTurn,
  type ToolAuthNeededPayload,
  type TurnExecutionPolicyV1,
  type XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import { createHash, randomUUID } from "node:crypto";
import { startOfUtcMonth } from "./model-usage";

export class WorkspaceHumanInputDisabledError extends Error {
  constructor(kind: "resume" | "interruption") {
    super(`Workspace policy rejects structured human-input ${kind}`);
    this.name = "WorkspaceHumanInputDisabledError";
  }
}

export function assertWorkspaceHumanInputAllowed(
  enabled: boolean,
  kind: "resume" | "interruption",
  attempted: boolean,
): void {
  if (!enabled && attempted) throw new WorkspaceHumanInputDisabledError(kind);
}

/** Broad personal lookup is allowed only for a direct human/API command. */
export function credentialSubjectIdForTurnInitiator(
  turn: Pick<SessionTurn, "source" | "initiator" | "initiatorContext">,
): string | undefined {
  return directPersonalConnectionSubjectId(turn);
}

export function xaiCatalogReadinessAuthority(
  turn: {
    initiatingHumanSubjectId: string | null;
    xaiProviderAccountAuthoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
  },
  directCredentialSubjectId: string | undefined,
): {
  subjectId: string;
  authoritySnapshot: XaiProviderAccountAuthoritySnapshotV1;
} | null {
  const subjectId = turn.initiatingHumanSubjectId ?? directCredentialSubjectId;
  return subjectId
    ? { subjectId, authoritySnapshot: turn.xaiProviderAccountAuthoritySnapshot }
    : null;
}

/**
 * Direct authenticated-human work is the persisted human source with subject
 * authority and no inherited agent or legacy provenance. Use this complete
 * immutable turn authority instead of inferring causality from a
 * `user.message` event shape or the root initiator alone.
 */
export function isDirectHumanTurnInitiation(
  turn: Pick<SessionTurn, "source" | "initiator" | "initiatorContext">,
): boolean {
  if ((turn.source !== "user" && turn.source !== "api") || turn.initiator.kind !== "subject") {
    return false;
  }
  return !["via", "viaTruncated", "provenanceError", "backfill"].some((key) =>
    Object.prototype.hasOwnProperty.call(turn.initiatorContext, key),
  );
}

/**
 * A disconnected personal Slack server is prepared best-effort before the model
 * runs. Its initialize/tools-list credential miss is setup state, not evidence
 * that an unrelated turn wants Slack. Keep concrete tool-call failures
 * actionable, but gate setup-time Slack prompts to a human message that names
 * Slack explicitly. Other providers retain the existing generic behavior.
 */
export function shouldPublishToolAuthNeededForTurn(
  payload: Pick<ToolAuthNeededPayload, "providerDomain" | "toolName">,
  trigger: Pick<SessionEvent, "type" | "payload">,
  turn: Pick<SessionTurn, "source" | "initiator" | "initiatorContext">,
): boolean {
  if (typeof payload.toolName === "string" && payload.toolName.trim().length > 0) {
    return true;
  }
  const providerDomain = payload.providerDomain.trim().toLowerCase();
  const isSlack = providerDomain === "slack.com" || providerDomain.endsWith(".slack.com");
  if (!isSlack) {
    return true;
  }
  if (!isDirectHumanTurnInitiation(turn) || trigger.type !== "user.message") {
    return false;
  }
  const text = (trigger.payload as { text?: unknown }).text;
  return typeof text === "string" && /\bslack\b/i.test(text);
}

/**
 * Keep host-owned auth events inert in browsers from before authoritySource
 * existed. Those bundles treat unsupported_auth as unavailable and therefore
 * do not invoke native OAuth; upgraded clients read hostReason and the
 * host-minted authorizationUrl.
 */
export function rollingSafeToolAuthNeededPayload(
  payload: ToolAuthNeededPayload,
): ToolAuthNeededPayload {
  if (payload.authoritySource !== "host") {
    return payload;
  }
  return {
    ...payload,
    reason: "unsupported_auth",
    hostReason: payload.hostReason ?? payload.reason,
  };
}

export function turnExecutionPolicyBillingIdentity(policy: TurnExecutionPolicyV1): {
  externallyBilled: boolean;
  countsTowardTokenCap: boolean;
  codexSubscription: boolean;
  xaiSubscription: boolean;
} {
  return {
    externallyBilled: policy.billing.metering === "external",
    countsTowardTokenCap: policy.billing.upstreamPayer === "deployment",
    codexSubscription:
      policy.providerId === "codex-subscription" &&
      policy.credentialSource.kind === "connected_subscription" &&
      policy.credentialSource.provider === "codex",
    xaiSubscription:
      policy.providerId === "supergrok-subscription" &&
      policy.credentialSource.kind === "connected_subscription" &&
      policy.credentialSource.provider === "xai",
  };
}

export function legacyTurnExecutionPolicyInput(
  turn: Pick<SessionTurn, "source" | "model" | "reasoningEffort" | "latencyMode">,
): Parameters<typeof resolveTurnExecutionPolicyV1>[1] {
  const explicit = turn.source === "user" || turn.source === "api";
  return {
    modelId: turn.model,
    requestedModelId: explicit ? turn.model : null,
    modelSource: explicit ? "explicit" : "continuation",
    reasoningEffort: turn.reasoningEffort,
    reasoningSource: explicit ? "explicit" : "continuation",
    latencyMode: turn.latencyMode,
    latencyModeSource: explicit ? "explicit" : "continuation",
  };
}

/** A retryable provider fault recovers the accepted turn itself. Goal state is
 * irrelevant: autonomous continuation and infrastructure recovery are separate
 * concerns. */
export function selectCodexCredentialForTurn(args: {
  sessionPinnedCredentialId: string | null;
  activeCredentialId: string | null;
  connectedIds: Set<string>;
}): string | null {
  return selectCodexCredentialId(args);
}

export function stableHumanInputRequestId(
  sessionId: string,
  turnId: string,
  toolCallId: string,
): string {
  const hex = createHash("sha256")
    .update("opengeni-human-input-v1\0")
    .update(sessionId)
    .update("\0")
    .update(turnId)
    .update("\0")
    .update(toolCallId)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function stableInteractionInterventionId(
  sessionId: string,
  turnId: string,
  toolCallId: string,
): string {
  return stableInteractionInterventionUuid(
    "opengeni-interaction-intervention-v1",
    sessionId,
    turnId,
    toolCallId,
  );
}

export function stableInteractionInterventionOperationId(
  sessionId: string,
  turnId: string,
  toolCallId: string,
): string {
  return stableInteractionInterventionUuid(
    "opengeni-interaction-intervention-operation-v1",
    sessionId,
    turnId,
    toolCallId,
  );
}

export function stableInteractionInterventionUuid(
  namespace: string,
  sessionId: string,
  turnId: string,
  toolCallId: string,
): string {
  const hex = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(turnId)
    .update("\0")
    .update(toolCallId)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * True when this activity attempt was cancelled because its hosting worker is
 * shutting down gracefully (SIGTERM during a deploy), as opposed to a
 * workflow-requested Pause/Steer cancellation or a server-side timeout.
 */
export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly serializedRunState: string | null,
    readonly allowance: AllowanceRefusal | null = null,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * The provider-call admission gate throws BudgetExhaustedError inside the
 * SDK's per-call input filter, where the runner may wrap it before the error
 * reaches the stream consumer. Walk the cause chain like
 * findCompactionNeededError so the budget valve still recognizes it.
 */
export function findBudgetExhaustedError(
  error: unknown,
  seen = new WeakSet<object>(),
): BudgetExhaustedError | null {
  if (error instanceof BudgetExhaustedError) {
    return error;
  }
  if (!error || typeof error !== "object" || seen.has(error)) {
    return null;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  return (
    findBudgetExhaustedError(record.cause, seen) ?? findBudgetExhaustedError(record.error, seen)
  );
}

export function usageReservationSourceId(
  turnId: string,
  turnAttemptId: string,
  ordinal: string | number,
): string {
  return `model_call_reservation:${turnId}:${turnAttemptId}:${ordinal}`;
}

export function usageReservationIdempotencyKey(
  reservedEventType: string,
  turnId: string,
  turnAttemptId: string,
  ordinal: string | number,
): string {
  return `usage:${reservedEventType}:${turnId}:${turnAttemptId}:${ordinal}`;
}

/**
 * Negative-quantity usage writes that release admitted holds. Idempotency-
 * keyed per call identity so authoritative usage reconciliation can retry
 * the same release safely; only the first lands.
 */
export function usageReservationReleaseEvents(input: {
  reservations: Iterable<readonly [string | number, { tokens?: number; costMicros?: number }]>;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
}): UsageEventWriteInput[] {
  const context = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    turnAttemptId: input.turnAttemptId,
  };
  const events: UsageEventWriteInput[] = [];
  for (const [ordinal, held] of input.reservations) {
    if (held.tokens && held.tokens > 0) {
      events.push({
        eventType: "model.tokens.reserved",
        quantity: -held.tokens,
        unit: "tokens",
        sourceResourceType: "model_call_reservation",
        sourceResourceId: usageReservationSourceId(input.turnId, input.turnAttemptId, ordinal),
        ...context,
        idempotencyKey: `${usageReservationIdempotencyKey(
          "model.tokens.reserved",
          input.turnId,
          input.turnAttemptId,
          ordinal,
        )}:release`,
      });
    }
    if (held.costMicros && held.costMicros > 0) {
      events.push({
        eventType: "model.cost.reserved",
        quantity: -held.costMicros,
        unit: "usd_micros",
        sourceResourceType: "model_call_reservation",
        sourceResourceId: usageReservationSourceId(input.turnId, input.turnAttemptId, ordinal),
        ...context,
        idempotencyKey: `${usageReservationIdempotencyKey(
          "model.cost.reserved",
          input.turnId,
          input.turnAttemptId,
          ordinal,
        )}:release`,
      });
    }
  }
  return events;
}

/**
 * Actual prompt size of the exact payload the provider is about to see: input
 * items + instructions + tool schemas, the same footprint the context
 * robustness filter measures. Called only at the producer-side admission
 * gate, where `modelData` is the final per-call payload.
 */
export function estimateModelCallPromptTokens(call: {
  modelData: { input: readonly unknown[]; instructions?: string | null };
  agent: unknown;
}): number {
  return (
    estimateTokensBreakdown(call.modelData.input as CompactionItem[]).totalTokens +
    estimateSerializedValueTokens(call.modelData.instructions ?? "") +
    estimateAgentToolSchemaTokens(call.agent as Parameters<typeof estimateAgentToolSchemaTokens>[0])
  );
}

/** Conservative input/context and output bounds, priced across all token classes and tiers. */
export function modelCallReservationQuantities(input: {
  settings: Settings;
  model: string;
  promptTokens: number;
  contextWindowTokens: number;
  latencyMode?: LatencyMode;
  maxOutputTokens?: number;
}): { tokens: number; costMicros: number | null } {
  const reservedOutput = input.maxOutputTokens ?? input.settings.contextReservedOutputTokens;
  // Prompt heuristics are unsuitable as financial bounds. Reserve the selected
  // provider's entire input window and clamp the dispatched output separately.
  const inputBound = Math.max(1, Math.floor(input.contextWindowTokens));
  const tokens = inputBound + reservedOutput;
  const schedules = configuredModelPricingSchedules(input.settings);
  const pricedModel = schedules[input.model]
    ? input.model
    : input.model.startsWith("codex/") && schedules[input.model.slice("codex/".length)]
      ? input.model.slice("codex/".length)
      : null;
  let costMicros: number | null = null;
  if (pricedModel) {
    const schedule = schedules[pricedModel]!;
    const prices = [
      schedule.default,
      ...(schedule.inputTokenTiers ?? []).map((tier) => tier.pricing),
    ];
    const worst = {
      inputMicrosPerMillionTokens: Math.max(
        ...prices.flatMap((price) => [
          price.inputMicrosPerMillionTokens,
          price.cachedInputMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens,
          price.cacheWriteMicrosPerMillionTokens ?? price.inputMicrosPerMillionTokens,
        ]),
      ),
      outputMicrosPerMillionTokens: Math.max(
        ...prices.map((price) => price.outputMicrosPerMillionTokens),
      ),
      marginBps: Math.max(...prices.map((price) => price.marginBps ?? 0)),
    };
    costMicros = calculateModelUsageCostBreakdown(
      { ...input.settings, modelPricingJson: JSON.stringify({ [pricedModel]: worst }) },
      pricedModel,
      { inputTokens: inputBound, outputTokens: reservedOutput, totalTokens: tokens },
      { latencyMode: input.latencyMode ?? "standard" },
    ).creditCostMicros;
  }
  return { tokens, costMicros };
}

export type AllowanceRefusal = AllowanceExhaustedRefusal;

/** Account allowance exhaustion is recoverable state, never a provider failure. */
export class AllowanceExhaustedError extends Error {
  readonly code = "allowance_exhausted";

  constructor(readonly refusal: AllowanceRefusal) {
    super(refusal.message);
    this.name = "AllowanceExhaustedError";
  }
}

/** Revalidate between paid calls without replaying provider work or reserving credits. */
export async function ensureRunAllowedBetweenModelCalls(input: {
  settings: Settings;
  db: ActivityServices["db"];
  accountId: string;
  workspaceId: string;
  isExternallyBilledTurn: boolean;
  entitlements?: ActivityServices["entitlements"];
  chargesOpenGeniCredits: boolean;
  countsTowardTokenCap: boolean;
  initiatingHumanSubjectId: string | null;
  serializedRunState?: () => string | null;
  monthlyBudgetReserved?: boolean;
}): Promise<void> {
  try {
    await ensureRunAllowed(
      input.settings,
      input.db,
      input.accountId,
      input.workspaceId,
      input.isExternallyBilledTurn,
      input.entitlements,
      input.chargesOpenGeniCredits,
      input.countsTowardTokenCap,
      input.initiatingHumanSubjectId,
      null,
      input.monthlyBudgetReserved,
    );
  } catch (limitError) {
    if (
      !(limitError instanceof UsageBudgetExceededError) &&
      !(limitError instanceof AllowanceExhaustedError)
    )
      throw limitError;
    let serializedRunState: string | null = null;
    try {
      serializedRunState = input.serializedRunState?.() ?? null;
    } catch {
      // Durable history remains authoritative when the SDK state cannot serialize.
    }
    throw new BudgetExhaustedError(
      limitError instanceof Error ? limitError.message : String(limitError),
      serializedRunState,
      limitError instanceof AllowanceExhaustedError ? limitError.refusal : null,
    );
  }
}

// Exported for unit testing the external-billing bypass (codex-billing.test.ts); not
// part of the activity surface. Takes the accepted policy's billing attribution and
// the optional §7.5 P3 host `entitlements` port (when bound, its `admitRun` REPLACES
// the local credit read for an OpenGeni-metered turn; unset → local ledger).
//
// When `reservation` is supplied the monthly caps are enforced with a bounded,
// atomic hold written BEFORE the provider call: the returned quantities are the
// committed hold (the complete requested bound) that the caller must later
// release through usageReservationReleaseEvents. Concurrent turns serialize on
// the account reservation lock, so they cannot spend the same remaining
// balance; without `reservation` the same caps are enforced read-only,
// including other turns' open holds.
export async function ensureRunAllowed(
  settings: Settings,
  db: ActivityServices["db"],
  accountId: string,
  workspaceId: string,
  isExternallyBilledTurn: boolean,
  entitlements?: ActivityServices["entitlements"],
  chargesOpenGeniCredits = !isExternallyBilledTurn,
  countsTowardTokenCap = !isExternallyBilledTurn,
  initiatingHumanSubjectId: string | null = null,
  reservation?: {
    sessionId: string;
    turnId: string;
    turnAttemptId: string;
    ordinal: string | number;
    tokens?: number | null;
    costMicros?: number | null;
  } | null,
  monthlyBudgetReserved = false,
): Promise<{ tokens?: number; costMicros?: number } | null> {
  // Upstream settlement and workspace-facing cost are independent. External
  // metering skips the token cap; free/subscription/workspace cost skips the
  // OpenGeni credit gate. The agent-run COUNT cap below is a volume/fairness
  // quota and is intentionally kept for every funding path.
  //
  // §7.5 P3 — host-entitlements DELEGATION (the worker half of the same seam the
  // API edge exposes). For a non-codex turn, when the host binds `entitlements`, its
  // `admitRun` decision REPLACES the local credit-balance read below: a host that owns
  // its ledger/meter is the funding authority. A deny throws the SAME Error the local
  // read throws, so the mid-stream budget-valve at :727 wraps it in a
  // `BudgetExhaustedError` and pauses identically — the valve never learns whether the
  // deny came from the local ledger or the host meter.
  //
  // This is an admission READ only; it records NO usage (metering stays the sole,
  // idempotency-keyed writer at recordModelUsageAndDebitCredits), so a PULL host meter
  // is consulted without ever double-charging.
  if (
    chargesOpenGeniCredits &&
    entitlements &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const decision = await entitlements.admitRun({
      accountId,
      workspaceId,
      action: "agent_run:create",
      quantity: 1,
    });
    if (!decision.allowed) {
      throw new UsageBudgetExceededError(decision.reason || "insufficient OpenGeni credits");
    }
  } else if (
    chargesOpenGeniCredits &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      throw new UsageBudgetExceededError("insufficient OpenGeni credits");
    }
  }
  if (chargesOpenGeniCredits) {
    const refusal = await checkWorkspaceAllowance(db, {
      accountId,
      workspaceId,
      subjectId: initiatingHumanSubjectId,
    });
    if (refusal) throw new AllowanceExhaustedError(refusal);
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    const monthStart = startOfUtcMonth();
    if (limits.maxMonthlyAgentRunsPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "agent_run.created",
        since: monthStart,
      });
      // Agent turns are admitted and recorded before this worker activity starts.
      // Equality means this accepted turn is exactly at the cap; greater-than is
      // the race/backstop case where another admission already exceeded the cap.
      if (used > limits.maxMonthlyAgentRunsPerWorkspace) {
        throw new UsageBudgetExceededError(
          `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`,
        );
      }
    }
    // Mid-stream caps: other turns' open holds count against the remaining
    // budget so a parallel turn cannot spend the same headroom, and an
    // already-committed call-in-flight reserves its bounded share before the
    // next provider request is admitted.
    const enforceTokenCap =
      !monthlyBudgetReserved && countsTowardTokenCap && limits.maxMonthlyTokensPerWorkspace;
    const enforceCostCap =
      !monthlyBudgetReserved && chargesOpenGeniCredits && limits.maxMonthlyCostMicrosPerAccount;
    if (enforceTokenCap || enforceCostCap) {
      const openReservationSince = new Date(0);
      const capCheck = async (
        eventType: string,
        reservedEventType: string,
        scope: { accountId: string } | { workspaceId: string },
        cap: number,
      ): Promise<void> => {
        const [used, openReserved] = await Promise.all([
          sumUsageQuantity(db, { ...scope, eventType, since: monthStart }),
          // Net each hold with its own releases across all accounting windows.
          openUsageReservationQuantity(db, {
            accountId,
            ...scope,
            eventType: reservedEventType,
            since: monthStart,
            holdSince: openReservationSince,
          }),
        ]);
        if (used + openReserved >= cap) {
          throw new UsageBudgetExceededError(
            `${eventType === "model.tokens" ? "monthly token" : "monthly cost"} limit reached (${cap})`,
          );
        }
      };
      if (reservation && enforceCostCap && reservation.costMicros == null) {
        throw new Error("Cannot bound model cost: configured model pricing is required");
      }
      const requests: NonNullable<Parameters<typeof tryReserveUsageBudget>[1]["reservations"]> = [];
      if (enforceTokenCap && reservation?.tokens != null) {
        requests.push({
          eventType: "model.tokens",
          reservedEventType: "model.tokens.reserved",
          scope: "workspace" as const,
          cap: limits.maxMonthlyTokensPerWorkspace!,
          quantity: reservation.tokens,
          unit: "tokens",
          idempotencyKey: usageReservationIdempotencyKey(
            "model.tokens.reserved",
            reservation.turnId,
            reservation.turnAttemptId,
            reservation.ordinal,
          ),
          sourceResourceId: usageReservationSourceId(
            reservation.turnId,
            reservation.turnAttemptId,
            reservation.ordinal,
          ),
        });
      }
      if (enforceCostCap && reservation?.costMicros != null) {
        requests.push({
          eventType: "model.cost",
          reservedEventType: "model.cost.reserved",
          scope: "account" as const,
          cap: limits.maxMonthlyCostMicrosPerAccount!,
          quantity: reservation.costMicros,
          unit: "usd_micros",
          idempotencyKey: usageReservationIdempotencyKey(
            "model.cost.reserved",
            reservation.turnId,
            reservation.turnAttemptId,
            reservation.ordinal,
          ),
          sourceResourceId: usageReservationSourceId(
            reservation.turnId,
            reservation.turnAttemptId,
            reservation.ordinal,
          ),
        });
      }
      let held: { tokens?: number; costMicros?: number } | null = null;
      if (reservation && requests.length > 0) {
        const result = await tryReserveUsageBudget(db, {
          accountId,
          workspaceId,
          sessionId: reservation.sessionId,
          turnId: reservation.turnId,
          turnAttemptId: reservation.turnAttemptId,
          since: monthStart,
          openReservationSince,
          reservations: requests,
        });
        if (!result.allowed) {
          if ("attemptClosed" in result) {
            // The attempt closed while this call awaited admission — not a
            // budget verdict. Surface it as an ordinary failure so the
            // budget valve does not mislabel the turn's terminal settle.
            throw new Error("turn attempt closed before provider dispatch; reservation refused");
          }
          throw new UsageBudgetExceededError(
            `${result.eventType === "model.tokens" ? "monthly token" : "monthly cost"} limit reached (${result.cap})`,
          );
        }
        held = {};
        for (const request of requests) {
          const hold = result.holds.find((h) => h.idempotencyKey === request.idempotencyKey);
          if (request.reservedEventType === "model.tokens.reserved") {
            held.tokens = hold?.quantity ?? 0;
          } else {
            held.costMicros = hold?.quantity ?? 0;
          }
        }
      }
      // Kinds a caller could not price (or a check-only admission) still get
      // the mid-stream cap read; open holds count toward the spend.
      if (enforceTokenCap && reservation?.tokens == null) {
        await capCheck(
          "model.tokens",
          "model.tokens.reserved",
          { workspaceId },
          limits.maxMonthlyTokensPerWorkspace!,
        );
      }
      if (enforceCostCap && reservation?.costMicros == null) {
        await capCheck(
          "model.cost",
          "model.cost.reserved",
          { accountId },
          limits.maxMonthlyCostMicrosPerAccount!,
        );
      }
      return held;
    }
  }
  return null;
}

export class UsageBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageBudgetExceededError";
  }
}

/** One fresh durable grant per dispatched call, including standalone compaction. */
export async function reserveModelCallBudget(input: {
  settings: Settings;
  db: ActivityServices["db"];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  model: string;
  isExternallyBilledTurn: boolean;
  entitlements?: ActivityServices["entitlements"];
  chargesOpenGeniCredits: boolean;
  countsTowardTokenCap: boolean;
  initiatingHumanSubjectId: string | null;
  latencyMode?: LatencyMode;
  maxOutputTokens?: number;
}): Promise<{
  callId: string;
  held: { tokens?: number; costMicros?: number } | null;
  maxOutputTokens: number;
  reservationReleases: UsageEventWriteInput[];
}> {
  const callId = randomUUID();
  const maxOutputTokens = Math.max(
    1,
    Math.floor(input.maxOutputTokens ?? input.settings.contextReservedOutputTokens),
  );
  const quantities = modelCallReservationQuantities({
    settings: input.settings,
    model: input.model,
    promptTokens: 0,
    contextWindowTokens: input.settings.contextWindowTokens,
    latencyMode: input.latencyMode ?? "standard",
    maxOutputTokens,
  });
  let held: { tokens?: number; costMicros?: number } | null;
  try {
    held = await ensureRunAllowed(
      input.settings,
      input.db,
      input.accountId,
      input.workspaceId,
      input.isExternallyBilledTurn,
      input.entitlements,
      input.chargesOpenGeniCredits,
      input.countsTowardTokenCap,
      input.initiatingHumanSubjectId,
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        turnAttemptId: input.turnAttemptId,
        ordinal: callId,
        ...quantities,
      },
    );
  } catch (error) {
    if (!(error instanceof UsageBudgetExceededError) && !(error instanceof AllowanceExhaustedError))
      throw error;
    throw new BudgetExhaustedError(
      error.message,
      null,
      error instanceof AllowanceExhaustedError ? error.refusal : null,
    );
  }
  return {
    callId,
    held,
    maxOutputTokens,
    reservationReleases: held
      ? usageReservationReleaseEvents({
          reservations: [[callId, held]],
          sessionId: input.sessionId,
          turnId: input.turnId,
          turnAttemptId: input.turnAttemptId,
        })
      : [],
  };
}
