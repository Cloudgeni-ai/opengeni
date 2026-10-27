import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION,
  ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
  activeSessionHistoryCompactionPressure,
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  readActiveSessionHistory,
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { ScriptedModel } from "@opengeni/testing/scripted-model";
import { testSettings } from "@opengeni/testing/settings";
import { createActivityTestHarness } from "../src/activities";
import { requestImageCompactionThreshold } from "../src/activities/agent-turn/compaction-prep";

// One synthetic screenshot the size of a real browser-automation capture.
const SCREENSHOT_BASE64_BYTES = 160 * 1024;
const SCREENSHOT_MARKER = "data:image/png;base64,AAAA";

function browserTranscript(steps: number): Array<Record<string, unknown>> {
  const image = `data:image/png;base64,${"A".repeat(SCREENSHOT_BASE64_BYTES)}`;
  const items: Array<Record<string, unknown>> = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Work through the checkout flow in the browser" }],
    },
  ];
  for (let step = 0; step < steps; step += 1) {
    const callId = `call_${step}`;
    items.push({
      type: "function_call",
      callId,
      name: "browser_screenshot",
      arguments: "{}",
      status: "completed",
    });
    items.push({
      type: "function_call_result",
      callId,
      name: "browser_screenshot",
      status: "completed",
      output: [
        { type: "input_text", text: `Captured step ${step}` },
        { type: "input_image", image },
      ],
    });
  }
  return items;
}

