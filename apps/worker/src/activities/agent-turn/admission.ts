import { getBillingBalance, sumUsageQuantity } from "@opengeni/db";
import {
  configuredStaticUsageLimits,
  resolveTurnExecutionPolicyV1,
  type Settings,
} from "@opengeni/config";
import { selectCodexCredentialId } from "@opengeni/codex";
import { directPersonalConnectionSubjectId } from "@opengeni/core";
import type { TurnActivityServices as ActivityServices } from "../types";
import {
  type SessionEvent,
  type SessionTurn,
  type ToolAuthNeededPayload,
  type TurnExecutionPolicyV1,
  type XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import { createHash } from "node:crypto";
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
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

// Exported for unit testing the external-billing bypass (codex-billing.test.ts); not
// part of the activity surface. Takes the accepted policy's billing attribution and
// the optional §7.5 P3 host `entitlements` port (when bound, its `admitRun` REPLACES
// the local credit read for an OpenGeni-metered turn; unset → local ledger).
export async function ensureRunAllowed(
  settings: Settings,
  db: ActivityServices["db"],
  accountId: string,
  workspaceId: string,
  isExternallyBilledTurn: boolean,
  entitlements?: ActivityServices["entitlements"],
  chargesOpenGeniCredits = !isExternallyBilledTurn,
  countsTowardTokenCap = !isExternallyBilledTurn,
): Promise<void> {
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
      throw new Error(decision.reason || "insufficient OpenGeni credits");
    }
  } else if (
    chargesOpenGeniCredits &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      throw new Error("insufficient OpenGeni credits");
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    if (limits.maxMonthlyAgentRunsPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      // Agent turns are admitted and recorded before this worker activity starts.
      // Equality means this accepted turn is exactly at the cap; greater-than is
      // the race/backstop case where another admission already exceeded the cap.
      if (used > limits.maxMonthlyAgentRunsPerWorkspace) {
        throw new Error(
          `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`,
        );
      }
    }
    if (countsTowardTokenCap && limits.maxMonthlyTokensPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "model.tokens",
        since: startOfUtcMonth(),
      });
      if (used >= limits.maxMonthlyTokensPerWorkspace) {
        throw new Error(`monthly token limit reached (${limits.maxMonthlyTokensPerWorkspace})`);
      }
    }
  }
}
