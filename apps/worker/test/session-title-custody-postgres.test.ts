import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as titleDb from "@opengeni/db";
import * as titlePolicy from "../src/activities/agent-turn/tool-policy";
import { resolveTurnModel } from "@opengeni/runtime";
import { recordModelTransportStarted } from "../../../packages/runtime/src/model-preparation-diagnostics";
import {
  acquireSharedTestDatabase,
  testSettings,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { codexRequestStorage } from "@opengeni/codex";
import { xaiSubscriptionRequestStorage } from "@opengeni/xai-subscription";
import {
  admitSessionTitleOperation,
  claimSessionTitleOperation,
  encryptEnvironmentValue,
  finishSessionTitleOperation,
  recordSessionTitleResponse,
  subscriptionCoreProvider,
  subscriptionCoreTurns,
  reserveSessionTitleDispatch,
  getSessionTitleOperation,
  updateSessionTitleWithEvent,
  aggregateModelCallFacts,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import { prepareClaudeSubscriptionRequest } from "../../../packages/runtime/src/claude-subscription-usage";
import { failoverFixture } from "../../../packages/db/test/helpers/subscription-core-failover-fixture";
import { withSessionTitleCustody } from "../src/activities/session-title-custody";
import { reconcileSessionTitleOperation } from "../src/activities/independent-session-title";
import { SessionTitleRequest } from "../src/activities/session-title-route";
import { SessionTitleLeaseBusyError } from "../src/activities/session-title-custody";
import type { TurnActivityServices } from "../src/activities/types";

setDefaultTimeout(180_000);
const enabled = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const providers = ["codex", "claude", "xai"].map(subscriptionCoreProvider);
const models = providers.map((provider) => ({
  id: `${provider.adapter.provider}/title-fixture`,
  provider: provider.adapter.provider,
  upstreamModelId: "title-fixture",
  reasoningLevels: ["high"],
}));
const key = Buffer.alloc(32, 53);
const settings = testSettings({
  environmentsEncryptionKey: key.toString("base64"),
  claudeSubscriptionEnabled: true,
  openaiAllowedModels: "gpt-6-luna",
});
let shared: SharedTestDatabase;
let fixture: ReturnType<typeof failoverFixture>;
beforeAll(async () => {
  if (!enabled) return;
  const value = await acquireSharedTestDatabase("session-title-native-custody");
  if (!value) throw new Error("Real PostgreSQL required");
  shared = value;
  fixture = failoverFixture(shared, providers, models);
});
afterAll(async () => {
  await fixture?.client.close();
  await shared?.release();
});

describe.skipIf(!enabled)("independent title native request custody", () => {
  for (const scenario of [
    "permanent",
    "busy",
    "serialization",
    "expired",
    "completion_retry",
    "completion_permanent",
    "sdk_retry",
    "stale_target",
    "stale_recovery",
    "renamed",
  ] as const) {
    test(`API title recovery: ${scenario}`, async () => {
      const org = await fixture.organization();
      const work = await fixture.turn(org, { model: models[0]! });
      const [turn] = await shared.admin<{ metadata: Record<string, unknown> }[]>`
        select metadata from session_turns where id = ${work.identity.turnId}::uuid`;
      const [session] = await shared.admin<
        { title: string | null; title_source: "agent" | "user" | null }[]
      >`
        select title, title_source from sessions where id = ${work.identity.sessionId}::uuid`;
      const policy = TurnExecutionPolicyV1.parse(turn!.metadata.turnExecutionPolicyV1);
      const resolved = resolveTurnModel(settings, "gpt-6-luna")!;
      expect(resolved).not.toBeNull();
      const request = SessionTitleRequest.parse({
        version: 1,
        prompt: "Explain coastal lighthouses",
        policy,
        providerId: resolved.provider.id,
        modelId: resolved.configured.id,
        upstreamModelId: policy.upstreamModelId,
        definitionVersion: resolved.configured.definitionVersion,
        apiConnectionId: null,
        expectedTitle: { title: session!.title, source: session!.title_source },
        externallyBilled: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        pricingJson: "{}",
      });
      const job = await admitSessionTitleOperation(fixture.client.db, {
        ...work,
        provider: "fixture-api",
        connectionId: null,
        requestEncrypted: encryptEnvironmentValue(key, JSON.stringify(request)),
      });
      const input = {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        operationId: job!.id,
      };
      await fixture.finish(work);
      if (scenario === "renamed" || scenario === "stale_target")
        await updateSessionTitleWithEvent(fixture.client.db, {
          workspaceId: org.workspaceId,
          sessionId: work.identity.sessionId,
          title: "My chosen title",
          source: "user",
        });
      let generated = 0;
      const service = {
        db: fixture.client.db,
        settings,
        bus: new MemoryEventBus(),
        observability: createObservability(settings, { component: "worker" }),
        runtime: {
          resolveTurnModel: () => resolved,
          generateSessionTitle: async () => {
            generated++;
            if (scenario === "permanent") throw new Error("Invalid configuration");
            if (scenario === "busy" && generated === 1) throw new SessionTitleLeaseBusyError();
            if (scenario === "serialization" && generated === 1)
              throw Object.assign(new Error("serialization"), { code: "40001" });
            await recordModelTransportStarted();
            if (scenario === "sdk_retry") await recordModelTransportStarted();
            if (scenario === "expired")
              await shared.admin`
              update session_title_operations set leased_until = clock_timestamp() - interval '1 second'
              where id = ${job!.id}::uuid`;
            return {
              title: "Coastal Lighthouse History",
              usage: {
                responseId: "fixture-response",
                usage: { inputTokens: 50, outputTokens: 12, totalTokens: 62 },
              },
            };
          },
        },
      } as unknown as TurnActivityServices;
      const route = spyOn(titlePolicy, "resolveAcceptedTurnModel").mockReturnValue(resolved);
      let titleFailure: ReturnType<typeof spyOn> | undefined;
      if (scenario === "completion_retry" || scenario === "completion_permanent")
        titleFailure = spyOn(titleDb, "updateSessionTitleWithEvent").mockRejectedValueOnce(
          Object.assign(new Error("database write failed"), {
            code: scenario === "completion_retry" ? "40001" : "XX000",
          }),
        );
      let terminalFailure: ReturnType<typeof spyOn> | undefined;
      if (scenario === "stale_target" || scenario === "stale_recovery")
        terminalFailure = spyOn(titleDb, "finishSessionTitleOperation").mockResolvedValueOnce(
          false,
        );
      if (scenario === "stale_recovery") {
        await claimSessionTitleOperation(fixture.client.db, {
          ...input,
          holderId: "prior",
          ttlMs: 300_000,
        });
        await reserveSessionTitleDispatch(fixture.client.db, {
          ...input,
          holderId: "prior",
          generation: 1,
        });
        await shared.admin`update session_title_operations set leased_until = now() - interval '1 second' where id = ${job!.id}::uuid`;
      }
      try {
        if (scenario === "completion_retry") {
          expect((await reconcileSessionTitleOperation(service, input)).action).toBe("retry");
          expect(await getSessionTitleOperation(fixture.client.db, input)).toMatchObject({
            state: "responded",
            holderId: null,
          });
          titleFailure?.mockRestore();
        } else {
          const first = await reconcileSessionTitleOperation(service, input);
          expect(first.action).toBe(
            ["busy", "serialization", "expired", "stale_target", "stale_recovery"].includes(
              scenario,
            )
              ? "retry"
              : "terminal",
          );
        }
        if (scenario === "stale_target" || scenario === "stale_recovery") {
          terminalFailure?.mockRestore();
          await shared.admin`update session_title_operations set leased_until = now() - interval '1 second' where id = ${job!.id}::uuid`;
        }
        await reconcileSessionTitleOperation(service, input);
        await reconcileSessionTitleOperation(service, input);
        expect(generated).toBe(
          ["renamed", "stale_target", "stale_recovery"].includes(scenario)
            ? 0
            : ["busy", "serialization"].includes(scenario)
              ? 2
              : 1,
        );
        expect((await getSessionTitleOperation(fixture.client.db, input))?.state).toBe(
          ["expired", "stale_recovery"].includes(scenario)
            ? "unknown"
            : ["permanent", "renamed", "stale_target", "completion_permanent"].includes(scenario)
              ? "failed"
              : "completed",
        );
        const receipts =
          await shared.admin`select source_id from opengeni_private.session_usage_limit_receipts
          where workspace_id = ${org.workspaceId}::uuid and source_id = ${`${work.identity.turnId}:session-title:${job!.id}`}`;
        expect(receipts).toHaveLength(
          ["permanent", "renamed", "stale_target", "stale_recovery"].includes(scenario) ? 0 : 1,
        );
        const usage =
          await shared.admin`select id from session_events where turn_id = ${work.identity.turnId}::uuid
          and type = 'agent.model.usage'`;
        expect(usage).toHaveLength(
          [
            "permanent",
            "renamed",
            "expired",
            "stale_target",
            "stale_recovery",
            "completion_permanent",
          ].includes(scenario)
            ? 0
            : 1,
        );
      } finally {
        route.mockRestore();
        titleFailure?.mockRestore();
        terminalFailure?.mockRestore();
      }
    });
  }
  for (const scenario of ["normal", "renamed", "gateway"] as const)
    test(`retained response settles late usage exactly once: ${scenario}`, async () => {
      const humanRename = scenario === "renamed";
      const gateway = scenario === "gateway";
      const org = await fixture.organization();
      const work = await fixture.turn(org, { model: models[0]! });
      if (gateway)
        await shared.admin`insert into workspace_gateway_custom_models
          (account_id, workspace_id, provider_kind, upstream_model_id, create_operation_id,
           create_request_hash, created_by_subject_id)
          values (${org.accountId}::uuid, ${org.workspaceId}::uuid, 'vercel_gateway', 'fixture/title',
            ${crypto.randomUUID()}::uuid, ${"a".repeat(64)}, ${org.subjectId})`;
      const [turn] = await shared.admin<
        { metadata: Record<string, unknown> }[]
      >`select metadata from session_turns where id = ${work.identity.turnId}::uuid`;
      const [session] = await shared.admin<
        { title: string | null; title_source: "agent" | "user" | null }[]
      >`select title, title_source from sessions where id = ${work.identity.sessionId}::uuid`;
      const policy = TurnExecutionPolicyV1.parse(turn!.metadata.turnExecutionPolicyV1);
      const request = SessionTitleRequest.parse({
        version: 1,
        prompt: "Describe lighthouse history",
        policy,
        providerId: gateway ? "workspace-gateway" : policy.providerId,
        modelId: gateway ? "workspace-gateway/fixture/title" : policy.productModelId,
        upstreamModelId: policy.upstreamModelId,
        definitionVersion: "fixture-definition",
        apiConnectionId: null,
        expectedTitle: { title: session!.title, source: session!.title_source },
        externallyBilled: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        pricingJson: "{}",
      });
      const job = await admitSessionTitleOperation(fixture.client.db, {
        ...work,
        provider: "fixture-api",
        connectionId: null,
        requestEncrypted: encryptEnvironmentValue(key, JSON.stringify(request)),
      });
      const input = {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        operationId: job!.id,
      };
      await claimSessionTitleOperation(fixture.client.db, {
        ...input,
        holderId: "interrupted",
        ttlMs: 300_000,
      });
      const claim = { ...input, holderId: "interrupted", generation: 1 };
      await reserveSessionTitleDispatch(fixture.client.db, claim);
      await recordSessionTitleResponse(fixture.client.db, {
        ...claim,
        responseEncrypted: encryptEnvironmentValue(
          key,
          JSON.stringify({
            title: "Coastal Lighthouse History",
            usage: {
              responseId: "title-response",
              ...(gateway
                ? { gatewayBilling: { finalProvider: "fixture", inferenceCostUsd: "0.00032" } }
                : {}),
              usage: { inputTokens: 50, outputTokens: 12, totalTokens: 62 },
            },
          }),
        ),
      });
      await fixture.finish(work);
      if (humanRename)
        await updateSessionTitleWithEvent(fixture.client.db, {
          workspaceId: org.workspaceId,
          sessionId: work.identity.sessionId,
          title: "My chosen title",
          source: "user",
        });
      await shared.admin`update session_title_operations set leased_until = clock_timestamp() - interval '1 second' where id = ${job!.id}::uuid`;
      const runSettings = {
        ...settings,
        billingMode: "disabled",
        usageLimitsMode: "none",
      } as typeof settings;
      const service = {
        db: fixture.client.db,
        settings: runSettings,
        bus: new MemoryEventBus(),
        observability: createObservability(runSettings, { component: "worker" }),
        runtime: {
          generateSessionTitle: () => {
            throw new Error("retained response must not call provider");
          },
        },
      } as unknown as TurnActivityServices;
      expect(await reconcileSessionTitleOperation(service, input)).toEqual({ action: "terminal" });
      expect(await reconcileSessionTitleOperation(service, input)).toEqual({ action: "terminal" });
      expect((await getSessionTitleOperation(fixture.client.db, input))?.state).toBe("completed");
      const events = await shared.admin<
        { payload: Record<string, unknown>; turn_association: string }[]
      >`select payload, turn_association from session_events
      where turn_id = ${work.identity.turnId}::uuid and type = 'agent.model.usage'`;
      expect(events).toHaveLength(1);
      expect(events[0]!.turn_association).toBe("current");
      expect(events[0]!.payload).toMatchObject({
        purpose: "session-title",
        inputTokens: 50,
        outputTokens: 12,
      });
      const [completed] =
        await shared.admin`select status from session_turns where id = ${work.identity.turnId}::uuid`;
      expect(completed!.status).toBe("completed");
      const [order] = await shared.admin`select
        max(sequence) filter (where type = 'turn.completed') as completion,
        max(sequence) filter (where type = 'agent.model.usage') as usage
        from session_events where turn_id = ${work.identity.turnId}::uuid`;
      expect(Number(order!.usage)).toBeGreaterThan(Number(order!.completion));
      const totals = await aggregateModelCallFacts(fixture.client.db, {
        workspaceId: org.workspaceId,
        since: new Date(Date.now() - 60_000),
        until: new Date(Date.now() + 60_000),
      });
      expect(totals).toHaveLength(1);
      expect(totals[0]).toMatchObject({
        calls: 1,
        inputTokens: 50,
        outputTokens: 12,
        totalTokens: 62,
      });
      const facts =
        await shared.admin`select source_key from model_call_facts where turn_id = ${work.identity.turnId}::uuid`;
      expect(facts).toHaveLength(1);
      if (gateway) {
        const [receipt] =
          await shared.admin`select amount_micros from opengeni_private.session_usage_limit_receipts
          where workspace_id = ${org.workspaceId}::uuid and source_id = ${`${work.identity.turnId}:session-title:${job!.id}`}`;
        expect(Number(receipt!.amount_micros)).toBe(320);
      }
      const [saved] = await shared.admin<
        { title: string; title_source: string }[]
      >`select title, title_source from sessions where id = ${work.identity.sessionId}::uuid`;
      expect(saved).toEqual(
        humanRename
          ? { title: "My chosen title", title_source: "user" }
          : { title: "Coastal Lighthouse History", title_source: "agent" },
      );
    });
  for (const [index, provider] of providers.entries()) {
    test(`${provider.adapter.provider}: source completion does not cancel or transfer the title request`, async () => {
      const org = await fixture.organization();
      const connectionId = await fixture.connection(org, provider);
      const credential =
        provider.adapter.provider === "codex"
          ? {
              access_token: "fixture-access",
              refresh_token: "fixture-refresh",
              id_token: "fixture-id",
            }
          : provider.adapter.provider === "claude"
            ? {
                version: 1,
                token: "sk-ant-oat01-fixture",
                identity: { accountUuid: "", deviceId: "a".repeat(64) },
              }
            : { version: 1, accessToken: "fixture-access", refreshToken: "fixture-refresh" };
      await shared.admin`update subscription_connections set credential_encrypted = ${encryptEnvironmentValue(key, JSON.stringify(credential))},
        expires_at = now() + interval '1 day', last_refresh_at = now() where id = ${connectionId}::uuid`;
      const work = await fixture.turn(org, { model: models[index]! });
      expect(
        await subscriptionCoreTurns(provider).placeSubscriptionCoreTurn(fixture.client.db, work),
      ).toMatchObject({ kind: "run", connectionId });
      const job = await admitSessionTitleOperation(fixture.client.db, {
        ...work,
        provider: provider.adapter.provider,
        connectionId,
        requestEncrypted: "fixture request",
      });
      const tenant = {
        accountId: org.accountId,
        workspaceId: org.workspaceId,
        operationId: job!.id,
      };
      const operation = await claimSessionTitleOperation(fixture.client.db, {
        ...tenant,
        holderId: "title",
        ttlMs: 300_000,
      });
      await fixture.finish(work);
      const diagnostics: unknown[] = [];
      await withSessionTitleCustody(
        {
          db: fixture.client.db,
          settings,
          operation: operation!,
          productModelId: models[index]!.id,
          upstreamModelId: "title-fixture",
          providerId: provider.adapter.modelPolicyProviderId,
          reasoningLevel: "high",
          onCleanupError: (error) => diagnostics.push(error),
          onQuotaRecovered: async () => {},
        },
        async (_settings, lane, flush) => {
          expect(lane).not.toBeNull();
          if (provider.adapter.provider === "claude") {
            const request = await prepareClaudeSubscriptionRequest(
              provider.adapter.modelPolicyProviderId,
              "https://provider.invalid/messages",
              { headers: {} },
            );
            expect(new Headers(request.init?.headers).get("authorization")).toBe(
              "Bearer sk-ant-oat01-fixture",
            );
            await request.admit();
            const response = await request.responded(
              new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
                headers: { "content-type": "text/event-stream" },
              }),
            );
            await response.text();
          } else {
            const context =
              provider.adapter.provider === "codex"
                ? codexRequestStorage.getStore()!
                : xaiSubscriptionRequestStorage.getStore()!;
            expect((await context.getToken()).accessToken).toBe("fixture-access");
            if (provider.adapter.provider === "codex") {
              const codex = codexRequestStorage.getStore()!;
              const refused = { requestId: codex.nextRequestId!(), transportAttempt: 1 };
              await codex.beforeProviderDispatch!(refused);
              await codex.onProviderRequestSettled!({ ...refused, outcome: "refused" });
              // A refreshed bearer may resend only after positive refusal. The
              // new token's usage observation must carry its new generation.
              await shared.admin`update subscription_connections set refresh_generation = refresh_generation + 1,
                credential_encrypted = ${encryptEnvironmentValue(
                  key,
                  JSON.stringify({
                    access_token: "fixture-access-v2",
                    refresh_token: "fixture-refresh-v2",
                    id_token: "fixture-id",
                  }),
                )} where id = ${connectionId}::uuid`;
              expect((await codex.getToken()).accessToken).toBe("fixture-access-v2");
              codex.onUsageHeaders?.({
                primaryUsedPercent: 12,
                secondaryUsedPercent: 25,
                primaryResetAt: new Date(Date.now() + 3_600_000),
                secondaryResetAt: new Date(Date.now() + 7_200_000),
                checkedAt: new Date(),
              });
              await flush();
            }
            const request = { requestId: context.nextRequestId!(), transportAttempt: 1 };
            await context.beforeProviderDispatch!(request);
            await context.onProviderRequestSettled!({ ...request, outcome: "response_received" });
          }
          await flush();
          expect(
            await recordSessionTitleResponse(fixture.client.db, {
              ...tenant,
              holderId: "title",
              generation: 1,
              responseEncrypted: "finite response",
            }),
          ).toBe(true);
          await lane!.checkpoint();
          expect(
            await finishSessionTitleOperation(fixture.client.db, {
              ...tenant,
              holderId: "title",
              generation: 1,
              state: "completed",
            }),
          ).toBe(true);
        },
      );
      expect(diagnostics).toEqual([]);
      const rows = await shared.admin<
        { request_id: string | null; request_outcome: string | null }[]
      >`
        select request_id, request_outcome from subscription_operation_leases
        where account_id = ${org.accountId}::uuid and turn_id = ${work.identity.turnId}::uuid`;
      expect(rows.length).toBe(provider.adapter.provider === "codex" ? 2 : 1);
      expect(rows.every((row) => row.request_id !== null)).toBe(true);
      expect(rows.filter((row) => row.request_outcome === "response_received")).toHaveLength(1);
      if (provider.adapter.provider === "codex")
        expect(rows.filter((row) => row.request_outcome === "refused")).toHaveLength(1);
    });
  }
});
