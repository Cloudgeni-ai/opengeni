import {
  ClaudeSubscriptionCredential,
  parseClaudeUsageHeaders,
  withClaudeConnectionCredential,
  type Settings,
} from "@opengeni/config";
import {
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  codexRequestStorage,
  withResponsesConversation,
} from "@opengeni/codex";
import { XAI_CLIENT_VERSION, xaiSubscriptionRequestStorage } from "@opengeni/xai-subscription";
import {
  buildSubscriptionCoreCodexConnectionTokenResolver,
  readSubscriptionCoreTurnIdentity,
  renewSessionTitleOperation,
  subscriptionCoreOperationConnections,
  subscriptionCoreOperations,
  subscriptionCoreProvider,
  subscriptionCoreRequests,
  subscriptionCoreTurns,
  decodeSubscriptionCoreClaudeQuota,
  type Database,
  type SessionTitleOperation,
} from "@opengeni/db";
import { withClaudeUsageObserver } from "@opengeni/runtime";
import {
  createCoreSubscriptionRequests,
  type CoreSubscriptionRequests,
} from "./agent-turn/subscription-core-requests";
import {
  claudeCoreModelScope,
  claudeCoreRequestPreparer,
  claudeCoreSettingsCredential,
  claudeSubscriptionUpstreamModelIds,
} from "./agent-turn/claude-core";
import { runAuxiliaryProviderDispatch } from "./auxiliary-provider-dispatch";
import {
  createCodexCreditGuard,
  assertCodexDispatchAdmission,
} from "./agent-turn/codex-credit-policy";
import { codexUsageHeadersQuotaObservation } from "./agent-turn/codex-core-settlement";
import type { SubscriptionQuota } from "@opengeni/subscriptions";

export const SESSION_TITLE_LEASE_MS = 5 * 60_000;

/** Positive retry evidence, unlike an arbitrary credential/admission failure. */
export class SessionTitleLeaseBusyError extends Error {}

