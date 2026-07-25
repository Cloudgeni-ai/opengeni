import {
  configuredStaticUsageLimits,
  policyProviderIdForModel,
  type Settings,
} from "@opengeni/config";
import {
  evaluateWorkspaceModelPolicy,
  mergeToolRefs,
  reasoningEffortForMetadata,
  type SessionGoal,
  type ToolRef,
} from "@opengeni/contracts";
import {
  addSessionSystemUpdate,
  enqueueSessionWorkflowWakeIfRunnable,
  evaluateGoalContinuation,
  getBillingBalance,
  getLatestStartedSessionTurn,
  getWorkspaceModelPolicy,
  getSessionGoal,
  isCodexBilledTurn,
  recordUsageEvent,
  requireSession,
  sumUsageQuantity,
  type Database,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import type { ActivityServices, MaybeContinueGoalInput, MaybeContinueGoalResult } from "./types";

export function createGoalActivities(services: () => Promise<ActivityServices>) {
  async function enqueueGoalRetryWake(input: MaybeContinueGoalInput): Promise<void> {
    const { db } = await services();
    await enqueueSessionWorkflowWakeIfRunnable(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      temporalWorkflowId: input.workflowId,
      reason: "goal_retry",
      // A permanently invalid goal must not become a tight workflow loop. One
      // durable retry after a short delay preserves liveness without scanning.
      notBefore: new Date(Date.now() + 30_000),
    });
  }

  async function maybeContinueGoal(
    input: MaybeContinueGoalInput,
  ): Promise<MaybeContinueGoalResult> {
    const { settings, db, bus } = await services();
    // Cheap pre-read: the common goal-less session skips the budget queries.
    const existingGoal = await getSessionGoal(db, input.workspaceId, input.sessionId);
    if (!existingGoal || existingGoal.status !== "active") {
      return { action: "none" };
    }
    // Loaded before the budget check so the codex-billed predicate and the
    // synthesized turn use the SAME effective policy. An explicit per-turn
    // model can differ from the persisted session default; follow-up goal work
    // must preserve the newest policy that actually emitted `turn.started`.
    // Admission-rejected turns have no such event and cannot poison it.
    // Kept below the goal-less fast path so a non-goal session still skips the
    // reads entirely.
    const session = await requireSession(db, input.workspaceId, input.sessionId);
    const latestStartedTurn = await getLatestStartedSessionTurn(
      db,
      input.workspaceId,
      input.sessionId,
    );
    let continuationModel = latestStartedTurn?.model ?? session.model;
    const continuationReasoningEffort =
      latestStartedTurn?.reasoningEffort ??
      reasoningEffortForMetadata(session.metadata, settings.openaiReasoningEffort);
    // Workspace model policy: a continuation inherits the last STARTED turn's
    // model, so a single policy-violating turn would otherwise re-arm itself on
    // every continuation (exactly how one bare-model turn kept a goal loop on
    // the paid built-in provider all night). If the inherited model is blocked
    // but the session's own default is allowed, recover to the default; if
    // both are blocked, pause the goal visibly (the budget-pause channel, with
    // a truthful rationale) instead of synthesizing a turn the worker's hard
    // gate would fail over and over.
    let modelPolicyBlocked: string | null = null;
    const workspaceModelPolicy = await getWorkspaceModelPolicy(db, input.workspaceId);
    if (workspaceModelPolicy) {
      const policyBlocks = (modelId: string): boolean =>
        !evaluateWorkspaceModelPolicy(workspaceModelPolicy, {
          providerId: policyProviderIdForModel(settings, modelId),
          modelId,
        }).allowed;
      if (policyBlocks(continuationModel)) {
        if (continuationModel !== session.model && !policyBlocks(session.model)) {
          continuationModel = session.model;
        } else {
          modelPolicyBlocked = `workspace model policy blocks model "${continuationModel}"; pick an allowed model or change the workspace model policy`;
        }
      }
    }
    // A codex-model goal continuation is paid by the user's ChatGPT/Codex plan,
    // so it must not be budget-paused for zero OpenGeni credits. This file uses
    // BASE settings (no codex overlay); the predicate does its own credential read.
    const isCodexRun = await isCodexBilledTurn({
      db,
      settings,
      workspaceId: input.workspaceId,
      model: continuationModel,
    });
    // Budget exhaustion pauses the goal visibly instead of failing the
    // session. Computed up front and applied inside the locked decision so a
    // limits pause never consumes continuation budget.
    const budgetBlocked = await goalRunBudgetBlocked(
      settings,
      db,
      input.accountId,
      input.workspaceId,
      isCodexRun,
    );
    const decision = await evaluateGoalContinuation(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      defaultMaxAutoContinuations: settings.goalMaxAutoContinuations ?? null,
      noProgressLimit: settings.goalNoProgressLimit,
      // A model-policy block takes precedence: it is deterministic (a budget
      // pause can clear on its own; a policy pause needs a model/policy change)
      // and rides the same visible-pause channel.
      budgetBlocked: modelPolicyBlocked ?? budgetBlocked,
    });
    if (decision.decision === "none" || decision.decision === "queue") {
      return { action: decision.decision };
    }
    if (decision.decision === "paused") {
      await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, [
        {
          type: "goal.paused",
          payload: {
            goalId: decision.goal.id,
            actor: "system",
            reason: decision.reason,
            ...(decision.goal.rationale ? { rationale: decision.goal.rationale } : {}),
            autoContinuations: decision.goal.autoContinuations,
            noProgressStreak: decision.goal.noProgressStreak,
          },
        },
      ]);
      return { action: "paused" };
    }
    // Stop/continue race guard: a concurrent goal_complete/goal_pause/operator
    // PATCH between the locked decision and this synthesis must win. The
    // version check also catches a replace. A pause landing after this point
    // results in at most one already-admitted continuation turn; the next
    // pass sees the non-active goal and stops, and interrupt-driven pauses
    // additionally cancel the claimed turn via the workflow interrupt path.
    const recheck = await getSessionGoal(db, input.workspaceId, input.sessionId);
    if (!recheck || recheck.status !== "active" || recheck.version !== decision.goal.version) {
      return { action: "none" };
    }
    const prompt = goalContinuationPrompt(decision.goal, decision.autoContinuation, decision.cap);
    const update = await addSessionSystemUpdate(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      kind: "goal_continuation",
      classification: "info",
      sourceId: decision.goal.id,
      dedupeKey: `goal-continuation:${decision.goal.id}:${decision.goal.version}:${decision.autoContinuation}`,
      summary: prompt,
      payload: {
        type: "goal_continuation",
        goalId: decision.goal.id,
        goalVersion: decision.goal.version,
        autoContinuation: decision.autoContinuation,
        maxAutoContinuations: decision.cap,
        prompt,
        policy: {
          model: continuationModel,
          reasoningEffort: continuationReasoningEffort,
          tools: withFirstPartyTools(settings, session.tools),
          sandboxBackend: session.sandboxBackend,
        },
      },
      lineage: { goalId: decision.goal.id },
    });
    if (update.reason === "session_cancelled") return { action: "none" };
    if (update.added && update.events.length > 0) {
      await bus.publish(input.workspaceId, input.sessionId, update.events);
    }
    // Continuations count as agent runs for limits/metering parity with
    // user-initiated and scheduled turns.
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session_system_update",
      sourceResourceId: update.update.id,
      sessionId: input.sessionId,
      initiator: { kind: "service", subjectId: "goal-continuation" },
      initiatorContext: { goalId: decision.goal.id },
      origin: "goal",
      idempotencyKey: `agent_run.created:goal:${input.workspaceId}:${update.update.id}`,
    });
    return { action: "continue" };
  }

  return {
    enqueueGoalRetryWake,
    maybeContinueGoal,
  };
}

