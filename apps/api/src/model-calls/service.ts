import {
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CodexReloginRequired,
  codexRequestStorage,
  type CodexFetch,
  type CodexRequestContext,
  type CodexUsagePayload,
} from "@opengeni/codex";
import {
  codexUpstreamModelSlugs,
  withClaudeConnectionCredential,
  type ConfiguredModel,
  type Settings,
} from "@opengeni/config";
import type { EntitlementsPort } from "@opengeni/contracts";
import {
  admissibleWorkspaceModel,
  admitModelCall,
  clampReasoningEffortForConfiguredModel,
  isWorkspaceModelAdmissible,
  ModelCallError,
  resolveCallerWorkspaceModelSelections,
  resolveDefaultSessionModelForSelections,
  resolveWorkspaceCatalogSettings,
  settingsWithModelProviderCredentials,
  settleModelUsage,
  type ModelCallCaller,
  type ModelCallInput,
  type ModelCallOutput,
  type ModelCallService,
  type WorkspaceModelSelection,
} from "@opengeni/core";
import {
  acquireSubscriptionCoreCodexOperationLease,
  buildSubscriptionCoreCodexConnectionTokenResolver,
  ClaudeSubscriptionReconnectRequired,
  connectionModelAllowed,
  fetchSubscriptionCoreCodexUsage,
  getWorkspace,
  listSubscriptionCoreCodexOperationCandidates,
  readCodexCutoverDisposition,
  releaseSubscriptionCoreCodexOperationLease,
  renewSubscriptionCoreCodexOperationLease,
  reserveSubscriptionCoreCodexOperationRequest,
  resolveClaudeAccountCredential,
  resolveClaudeProviderAccountAuthoritySnapshotForAcceptance,
  selectClaudeCredentialForUse,
  settleSubscriptionCoreCodexOperationRequest,
  withCreditDebitAttribution,
  type Database,
  type SubscriptionCoreCodexOperationLeaseRef,
  type SubscriptionCoreCodexOperationScope,
} from "@opengeni/db";
import {
  MultiProviderModelProvider,
  normalizeModelCallUsage,
  runSingleModelCall,
  SingleModelCallProviderError,
  SingleModelCallUnsupportedError,
  type SingleModelCallResult,
} from "@opengeni/runtime/model-call";
import {
  XAI_CLIENT_VERSION,
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  XaiSubscriptionReloginRequired,
  xaiSubscriptionRequestStorage,
  type XaiFetch,
} from "@opengeni/xai-subscription";
import {
  creditDebitAttributionForGrant,
  withAccessGrantSessionRlsContext,
} from "../access-grant-rls";
import { buildXaiSubscriptionAuthorization } from "../xai-subscription-auth";

export type ModelCallServiceDeps = {
  db: Database;
  settings: Settings;
  /** Catalog source settings; defaults to `settings`. */
  catalogSourceSettings?: Settings;
  entitlements?: EntitlementsPort | null;
  codexFetch?: CodexFetch;
  xaiFetch?: XaiFetch;
  log?: (message: string, attributes: Record<string, string | number | boolean>) => void;
};

const PROVIDER_MESSAGE_MAX_LENGTH = 512;

