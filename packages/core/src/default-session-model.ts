import {
  canonicalizeConfiguredModelId,
  CLAUDE_CONNECTION_KINDS,
  type ClaudeConnectionCatalog,
  type ConfiguredModel,
  type Settings,
} from "@opengeni/config";
import {
  resolveWorkspaceSessionDefaults,
  type DefaultModelSelection,
  type ReasoningEffort,
  type ScheduledTask,
  type WorkspaceSessionDefaults,
  type XaiProviderAccountAuthoritySnapshotV1,
  type ClaudeProviderAccountAuthoritySnapshotV1,
  type BillingBalance,
} from "@opengeni/contracts";
import {
  getScheduledTaskXaiProviderAccountAuthoritySnapshot,
  getScheduledTaskClaudeProviderAccountAuthoritySnapshot,
  getSession,
  getWorkspace,
  getWorkspaceConnectionModelRestrictions,
  getWorkspaceModelPolicy,
  getOrganizationModelProviderCatalogForWorkspace,
  listConnectionsMetadata,
  listWorkspaceProviderCustomModelsByKind,
  workspaceCodexSubscriptionActive,
  workspaceProviderApiKeyConnectionMetadataFromConnections,
  getBillingBalance,
  spendableCreditMicros,
  workspaceXaiSubscriptionActive,
  workspaceXaiSubscriptionActiveForAuthority,
  XaiAuthorityPoolInactiveError,
  ClaudeAuthorityPoolInactiveError,
  resolveClaudeProviderAccountAuthoritySnapshotForAcceptance,
  workspaceClaudeSubscriptionActiveForAuthority,
  type ConnectionModelRestrictions,
  type Database,
  type WorkspaceCustomModelProviderKind,
} from "@opengeni/db";
import {
  isWorkspaceModelAdmissible,
  resolveWorkspaceModelSelection,
  type WorkspaceModelSelection,
  type WorkspaceModelSelectionInput,
} from "./model-catalog";

import { loadWorkspaceCodexModelAvailability } from "./codex-model-availability";

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
  /**
   * True while the organization holds a positive OpenGeni credit balance from
   * any source, the verified-signup trial grant included (see
   * `organizationHoldsCredits`).
   */
  creditsAvailable: boolean;
  creditBalance?: BillingBalance;
};

