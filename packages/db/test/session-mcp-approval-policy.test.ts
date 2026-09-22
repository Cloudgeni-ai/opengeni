import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { SessionMcpApprovalPolicy } from "@opengeni/contracts";
import {
  appendSessionEvents,
  appendSessionEventsWithLockedSessionUpdate,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionMcpServers,
  enqueueSessionTurn,
  initializeSessionStartAtomically,
  listSessionMcpServersForRun,
  getSessionAttemptMcpApprovalPolicies,
  getSession,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let firstClient: DbClient | null = null;
let secondClient: DbClient | null = null;
let firstDb: Database;
let secondDb: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-mcp-approval-policy");
  if (!shared) {
    available = false;
    return;
  }
  firstClient = createDb(shared.appUrl);
  secondClient = createDb(shared.appUrl);
  firstDb = firstClient.db;
  secondDb = secondClient.db;
}, 180_000);

afterAll(async () => {
  await Promise.all([firstClient?.close(), secondClient?.close()]);
  await shared?.release();
}, 180_000);

async function updatePolicy(
  db: Database,
  workspaceId: string,
  sessionId: string,
  requireApproval: SessionMcpApprovalPolicy,
  hold?: () => Promise<void>,
): Promise<void> {
  await appendSessionEventsWithLockedSessionUpdate(
    db,
    workspaceId,
    sessionId,
    async (_session, context) => {
      const result = await context.updateSessionMcpApprovalPolicy("external", requireApproval);
      if (!result.server) {
        throw new Error("missing session MCP server");
      }
      await hold?.();
      return {
        events: result.changed
          ? [
              {
                type: "session.mcp.approval_policy.updated" as const,
                payload: {
                  serverId: "external",
                  effectiveFrom: "next_attempt",
                },
              },
            ]
          : [],
      };
    },
    { activity: "semantic" },
  );
}