describe("stored-history footprint compaction", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("history-footprint-compaction");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  async function screenshotSession(steps: number) {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Screenshot-heavy session",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Screenshot-heavy session",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId,
      initialMessage: "keep going with the checkout flow",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    const items = browserTranscript(steps);
    await withWorkspaceRls(client.db, workspaceId, async (db) => {
      for (let start = 0; start < items.length; start += 20) {
        await db.insert(schema.sessionHistoryItems).values(
          items.slice(start, start + 20).map((item, index) => ({
            accountId: grant.accountId,
            workspaceId,
            sessionId: session.id,
            position: start + index,
            item,
          })),
        );
      }
    });
    return { accountId: grant.accountId, workspaceId, sessionId: session.id };
  }

  /** Runs one ordinary turn on a chat route, which has no per-request image limit. */
  async function runTurn(scope: Awaited<ReturnType<typeof screenshotSession>>) {
    const scriptedModel = new ScriptedModel([{ outputText: "Continued the checkout flow." }]);
    const summarizerRequests: string[] = [];
    const summarizerClient = {
      chat: {
        completions: {
          create: async (body: unknown) => {
            summarizerRequests.push(JSON.stringify(body));
            return {
              id: "chatcmpl-footprint-compaction",
              usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 },
              choices: [
                {
                  message: {
                    content: "The checkout flow is half done; the cart page is open.",
                  },
                  finish_reason: "stop",
                },
              ],
            };
          },
        },
      },
    } as unknown as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"];
    const productionRuntime = createProductionAgentRuntime({ model: scriptedModel });
    const modelRequests: number[] = [];
    const runtime: OpenGeniRuntime = {
      ...productionRuntime,
      configure: () => undefined,
      resolveTurnModel: () => ({
        provider: {
          id: "test-chat",
          label: "Test chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        client: summarizerClient,
        model: scriptedModel,
        configured: {
          id: "scripted-model",
          label: "Scripted model",
          providerId: "test-chat",
          providerLabel: "Test chat",
          api: "chat",
          contextWindowTokens: 1_000_000,
          effectiveContextWindowTokens: 1_000_000,
          autoCompactTokenLimit: 900_000,
          reasoningEffort: false,
          hostedWebSearch: false,
        },
      }),
      runStream: async (agent, preparedInput, settings, options) => {
        modelRequests.push(Array.isArray(preparedInput) ? preparedInput.length : 0);
        return await productionRuntime.runStream(agent, preparedInput, settings, options);
      },
    };
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
        contextWindowTokens: 1_000_000,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      runtime,
    });
    const result = await activities.runAgentTurn({
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      workflowId: `session-${scope.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    const events = await listSessionEvents(client.db, scope.workspaceId, scope.sessionId, {
      after: 0,
      limit: 1_000,
    });
    return { result, events, summarizerRequests, modelRequests, scriptedModel };
  }

  test("a long screenshot-heavy session compacts before the materialization guard and continues", async () => {
    // 60 screenshots: about 9.6 MB stored, which is only ~60k-120k provider
    // tokens of images, far below the token threshold, but past 60% of the
    // 15 MiB guard.
    const scope = await screenshotSession(60);
    const before = await readActiveSessionHistory(client.db, scope.workspaceId, scope.sessionId);
    expect(before.footprint.jsonBytes).toBeLessThan(ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES);
    expect(activeSessionHistoryCompactionPressure(before.footprint)).toMatchObject({
      limitKind: "json_bytes",
      exceeded: false,
    });

    const { result, events, summarizerRequests } = await runTurn(scope);
    expect(result).toMatchObject({ status: "idle" });
    const types = events.map((event) => event.type);
    expect(types).not.toContain("turn.failed");
    expect(types).toContain("turn.completed");
    const compacted = events.find((event) => event.type === "session.context.compacted");
    expect(compacted?.payload).toMatchObject({ trigger: "proactive" });
    // Ordinary compaction: nothing was left out of the summarizer's input view.
    expect(compacted?.payload).not.toHaveProperty("compactionInputInlinePayloadRowsElided");
    expect(summarizerRequests).toHaveLength(1);
    // The continuation was answered after the compaction.
    expect(types.indexOf("turn.completed")).toBeGreaterThan(events.indexOf(compacted!));

    const after = await readActiveSessionHistory(client.db, scope.workspaceId, scope.sessionId);
    expect(after.footprint.jsonBytes).toBeLessThan(before.footprint.jsonBytes / 10);
    expect(activeSessionHistoryCompactionPressure(after.footprint)).toBeNull();
  }, 180_000);

  test("a session already over the guard compacts from a bounded view and continues", async () => {
    // 100 screenshots: about 16 MB, over the 15 MiB guard. Before this change
    // every turn failed permanently with active_history_too_large.
    const scope = await screenshotSession(100);
    await expect(
      readActiveSessionHistory(client.db, scope.workspaceId, scope.sessionId),
    ).rejects.toMatchObject({ code: "active_history_too_large" });

    const { result, events, summarizerRequests } = await runTurn(scope);
    expect(result).toMatchObject({ status: "idle" });
    const types = events.map((event) => event.type);
    expect(types).not.toContain("turn.failed");
    expect(types).toContain("turn.completed");
    const compacted = events.find((event) => event.type === "session.context.compacted");
    const payload = compacted?.payload as Record<string, unknown> | undefined;
    const elided = payload?.compactionInputInlinePayloadRowsElided;
    expect(payload).toMatchObject({ trigger: "proactive", compactionInputHistoryRowsOmitted: 0 });
    if (typeof elided !== "number") throw new Error("compaction did not report elided rows");
    expect(elided).toBeGreaterThan(40);
    expect(elided).toBeLessThan(100);

    // The summarizer saw the whole transcript in order with the oldest images
    // replaced by a content-free note, and never more than the bounded view.
    expect(summarizerRequests).toHaveLength(1);
    const request = summarizerRequests[0]!;
    expect(request).toContain(ACTIVE_HISTORY_INLINE_PAYLOAD_OMISSION);
    expect(request).toContain("Captured step 0");
    expect(request).toContain("Captured step 99");
    expect(request.split(SCREENSHOT_MARKER).length - 1).toBeLessThanOrEqual(100 - elided);
    expect(Buffer.byteLength(request)).toBeLessThan(ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES * 0.6);

    // The session is usable again: its active history reads normally.
    const after = await readActiveSessionHistory(client.db, scope.workspaceId, scope.sessionId);
    expect(after.recovery).toBeNull();
    expect(activeSessionHistoryCompactionPressure(after.footprint)).toBeNull();
  }, 180_000);

  test("request image thresholds follow each provider's per-request image limit", () => {
    const settings = { openaiProvider: "openai", contextWindowTokens: 272_000 } as const;
    expect(requestImageCompactionThreshold(null, settings)).toBe(900);
    expect(requestImageCompactionThreshold(null, { ...settings, openaiProvider: "azure" })).toBe(
      30,
    );
    expect(
      requestImageCompactionThreshold(
        { api: "anthropic-messages", wireProfile: "openai" },
        {
          ...settings,
          contextWindowTokens: 200_000,
        },
      ),
    ).toBe(60);
    expect(
      requestImageCompactionThreshold(
        { api: "anthropic-messages", wireProfile: "openai" },
        { ...settings, contextWindowTokens: 1_000_000 },
      ),
    ).toBe(360);
    expect(requestImageCompactionThreshold({ api: "chat", wireProfile: "openai" }, settings)).toBe(
      null,
    );
  });
});