export function createModelCallService(deps: ModelCallServiceDeps): ModelCallService {
  const catalogSource = deps.catalogSourceSettings ?? deps.settings;

  async function selections(caller: ModelCallCaller): Promise<{
    catalogSettings: Settings;
    selections: WorkspaceModelSelection[];
  }> {
    return await withAccessGrantSessionRlsContext(deps, caller.grant, async () => {
      const catalogSettings = (
        await resolveWorkspaceCatalogSettings(deps.db, catalogSource, {
          accountId: caller.accountId,
          workspaceId: caller.workspaceId,
        })
      ).settings;
      return {
        catalogSettings,
        selections: await resolveCallerWorkspaceModelSelections(deps.db, catalogSettings, {
          accountId: caller.accountId,
          workspaceId: caller.workspaceId,
          subjectId: caller.subjectId,
        }),
      };
    });
  }

  async function resolveModel(
    caller: ModelCallCaller,
    requested: string | null,
  ): Promise<{ selection: WorkspaceModelSelection; catalogSettings: Settings }> {
    const resolved = await selections(caller);
    let modelId = requested;
    if (!modelId) {
      const workspace = await getWorkspace(deps.db, caller.workspaceId);
      modelId = (
        await resolveDefaultSessionModelForSelections(deps.db, {
          settings: resolved.catalogSettings,
          accountId: caller.accountId,
          workspaceSettings: workspace?.settings ?? {},
          selections: resolved.selections,
        })
      ).model;
    }
    const selection = admissibleWorkspaceModel(resolved.selections, modelId);
    if (!selection) {
      throw new ModelCallError({
        status: 404,
        type: "not_found_error",
        code: "model_not_found",
        param: "model",
        message: `The model '${modelId}' does not exist or is not available in this workspace.`,
      });
    }
    return { selection, catalogSettings: resolved.catalogSettings };
  }

  return {
    async listModels(caller) {
      const { selections: all } = await selections(caller);
      return all.filter(isWorkspaceModelAdmissible).map(({ model }) => ({
        id: model.id,
        label: model.label,
        providerLabel: model.providerLabel,
      }));
    },

    async call(input) {
      const { selection, catalogSettings } = await resolveModel(input, input.model);
      const model = selection.model;
      assertModelSupportsRequest(model, input.request);
      const source = model.credentialSource;
      const subscription = source.kind === "connected_subscription" ? source.provider : null;
      const chargesOpenGeniCredits = model.billing.metering === "opengeni_credits";
      const countsTowardTokenCap = model.billing.upstreamPayer === "deployment";
      const admission = await admitModelCall(deps, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        model: model.id,
        chargesOpenGeniCredits,
        countsTowardTokenCap,
        subjectId: input.subjectId,
      });
      if (!admission.allowed) {
        throw new ModelCallError({
          status: admission.denial === "insufficient_credits" ? 402 : 429,
          type: "insufficient_quota",
          code: admission.denial,
          message: admission.message,
        });
      }
      let settings = await settingsWithModelProviderCredentials(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        settings: catalogSettings,
        productModelId: model.id,
        codexSubscriptionActive: subscription === "codex",
      });
      if (subscription === "claude") {
        settings = await withClaudeSubscriptionCredential(deps, settings, input, model);
      }
      const request = {
        ...input.request,
        ...reasoningEffortFor(model, input.request.reasoningEffort),
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const execute = async (): Promise<SingleModelCallResult> => {
        const binding = new MultiProviderModelProvider(settings).resolveBinding(model.id);
        return await runSingleModelCall(
          { client: binding.client, provider: binding.provider, modelId: binding.modelId },
          request,
          input.onTextDelta ? { onTextDelta: input.onTextDelta } : {},
        );
      };
      let result: SingleModelCallResult;
      try {
        result =
          subscription === "codex"
            ? await withCodexOperation(deps, settings, input, model, execute)
            : subscription === "xai"
              ? await withXaiSubscription(deps, input, execute)
              : await execute();
      } catch (error) {
        const mapped = publicModelCallError(error);
        if (mapped instanceof ModelCallError && mapped.status >= 500) {
          // Names and statuses only: provider messages can echo prompt content.
          deps.log?.("Model call failed", {
            requestId: input.requestId,
            model: model.id,
            code: mapped.code ?? "unknown",
            errorName: error instanceof Error ? error.name : typeof error,
            providerStatus: providerStatus(error) ?? 0,
          });
        }
        throw mapped;
      }
      const usage = result.usage;
      if (usage) {
        // Settlement failure must not discard a completed answer. The usage
        // record is idempotent on the request id; the operator is alerted.
        await withCreditDebitAttribution(creditDebitAttributionForGrant(input.grant), () =>
          // Execution settings carry the workspace catalog the price resolves from.
          settleModelUsage(settings, deps.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            model: model.id,
            chargesOpenGeniCredits,
            countsTowardTokenCap,
            creditPolicyRevision: admission.creditPolicyRevision,
            ...(usage.gatewayBilling ? { gatewayBilling: usage.gatewayBilling } : {}),
            normalizedUsage: normalizeModelCallUsage(usage.usage),
            sourceId: `model_call:${input.requestId}`,
            debitMetadata: { modelCallId: input.requestId },
          }),
        ).catch((error: unknown) => {
          deps.log?.("Model call usage settlement failed", {
            requestId: input.requestId,
            model: model.id,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        });
      }
      return { model: model.id, result } satisfies ModelCallOutput;
    },
  };
}

function assertModelSupportsRequest(model: ConfiguredModel, request: ModelCallInput["request"]) {
  const hasImage = request.messages.some(
    (message) =>
      typeof message.content !== "string" && message.content.some((part) => part.type === "image"),
  );
  if (hasImage && !model.capabilities.inputModalities.includes("image")) {
    throw new ModelCallError({
      status: 400,
      type: "invalid_request_error",
      code: "unsupported_content",
      param: "messages",
      message: `The model '${model.id}' does not accept image input.`,
    });
  }
  if (
    request.outputFormat?.type === "json_schema" &&
    !model.capabilities.structuredOutput.runnable
  ) {
    throw new ModelCallError({
      status: 400,
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: "response_format",
      message: `The model '${model.id}' does not support structured output.`,
    });
  }
}

