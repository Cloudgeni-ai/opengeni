import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { settingsWithModelProviderCredentials } from "@opengeni/core";
import {
  admitSessionTitleOperation,
  appendSessionEvents,
  claimSessionTitleOperation,
  completeSessionTitleOperation,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  finishSessionTitleOperation,
  getSessionTitleOperation,
  getSessionTitleTarget,
  getSessionTitleRequestOutcome,
  isRetryableDatabaseTransportFailure,
  isRetryablePersistenceSqlState,
  nestedPostgresSqlState,
  readSubscriptionCoreTurnIdentity,
  retrySessionTitleOperation,
  recordSessionTitleResponse,
  reserveSessionTitleDispatch,
  updateSessionTitleWithEvent,
  type Database,
  type SessionTitleOperation,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  normalizeModelCallUsage,
  SESSION_TITLE_GENERATION_INPUT_MAX_CHARACTERS,
  withModelTransportStartedObserver,
} from "@opengeni/runtime";
import type { TurnExecutionPolicyV1, SessionEvent } from "@opengeni/contracts";
import type { TurnActivityServices } from "./types";
import {
  PARALLEL_SESSION_TITLE_TIMEOUT_MS,
  sessionTitleGenerationOptions,
  sessionTitleRoute,
  type SessionTitleRoute,
} from "./agent-turn/session-title";
import { resolveAcceptedTurnModel } from "./agent-turn/tool-policy";
import {
  emitModelCallUsage,
  recordAuthoritativeModelCallFact,
  recordAuthoritativeModelUsageMetrics,
  recordModelUsageAndDebitCredits,
} from "./agent-turn/model-usage";
import {
  assertSessionTitleRoute,
  SessionTitleRequest,
  SessionTitleResponse,
  SessionTitleRouteUnavailableError,
  sessionTitleApiConnectionId,
  sessionTitleRouteIdentity,
  titlePricingJson,
} from "./session-title-route";
import {
  SESSION_TITLE_LEASE_MS,
  SessionTitleLeaseBusyError,
  withSessionTitleCustody,
} from "./session-title-custody";
import {
  CODEX_CORE_WAIT_BINDING,
  wakeSubscriptionCoreWaitersAndDeliver,
} from "./subscription-core-codex-waits";
import { CLAUDE_CORE_WAIT_BINDING } from "./subscription-core-claude-waits";
import { XAI_CORE_WAIT_BINDING } from "./subscription-core-xai-waits";

type OperationInput = { accountId: string; workspaceId: string; operationId: string };
type ReconcileResult = { action: "terminal" } | { action: "retry"; delayMs: number };