export function goalContinuationPrompt(
  goal: SessionGoal,
  autoContinuation: number,
  cap: number | null,
): string {
  const counter = cap === null ? `${autoContinuation}` : `${autoContinuation}/${cap}`;
  return [
    `[GOAL CONTINUATION ${counter}] The session goal is not done. Goal: ${goal.text}.`,
    `Success criteria: ${goal.successCriteria ?? "none specified"}.`,
    "Continue from the existing conversation state. Do not repeat completed session setup, persistent metadata settings, or context checks merely because this is a new continuation turn.",
    "Continue working toward the goal now. If it is actually complete, call opengeni__goal_complete with concrete evidence.",
    "If you are blocked or continuing is not productive, call opengeni__goal_pause with your rationale.",
    "You may revise the goal with opengeni__goal_update. Do not stop without one of these explicit actions.",
  ].join("\n");
}

/**
 * Ensures a session/turn carries the first-party "opengeni" MCP server, which
 * hosts set_session_title, the goal tools, and the permission-gated
 * orchestration/environment/github tools. Attached to EVERY session/turn (not
 * just goal-bearing ones); built-in tool refs are not auto-added to empty tool
 * lists anywhere else in the pipeline. No-op when the server is not configured.
 */
export function withFirstPartyTools(settings: Settings, tools: ToolRef[]): ToolRef[] {
  if (!settings.mcpServers.some((server) => server.id === "opengeni")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "opengeni" }]);
}

/**
 * Ensures a turn references the synthetic codex_apps connectors MCP server when
 * the codex overlay injected it (active subscription + connector scopes). A
 * registry entry is inert until a ToolRef references its id, so this wires the
 * server into the run. No-op when the server is not configured (every non-codex
 * turn), and idempotent via mergeToolRefs.
 */
export function withCodexAppsTool(settings: Settings, tools: ToolRef[]): ToolRef[] {
  if (!settings.mcpServers.some((server) => server.id === "codex_apps")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "codex_apps" }]);
}

/**
 * Non-throwing variant of the scheduled-run admission check: returns a human
 * readable reason when balance or monthly caps block another agent run.
 */
async function goalRunBudgetBlocked(
  settings: Settings,
  db: Database,
  accountId: string,
  workspaceId: string,
  isCodexRun: boolean,
): Promise<string | null> {
  // Codex-billed continuations are paid by the user's ChatGPT/Codex plan: skip
  // the credit-balance gate and the monthly model-cost cap. The agent-run COUNT
  // cap below is a volume quota (not a credit/cost gate) and is intentionally kept.
  if (
    !isCodexRun &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      return "insufficient OpenGeni credits";
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    if (!isCodexRun && limits.maxMonthlyCostMicrosPerAccount) {
      const used = await sumUsageQuantity(db, {
        accountId,
        eventType: "model.cost",
        since: startOfUtcMonth(),
      });
      if (used >= limits.maxMonthlyCostMicrosPerAccount) {
        return `monthly model cost limit reached (${limits.maxMonthlyCostMicrosPerAccount} micros)`;
      }
    }
    if (limits.maxMonthlyAgentRunsPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      if (used + 1 > limits.maxMonthlyAgentRunsPerWorkspace) {
        return `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`;
      }
    }
  }
  return null;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