/** A requested effort clamps to the model's nearest supported effort, or is dropped. */
function reasoningEffortFor(
  model: ConfiguredModel,
  requested: ModelCallInput["request"]["reasoningEffort"],
): Pick<ModelCallInput["request"], "reasoningEffort"> {
  if (!requested || !model.capabilities.reasoning.runnable) return {};
  if (model.capabilities.reasoning.efforts.length === 0) return {};
  return { reasoningEffort: clampReasoningEffortForConfiguredModel(model, requested, requested) };
}

async function withClaudeSubscriptionCredential(
  deps: ModelCallServiceDeps,
  settings: Settings,
  input: ModelCallInput,
  model: ConfiguredModel,
): Promise<Settings> {
  const authoritySnapshot = await resolveClaudeProviderAccountAuthoritySnapshotForAcceptance(
    deps.db,
    { workspaceId: input.workspaceId, subjectId: input.subjectId },
  );
  // Single calls hold no capacity lease, like transcription and media: one
  // account may serve many concurrent requests.
  const selected = await selectClaudeCredentialForUse(deps.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    authoritySnapshot,
    shardKey: input.requestId,
    modelId: model.id,
    upstreamModelId: model.upstreamModelId,
  });
  if (!selected.credentialId) throw subscriptionCapacityUnavailable("Claude");
  const credential = await resolveClaudeAccountCredential(deps.db, deps.settings, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    credentialId: selected.credentialId,
    authoritySnapshot,
  });
  if ("reconnectRequired" in credential) throw subscriptionReconnectRequired("Claude");
  return withClaudeConnectionCredential(
    settings,
    "claude_subscription",
    JSON.stringify(credential.secret),
    authoritySnapshot.scope === "organization" ? "organization" : "workspace",
    { connectionId: selected.credentialId, credentialVersion: credential.version },
  );
}

async function withXaiSubscription<T>(
  deps: ModelCallServiceDeps,
  input: ModelCallInput,
  run: () => Promise<T>,
): Promise<T> {
  let authorization: Awaited<ReturnType<typeof buildXaiSubscriptionAuthorization>>;
  try {
    authorization = await buildXaiSubscriptionAuthorization({
      db: deps.db,
      settings: deps.settings,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      shardKey: input.requestId,
      sessionId: input.requestId,
      ...(deps.xaiFetch ? { fetch: deps.xaiFetch } : {}),
    });
  } catch (error) {
    if (error instanceof XaiSubscriptionReloginRequired) {
      throw subscriptionReconnectRequired("SuperGrok");
    }
    throw subscriptionCapacityUnavailable("SuperGrok");
  }
  let sequence = 0;
  return await xaiSubscriptionRequestStorage.run(
    {
      clientVersion: XAI_CLIENT_VERSION,
      sessionId: input.requestId,
      turnId: input.requestId,
      getToken: authorization.context.getToken,
      refresh: authorization.context.refresh,
      resolveModel: (model) =>
        model.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)
          ? model.slice(XAI_SUBSCRIPTION_MODEL_ID_PREFIX.length)
          : model,
      nextRequestId: () => `completion:${input.requestId}:${++sequence}`,
    },
    run,
  );
}

/**
 * Whether the account still has included plan usage. A single call never
 * spends a ChatGPT account's paid extra credits: an exhausted or unverifiable
 * account is skipped before anything reaches the provider.
 */
export function codexIncludedUsageAvailable(usage: CodexUsagePayload, now = Date.now()): boolean {
  if (usage.status !== "ok" || usage.limitReached) return false;
  const windows = [usage.fiveHour, usage.weekly].filter((window) => window !== null);
  if (windows.length === 0) return false;
  return windows.every(
    (window) =>
      Number.isFinite(window.percent) &&
      (window.percent < 100 || (window.resetAt !== null && Date.parse(window.resetAt) <= now)),
  );
}

/**
 * A Codex single call is a sessionless operation on the shared subscription
 * core, like transcription: it holds its own operation lease on a shared
 * organization- or workspace-scoped connection, and every physical request is
 * reserved and settled against that lease. Accounts are tried in allocation
 * order only before dispatch; a dispatched request is never replayed.
 */