function creditsCandidate(
  input: Pick<DefaultSessionModelInput, "settings" | "selections" | "creditBalance">,
): DefaultModelSelection | null {
  const selections = input.creditBalance
    ? input.selections.filter(
        (selection) => spendableCreditMicros(input.creditBalance!, selection.model.id) > 0,
      )
    : input.selections;
  const fallbackEffort = input.settings.openaiReasoningEffort;
  const deployment = findSelection(selections, input.settings.openaiModel);
  const configured = findSelection(selections, input.settings.creditsDefaultModel);
  if (deployment?.availability.selectable && deployment.model.cost === "credits") {
    // A funded paid deployment default is preserved. When it is the
    // credits default model itself, credit holders get the credits default
    // effort rather than the deployment-wide fallback effort.
    if (configured?.model.id !== deployment.model.id) return null;
    return {
      model: deployment.model.id,
      reasoningEffort: clampReasoningEffortForConfiguredModel(
        deployment.model,
        input.settings.creditsDefaultReasoningEffort,
        fallbackEffort,
      ),
      source: "credits",
    };
  }
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
  const first = selections.find(
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
 *    while it is selectable in this workspace, its saved effort clamped to
 *    what the model supports today.
 * 2. `subscription`: the first selectable connected-subscription model
 *    (ChatGPT/Codex, then SuperGrok) in operator catalog order. The
 *    deployment default wins inside this step when it is itself a selectable
 *    subscription model.
 * 3. `credits`: while the organization holds a positive OpenGeni credit
 *    balance (a purchase, a grant, or the verified-signup trial grant), the
 *    configured credits default (`OPENGENI_CREDITS_DEFAULT_MODEL`, effort
 *    clamped to what the model supports), or the first selectable
 *    credits-billed model when that one is not selectable. When the
 *    deployment default is already a funded, selectable credits-billed model it
 *    keeps the deployment effort, except that it takes the
 *    credits default effort when it is the credits default model itself.
 * 4. `deployment`: the deployment default with the deployment reasoning effort
 *    when stably admissible; otherwise the first stably admissible catalog
 *    model with its own default effort. With no admitted models, retain the
 *    deployment hint and let fresh creation refuse it.
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
        reasoningEffort: clampReasoningEffortForConfiguredModel(
          saved.model,
          input.workspaceDefaults.reasoningEffort,
          fallbackEffort,
        ),
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
  if (deployment && isWorkspaceModelAdmissible(deployment)) {
    return { model: deployment.model.id, reasoningEffort: fallbackEffort, source: "deployment" };
  }
  const fallback = input.selections.find(isWorkspaceModelAdmissible);
  return fallback
    ? {
        model: fallback.model.id,
        reasoningEffort: defaultReasoningEffortForConfiguredModel(fallback.model, fallbackEffort),
        source: "deployment",
      }
    : {
        model: canonicalizeConfiguredModelId(input.settings, input.settings.openaiModel),
        reasoningEffort: fallbackEffort,
        source: "deployment",
      };
}

/**
 * The default this workspace would use while its organization holds a
 * positive OpenGeni credit balance. Null when the deployment does not bill
 * credits.
 */
export function creditsDefaultSessionModel(input: {
  settings: Settings;
  selections: readonly WorkspaceModelSelection[];
  workspaceSettings: unknown;
  creditBalance?: BillingBalance;
}): DefaultModelSelection | null {
  if (input.settings.billingMode !== "stripe") return null;
  return selectDefaultSessionModel({
    settings: input.settings,
    selections: input.selections,
    workspaceDefaults: resolveWorkspaceSessionDefaults(input.workspaceSettings),
    creditsAvailable: true,
    ...(input.creditBalance ? { creditBalance: input.creditBalance } : {}),
  });
}

/**
 * Resolve the default for an already-loaded workspace selection. The credit
 * ledger is read only when it can change the answer.
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
    !input.selections.some(
      (selection) => selection.availability.selectable && selection.model.cost === "credits",
    )
  ) {
    return withoutCredits;
  }
  const creditBalance = await getBillingBalance(db, input.accountId);
  return selectDefaultSessionModel({ ...decision, creditsAvailable: true, creditBalance });
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
  /** Already accepted Claude pool; never replace it with current selection. */
  claudeAuthoritySnapshot?: ClaudeProviderAccountAuthoritySnapshotV1 | undefined;
};

/**
 * Connection restrictions and SuperGrok readiness for the subject. With a
 * frozen authority (a scheduled task's snapshot), a user pool that no longer
 * resolves (disconnected, reconnected under a new authority generation, or its
 * owner left) means SuperGrok is not ready: no SuperGrok model is selectable,
 * and resolution falls through to credits or the deployment default instead of
 * failing the occurrence. The frozen authority is never swapped for the
 * subject's current one; the SuperGrok restriction is closed outright, while
 * the other providers' restrictions do not depend on SuperGrok authority.
 */
async function connectionRestrictionsAndXaiReadiness(
  db: Database,
  settings: Settings,
  context: WorkspaceModelSelectionContext,
): Promise<{ restrictions: ConnectionModelRestrictions; xaiSubscriptionActive: boolean }> {
  const { workspaceId, subjectId, xaiAuthoritySnapshot } = context;
  if (!xaiAuthoritySnapshot) {
    const [restrictions, xaiSubscriptionActive] = await Promise.all([
      getWorkspaceConnectionModelRestrictions(
        db,
        workspaceId,
        subjectId,
        undefined,
        context.claudeAuthoritySnapshot,
      ),
      workspaceXaiSubscriptionActive(db, settings, workspaceId, subjectId),
    ]);
    return { restrictions, xaiSubscriptionActive };
  }
  const frozen = await Promise.allSettled([
    getWorkspaceConnectionModelRestrictions(
      db,
      workspaceId,
      subjectId,
      xaiAuthoritySnapshot,
      context.claudeAuthoritySnapshot,
    ),
    workspaceXaiSubscriptionActiveForAuthority(db, settings, {
      workspaceId,
      subjectId,
      authoritySnapshot: xaiAuthoritySnapshot,
    }),
  ]);
  const [restrictions, readiness] = frozen;
  if (restrictions.status === "fulfilled" && readiness.status === "fulfilled") {
    return { restrictions: restrictions.value, xaiSubscriptionActive: readiness.value };
  }
  for (const result of frozen) {
    if (result.status === "rejected" && !(result.reason instanceof XaiAuthorityPoolInactiveError)) {
      throw result.reason;
    }
  }
  const current = await getWorkspaceConnectionModelRestrictions(
    db,
    workspaceId,
    subjectId,
    undefined,
    context.claudeAuthoritySnapshot,
  );
  return {
    restrictions: { ...current, "supergrok/": [] },
    xaiSubscriptionActive: false,
  };
}

