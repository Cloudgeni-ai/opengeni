import {
  allowedFirstPartyMcpToolsForSession,
  configuredStaticUsageLimits,
  policyProviderIdForModel,
  type Settings,
} from "@opengeni/config";
import {
  evaluateWorkspaceModelPolicy,
  mergeToolRefs,
  type SessionGoal,
  type ToolRef,
} from "@opengeni/contracts";
import { isCodexBilledModel } from "@opengeni/codex";
import {
  enqueueSessionWorkflowWakeIfRunnable,
  getBillingBalance,
  getLatestStartedSessionTurn,
  getWorkspaceModelPolicy,
  getSessionGoal,
  isCodexBilledTurn,
  materializeGoalContinuation,
  requireSession,
  sumUsageQuantity,
  type Database,
} from "@opengeni/db";
import type {
  ControlActivityServices,
  MaybeContinueGoalInput,
  MaybeContinueGoalResult,
} from "./types";

export function createGoalActivities(services: () => Promise<ControlActivityServices>) {
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
      latestStartedTurn?.reasoningEffort ?? session.reasoningEffort;
    const continuationLatencyMode = latestStartedTurn?.latencyMode ?? session.latencyMode;
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
    // remote_v2 sessions may only continue on Codex models — refuse synthesis
    // that would leave the portable/non-Codex path (and mixed history shapes).
    if (
      !modelPolicyBlocked &&
      session.codexCompactionMode === "remote_v2" &&
      !isCodexBilledModel(continuationModel)
    ) {
      modelPolicyBlocked = `session is locked to Codex remote compaction v2; model "${continuationModel}" is not a Codex subscription model`;
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
    const decision = await materializeGoalContinuation(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      defaultMaxAutoContinuations: settings.goalMaxAutoContinuations ?? null,
      // A model-policy block takes precedence: it is deterministic (a budget
      // pause can clear on its own; a policy pause needs a model/policy change)
      // and rides the same visible-pause channel.
      budgetBlocked: modelPolicyBlocked ?? budgetBlocked,
      policy: {
        model: continuationModel,
        reasoningEffort: continuationReasoningEffort,
        latencyMode: continuationLatencyMode,
        tools: withFirstPartyTools(settings, session.tools),
        sandboxBackend: session.sandboxBackend,
      },
      // The hold guidance is only given when `goal_wait` is actually in this
      // session's effective first-party selection (the same source the worker
      // signs into the delegated token and the API uses to register tools), so
      // a pre-existing narrowed selection is never told to call a missing tool.
      prompt: (goal, autoContinuation, cap) =>
        goalContinuationPrompt(goal, autoContinuation, cap, {
          goalWaitAvailable: allowedFirstPartyMcpToolsForSession(
            settings,
            session.firstPartyMcpTools,
          ).includes("goal_wait"),
        }),
    });
    if (decision.events.length > 0) {
      await bus.publish(input.workspaceId, input.sessionId, decision.events);
    }
    return { action: decision.action };
  }

  return {
    enqueueGoalRetryWake,
    maybeContinueGoal,
  };
}

export function goalContinuationPrompt(
  _goal: SessionGoal,
  _autoContinuation: number,
  _cap: number | null,
  options: { goalWaitAvailable?: boolean } = {},
): string {
  const waitingGuidance = options.goalWaitAvailable
    ? [
        "Waiting on child sessions or external events:",
        "- When the next progress depends on child sessions you spawned or on an external event, do not sleep, loop, or poll sessions_list/session_get/session_events to wait for it.",
        "- Re-check sessions_list or session_get once; if the work is still in flight, call opengeni__goal_wait with a concrete reason and a deadline (untilSeconds), then end your turn immediately. You will be woken by a child result, a message, a human prompt, or at the deadline, and this goal stays active.",
        "- A hold is for child/external progress only. If you are blocked on a human decision, use opengeni__goal_pause under the blocked audit below instead.",
        "",
      ]
    : [];
  return [
    "Continue working toward the active session goal.",
    "",
    "Continuation behavior:",
    "- This goal persists across turns. Ending this turn does not require shrinking the objective to what fits now.",
    "- Keep the full objective intact. If it cannot be finished now, make concrete progress toward the real requested end state, leave the goal active, and do not redefine success around a smaller or easier task.",
    "- Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.",
    "",
    "Work from evidence:",
    "Use the current workspace and external state as authoritative. Previous conversation context can help locate relevant work, but inspect the current state before relying on it. Improve, replace, or remove existing work as needed to satisfy the actual objective.",
    "",
    "Progress visibility:",
    "If a planning tool is available and the next work is meaningfully multi-step, use it to show a concise plan tied to the real objective. Keep the plan current as steps complete or the next best action changes. Skip planning overhead for trivial one-step progress, and do not treat a plan update as a substitute for doing the work.",
    "",
    "Fidelity:",
    "- Optimize each turn for movement toward the requested end state, not for the smallest stable-looking subset or easiest passing change.",
    "- Do not substitute a narrower, safer, smaller, merely compatible, or easier-to-test solution because it is more likely to pass current tests.",
    "- Treat alignment as movement toward the requested end state. An edit is aligned only if it makes the requested final state more true; useful-looking behavior that preserves a different end state is misaligned.",
    "",
    "Completion audit:",
    "Before deciding that the goal is achieved, treat completion as unproven and verify it against the actual current state:",
    "- Derive concrete requirements from the objective and any referenced files, plans, specifications, issues, or user instructions.",
    "- Preserve the original scope; do not redefine success around the work that already exists.",
    "- For every explicit requirement, named artifact, command, test, gate, invariant, and deliverable, identify and inspect the authoritative evidence that would prove it.",
    "- Match verification scope to requirement scope. Treat uncertain, indirect, incomplete, or missing evidence as not achieved and continue working.",
    "- The audit must prove completion, not merely fail to find obvious remaining work.",
    "",
    "Do not rely on intent, partial progress, memory of earlier work, or a plausible final answer as proof of completion. Call opengeni__goal_complete with concrete evidence only when the full objective is actually achieved and no required work remains.",
    "",
    ...waitingGuidance,
    "Blocked audit:",
    "- Do not call opengeni__goal_pause the first time a blocker appears.",
    "- Pause only when the same blocking condition has repeated for at least three consecutive goal turns and meaningful progress is impossible without user input or an external-state change.",
    "- Do not pause merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.",
    "- Once that threshold is satisfied, call opengeni__goal_pause with the concrete blocker instead of repeatedly reporting it while leaving the goal active.",
    "",
    "Do not call opengeni__goal_complete or opengeni__goal_pause unless the corresponding audit above is satisfied.",
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