describe("session MCP approval-policy attempt snapshots", () => {
  for (const inherited of [false, true])
    test(`keeps ${inherited ? "inherited" : "attached"} policies immutable and serializes the next claim behind policy update`, async () => {
      if (!available || !shared) throw new Error("PostgreSQL required for policy regression");
      const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('MCP policy account') returning id`;
      const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'MCP policy workspace') returning id`;
      await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;

      const session = await createSession(firstDb, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        initialMessage: "first",
        resources: [],
        tools: [{ kind: "mcp", id: "external" }],
        metadata: {},
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
        ...(inherited
          ? {
              toolPolicy: { mode: "workspace_default" as const, inheritedFromSessionId: null },
              mcpApprovalPolicies: { external: false },
            }
          : {}),
      });
      if (inherited) {
        await shared.admin`insert into capability_catalog_items
        (id, account_id, workspace_id, kind, source, name, endpoint_url, metadata)
        values ('external', ${account!.id}, ${workspace!.id}, 'mcp', 'manual', 'External', 'https://external.example/mcp', '{"mcpServerId":"external","requireApproval":true}')`;
        await shared.admin`insert into capability_installations
        (account_id, workspace_id, capability_id, kind, metadata)
        values (${account!.id}, ${workspace!.id}, 'external', 'mcp', '{"mcpConnectivity":{"status":"ok"}}')`;
      } else
        await createSessionMcpServers(firstDb, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          sessionId: session.id,
          servers: [
            {
              id: "external",
              url: "https://external.example/mcp",
              requireApproval: false,
            },
          ],
        });
      const started = await initializeSessionStartAtomically(firstDb, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId: session.id,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      });
      if (!started.turn) throw new Error("initial turn missing");

      const firstAttemptId = crypto.randomUUID();
      const firstClaim = await claimSessionWorkForAttempt(firstDb, workspace!.id, {
        sessionId: session.id,
        workflowId: started.temporalWorkflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId: firstAttemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (firstClaim.action !== "claimed")
        throw new Error(`first claim failed: ${firstClaim.reason}`);
      expect(
        (
          await getSessionAttemptMcpApprovalPolicies(
            firstDb,
            workspace!.id,
            session.id,
            firstAttemptId,
          )
        ).external,
      ).toBe(false);

      await updatePolicy(firstDb, workspace!.id, session.id, true);
      expect(
        (
          await getSessionAttemptMcpApprovalPolicies(
            firstDb,
            workspace!.id,
            session.id,
            firstAttemptId,
          )
        ).external,
      ).toBe(false);

      const settled = await applySessionTurnSettlement(firstDb, workspace!.id, {
        sessionId: session.id,
        turnId: firstClaim.turn.id,
        triggerEventId: firstClaim.turn.triggerEventId,
        attemptId: firstAttemptId,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        events: [],
      });
      expect(settled.action).toBe("settled");
      await expect(
        listSessionMcpServersForRun(firstDb, workspace!.id, session.id, firstAttemptId, null),
      ).rejects.toThrow(`session MCP policy snapshot is unavailable for attempt ${firstAttemptId}`);

      const [trigger] = await appendSessionEvents(firstDb, workspace!.id, session.id, [
        { type: "user.message", payload: { text: "second" } },
      ]);
      if (!trigger) throw new Error("second trigger missing");
      await enqueueSessionTurn(firstDb, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        sessionId: session.id,
        triggerEventId: trigger.id,
        temporalWorkflowId: started.temporalWorkflowId,
        source: "user",
        prompt: "second",
        resources: [],
        tools: [{ kind: "mcp", id: "external" }],
        model: "test-model",
        reasoningEffort: "low",
        sandboxBackend: "none",
        metadata: {},
        initiator: { kind: "subject", subjectId: "user:test" },
      });
      await updatePolicy(firstDb, workspace!.id, session.id, false);

      let releaseUpdate = (): void => undefined;
      const updateGate = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      let markUpdateLocked = (): void => undefined;
      const updateLocked = new Promise<void>((resolve) => {
        markUpdateLocked = resolve;
      });
      const selectivePolicy = ["delete_record", "write_record"];
      const updatePromise = updatePolicy(
        firstDb,
        workspace!.id,
        session.id,
        selectivePolicy,
        async () => {
          markUpdateLocked();
          await updateGate;
        },
      );
      await updateLocked;

      const secondAttemptId = crypto.randomUUID();
      let claimSettled = false;
      const claimPromise = claimSessionWorkForAttempt(secondDb, workspace!.id, {
        sessionId: session.id,
        workflowId: started.temporalWorkflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId: secondAttemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      }).finally(() => {
        claimSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(claimSettled).toBe(false);

      releaseUpdate();
      await updatePromise;
      const secondClaim = await claimPromise;
      if (secondClaim.action !== "claimed") {
        throw new Error(`second claim failed: ${secondClaim.reason}`);
      }
      expect(
        (
          await getSessionAttemptMcpApprovalPolicies(
            secondDb,
            workspace!.id,
            session.id,
            secondAttemptId,
          )
        ).external,
      ).toEqual(selectivePolicy);
      if (inherited) {
        const projection = await getSession(firstDb, workspace!.id, session.id);
        expect(projection?.mcpServers).toEqual([]);
        expect(projection?.mcpApprovalPolicies?.external).toEqual(selectivePolicy);
        expect(
          await listSessionMcpServersForRun(
            secondDb,
            workspace!.id,
            session.id,
            secondAttemptId,
            null,
          ),
        ).toEqual([]);
        // A curated capability's mandatory floor cannot be removed by a session override.
        await shared.admin`update capability_catalog_items set workspace_id = null, account_id = null,
        metadata = '{"mcpServerId":"external","requireApproval":["mandated_write"]}'
        where workspace_id = ${workspace!.id} and id = 'external'`;
        await updatePolicy(firstDb, workspace!.id, session.id, false);
        expect(
          (await getSession(firstDb, workspace!.id, session.id))?.mcpApprovalPolicies?.external,
        ).toEqual(["mandated_write"]);
        expect(
          (
            await getSessionAttemptMcpApprovalPolicies(
              secondDb,
              workspace!.id,
              session.id,
              secondAttemptId,
            )
          ).external,
        ).toEqual(selectivePolicy);
      }
    }, 180_000);
});