/**
 * Readiness for the subject's current or already accepted Claude pool observes
 * metadata only; quota is handled by the runtime allocator. This is not an
 * authorization: callers must supply their authenticated or frozen subject.
 */
export async function loadWorkspaceClaudeSubscriptionReadiness(
  db: Database,
  settings: Settings,
  context: WorkspaceModelSelectionContext,
): Promise<{ workspace: boolean; organization: boolean }> {
  if (!settings.claudeSubscriptionEnabled) return { workspace: false, organization: false };
  const authoritySnapshot =
    context.claudeAuthoritySnapshot ??
    (await resolveClaudeProviderAccountAuthoritySnapshotForAcceptance(db, context));
  let active: boolean;
  try {
    active = await workspaceClaudeSubscriptionActiveForAuthority(db, settings, {
      ...context,
      authoritySnapshot,
    });
  } catch (error) {
    if (!context.claudeAuthoritySnapshot || !(error instanceof ClaudeAuthorityPoolInactiveError))
      throw error;
    active = false;
  }
  return {
    workspace: active && authoritySnapshot.scope !== "organization",
    organization: active && authoritySnapshot.scope === "organization",
  };
}

/** Load the same inputs the workspace model catalog route evaluates. */
export async function loadWorkspaceModelSelectionInput(
  db: Database,
  settings: Settings,
  context: WorkspaceModelSelectionContext,
  options: { observeAvailability?: boolean } = {},
): Promise<WorkspaceModelSelectionInput> {
  const { accountId, workspaceId } = context;
  // The exact provider set the catalog route reads. A disabled Claude
  // subscription contributes no catalog entry, so its rows are not read.
  const providerKinds: WorkspaceCustomModelProviderKind[] = [
    "vercel_gateway",
    "openrouter",
    "opper",
    ...CLAUDE_CONNECTION_KINDS.filter(
      (kind) => kind !== "claude_subscription" || settings.claudeSubscriptionEnabled,
    ),
  ];
  const inputRead = (async () =>
    Promise.all([
      connectionRestrictionsAndXaiReadiness(db, settings, context),
      loadWorkspaceClaudeSubscriptionReadiness(db, settings, context),
      getWorkspaceModelPolicy(db, workspaceId),
      workspaceCodexSubscriptionActive(db, settings, workspaceId),
      options.observeAvailability === false
        ? Promise.resolve({})
        : loadWorkspaceCodexModelAvailability(db, settings, workspaceId),
    ]))();
  // Transaction handles share one backend and LOCAL scope. Preserve the old
  // batch ordering there rather than introduce concurrent nested savepoints.
  if (typeof (db as Database & { rollback?: unknown }).rollback === "function") await inputRead;
  // One scoped read per catalog family (workspace connection metadata,
  // workspace custom models, organization provider readiness + models) instead
  // of one scoped transaction per provider kind. The batched readers keep each
  // provider's filters, bound and overflow error, exactly as the workspace
  // model catalog route reads them.
  const catalogRead = (async () =>
    Promise.all([
      listConnectionsMetadata(db, workspaceId, null),
      listWorkspaceProviderCustomModelsByKind(db, { accountId, workspaceId, providerKinds }),
      getOrganizationModelProviderCatalogForWorkspace(db, {
        accountId,
        workspaceId,
        providerKinds,
      }),
    ]))();
  // Observe both batches before admission resumes or fails. Retain the previous
  // input-batch error precedence even if the independent catalog fails first.
  const [inputResult, catalogResult] = await Promise.allSettled([inputRead, catalogRead]);
  if (inputResult.status === "rejected") throw inputResult.reason;
  if (catalogResult.status === "rejected") throw catalogResult.reason;
  const [
    { restrictions: connectionModelRestrictions, xaiSubscriptionActive },
    claudePool,
    policy,
    codexSubscriptionActive,
    observations,
  ] = inputResult.value;
  const [workspaceConnections, workspaceCustomModels, organizationProviders] = catalogResult.value;
  const workspaceConnectionActive = (kind: WorkspaceCustomModelProviderKind) =>
    workspaceProviderApiKeyConnectionMetadataFromConnections(workspaceConnections, kind) !== null;
  const claudeConnections: ClaudeConnectionCatalog = {};
  const workspaceClaudeConnections: ClaudeConnectionCatalog = {};
  for (const kind of CLAUDE_CONNECTION_KINDS) {
    if (kind === "claude_subscription" && !settings.claudeSubscriptionEnabled) continue;
    claudeConnections[kind] = {
      active:
        kind === "claude_subscription"
          ? claudePool.organization
          : organizationProviders[kind].active,
      models: organizationProviders[kind].models,
    };
    workspaceClaudeConnections[kind] = {
      active:
        kind === "claude_subscription" ? claudePool.workspace : workspaceConnectionActive(kind),
      models: workspaceCustomModels[kind],
    };
  }
  return {
    claudeConnections,
    workspaceClaudeConnections,
    connectionModelRestrictions,
    settings,
    policy,
    codexSubscriptionActive,
    observations,
    xaiSubscriptionActive,
    workspaceGatewayConnectionActive: workspaceConnectionActive("vercel_gateway"),
    workspaceGatewayCustomModels: workspaceCustomModels.vercel_gateway,
    workspaceOpenRouterConnectionActive: workspaceConnectionActive("openrouter"),
    workspaceOpenRouterCustomModels: workspaceCustomModels.openrouter,
    organizationGatewayConnectionActive: organizationProviders.vercel_gateway.active,
    organizationOpenRouterConnectionActive: organizationProviders.openrouter.active,
    organizationGatewayCustomModels: organizationProviders.vercel_gateway.models,
    organizationOpenRouterCustomModels: organizationProviders.openrouter.models,
    workspaceOpperConnectionActive: workspaceConnectionActive("opper"),
    workspaceOpperCustomModels: workspaceCustomModels.opper ?? [],
    organizationOpperConnectionActive: organizationProviders.opper?.active === true,
    organizationOpperCustomModels: organizationProviders.opper?.models ?? [],
  };
}

