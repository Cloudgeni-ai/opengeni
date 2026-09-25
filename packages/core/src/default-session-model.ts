import {
  canonicalizeConfiguredModelId,
  type ConfiguredModel,
  type Settings,
} from "@opengeni/config";
import {
  resolveWorkspaceSessionDefaults,
  type DefaultModelSelection,
  type ReasoningEffort,
  type WorkspaceSessionDefaults,
  type XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import {
  getBillingBalance,
  getWorkspace,
  getWorkspaceConnectionModelRestrictions,
  getWorkspaceModelPolicy,
  listOrganizationModelProviderCustomModelsForWorkspace,
  listWorkspaceGatewayCustomModels,
  listWorkspaceOpenRouterCustomModels,
  organizationModelProviderConnectionActiveForWorkspace,
  workspaceCodexSubscriptionActive,
  workspaceOpenRouterConnectionActive,
  workspaceVercelAiGatewayConnectionActive,
  workspaceXaiSubscriptionActive,
  workspaceXaiSubscriptionActiveForAuthority,
  type Database,
} from "@opengeni/db";
import {
  resolveWorkspaceModelSelection,
  type WorkspaceModelSelection,
  type WorkspaceModelSelectionInput,
} from "./model-catalog";

const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function supportedReasoningEfforts(model: ConfiguredModel): ReasoningEffort[] {
  const efforts = model.capabilities.reasoning.efforts;
  return REASONING_EFFORT_ORDER.filter((effort) => efforts.includes(effort));
}

/** The model's own default effort, matching the web picker's choice. */
export function defaultReasoningEffortForConfiguredModel(
  model: ConfiguredModel,
  fallback: ReasoningEffort,
): ReasoningEffort {
  const options = supportedReasoningEfforts(model);
  if (options.length === 0) return fallback;
  const configured = model.capabilities.reasoning.defaultEffort;
  if (configured && options.includes(configured)) return configured;
  return options[0]!;
}

/** The highest supported effort at or below `preferred`. */
export function clampReasoningEffortForConfiguredModel(
  model: ConfiguredModel,
  preferred: ReasoningEffort,
  fallback: ReasoningEffort,
): ReasoningEffort {
  const options = supportedReasoningEfforts(model);
  if (options.length === 0) return fallback;
  if (options.includes(preferred)) return preferred;
  const ceiling = REASONING_EFFORT_ORDER.indexOf(preferred);
  const below = options.filter((effort) => REASONING_EFFORT_ORDER.indexOf(effort) <= ceiling);
  return below.at(-1) ?? defaultReasoningEffortForConfiguredModel(model, fallback);
}

function findSelection(
  selections: readonly WorkspaceModelSelection[],
  modelId: string,
): WorkspaceModelSelection | undefined {
  return (
    selections.find((selection) => selection.model.id === modelId) ??
    selections.find((selection) => selection.model.aliases.includes(modelId))
  );
}

export type DefaultSessionModelInput = {
  /** Catalog-resolved settings: `openaiModel` is the deployment default. */
  settings: Settings;
  /** This workspace's selection, in operator catalog order. */
  selections: readonly WorkspaceModelSelection[];
  workspaceDefaults: WorkspaceSessionDefaults | null;
  /** True while the organization holds a positive OpenGeni credit balance. */
  creditsAvailable: boolean;
};

function creditsCandidate(
  input: Pick<DefaultSessionModelInput, "settings" | "selections">,
): DefaultModelSelection | null {
  const fallbackEffort = input.settings.openaiReasoningEffort;
  const deployment = findSelection(input.selections, input.settings.openaiModel);
  if (deployment?.availability.selectable && deployment.model.cost === "credits") return null;
  const configured = findSelection(input.selections, input.settings.creditsDefaultModel);
  if (configured?.availability.selectable && configured.model.cost === "credits") {
    return {
      model: configured.model.id,
      reasoningEffort: clampReasoningEffortForConfiguredModel(
        configured.model,
        input.settings.creditsDefaultReasoningEffort,
        fallbackEffort,
      ),
      source: "credits",
    };
  }
  const first = input.selections.find(
    (selection) => selection.availability.selectable && selection.model.cost === "credits",
  );
  return first
    ? {
        model: first.model.id,
        reasoningEffort: defaultReasoningEffortForConfiguredModel(first.model, fallbackEffort),
        source: "credits",
      }
    : null;
}

/**
 * Default model policy for a new chat or scheduled task that names no model.
 *
 * Precedence, first match wins:
 *
 * 1. `workspace`: the saved workspace default (`settings.sessionDefaults`)
 *    while it is selectable in this workspace.
 * 2. `subscription`: the first selectable connected-subscription model
 *    (ChatGPT/Codex, then SuperGrok) in operator catalog order. The
 *    deployment default wins inside this step when it is itself a selectable
 *    subscription model.
 * 3. `credits`: while the organization holds an OpenGeni credit balance, the
 *    configured credits default (`OPENGENI_CREDITS_DEFAULT_MODEL`, effort
 *    clamped to what the model supports), or the first selectable
 *    credits-billed model when that one is not selectable. Skipped when the
 *    deployment default is already a selectable credits-billed model, so an
 *    operator's paid default is never replaced.
 * 4. `deployment`: the deployment default with the deployment reasoning effort.
 *
 * An explicit model on the request, the scheduled task, or the person's
 * new-chat draft is never passed through this function.
 */
export function selectDefaultSessionModel(input: DefaultSessionModelInput): DefaultModelSelection {
  const fallbackEffort = input.settings.openaiReasoningEffort;
  if (input.workspaceDefaults) {
    const saved = findSelection(input.selections, input.workspaceDefaults.model);
    if (saved?.availability.selectable) {
      return {
        model: saved.model.id,
        reasoningEffort: input.workspaceDefaults.reasoningEffort,
        source: "workspace",
      };
    }
  }
  const deployment = findSelection(input.selections, input.settings.openaiModel);
  const subscription =
    deployment?.availability.selectable && deployment.model.cost === "subscription"
      ? deployment
      : input.selections.find(
          (selection) =>
            selection.availability.selectable && selection.model.cost === "subscription",
        );
  if (subscription) {
    return {
      model: subscription.model.id,
      reasoningEffort: defaultReasoningEffortForConfiguredModel(subscription.model, fallbackEffort),
      source: "subscription",
    };
  }
  if (input.creditsAvailable) {
    const credits = creditsCandidate(input);
    if (credits) return credits;
  }
  return {
    model:
      deployment?.model.id ??
      canonicalizeConfiguredModelId(input.settings, input.settings.openaiModel),
    reasoningEffort: fallbackEffort,
    source: "deployment",
  };
}

/**
 * The default this workspace would use once its organization holds an
 * OpenGeni credit balance. Null when the deployment does not bill credits.
 */
export function creditsDefaultSessionModel(input: {
  settings: Settings;
  selections: readonly WorkspaceModelSelection[];
  workspaceSettings: unknown;
}): DefaultModelSelection | null {
  if (input.settings.billingMode !== "stripe") return null;
  return selectDefaultSessionModel({
    settings: input.settings,
    selections: input.selections,
    workspaceDefaults: resolveWorkspaceSessionDefaults(input.workspaceSettings),
    creditsAvailable: true,
  });
}

/**
 * Resolve the default for an already-loaded workspace selection. The credit
 * balance is read only when it can change the answer.
 */
export async function resolveDefaultSessionModelForSelections(
  db: Database,
  input: {
    settings: Settings;
    accountId: string;
    workspaceSettings: unknown;
    selections: readonly WorkspaceModelSelection[];
  },
): Promise<DefaultModelSelection> {
  const decision = {
    settings: input.settings,
    selections: input.selections,
    workspaceDefaults: resolveWorkspaceSessionDefaults(input.workspaceSettings),
  };
  const withoutCredits = selectDefaultSessionModel({ ...decision, creditsAvailable: false });
  if (
    withoutCredits.source !== "deployment" ||
    input.settings.billingMode !== "stripe" ||
    creditsCandidate(decision) === null
  ) {
    return withoutCredits;
  }
  const balance = await getBillingBalance(db, input.accountId);
  return balance.balanceMicros > 0
    ? selectDefaultSessionModel({ ...decision, creditsAvailable: true })
    : withoutCredits;
}

export type WorkspaceModelSelectionContext = {
  accountId: string;
  workspaceId: string;
  /**
   * The subject whose connected-subscription authority applies: the
   * authenticated caller for direct creates, or a scheduled task's immutable
   * execution owner. Never another member.
   */
  subjectId: string;
  /**
   * An already-frozen SuperGrok authority (a scheduled task's snapshot).
   * Omitted means the subject's current acceptance authority, exactly as a
   * direct Send resolves it.
   */
  xaiAuthoritySnapshot?: XaiProviderAccountAuthoritySnapshotV1 | undefined;
};

/** Load the same inputs the workspace model catalog route evaluates. */
export async function loadWorkspaceModelSelectionInput(
  db: Database,
  settings: Settings,
  context: WorkspaceModelSelectionContext,
): Promise<WorkspaceModelSelectionInput> {
  const { accountId, workspaceId, subjectId, xaiAuthoritySnapshot } = context;
  const [
    connectionModelRestrictions,
    policy,
    codexSubscriptionActive,
    xaiSubscriptionActive,
    workspaceGatewayConnectionActive,
    workspaceGatewayCustomModels,
    openRouterConnectionActive,
    workspaceOpenRouterCustomModels,
    organizationGatewayConnectionActive,
    organizationOpenRouterConnectionActive,
    organizationGatewayCustomModels,
    organizationOpenRouterCustomModels,
  ] = await Promise.all([
    getWorkspaceConnectionModelRestrictions(db, workspaceId, subjectId, xaiAuthoritySnapshot),
    getWorkspaceModelPolicy(db, workspaceId),
    workspaceCodexSubscriptionActive(db, settings, workspaceId),
    xaiAuthoritySnapshot
      ? workspaceXaiSubscriptionActiveForAuthority(db, settings, {
          workspaceId,
          subjectId,
          authoritySnapshot: xaiAuthoritySnapshot,
        })
      : workspaceXaiSubscriptionActive(db, settings, workspaceId, subjectId),
    workspaceVercelAiGatewayConnectionActive(db, workspaceId),
    listWorkspaceGatewayCustomModels(db, { accountId, workspaceId }),
    workspaceOpenRouterConnectionActive(db, workspaceId),
    listWorkspaceOpenRouterCustomModels(db, { accountId, workspaceId }),
    organizationModelProviderConnectionActiveForWorkspace(db, {
      accountId,
      workspaceId,
      providerKind: "vercel_gateway",
    }),
    organizationModelProviderConnectionActiveForWorkspace(db, {
      accountId,
      workspaceId,
      providerKind: "openrouter",
    }),
    listOrganizationModelProviderCustomModelsForWorkspace(db, {
      accountId,
      workspaceId,
      providerKind: "vercel_gateway",
    }),
    listOrganizationModelProviderCustomModelsForWorkspace(db, {
      accountId,
      workspaceId,
      providerKind: "openrouter",
    }),
  ]);
  return {
    connectionModelRestrictions,
    settings,
    policy,
    codexSubscriptionActive,
    xaiSubscriptionActive,
    workspaceGatewayConnectionActive,
    workspaceGatewayCustomModels,
    workspaceOpenRouterConnectionActive: openRouterConnectionActive,
    workspaceOpenRouterCustomModels,
    organizationGatewayConnectionActive,
    organizationOpenRouterConnectionActive,
    organizationGatewayCustomModels,
    organizationOpenRouterCustomModels,
  };
}

/**
 * Server-side default for new work that names no model: API and Slack session
 * creates, new-chat drafts that follow the default, and scheduled-task
 * occurrences. The result is resolved once and then frozen by the accepted
 * session or occurrence like any other model choice.
 */
export async function resolveDefaultSessionModel(
  db: Database,
  settings: Settings,
  context: WorkspaceModelSelectionContext & { workspaceSettings?: unknown },
): Promise<DefaultModelSelection> {
  const [selectionInput, workspaceSettings] = await Promise.all([
    loadWorkspaceModelSelectionInput(db, settings, context),
    context.workspaceSettings !== undefined
      ? Promise.resolve(context.workspaceSettings)
      : getWorkspace(db, context.workspaceId).then((workspace) => workspace?.settings ?? {}),
  ]);
  return await resolveDefaultSessionModelForSelections(db, {
    settings,
    accountId: context.accountId,
    workspaceSettings,
    selections: resolveWorkspaceModelSelection(selectionInput),
  });
}
