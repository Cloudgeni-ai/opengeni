import {
  allowedFirstPartyMcpToolsForSession,
  configuredStaticUsageLimits,
  policyProviderIdForModel,
  resolveModelProvider,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
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
import { resolveCatalogSettings, resolveWorkspaceCatalogSettings } from "@opengeni/core";

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
    const service = await services();
    const { db, bus } = service;
    const catalogSourceSettings = service.catalogSourceSettings ?? service.settings;
    // Cheap pre-read: the common goal-less session skips the budget queries.
    const existingGoal = await getSessionGoal(db, input.workspaceId, input.sessionId);
    if (!existingGoal || existingGoal.status !== "active") {
      return { action: "none" };
    }
    let settings = (await resolveCatalogSettings(db, catalogSourceSettings)).settings;
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
    const inheritedContinuationModel = latestStartedTurn?.model ?? session.model;
    let continuationModel = inheritedContinuationModel;
    const continuationReasoningEffort =
      latestStartedTurn?.reasoningEffort ?? session.reasoningEffort;
    const continuationLatencyMode = latestStartedTurn?.latencyMode ?? session.latencyMode;
    const workspaceModelPolicy = await getWorkspaceModelPolicy(db, input.workspaceId);
    if (
      inheritedContinuationModel.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX) ||
      session.model.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX)
    ) {
      settings = (
        await resolveWorkspaceCatalogSettings(db, catalogSourceSettings, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
        })
      ).settings;
    }
    const modelDecision = goalContinuationModelDecision({
      settings,
      workspaceModelPolicy,
      inheritedModel: inheritedContinuationModel,
      sessionModel: session.model,
    });
    continuationModel = modelDecision.model;
    let modelPolicyBlocked = modelDecision.blocked;
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
    const resolvedModel = resolveModelProvider(settings, continuationModel)?.model;
    const fundedWithoutCredits =
      isCodexRun || (resolvedModel !== undefined && resolvedModel.cost !== "credits");
    // Budget exhaustion pauses the goal visibly instead of failing the
    // session. Computed up front and applied inside the locked decision so a
    // limits pause never consumes continuation budget.
    const budgetBlocked = await goalRunBudgetBlocked(
      settings,
      db,
      input.accountId,
      input.workspaceId,
      fundedWithoutCredits,
    );
    const decision = await materializeGoalContinuation(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      defaultMaxAutoContinuations: settings.goalMaxAutoContinuations ?? null,
      // Pacing between consecutive no-input continuations (never a cap). The
      // materializer re-arms a delayed outbox wake and returns `deferred`.
      idleBackoff: {
        scheduleMs: settings.goalIdleBackoffMs,
        maxMs: settings.goalIdleBackoffMaxMs,
      },
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
      prompt: (goal, autoContinuation, cap) => {
        const effectiveFirstPartyTools = allowedFirstPartyMcpToolsForSession(
          settings,
          session.firstPartyMcpTools,
        );
        return goalContinuationPrompt(goal, autoContinuation, cap, {
          goalWaitAvailable: effectiveFirstPartyTools.includes("goal_wait"),
          humanInputRespondAvailable: effectiveFirstPartyTools.includes(
            "session_human_input_respond",
          ),
        });
      },
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

export function goalContinuationModelDecision(input: {
  settings: Settings;
  workspaceModelPolicy: Awaited<ReturnType<typeof getWorkspaceModelPolicy>>;
  inheritedModel: string;
  sessionModel: string;
}): { model: string; blocked: string | null } {
  const catalogSettings = input.settings.supergrokSubscriptionEnabled
    ? withXaiSubscriptionCatalogProvider(
        input.settings.codexSubscriptionEnabled
          ? withCodexCatalogProvider(input.settings)
          : input.settings,
      )
    : input.settings.codexSubscriptionEnabled
      ? withCodexCatalogProvider(input.settings)
      : input.settings;
  const policyBlocks = (modelId: string): boolean =>
    input.workspaceModelPolicy !== null &&
    !evaluateWorkspaceModelPolicy(input.workspaceModelPolicy, {
      providerId: policyProviderIdForModel(catalogSettings, modelId),
      modelId,
    }).allowed;
  const candidates = [...new Set([input.inheritedModel, input.sessionModel])];
  for (const model of candidates) {
    if (resolveModelProvider(catalogSettings, model) && !policyBlocks(model)) {
      return { model, blocked: null };
    }
  }
  if (!resolveModelProvider(catalogSettings, input.inheritedModel)) {
    return {
      model: input.inheritedModel,
      blocked: `model "${input.inheritedModel}" is no longer in the deployment or workspace catalog; choose an available model before resuming the goal`,
    };
  }
  return {
    model: input.inheritedModel,
    blocked: `workspace model policy blocks model "${input.inheritedModel}"; pick an allowed model or change the workspace model policy`,
  };
}

export function goalContinuationPrompt(
  _goal: SessionGoal,
  _autoContinuation: number,
  _cap: number | null,
  options: { goalWaitAvailable?: boolean; humanInputRespondAvailable?: boolean } = {},
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
  const childNoticeGuidance = [
    "Child lifecycle notices:",
    "- A `child_requires_action` update means a worker you spawned is blocked on a question or a tool approval and will not progress until it is answered. " +
      (options.humanInputRespondAvailable
        ? "If you know the answer to its question, answer it with opengeni__session_human_input_respond (pass the worker's sessionId, the requestId from the notice, and a response). "
        : "") +
      "Tool approvals can only be decided by a human. If you cannot resolve the blocker yourself, report the exact blocker (worker session id, the question) to the user and wait or pause instead of retrying the worker.",
    "- `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`, and `child_progress` updates are informational: a resolved notice means the worker is moving again; a paused worker needs a human or you to resume it; a capacity wait resumes by itself; a progress note needs no action.",
    "",
  ];
  return [
    "Reconcile the active session goal against authoritative current state, then carry the work through to the full requested end state and verify it.",
    "",
    "Goal recovery:",
    "- Treat this continuation as re-entry into the full objective, not as a request to perform one step and stop.",
    "- Do not rely on previous assistant claims of progress or completion; use them only to locate authoritative evidence.",
    "- If authoritative evidence already proves the full objective, call opengeni__goal_complete instead of manufacturing more work.",
    "- Before repeating a state-setting action, verify whether its desired state already holds. If it does, do not repeat it; continue reconciling the overall goal.",
    "",
    "Continuation behavior:",
    "- This goal persists across turns. A runtime boundary can end one turn without shrinking the objective; the next continuation resumes the same full objective.",
    "- Keep working until the requested end state is true and verified. Do not end the turn merely because one useful action completed, and do not redefine success around a smaller or easier task.",
    "- Temporary rough edges are acceptable while the work is moving in the right direction. Completion still requires the requested end state to be true and verified.",
    "",
    "Work from evidence:",
    "Use the current workspace and external state as authoritative. Conversation context can help locate relevant work, but it is not proof of the current state. Inspect the current state before relying on it. Improve, replace, or remove existing work as needed to satisfy the actual objective.",
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
    ...childNoticeGuidance,
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
  fundedWithoutCredits: boolean,
): Promise<string | null> {
  // Free, subscription, and workspace-funded continuations skip OpenGeni's
  // credit-balance gate and monthly model-cost cap. The agent-run COUNT cap
  // below is a volume quota (not a credit/cost gate) and remains enforced.
  if (
    !fundedWithoutCredits &&
    (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed")
  ) {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      return "insufficient OpenGeni credits";
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    if (!fundedWithoutCredits && limits.maxMonthlyCostMicrosPerAccount) {
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