/**
 * Caller-scoped stable fresh admission; never re-admit already accepted work.
 * Live discovery is opt-in: its token refresh can mutate connection readiness,
 * so a health hint must not change the billing rail of an explicit create.
 */
export async function resolveCallerWorkspaceModelSelections(
  db: Database,
  settings: Settings,
  context: WorkspaceModelSelectionContext,
  options: { observeAvailability?: boolean } = {},
): Promise<WorkspaceModelSelection[]> {
  return resolveWorkspaceModelSelection(
    await loadWorkspaceModelSelectionInput(db, settings, context, {
      observeAvailability: options.observeAvailability === true,
    }),
  );
}

/** Transient selectability for existing consumers; not fresh-create admission. */
export function selectableWorkspaceModel(
  selections: readonly WorkspaceModelSelection[],
  modelId: string,
): WorkspaceModelSelection | undefined {
  const selection = findSelection(selections, modelId);
  return selection?.availability.selectable ? selection : undefined;
}

/** Same stable decision used by client config and direct fresh session creation. */
export function admissibleWorkspaceModel(
  selections: readonly WorkspaceModelSelection[],
  modelId: string,
): WorkspaceModelSelection | undefined {
  const selection = findSelection(selections, modelId);
  return selection && isWorkspaceModelAdmissible(selection) ? selection : undefined;
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
  return (await resolveDefaultSessionModelWithSelectionInput(db, settings, context)).selection;
}

