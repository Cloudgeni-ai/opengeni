import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type AccessGrant } from "@opengeni/contracts";
import { createSessionForRequest, type ApiRouteDeps } from "@opengeni/core";
import {
  applyCreditDebitAfterUse,
  applyCreditLedgerEntry,
  appendSessionEvents,
  bootstrapWorkspace,
  checkWorkspaceAllowance,
  claimSessionWorkForAttempt,
  createDb,
  setMemberAllowance,
  setWorkspaceAllowance,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { createApp } from "../src/app";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("mcp-allowance-refusal");
  if (!acquired) throw new Error("MCP allowance admission regression requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

describe("MCP real PostgreSQL exhausted-counter admission", () => {
  test.each(["workspace", "member"] as const)(
    "%s counter refuses actual create and send handlers without new work",
    async (scope) => {
      const subjectId = `user:mcp-allowance:${crypto.randomUUID()}`;
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "mcp-refusal",
        accountExternalId: crypto.randomUUID(),
        accountName: "MCP allowance fixture",
        workspaceExternalSource: "mcp-refusal",
        workspaceExternalId: crypto.randomUUID(),
        workspaceName: "MCP fixture",
        subjectId,
      });
      const base = access.workspaceGrants[0]!;
      const grant: AccessGrant = {
        ...base,
        principalKind: "human_session",
        permissions: ["sessions:create", "sessions:read", "sessions:control"],
      };
      const personalId = crypto.randomUUID();
      await shared.admin`insert into workspaces (id,account_id,name)
        values (${personalId},${grant.accountId},'Personal')`;
      await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
        values (${grant.accountId},${subjectId},'owner','active',${personalId})`;
      await applyCreditLedgerEntry(client.db, {
        accountId: grant.accountId,
        type: "credit_topup",
        amountMicros: 1_000_000,
        sourceType: "test",
        sourceId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      });
      const noop = async () => undefined;
      const deps = {
        db: client.db,
        settings: testSettings({
          databaseUrl: shared.appUrl,
          billingMode: "stripe",
          usageLimitsMode: "managed",
          sandboxBackend: "none",
          productAccessMode: "managed",
          delegationSecret: "allowance-refusal-test-secret",
        }),
        bus: new MemoryEventBus(),
        workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
        objectStorage: null,
        githubStateSecret: "test",
        documentIndexer: { indexDocument: noop },
        getDocumentServices: () => ({}),
      } as unknown as ApiRouteDeps;
      const target = await createSessionForRequest(deps, grant, grant.workspaceId, {
        initialMessage: "Initially allowed",
        idempotencyKey: crypto.randomUUID(),
      });
      const caller = await createSessionForRequest(deps, grant, grant.workspaceId, {
        initialMessage: "Delegated caller before exhaustion",
        idempotencyKey: crypto.randomUUID(),
      });
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
        sessionId: caller.id,
        workflowId: `session-${caller.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("Delegated caller was not claimed");
      const policyScope = {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        actorSubjectId: subjectId,
      };
      await setWorkspaceAllowance(client.db, {
        ...policyScope,
        includedCredits: scope === "workspace" ? 5 : 100,
        period: scope === "workspace" ? "monthly" : "none",
        expectedVersion: 0,
      });
      if (scope === "member")
        await setMemberAllowance(client.db, {
          ...policyScope,
          rule: { credits: 5 },
          expectedVersion: 0,
        });
      const [turn] = await shared.admin`select id from session_turns
        where session_id=${target.id} order by created_at limit 1`;
      expect(turn).toBeDefined();
      await applyCreditDebitAfterUse(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        type: "model",
        amountMicros: 10,
        sourceType: "model_response",
        sourceId: `${turn!.id}:fixture-response`,
        idempotencyKey: crypto.randomUUID(),
      });
      const refusal = await checkWorkspaceAllowance(client.db, policyScope);
      expect(refusal).toMatchObject({ code: "allowance_exhausted", scope });
      const before =
        await shared.admin`select id from session_turns where workspace_id=${grant.workspaceId}`;
      const server = buildOpenGeniMcpServer(deps, grant);
      const tools = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: Record<string, unknown>,
                extra: unknown,
              ) => Promise<{
                isError?: boolean;
                structuredContent?: { error?: Record<string, unknown> };
              }>;
            }
          >;
        }
      )._registeredTools;
      for (const [name, args] of [
        [
          "session_create",
          { initialMessage: "Refuse new work", idempotencyKey: crypto.randomUUID() },
        ],
        [
          "session_send_message",
          { sessionId: target.id, text: "Refuse new input", idempotencyKey: crypto.randomUUID() },
        ],
      ] as const) {
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const result = await tools[name]!.handler(args, {});
          expect(result.isError).toBe(true);
          expect(result.structuredContent?.error).toMatchObject({
            code: "allowance_exhausted",
            retryable: false,
            scope,
            resetsAt: refusal!.resetsAt,
            ...(scope === "member" ? { subjectId } : {}),
          });
          expect(JSON.stringify(result)).not.toMatch(/subscription|buy credits|sql/i);
        }
      }
      const delegatedServer = buildOpenGeniMcpServer(deps, {
        ...grant,
        principalKind: "agent_attempt",
        metadata: {
          sessionId: caller.id,
          turnId: claimed.turn.id,
          attemptId,
          executionGeneration: claimed.turn.executionGeneration,
          firstPartyMcpTools: ["session_send_message", "session_steer"],
        },
      });
      const delegatedTools = (
        delegatedServer as unknown as {
          _registeredTools: typeof tools;
        }
      )._registeredTools;
      const commandState = async () => {
        const [state] = await shared.admin`
          select
            (select jsonb_agg(to_jsonb(u) order by u.id) from session_system_updates u
              where u.workspace_id=${grant.workspaceId}) as updates,
            (select jsonb_agg(to_jsonb(i) order by i.id) from session_attempt_interruptions i
              where i.workspace_id=${grant.workspaceId}) as interruptions,
            (select jsonb_agg(to_jsonb(r) order by r.id) from session_command_receipts r
              where r.workspace_id=${grant.workspaceId}) as receipts,
            (select jsonb_agg(to_jsonb(t) order by t.id) from session_turns t
              where t.workspace_id=${grant.workspaceId}) as turns`;
        return state;
      };
      const commandBefore = await commandState();
      for (const [name, args] of [
        [
          "session_send_message",
          {
            sessionId: target.id,
            text: "Refuse delegated Send",
            idempotencyKey: crypto.randomUUID(),
          },
        ],
        [
          "session_steer",
          {
            sessionId: target.id,
            instruction: "Refuse delegated Steer",
            idempotencyKey: crypto.randomUUID(),
          },
        ],
      ] as const) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = await delegatedTools[name]!.handler(args, {});
          expect(result.isError).toBe(true);
          expect(result.structuredContent?.error).toMatchObject({
            code: "allowance_exhausted",
            retryable: false,
            scope,
            resetsAt: refusal!.resetsAt,
            ...(scope === "member" ? { subjectId } : {}),
          });
        }
      }
      expect(await commandState()).toEqual(commandBefore);
      // Retry is HTTP-only, not an MCP catalog entry. Exercise its registered
      // handler and real frozen-turn allowance check, not a synthetic probe.
      const [failure] = await appendSessionEvents(client.db, grant.workspaceId, target.id, [
        {
          type: "turn.failed",
          turnId: String(turn!.id),
          payload: { error: "Provider unavailable" },
        },
      ]);
      const token = await signDelegatedAccessToken(deps.settings.delegationSecret!, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: grant.permissions,
        exp: Math.floor(Date.now() / 1000) + 3_600,
      });
      const app = createApp({ ...deps, managedAuth: null });
      const request = { clientEventId: crypto.randomUUID(), failureEventId: failure!.id };
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const response = await app.request(
          `/v1/workspaces/${grant.workspaceId}/sessions/${target.id}/retry`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
          },
        );
        expect(response.status).toBe(402);
        expect(await response.json()).toMatchObject({
          error: {
            code: "allowance_exhausted",
            retryable: false,
            details: {
              scope,
              resetsAt: refusal!.resetsAt,
              ...(scope === "member" ? { subjectId } : {}),
            },
          },
        });
      }
      const after =
        await shared.admin`select id from session_turns where workspace_id=${grant.workspaceId}`;
      expect([...after]).toEqual([...before]);
    },
    60_000,
  );
});