export async function admitIndependentSessionTitle(input: {
  db: Database;
  settings: Settings;
  start: NonNullable<TurnActivityServices["startSessionTitleWorkflow"]>;
  observability: TurnActivityServices["observability"];
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  route: SessionTitleRoute;
  policy: TurnExecutionPolicyV1;
  prompt: string;
  subscriptionConnectionId: string | null;
  subscriptionProvider: string | null;
  expectedTitle: SessionTitleRequest["expectedTitle"];
  creditPolicyRevision?: number | undefined;
  externallyBilled: boolean;
  chargesOpenGeniCredits: boolean;
  countsTowardTokenCap: boolean;
  serviceTier?: "fast" | "priority" | "ultrafast";
}): Promise<void> {
  if (!input.prompt.trim()) return;
  const key = environmentsEncryptionKeyBytes(input.settings);
  if (!key) throw new Error("Independent title requires the environment encryption key");
  const identity = await readSubscriptionCoreTurnIdentity(input.db, input);
  if (!identity) throw new Error("Title source turn is no longer accessible");
  const route = sessionTitleRouteIdentity(input.route);
  const request = SessionTitleRequest.parse({
    version: 1,
    ...route,
    policy: input.policy,
    prompt: Array.from(input.prompt.trim())
      .slice(0, SESSION_TITLE_GENERATION_INPUT_MAX_CHARACTERS)
      .join(""),
    apiConnectionId: input.subscriptionConnectionId
      ? null
      : await sessionTitleApiConnectionId({
          ...input,
          productModelId: input.policy.productModelId,
          provider: input.route.resolvedModel!.provider,
        }),
    expectedTitle: input.expectedTitle,
    creditPolicyRevision: input.creditPolicyRevision,
    externallyBilled: input.externallyBilled,
    chargesOpenGeniCredits: input.chargesOpenGeniCredits,
    countsTowardTokenCap: input.countsTowardTokenCap,
    pricingJson: titlePricingJson(input.settings, route.modelId),
    serviceTier: input.serviceTier,
  });
  const operation = await admitSessionTitleOperation(input.db, {
    identity,
    attemptId: input.attemptId,
    executionGeneration: input.executionGeneration,
    provider: input.subscriptionProvider ?? route.providerId,
    connectionId: input.subscriptionConnectionId,
    requestEncrypted: encryptEnvironmentValue(key, JSON.stringify(request)),
  });
  if (!operation) throw new Error("Title source attempt is no longer current");
  try {
    await input.start({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: operation.id,
    });
  } catch (error) {
    // Admission is durable. The recovery sweep starts this same workflow, never
    // a detached title promise and never a second naming request.
    input.observability.warn("Session title workflow start awaits recovery", {
      operationId: operation.id,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export function createSessionTitleActivities(services: () => Promise<TurnActivityServices>) {
  return {
    reconcileSessionTitleOperation: async (input: OperationInput): Promise<ReconcileResult> =>
      reconcileSessionTitleOperation(await services(), input),
  };
}

export async function reconcileSessionTitleOperation(
  service: TurnActivityServices,
  input: OperationInput,
): Promise<ReconcileResult> {
  const { db } = service;
  const prior = await getSessionTitleOperation(db, input);
  if (!prior || ["completed", "failed", "unknown"].includes(prior.state))
    return { action: "terminal" };
  const operation = await claimSessionTitleOperation(db, {
    ...input,
    holderId: `session-title:${crypto.randomUUID()}`,
    ttlMs: SESSION_TITLE_LEASE_MS,
  });
  if (!operation) return { action: "retry", delayMs: 5_000 };
  const claim = { ...input, holderId: operation.holderId!, generation: operation.generation };
  const finish = async (state: "failed" | "unknown"): Promise<ReconcileResult> =>
    (await finishSessionTitleOperation(db, { ...claim, state }))
      ? { action: "terminal" }
      : { action: "retry", delayMs: 5_000 };
  try {
    const key = environmentsEncryptionKeyBytes(service.settings);
    if (!key) throw new Error("Session title encryption key is unavailable");
    const request = SessionTitleRequest.parse(
      JSON.parse(decryptEnvironmentValue(key, operation.requestEncrypted!)),
    );
    if (operation.state === "dispatching") {
      // A worker vanished after reservation. Lack of a retained response is not
      // proof that the provider did not act; never send it again.
      const refused = (await getSessionTitleRequestOutcome(db, operation)) === "refused";
      return await finish(refused ? "failed" : "unknown");
    }
    if (operation.state === "responded") {
      const recoveredSettings = await settingsWithModelProviderCredentials(db, {
        ...input,
        settings: service.settings,
        productModelId: request.policy.productModelId,
        codexSubscriptionActive: operation.provider === "codex",
      });
      const completed = await completeTitle(service, operation, request, {
        ...recoveredSettings,
        modelPricingJson: request.pricingJson,
      });
      if (!completed) return { action: "retry", delayMs: 5_000 };
      return { action: "terminal" };
    }
    const target = await getSessionTitleTarget(db, operation);
    if (
      !target ||
      target.archived ||
      target.title !== request.expectedTitle.title ||
      target.source !== request.expectedTitle.source
    ) {
      return await finish("failed");
    }
    const settings = await settingsWithModelProviderCredentials(db, {
      ...input,
      settings: service.settings,
      productModelId: request.policy.productModelId,
      codexSubscriptionActive: operation.provider === "codex",
    });
    await withSessionTitleCustody(
      {
        db,
        settings,
        operation,
        productModelId: request.policy.productModelId,
        upstreamModelId: request.upstreamModelId,
        providerId: request.providerId,
        reasoningLevel: request.policy.reasoningEffort,
        onQuotaRecovered: async () => {
          const binding =
            operation.provider === "codex"
              ? CODEX_CORE_WAIT_BINDING
              : operation.provider === "claude"
                ? CLAUDE_CORE_WAIT_BINDING
                : XAI_CORE_WAIT_BINDING;
          await wakeSubscriptionCoreWaitersAndDeliver(service, binding, {
            accountId: operation.accountId,
            reason: "quota_observed_available",
          });
        },
        onCleanupError: (error) =>
          service.observability.warn("Title lease cleanup awaits durable settlement", {
            operationId: operation.id,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          }),
      },
      async (authorizedSettings, lane, flushObservations) => {
        const source = resolveAcceptedTurnModel(
          service.runtime,
          authorizedSettings,
          request.policy,
        );
        const route = sessionTitleRoute({
          resolvedModel: source,
          modelName: request.policy.upstreamModelId,
          resolveTurnModel: (id) => service.runtime.resolveTurnModel(authorizedSettings, id),
        });
        assertSessionTitleRoute(request, route);
        if (!operation.connectionId) {
          const connectionId = await sessionTitleApiConnectionId({
            ...input,
            db,
            settings: authorizedSettings,
            productModelId: request.policy.productModelId,
            provider: route.resolvedModel!.provider,
          });
          if (connectionId !== request.apiConnectionId)
            throw new SessionTitleRouteUnavailableError("Accepted title account changed");
        }
        if (!service.runtime.generateSessionTitle)
          throw new SessionTitleRouteUnavailableError("Title generation is unavailable");
        const generate = () =>
          service.runtime.generateSessionTitle!(
            authorizedSettings,
            request.prompt,
            sessionTitleGenerationOptions({
              resolvedModel: route.resolvedModel,
              modelName: route.modelName,
              serviceTier: request.serviceTier,
              signal: AbortSignal.timeout(PARALLEL_SESSION_TITLE_TIMEOUT_MS),
            }),
          );
        // SDK retries within this live invocation reuse one reservation. A new
        // activity still sees dispatching and never replays an uncertain call.
        let reservation: Promise<void> | undefined;
        const result = operation.connectionId
          ? await generate()
          : await withModelTransportStartedObserver(
              () =>
                (reservation ??= (async () => {
                  if (!(await reserveSessionTitleDispatch(db, claim)))
                    throw new Error("Title request was already dispatched");
                })()),
              generate,
            );
        // Paid usage is accounting truth even if the metadata holder expired
        // while the provider was answering. The same stable key is replay-safe
        // when the retained-response transaction later records its event/fact.
        let billingFailure: { error: unknown } | null = null;
        try {
          if (result.usage)
            await recordTitleBilling(
              service,
              db,
              operation,
              request,
              {
                ...authorizedSettings,
                modelPricingJson: request.pricingJson,
              },
              result.usage,
            );
        } catch (error) {
          billingFailure = { error };
        }
        await flushObservations().catch((error) => {
          service.observability.warn("Title quota observation was not applied", {
            operationId: operation.id,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
        });
        if (
          !(await recordSessionTitleResponse(db, {
            ...claim,
            responseEncrypted: encryptEnvironmentValue(
              key,
              JSON.stringify(SessionTitleResponse.parse(result)),
            ),
          }))
        ) {
          throw new Error("Title response holder expired");
        }
        // Only the retained finite response permits the transport lane to settle.
        // Completion records the exact retained request even if access was
        // revoked since dispatch. A live-lane cleanup failure cannot lose it.
        await lane?.checkpoint().catch((error) => {
          service.observability.warn("Retained title request awaits atomic settlement", {
            operationId: operation.id,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
        });
        if (billingFailure) throw billingFailure.error;
        const retained = await getSessionTitleOperation(db, input);
        if (!retained) throw new Error("Title operation disappeared");
        if (
          !(await completeTitle(service, retained, request, {
            ...authorizedSettings,
            modelPricingJson: request.pricingJson,
          }))
        )
          throw new Error("Title settlement holder expired");
      },
    );
  } catch (error) {
    const current = await getSessionTitleOperation(db, input);
    if (
      (current?.state === "pending" || current?.state === "responded") &&
      isRetryableTitleAdmissionError(error)
    ) {
      await retrySessionTitleOperation(db, claim);
      return { action: "retry", delayMs: 5_000 };
    }
    const uncertain =
      current?.state === "dispatching" &&
      (await getSessionTitleRequestOutcome(db, current)) !== "refused";
    const outcome = await finish(uncertain ? "unknown" : "failed");
    service.observability.warn("Independent session title failed", {
      operationId: operation.id,
      terminalStateCommitted: outcome.action === "terminal",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    });
    return outcome;
  }
  return { action: "terminal" };
}

function isRetryableTitleAdmissionError(error: unknown): boolean {
  return (
    error instanceof SessionTitleLeaseBusyError ||
    isRetryablePersistenceSqlState(nestedPostgresSqlState(error)) ||
    isRetryableDatabaseTransportFailure(error)
  );
}

function recordTitleBilling(
  service: TurnActivityServices,
  db: Database,
  operation: SessionTitleOperation,
  request: SessionTitleRequest,
  settings: Settings,
  usage: NonNullable<ReturnType<typeof SessionTitleResponse.parse>["usage"]>,
) {
  return recordModelUsageAndDebitCredits(settings, db, {
    accountId: operation.accountId,
    workspaceId: operation.workspaceId,
    sessionId: operation.sessionId,
    turnId: operation.sourceTurnId,
    turnAttemptId: operation.sourceAttemptId,
    model: request.modelId,
    sourceKey: `session-title:${operation.id}`,
    externallyBilled: request.externallyBilled,
    chargesOpenGeniCredits: request.chargesOpenGeniCredits,
    countsTowardTokenCap: request.countsTowardTokenCap,
    creditPolicyRevision: request.creditPolicyRevision,
    normalizedUsage: normalizeModelCallUsage(usage.usage),
    usage: usage.usage,
    gatewayBilling: usage.gatewayBilling,
    observability: service.observability,
    metricProvider: request.providerId,
    atomicReceiptPersistence: true,
  });
}

async function completeTitle(
  service: TurnActivityServices,
  operation: SessionTitleOperation,
  request: SessionTitleRequest,
  settings: Settings,
) {
  const key = environmentsEncryptionKeyBytes(service.settings)!;
  const generated = SessionTitleResponse.parse(
    JSON.parse(decryptEnvironmentValue(key, operation.responseEncrypted!)),
  );
  const result = await completeSessionTitleOperation(
    service.db,
    {
      ...operation,
      operationId: operation.id,
      holderId: operation.holderId!,
    },
    async (tx) => {
      const events: SessionEvent[] = [];
      let usageMetrics: Parameters<typeof recordAuthoritativeModelUsageMetrics>[0] | null = null;
      const sourceKey = `session-title:${operation.id}`;
      const identity = {
        accountId: operation.accountId,
        workspaceId: operation.workspaceId,
        sessionId: operation.sessionId,
        turnId: operation.sourceTurnId,
        turnAttemptId: operation.sourceAttemptId,
      };
      if (generated.usage) {
        const normalizedUsage = normalizeModelCallUsage(generated.usage.usage);
        const billing = await recordTitleBilling(
          service,
          tx,
          operation,
          request,
          settings,
          generated.usage,
        );
        const authoritative = await emitModelCallUsage({
          ...identity,
          observability: service.observability,
          provider: request.providerId,
          providerApi: request.policy.wireApi,
          model: request.modelId,
          purpose: "session-title",
          sourceKey,
          usage: generated.usage,
          normalizedUsage,
          ...(billing ? { billingPath: billing.billingPath, billingSnapshot: billing } : {}),
          ...(billing?.upstreamProvider ? { upstreamProvider: billing.upstreamProvider } : {}),
          publish: async (inputs) => {
            const appended = await appendSessionEvents(
              tx,
              operation.workspaceId,
              operation.sessionId,
              inputs.map((event) => ({
                ...event,
                turnId: operation.sourceTurnId,
                turnAttemptId: operation.sourceAttemptId,
              })),
            );
            events.push(...appended);
            return { events: appended, accepted: true, canonicalStartupMilestones: [] };
          },
        });
        if (authoritative && billing) {
          await recordAuthoritativeModelCallFact({
            ...identity,
            db: tx,
            observability: service.observability,
            sourceKey,
            provider: request.providerId,
            providerApi: request.policy.wireApi,
            model: request.modelId,
            billing,
            subscriptionConnectionId: operation.connectionId,
          });
          usageMetrics = {
            settings,
            observability: service.observability,
            provider: request.providerId,
            model: request.modelId,
            externallyBilled: request.externallyBilled,
            billing,
            webSearchRequests: generated.usage.webSearchRequests,
          };
        }
      }
      const target = await getSessionTitleTarget(tx, operation);
      if (generated.title && target && !target.archived) {
        const title = await updateSessionTitleWithEvent(tx, {
          workspaceId: operation.workspaceId,
          sessionId: operation.sessionId,
          title: generated.title,
          source: "agent",
          expectedCurrent: request.expectedTitle,
        });
        events.push(...title.events);
      }
      return { events, usageMetrics };
    },
  );
  if (result.completed && result.value.usageMetrics)
    recordAuthoritativeModelUsageMetrics(result.value.usageMetrics);
  if (result.completed && result.value.events.length) {
    await publishDurableSessionEvents(
      service.bus,
      operation.workspaceId,
      operation.sessionId,
      result.value.events,
    );
  }
  return result.completed;
}