/**
 * `resolveDefaultSessionModel` plus the exact selection input it read, so a
 * caller that must also admit the resolved default for the SAME subject,
 * settings and (absent) frozen authorities can reuse that read through
 * `freshAdmissionSelectionsFromInput` instead of loading the catalog again.
 */
export async function resolveDefaultSessionModelWithSelectionInput(
  db: Database,
  settings: Settings,
  context: WorkspaceModelSelectionContext & { workspaceSettings?: unknown },
): Promise<{ selection: DefaultModelSelection; input: WorkspaceModelSelectionInput }> {
  const [selectionInput, workspaceSettings] = await Promise.all([
    loadWorkspaceModelSelectionInput(db, settings, context),
    context.workspaceSettings !== undefined
      ? Promise.resolve(context.workspaceSettings)
      : getWorkspace(db, context.workspaceId).then((workspace) => workspace?.settings ?? {}),
  ]);
  return {
    selection: await resolveDefaultSessionModelForSelections(db, {
      settings,
      accountId: context.accountId,
      workspaceSettings,
      selections: resolveWorkspaceModelSelection(selectionInput),
    }),
    input: selectionInput,
  };
}

/**
 * The selections `resolveCallerWorkspaceModelSelections` computes for fresh
 * admission, derived from an input already loaded for the same caller context.
 * Admission never consumes live availability observations (a health hint must
 * not change the billing rail), so they are dropped exactly as
 * `observeAvailability: false` would have omitted them.
 */
export function freshAdmissionSelectionsFromInput(
  input: WorkspaceModelSelectionInput,
): WorkspaceModelSelection[] {
  return resolveWorkspaceModelSelection({ ...input, observations: {} });
}

/**
 * The default a scheduled occurrence uses when its task names no model and the
 * occurrence creates its own session: resolved under the task's immutable
 * execution owner (or its creator for a workspace/service task) and the task's
 * frozen SuperGrok authority, never another member's. The worker stamps the
 * result onto the accepted execution, so retries and recovery replay it; the
 * API's manual-trigger limit check uses the same resolution so it gates the
 * model that will run.
 */
export async function resolveScheduledTaskDefaultModel(
  db: Database,
  settings: Settings,
  task: Pick<ScheduledTask, "id" | "accountId" | "workspaceId" | "ownerSubjectId" | "createdBy">,
): Promise<DefaultModelSelection> {
  return await resolveDefaultSessionModel(db, settings, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    subjectId: task.ownerSubjectId ?? task.createdBy.subjectId,
    claudeAuthoritySnapshot: await getScheduledTaskClaudeProviderAccountAuthoritySnapshot(
      db,
      task.workspaceId,
      task.id,
    ),
    xaiAuthoritySnapshot: await getScheduledTaskXaiProviderAccountAuthoritySnapshot(
      db,
      task.workspaceId,
      task.id,
    ),
  });
}

/**
 * The model a manual trigger's limit pre-check evaluates, matching what the
 * occurrence will run: the task's explicit model, else the target or reusable
 * session's model when that session exists, else the resolved scheduled
 * default. The worker still resolves authoritatively at dispatch.
 */
export async function resolveScheduledTaskPreflightModel(
  db: Database,
  settings: Settings,
  task: Pick<
    ScheduledTask,
    | "id"
    | "accountId"
    | "workspaceId"
    | "ownerSubjectId"
    | "createdBy"
    | "agentConfig"
    | "runMode"
    | "targetSessionId"
    | "reusableSessionId"
  >,
): Promise<string> {
  if (task.agentConfig.model) return task.agentConfig.model;
  const targetSessionId =
    task.runMode === "existing_session"
      ? task.targetSessionId
      : task.runMode === "reusable_session"
        ? task.reusableSessionId
        : null;
  if (targetSessionId) {
    const session = await getSession(db, task.workspaceId, targetSessionId);
    if (session) return session.model;
  }
  return (await resolveScheduledTaskDefaultModel(db, settings, task)).model;
}