async function withCodexOperation<T>(
  deps: ModelCallServiceDeps,
  settings: Settings,
  input: ModelCallInput,
  model: ConfiguredModel,
  run: () => Promise<T>,
): Promise<T> {
  const disposition = await readCodexCutoverDisposition(
    deps.db,
    input.accountId,
    input.workspaceId,
  );
  if (disposition !== "core") throw subscriptionCapacityUnavailable("Codex");
  const scope: SubscriptionCoreCodexOperationScope = {
    kind: "workspace",
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
  };
  const candidates = (await listSubscriptionCoreCodexOperationCandidates(deps.db, scope)).filter(
    (candidate) => connectionModelAllowed(candidate.allowedModelIds, model.id),
  );
  if (candidates.length === 0) throw subscriptionCapacityUnavailable("Codex");
  const operationId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const resolveModel = buildModelResolver(codexUpstreamModelSlugs(settings));
  for (const candidate of candidates) {
    const ref: SubscriptionCoreCodexOperationLeaseRef = {
      operationId,
      attemptId,
      operationKind: "completion",
      connectionId: candidate.connectionId,
      holderId: `completion:${input.requestId}`.slice(0, 256),
      generation: 1,
    };
    const lease = await acquireSubscriptionCoreCodexOperationLease(deps.db, scope, ref);
    if (lease.kind !== "acquired") continue;
    try {
      const { usage } = await fetchSubscriptionCoreCodexUsage(
        deps.db,
        deps.settings,
        scope,
        candidate.connectionId,
        deps.codexFetch,
      );
      if (!codexIncludedUsageAvailable(usage)) continue;
      const resolver = buildSubscriptionCoreCodexConnectionTokenResolver(
        deps.db,
        deps.settings,
        scope,
        candidate.connectionId,
        ref,
      );
      let pending: { operationId: string } | null = null;
      let sequence = 0;
      const context: CodexRequestContext = {
        clientVersion: CODEX_CLIENT_VERSION,
        getToken: () => resolver.getToken(),
        refresh: () => resolver.refresh(),
        resolveModel,
        beforeProviderDispatch: async (request) => {
          if (!(await renewSubscriptionCoreCodexOperationLease(deps.db, scope, ref))) {
            throw subscriptionCapacityUnavailable("Codex");
          }
          if (request) {
            pending = await reserveSubscriptionCoreCodexOperationRequest(
              deps.db,
              scope,
              ref,
              candidate.connectionId,
              request,
            );
          }
        },
        onProviderRequestSettled: async ({ outcome }) => {
          const reserved = pending;
          pending = null;
          if (!reserved) return;
          await settleSubscriptionCoreCodexOperationRequest(deps.db, scope, {
            operationId: reserved.operationId,
            outcome,
          });
        },
        nextRequestId: () => `completion:${input.requestId}:${++sequence}`,
      };
      return await codexRequestStorage.run(context, run);
    } finally {
      await releaseSubscriptionCoreCodexOperationLease(deps.db, scope, ref).catch(() => false);
    }
  }
  throw new ModelCallError({
    status: 429,
    type: "rate_limit_error",
    code: "subscription_usage_exhausted",
    message: "No Codex subscription account has included usage available right now.",
  });
}

function subscriptionCapacityUnavailable(provider: string): ModelCallError {
  return new ModelCallError({
    status: 503,
    type: "service_unavailable",
    code: "subscription_unavailable",
    message: `No ${provider} subscription account is available for this call.`,
  });
}

function subscriptionReconnectRequired(provider: string): ModelCallError {
  return new ModelCallError({
    status: 503,
    type: "service_unavailable",
    code: "subscription_reconnect_required",
    message: `Reconnect the ${provider} subscription to use this model.`,
  });
}

export function isModelCallAbort(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

function providerMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length > PROVIDER_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, PROVIDER_MESSAGE_MAX_LENGTH)}…`
    : message;
}

/** Map a provider or runtime failure to a public error; aborts pass through. */
export function publicModelCallError(error: unknown): unknown {
  if (error instanceof ModelCallError || isModelCallAbort(error)) return error;
  if (error instanceof SingleModelCallUnsupportedError) {
    return new ModelCallError({
      status: 400,
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: error.parameter,
      message: error.message,
    });
  }
  if (error instanceof CodexReloginRequired) return subscriptionReconnectRequired("Codex");
  if (error instanceof XaiSubscriptionReloginRequired) {
    return subscriptionReconnectRequired("SuperGrok");
  }
  if (error instanceof ClaudeSubscriptionReconnectRequired) {
    return subscriptionReconnectRequired("Claude");
  }
  if (error instanceof SingleModelCallProviderError) {
    return new ModelCallError({
      status: 502,
      type: "api_error",
      code: "provider_error",
      message: providerMessage(error) || "The model request failed.",
    });
  }
  const status = providerStatus(error);
  if (status === 429) {
    return new ModelCallError({
      status: 429,
      type: "rate_limit_error",
      code: "provider_rate_limited",
      message: "The model provider is rate limiting requests. Retry later.",
    });
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new ModelCallError({
      status: 400,
      type: "invalid_request_error",
      code: "provider_rejected_request",
      message: providerMessage(error) || "The model provider rejected the request.",
    });
  }
  return new ModelCallError({
    status: 502,
    type: "api_error",
    code: "provider_error",
    message: "The model request failed.",
  });
}

function providerStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}
