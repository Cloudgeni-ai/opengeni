import {
  isModelAvailableForNewSelection,
  policyProviderIdForModel,
  resolveModelProvider,
  runnableLatencyModesForModel,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import {
  evaluateWorkspaceModelPolicy,
  type GoalAdmissionPausedReason,
  type Session,
} from "@opengeni/contracts";
import { isCodexBilledModel } from "@opengeni/codex";
import { getWorkspaceModelPolicy, type Database } from "@opengeni/db";
import { resolveWorkspaceCatalogSettings } from "./model-catalog";
import { agentRunAdmissionDenial } from "./billing/agent-run-admission";

export type GoalAdmissionBlock = { pausedReason: GoalAdmissionPausedReason; message: string };

/** Catalog membership never grants access to a connection or changes the selected model. */
export function goalContinuationModelDecision(input: {
  settings: Settings;
  workspaceModelPolicy: Awaited<ReturnType<typeof getWorkspaceModelPolicy>>;
  inheritedModel: string;
  codexCompactionMode?: Session["codexCompactionMode"];
  latencyMode?: Session["latencyMode"];
}): { model: string; blocked: string | null; pausedReason?: GoalAdmissionPausedReason } {
  const catalogSettings = input.settings.supergrokSubscriptionEnabled
    ? withXaiSubscriptionCatalogProvider(
        input.settings.codexSubscriptionEnabled
          ? withCodexCatalogProvider(input.settings)
          : input.settings,
      )
    : input.settings.codexSubscriptionEnabled
      ? withCodexCatalogProvider(input.settings)
      : input.settings;
  const model = input.inheritedModel;
  if (!resolveModelProvider(catalogSettings, model)) {
    return {
      model,
      blocked: "The selected model is unavailable. Choose an available model before resuming.",
      pausedReason: "model_unavailable",
    };
  }
  if (!isModelAvailableForNewSelection(catalogSettings, model)) {
    return {
      model,
      blocked: "The selected model has been retired. Choose an available model before resuming.",
      pausedReason: "model_unavailable",
    };
  }
  if (
    input.workspaceModelPolicy !== null &&
    !evaluateWorkspaceModelPolicy(input.workspaceModelPolicy, {
      providerId: policyProviderIdForModel(catalogSettings, model),
      modelId: model,
    }).allowed
  ) {
    return {
      model,
      blocked:
        "Workspace policy blocks the selected model. Choose an allowed model before resuming.",
      pausedReason: "model_policy",
    };
  }
  if (input.codexCompactionMode === "remote_v2" && !isCodexBilledModel(model)) {
    return {
      model,
      blocked: "This conversation requires a Codex model. Choose a Codex model before resuming.",
      pausedReason: "model_policy",
    };
  }
  if (
    !runnableLatencyModesForModel(catalogSettings, model).includes(input.latencyMode ?? "standard")
  ) {
    return {
      model,
      blocked:
        "The selected model does not support this conversation's latency mode. Choose a supported mode or model before resuming.",
      pausedReason: "model_policy",
    };
  }
  return { model, blocked: null };
}

/** The same scoped, secret-free catalog used at ordinary turn admission. */
export async function resolveGoalModelAdmission(
  db: Database,
  settings: Settings,
  input: {
    accountId: string;
    workspaceId: string;
    model: string;
    codexCompactionMode?: Session["codexCompactionMode"];
    latencyMode?: Session["latencyMode"];
  },
) {
  const catalog = await resolveWorkspaceCatalogSettings(db, settings, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    retainedProductModelId: input.model,
  });
  const workspaceModelPolicy = await getWorkspaceModelPolicy(db, input.workspaceId);
  return {
    settings: catalog.settings,
    ...goalContinuationModelDecision({
      settings: catalog.settings,
      workspaceModelPolicy,
      inheritedModel: input.model,
      ...(input.codexCompactionMode ? { codexCompactionMode: input.codexCompactionMode } : {}),
      ...(input.latencyMode ? { latencyMode: input.latencyMode } : {}),
    }),
  };
}

/** Shared with scheduled work; reasons describe the actual admission gate. */
export async function goalRunBudgetBlocked(
  services: Parameters<typeof agentRunAdmissionDenial>[0],
  input: Omit<Parameters<typeof agentRunAdmissionDenial>[1], "requestedAgentRuns">,
): Promise<GoalAdmissionBlock | null> {
  const denial = await agentRunAdmissionDenial(services, { ...input, requestedAgentRuns: 1 });
  if (denial === null) return null;
  const blocks: Record<NonNullable<typeof denial>, GoalAdmissionBlock> = {
    insufficient_credits: services.entitlements
      ? {
          pausedReason: "usage_policy",
          message: "The application's usage policy blocks another run. Resume when it allows.",
        }
      : {
          pausedReason: "credits",
          message: "Insufficient OpenGeni credits. Add credits before resuming.",
        },
    allowance_exhausted: {
      pausedReason: "allowance",
      message: "OpenGeni usage allowance exhausted. Resume when your allowance is available.",
    },
    monthly_model_cost_limit: {
      pausedReason: "budget",
      message: "Monthly model spending limit reached. Resume when the spending limit allows.",
    },
    monthly_agent_run_limit: {
      pausedReason: "usage_limit",
      message: "Monthly agent run limit reached. Resume when the run limit allows.",
    },
  };
  return blocks[denial];
}

export class GoalResumeBlockedError extends Error {
  constructor(
    readonly pausedReason: GoalAdmissionPausedReason,
    message: string,
  ) {
    super(message);
    this.name = "GoalResumeBlockedError";
  }
}

/** Called under the goal transition's locks, before counters, events or wakes change. */
export async function assertGoalResumeAllowed(
  services: Parameters<typeof agentRunAdmissionDenial>[0] & { catalogSourceSettings?: Settings },
  session: Pick<Session, "accountId" | "workspaceId" | "model" | "codexCompactionMode"> &
    Partial<Pick<Session, "latencyMode">>,
  causalTurn: { initiatingHumanSubjectId: string | null } | null,
): Promise<void> {
  const decision = await resolveGoalModelAdmission(
    services.db,
    services.catalogSourceSettings ?? services.settings,
    session,
  );
  if (decision.blocked) {
    throw new GoalResumeBlockedError(decision.pausedReason!, decision.blocked);
  }
  const block = await goalRunBudgetBlocked(
    { ...services, settings: decision.settings },
    {
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      model: decision.model,
      // Resuming does not lend the clicking user's allowance or credentials.
      initiatingHumanSubjectId: causalTurn?.initiatingHumanSubjectId ?? null,
    },
  );
  if (block) throw new GoalResumeBlockedError(block.pausedReason, block.message);
}