/** The normal provider clients, but with the metadata job's lease and request lane. */
export async function withSessionTitleCustody<T>(
  input: {
    db: Database;
    settings: Settings;
    operation: SessionTitleOperation;
    productModelId: string;
    upstreamModelId: string;
    providerId: string;
    reasoningLevel: string;
    onCleanupError: (error: unknown) => void;
    onQuotaRecovered: () => Promise<void>;
  },
  run: (
    settings: Settings,
    lane: CoreSubscriptionRequests | null,
    flushObservations: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const { db, settings, operation } = input;
  if (!operation.connectionId) return run(settings, null, async () => {});
  const provider = subscriptionCoreProvider(operation.provider);
  const identity = await readSubscriptionCoreTurnIdentity(db, {
    ...operation,
    turnId: operation.sourceTurnId,
  });
  if (!identity || !operation.holderId) throw provider.errors.accessLost();
  const scope = { kind: "turn" as const, identity };
  const ref = {
    operationId: operation.id,
    operationKind: "session_title" as const,
    attemptId: operation.sourceAttemptId,
    holderId: operation.holderId,
    generation: operation.generation,
    connectionId: operation.connectionId,
  };
  const operations = subscriptionCoreOperations(provider);
  const acquired = await operations.acquireSubscriptionCoreOperationLease(db, scope, ref);
  if (acquired.kind === "busy")
    throw new SessionTitleLeaseBusyError("Title provider lease is busy");
  if (acquired.kind !== "acquired") throw provider.errors.accessLost();
  const repository = subscriptionCoreRequests(provider);
  const lane = createCoreSubscriptionRequests({
    displayName: provider.adapter.displayName,
    reserve: (request) =>
      repository.reserveSubscriptionCoreOperationRequest(
        db,
        scope,
        ref,
        operation.connectionId!,
        request,
      ),
    settle: (request) => repository.settleSubscriptionCoreOperationRequest(db, scope, request),
    outcomeUnknown: provider.errors.requestOutcomeUnknown,
    isOutcomeUnknown: (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      return typeof code === "string" && code.endsWith("outcome_unknown");
    },
  });
  const assertDispatch = async () => {
    if (
      await repository.isSubscriptionCoreSourceDisconnected(db, identity, operation.connectionId!)
    )
      throw provider.errors.sourceDisconnected();
    const current = await renewSessionTitleOperation(db, {
      ...operation,
      operationId: operation.id,
      holderId: operation.holderId!,
      ttlMs: SESSION_TITLE_LEASE_MS,
    });
    if (!current || !(await operations.renewSubscriptionCoreOperationLease(db, scope, ref))) {
      throw provider.errors.leaseLost();
    }
  };
  let sequence = 0;
  let observations: Promise<boolean> = Promise.resolve(false);
  let recoveredDelivered = false;
  const observeQuota = (quota: SubscriptionQuota) => {
    observations = observations.then(async (recovered) => {
      try {
        const result = await operations.recordSubscriptionCoreUsageObservation(
          db,
          scope,
          operation.connectionId!,
          quota,
          {},
          ref,
        );
        return recovered || result.recovered;
      } catch (error) {
        input.onCleanupError(error);
        return recovered;
      }
    });
  };
  const flushObservations = async () => {
    const recovered = await observations;
    if (recovered && !recoveredDelivered) {
      recoveredDelivered = true;
      try {
        await input.onQuotaRecovered();
      } catch (error) {
        input.onCleanupError(error);
      }
    }
  };
  const nextRequestId = () => `session-title:${operation.id}:${operation.generation}:${++sequence}`;
  const resolveModel = buildModelResolver([input.upstreamModelId]);
  const invoke = (nextSettings: Settings) =>
    withResponsesConversation(undefined, () =>
      runAuxiliaryProviderDispatch(() => run(nextSettings, lane, flushObservations)),
    );
  try {
    if (operation.provider === "codex") {
      const token = buildSubscriptionCoreCodexConnectionTokenResolver(
        db,
        settings,
        scope,
        operation.connectionId,
        ref,
      );
      let credentialVersion = 0;
      const track = async (load: typeof token.getToken) => {
        const value = await load();
        credentialVersion = value.credentialVersion;
        return value;
      };
      const guard = createCodexCreditGuard({
        canSpendCredits: () =>
          subscriptionCoreTurns(provider).canSpendSubscriptionCoreExtraCredits(db, {
            identity,
            connectionId: operation.connectionId!,
            attemptId: operation.sourceAttemptId,
            executionGeneration: operation.sourceExecutionGeneration,
            holderId: operation.holderId!,
            productModelId: input.productModelId,
            reasoningLevel: input.reasoningLevel,
            leaseTtlMs: SESSION_TITLE_LEASE_MS,
            operationRef: ref,
          }),
      });
      return await codexRequestStorage.run(
        {
          clientVersion: CODEX_CLIENT_VERSION,
          sessionId: operation.sessionId,
          getToken: () => track(token.getToken),
          refresh: () => track(token.refresh),
          onUsageHeaders: (snapshot) => {
            guard.observe(snapshot);
            observeQuota(codexUsageHeadersQuotaObservation(snapshot, credentialVersion));
          },
          resolveModel,
          nextRequestId,
          turnMetadata: { request_kind: "session_title" },
          beforeProviderDispatch: async (request) => {
            const stored = await operations.readSubscriptionCoreOperationQuota(db, scope, ref);
            if (!stored) throw provider.errors.accessLost();
            const now = Date.now();
            const quota = stored.quota;
            if (
              quota?.exhaustedKind === "quota" &&
              quota.exhaustedUntil !== null &&
              quota.exhaustedUntil > now
            )
              guard.observeIncludedExhaustion(quota.exhaustedUntil);
            for (const window of quota?.windows ?? []) {
              if (
                (window.usedPercent ?? 0) >= 100 &&
                (window.resetsAt === null || window.resetsAt > now)
              )
                guard.observeIncludedExhaustion(window.resetsAt);
            }
            await assertCodexDispatchAdmission(
              guard.assertKnownUsageAllowsDispatch,
              assertDispatch,
            );
            if (!request) throw provider.errors.operationUnavailable();
            await lane.reserve(request);
          },
          onProviderRequestSettled: lane.observe,
        },
        () => invoke(settings),
      );
    }
    const token = subscriptionCoreOperationConnections(
      provider,
    ).buildSubscriptionCoreConnectionTokenResolver(
      db,
      settings,
      scope,
      operation.connectionId,
      ref,
    );
    if (operation.provider === "xai") {
      const map = (value: Awaited<ReturnType<typeof token.getToken>>) => {
        const credential = value.credential as { accessToken?: unknown };
        if (typeof credential.accessToken !== "string" || !value.providerAccountId)
          throw provider.errors.accessLost();
        return { accessToken: credential.accessToken, userId: value.providerAccountId };
      };
      return await xaiSubscriptionRequestStorage.run(
        {
          clientVersion: XAI_CLIENT_VERSION,
          sessionId: operation.sessionId,
          turnId: operation.sourceTurnId,
          getToken: async () => map(await token.getToken()),
          refresh: async () => map(await token.refresh()),
          resolveModel,
          nextRequestId,
          beforeProviderDispatch: async (request) => {
            await assertDispatch();
            await lane.reserve(request);
          },
          onProviderRequestSettled: lane.observe,
        },
        () => invoke(settings),
      );
    }
    if (operation.provider !== "claude") throw provider.errors.operationUnavailable();
    const map = (value: Awaited<ReturnType<typeof token.getToken>>) => ({
      credential: ClaudeSubscriptionCredential.parse(value.credential),
      credentialVersion: value.credentialVersion,
    });
    const current = map(await token.getToken());
    let refresh: Promise<ReturnType<typeof map>> | undefined;
    const authorization = {
      getToken: async () => map(await token.getToken()),
      renewAfterUnauthorized: async (generation: number) => {
        refresh ??= token.refresh().then(map);
        const next = await refresh;
        return next.credentialVersion > generation ? next : null;
      },
      assertDispatch,
      mainLaneAdmitted: () => undefined,
      observeResponse: (response: Response, generation: number, upstreamModelId?: string) => {
        const observation = parseClaudeUsageHeaders(response.headers, new Date(), upstreamModelId);
        if (observation)
          observeQuota({
            ...decodeSubscriptionCoreClaudeQuota({
              observation,
              refreshGeneration: generation,
              upstreamModelIds: claudeSubscriptionUpstreamModelIds(settings),
            }),
            revision: 0,
          });
      },
    };
    const claudeSettings = withClaudeConnectionCredential(
      settings,
      "claude_subscription",
      claudeCoreSettingsCredential(current, operation.connectionId),
      claudeCoreModelScope(input.productModelId),
      { connectionId: operation.connectionId, credentialVersion: current.credentialVersion },
    );
    return await withClaudeUsageObserver(
      () => undefined,
      () => invoke(claudeSettings),
      claudeCoreRequestPreparer({
        authorization,
        observe: authorization.observeResponse,
        lane,
        mainLane: false,
        nextRequestId,
        providerIds: new Set([input.providerId]),
      }),
    );
  } finally {
    await flushObservations();
    // Retained-response/terminal settlement and reclaim also release the exact
    // owner transactionally. Cleanup failure must not replace transport evidence.
    try {
      await operations.releaseSubscriptionCoreOperationLease(db, scope, ref);
    } catch (error) {
      input.onCleanupError(error);
    }
  }
}
