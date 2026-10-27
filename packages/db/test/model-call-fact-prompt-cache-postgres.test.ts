import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import type { PromptCacheRequestFingerprint } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession, recordModelCallFact } from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const db = await acquireSharedTestDatabase("model-call-fact-prompt-cache");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const digest = (seed: string) => seed.repeat(16).slice(0, 16);
const fingerprint = (system: string): PromptCacheRequestFingerprint => ({
  v: 1,
  tools: digest("a"),
  system: digest(system),
  items: 4,
  history: [
    [1, digest("1")],
    [2, digest("2")],
    [4, digest("4")],
  ],
});

async function scope() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "cache",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "cache",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, sessionId: session.id };
}

const call = (
  base: Awaited<ReturnType<typeof scope>>,
  input: {
    at: number;
    inputTokens: number;
    cachedTokens: number;
    promptCache?: Parameters<typeof recordModelCallFact>[1]["promptCache"];
  },
) =>
  recordModelCallFact(client.db, {
    ...base,
    turnId: crypto.randomUUID(),
    sourceKey: crypto.randomUUID(),
    provider: "anthropic",
    providerApi: "messages",
    model: "claude-test",
    billingPath: "external",
    pricedCostMicros: 0,
    inputTokens: input.inputTokens,
    cachedTokens: input.cachedTokens,
    occurredAt: new Date(input.at),
    ...(input.promptCache === undefined ? {} : { promptCache: input.promptCache }),
  });

test("a warm miss is classified against the previous call of the same model", async () => {
  const base = await scope();
  const start = Date.UTC(2026, 0, 1);
  const first = await call(base, {
    at: start,
    inputTokens: 200_000,
    cachedTokens: 190_000,
    promptCache: { request: fingerprint("b") },
  });
  expect(first.promptCacheDiagnostics).toEqual({ request: fingerprint("b") });

  const changed = await call(base, {
    at: start + 30_000,
    inputTokens: 201_000,
    cachedTokens: 29_739,
    promptCache: {
      request: fingerprint("c"),
      thinkingBlocksDropped: { prefix_binding_mismatch: 3 },
    },
  });
  expect(changed.promptCacheDiagnostics).toMatchObject({
    thinkingBlocksDropped: { prefix_binding_mismatch: 3 },
    warmMiss: {
      class: "system_changed",
      expectedCachedTokens: 200_000,
      previousSourceKey: first.sourceKey,
      gapMs: 30_000,
    },
  });

  const hit = await call(base, {
    at: start + 60_000,
    inputTokens: 202_000,
    cachedTokens: 200_500,
    promptCache: { request: fingerprint("c") },
  });
  expect(hit.promptCacheDiagnostics).toEqual({ request: fingerprint("c") });
}, 180_000);

test("repair paths that omit the observation leave diagnostics empty", async () => {
  const base = await scope();
  const start = Date.UTC(2026, 0, 1);
  await call(base, { at: start, inputTokens: 200_000, cachedTokens: 190_000, promptCache: null });
  const repaired = await call(base, { at: start + 1_000, inputTokens: 200_000, cachedTokens: 0 });
  expect(repaired.promptCacheDiagnostics).toBeNull();
  const observed = await call(base, {
    at: start + 2_000,
    inputTokens: 200_000,
    cachedTokens: 0,
    promptCache: null,
  });
  expect(observed.promptCacheDiagnostics?.warmMiss?.class).toBe("unexplained");
}, 180_000);
