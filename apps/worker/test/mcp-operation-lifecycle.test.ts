import { afterAll, beforeAll, expect, test } from "bun:test";
import { RunContext } from "@openai/agents-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureExternalIdentity,
  getSessionTurnForAttempt,
  grantWorkspaceAccess,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { migrate } from "../../../packages/db/src/migrate";
import { provisionRoles } from "../../../packages/db/src/provision-roles";
import {
  createMcpOperationPersistence,
  readMcpOperation as readStoredOperation,
  type McpOperationAttempt,
} from "../../../packages/db/src/mcp-operations";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  type ResolveConnectionCredentialResult,
} from "@opengeni/runtime";
import { digestCanonicalJson } from "@opengeni/tool-gateway";
import { createMcpOperationReadStore } from "../src/activities/mcp-operation-store";
import { readMcpOperation } from "../src/activities/mcp-operation-reader";
import { createMcpOperationObserverResolver } from "../src/activities/mcp-operation-observer";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const nativeUrl = process.env.MCP_LEDGER_TEST_ADMIN_URL;
  const acquired = nativeUrl
    ? await (async () => {
        if (process.env.MCP_LEDGER_TEST_PREPARED !== "1") {
          await migrate(process.env.MCP_LEDGER_TEST_OWNER_URL ?? nativeUrl);
          await provisionRoles(nativeUrl, {
            appRole: "opengeni_app",
            appPassword: "ledger-test-only",
            rlsStrategy: "force",
          });
        }
        const admin = postgres(nativeUrl, { max: 4 });
        const appUrl = new URL(nativeUrl);
        appUrl.username = "opengeni_app";
        appUrl.password = "ledger-test-only";
        return {
          admin,
          adminUrl: nativeUrl,
          appUrl: appUrl.toString(),
          release: async () => {
            await admin.end();
          },
        };
      })()
    : await acquireSharedTestDatabase("mcp-operation-lifecycle");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function claim(scope: { accountId: string; workspaceId: string; sessionId: string }) {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: scope.sessionId,
    workflowId: `session-${scope.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error("Lifecycle attempt not claimed");
  return {
    ...scope,
    attemptId,
    turnId: result.turn.id,
    executionGeneration: result.turn.executionGeneration,
  };
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "MCP lifecycle",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "MCP lifecycle",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const identity = await ensureExternalIdentity(client.db, {
    accountId: scope.accountId,
    externalId: suffix,
  });
  const subjectId = identity.subjectId;
  await grantWorkspaceAccess(client.db, {
    ...scope,
    subjectId,
    permissions: ["sessions:read", "sessions:create", "sessions:control"],
  });
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "mutate",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
  });
  await initializeSessionStartAtomically(client.db, {
    ...scope,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  return { attempt: await claim({ ...scope, sessionId: session.id }), subjectId };
}

async function successor(attempt: McpOperationAttempt, subjectId: string) {
  const [turn] = await shared.admin`
    select trigger_event_id from session_turns where id=${attempt.turnId}`;
  await applySessionTurnSettlement(client.db, attempt.workspaceId, {
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    triggerEventId: turn!.trigger_event_id,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { output: "outcome unknown" } }],
  });
  const [trigger] = await appendSessionEvents(client.db, attempt.workspaceId, attempt.sessionId, [
    { type: "user.message", payload: { text: "observe original operation" } },
  ]);
  await enqueueSessionTurn(client.db, {
    accountId: attempt.accountId,
    workspaceId: attempt.workspaceId,
    sessionId: attempt.sessionId,
    triggerEventId: trigger!.id,
    temporalWorkflowId: `session-${attempt.sessionId}`,
    source: "api",
    prompt: "observe original operation",
    resources: [],
    tools: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    sandboxBackend: "none",
    metadata: {},
    initiator: { kind: "subject", subjectId },
  });
  return claim(attempt);
}

for (const scenario of [
  "late commit after restart",
  "late commit recovered by fresh adapter process",
  "original completion wins observer race",
] as const) {
  test(`real MCP lifecycle: ${scenario}`, async () => {
    const { attempt: originalAttempt, subjectId } = await fixture();
    const gate = deferred();
    const started = deferred();
    const committed = deferred();
    const observerStarted = deferred();
    const observerGate = deferred();
    const args = { value: "payload", operationId: "caller-input-is-not-operation-identity" };
    const result = { content: [{ type: "text" as const, text: "committed payload" }] };
    let effects = 0;
    let observations = 0;
    let originalOperationId: string | undefined;
    let authorityDigest = "a".repeat(64);
    const receipts = new Map<string, typeof result>();
    const transports: WebStandardStreamableHTTPServerTransport[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const server = new McpServer({ name: "lifecycle-provider", version: "1.0.0" });
        server.registerTool(
          "mutate",
          {
            inputSchema: { value: z.string(), operationId: z.string() },
            annotations: { idempotentHint: true },
          },
          async (_input, extra) => {
            const operationId = extra._meta?.opengeniOperationId;
            if (typeof operationId !== "string") throw new Error("Missing operation metadata");
            originalOperationId = operationId;
            effects++;
            started.resolve();
            await gate.promise;
            // The provider retains the ORIGINAL trusted transport identity. Caller
            // input and the later observer request's own metadata cannot replace it.
            receipts.set(operationId, result);
            committed.resolve();
            return result;
          },
        );
        server.registerTool(
          "observe",
          {
            inputSchema: {
              version: z.literal(1),
              operationRef: z.string(),
              originalTool: z.string(),
              fingerprint: z.object({
                version: z.literal(1),
                algorithm: z.literal("sha256"),
                value: z.string(),
              }),
            },
          },
          async (input) => {
            if (input.operationRef !== originalOperationId) {
              throw new Error("Observer did not reference original transport identity");
            }
            observations++;
            observerStarted.resolve();
            if (scenario === "original completion wins observer race") await observerGate.promise;
            const stored =
              scenario === "original completion wins observer race"
                ? { content: [{ type: "text" as const, text: "conflicting observer result" }] }
                : receipts.get(input.operationRef);
            if (!stored) throw new Error("Original operation missing");
            return {
              content: [],
              structuredContent: {
                version: 1,
                operationRef: input.operationRef,
                fingerprint: { version: 1, algorithm: "sha256", value: digestCanonicalJson(args) },
                status: "completed",
                receiptRevision: "receipt-1",
                result: stored,
              },
            };
          },
        );
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        transports.push(transport);
        await server.connect(transport);
        return transport.handleRequest(request);
      },
    });
    const settings = testSettings({
      sandboxBackend: "none",
      mcpServers: [
        {
          id: "lifecycle",
          url: `http://127.0.0.1:${provider.port}/mcp`,
          timeoutMs: scenario === "original completion wins observer race" ? 10_000 : 1000,
          cacheToolsList: false,
          connectionRef: {
            connectionId: "lifecycle-test-connection",
            providerDomain: "example.test",
          },
          operationRecovery: { mutate: { observerTool: "observe" } },
        },
      ],
    });
    const connectorActionPolicy = {
      prepare: async () => ({ managed: false as const, decision: "unmanaged" as const }),
      begin: async () => ({ allowed: true as const, managed: false as const }),
      complete: async () => {},
    };
    // Explicit test trust boundary: provider credentials are synthetic. Durable
    // attempt/principal/membership authorization and storage below use real SQL.
    const resolveSyntheticCredential = async (): Promise<ResolveConnectionCredentialResult> => ({
      status: "ok",
      connectionId: "lifecycle-test-connection",
      headers: {},
      operationAuthorityDigest: authorityDigest,
      authorizeProviderRequest: async () => true,
    });
    const prepare = (attempt: McpOperationAttempt) =>
      prepareAgentTools(settings, [{ kind: "mcp", id: "lifecycle" }], {
        ...attempt,
        workspaceToolGateway: {},
        connectorActionPolicy,
        resolveCredential: resolveSyntheticCredential,
        mcpOperationPersistence: createMcpOperationPersistence(client.db, attempt),
      });
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | undefined;
    const dependencies = (
      attempt: McpOperationAttempt,
      currentPrepared: Awaited<ReturnType<typeof prepareAgentTools>>,
    ) => ({
      ...createMcpOperationReadStore(client.db, attempt),
      resolveObserver: createMcpOperationObserverResolver({
        settings,
        workspaceId: attempt.workspaceId,
        resolveCredential: resolveSyntheticCredential,
        assertAttempt: async () => {
          const current = await getSessionTurnForAttempt(
            client.db,
            attempt.workspaceId,
            attempt.sessionId,
            attempt.attemptId,
          );
          if (
            !current ||
            current.id !== attempt.turnId ||
            current.executionGeneration !== attempt.executionGeneration
          ) {
            throw new Error("Stale lifecycle attempt");
          }
        },
        getEnvironment: async () => currentPrepared.attemptToolEnvironment ?? null,
      }),
    });
    try {
      if (scenario === "late commit recovered by fresh adapter process") {
        const sourceCallId = "sdk-call-from-exited-process";
        const selector = { sourceTurnId: originalAttempt.turnId, sourceCallId };
        const runProcess = async (mode: "mutate" | "read", attempt: McpOperationAttempt) => {
          const child = Bun.spawn(
            [
              process.execPath,
              new URL("./mcp-operation-lifecycle-process-fixture.ts", import.meta.url).pathname,
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
          );
          child.stdin.write(
            JSON.stringify({
              mode,
              appUrl: shared.appUrl,
              settings,
              attempt,
              sourceCallId,
              sourceTurnId: originalAttempt.turnId,
              ...(mode === "mutate" ? { arguments: args } : {}),
            }),
          );
          await child.stdin.flush();
          child.stdin.end();
          const timeout = setTimeout(() => child.kill(), 20_000);
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]).finally(() => clearTimeout(timeout));
          if (exitCode !== 0)
            throw new Error(`Lifecycle subprocess failed (${exitCode}): ${stderr}`);
          const lines = stdout
            .split("\n")
            .filter((line) => line.startsWith("MCP_LIFECYCLE_RESULT:"));
          if (lines.length !== 1) throw new Error("Missing unique lifecycle process result");
          return JSON.parse(lines[0]!.slice("MCP_LIFECYCLE_RESULT:".length)) as {
            pid: number;
            output: Record<string, unknown>;
          };
        };
        // The reader receives only settings, current attempt authority and a
        // source locator, never mutation arguments, operation records, receipts,
        // or async-local state from the original process.
        const mutation = runProcess("mutate", originalAttempt);
        await Promise.race([
          started.promise,
          mutation.then(() => {
            throw new Error("Mutation process exited before provider dispatch");
          }),
        ]);
        const exitedMutation = await mutation;
        expect(exitedMutation.pid).not.toBe(process.pid);
        expect(exitedMutation.output).toMatchObject({ isError: true });
        expect(JSON.stringify(exitedMutation.output)).toContain(
          `MCP operation ${originalOperationId} has an unknown outcome`,
        );
        const before = await readStoredOperation(client.db, originalAttempt, selector);
        if (before.status !== "found") throw new Error("Exited process capture missing");
        expect(before.operation.operationId).toBe(originalOperationId!);
        expect(before.operation.originalOutcome).toBe("outcome_unknown");
        expect(before.operation.observationResult).toBeNull();
        gate.resolve();
        await committed.promise;
        const currentAttempt = await successor(originalAttempt, subjectId);
        const recovered = await runProcess("read", currentAttempt);
        expect(recovered.pid).not.toBe(process.pid);
        expect(recovered.pid).not.toBe(exitedMutation.pid);
        expect(recovered.output.first).toMatchObject({
          operationId: originalOperationId,
          original: { turnId: originalAttempt.turnId, sourceCallId },
          invocationOutcome: "outcome_unknown",
          observation: { status: "completed", result },
        });
        expect(recovered.output.cached).toEqual(recovered.output.first);
        expect(effects).toBe(1);
        expect(observations).toBe(1);
        const after = await readStoredOperation(client.db, currentAttempt, selector);
        if (after.status !== "found") throw new Error("Fresh process receipt missing");
        expect(after.operation.originalOutcome).toBe(before.operation.originalOutcome);
        expect(after.operation.originalResult).toEqual(before.operation.originalResult);
        expect(after.operation.observationResult).toEqual(result);
        return;
      }
      prepared = await prepare(originalAttempt);
      const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
      const tool = (await agent.getMcpTools(new RunContext())).find(
        (entry) => entry.type === "function" && entry.name === "lifecycle__mutate",
      );
      if (!tool || tool.type !== "function") throw new Error("Mutation SDK tool unavailable");
      const sourceCallId = "sdk-call-original-exact";
      expect(await tool.needsApproval(new RunContext(), args, sourceCallId)).toBe(false);
      const invocation = tool.invoke(new RunContext(), JSON.stringify(args), {
        toolCall: { callId: sourceCallId },
      } as never);
      await started.promise;
      const selector = { sourceTurnId: originalAttempt.turnId, sourceCallId };
      if (scenario === "original completion wins observer race") {
        const captured = await readStoredOperation(client.db, originalAttempt, selector);
        if (captured.status !== "found") throw new Error("Original capture unavailable");
        expect(captured.operation.originalOutcome).toBe("captured");
        expect(captured.operation.operationId).toBe(originalOperationId!);
        const deps = dependencies(originalAttempt, prepared);
        const reading = readMcpOperation(selector, deps);
        await observerStarted.promise;
        gate.resolve();
        await invocation;
        const completed = await readStoredOperation(client.db, originalAttempt, selector);
        if (completed.status !== "found") throw new Error("Runtime completion unavailable");
        expect(completed.operation.originalOutcome).toBe("completed");
        expect(completed.operation.originalResult).toEqual(result);
        expect(completed.operation.observationResult).toBeNull();
        observerGate.resolve();
        expect(await reading).toMatchObject({
          invocationOutcome: "completed",
          result,
          observation: { status: "unknown" },
        });
        const settled = await readStoredOperation(client.db, originalAttempt, selector);
        if (settled.status !== "found") throw new Error("Original completion unavailable");
        expect(settled.operation.originalOutcome).toBe("completed");
        expect(settled.operation.originalResult).toEqual(result);
        expect(settled.operation.observationResult).toBeNull();
        expect(settled.operation.receiptRevision).toBeNull();
        expect(await readMcpOperation(selector, deps)).toMatchObject({
          invocationOutcome: "completed",
          result,
        });
        expect(effects).toBe(1);
        expect(observations).toBe(1);
        return;
      }
      const originalTimeout = await invocation;
      expect(originalTimeout).toMatchObject({ isError: true });
      expect(JSON.stringify(originalTimeout)).toContain(
        `MCP operation ${originalOperationId} has an unknown outcome`,
      );
      expect(JSON.stringify(originalTimeout)).toContain("do not repeat the mutation");
      expect(effects).toBe(1);
      const before = await readStoredOperation(client.db, originalAttempt, selector);
      expect(before.status).toBe("found");
      if (before.status !== "found") throw new Error("Original operation not persisted");
      expect(before.operation.operationId).toBe(originalOperationId!);
      expect(before.operation.operationId).not.toBe(args.operationId);
      expect(before.operation.originalOutcome).toBe("outcome_unknown");
      expect(before.operation.observationResult).toBeNull();
      gate.resolve();
      await committed.promise;
      await prepared.close();
      prepared = undefined;
      await client.close();
      client = createDb(shared.appUrl);
      const currentAttempt = await successor(originalAttempt, subjectId);
      prepared = await prepare(currentAttempt);
      const deps = dependencies(currentAttempt, prepared);
      await expect(readStoredOperation(client.db, originalAttempt, selector)).rejects.toThrow();
      authorityDigest = "b".repeat(64);
      expect(await readMcpOperation(selector, deps)).toMatchObject({
        observation: { status: "auth_needed" },
      });
      expect(observations).toBe(0);
      authorityDigest = "a".repeat(64);
      const observed = await readMcpOperation(selector, deps);
      expect(observed).toMatchObject({
        operationId: originalOperationId,
        invocationOutcome: "outcome_unknown",
        original: { turnId: originalAttempt.turnId, sourceCallId },
        observation: { status: "completed", result },
      });
      expect(observations).toBe(1);
      expect(effects).toBe(1);
      expect(await readMcpOperation(selector, deps)).toEqual(observed);
      expect(observations).toBe(1);
      expect(effects).toBe(1);
      const after = await readStoredOperation(client.db, currentAttempt, selector);
      expect(after.status).toBe("found");
      if (after.status !== "found") throw new Error("Observed operation missing");
      expect(after.operation.originalOutcome).toBe(before.operation.originalOutcome);
      expect(after.operation.originalResult).toEqual(before.operation.originalResult);
      expect(after.operation.observationResult).toEqual(result);
      expect(after.operation.sourceAttemptId).toBe(originalAttempt.attemptId);
      // Revocation must deny even an already-cached receipt; it must not cause a
      // credential refresh, another provider observation, or a mutation replay.
      await shared.admin`delete from workspace_memberships
      where workspace_id=${currentAttempt.workspaceId} and subject_id=${subjectId}`;
      await expect(readMcpOperation(selector, deps)).rejects.toThrow();
      expect(observations).toBe(1);
      expect(effects).toBe(1);
    } finally {
      gate.resolve();
      observerGate.resolve();
      await prepared?.close();
      for (const transport of transports) await transport.close();
      provider.stop(true);
    }
  }, 30_000);
}
