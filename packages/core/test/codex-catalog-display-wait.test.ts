import { describe, expect, test } from "bun:test";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import type * as dbApi from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  CODEX_CATALOG_DISPLAY_WAIT_MS,
  loadWorkspaceCodexCatalogReadiness,
} from "../src/codex-model-availability";

// A page load or picker must not wait for a slow provider's model list. It
// waits briefly, then uses the last list it knows, while the live read
// finishes in the background and records its result for the next read.

const settings = testSettings({ codexSubscriptionEnabled: true });
const model = configuredModels(withCodexCatalogProvider(settings)).find(
  (candidate) =>
    candidate.credentialSource.kind === "connected_subscription" &&
    candidate.credentialSource.provider === "codex",
)!;
const db = {} as dbApi.Database;
type Deps = NonNullable<Parameters<typeof loadWorkspaceCodexCatalogReadiness>[4]>;

function sharedConnection(
  modelCatalog: dbApi.SubscriptionCoreCodexServingConnection["modelCatalog"],
): dbApi.SubscriptionCoreCodexServingConnection {
  return {
    connectionId: crypto.randomUUID(),
    ownership: "shared",
    planType: "pro",
    allowedModelIds: null,
    excludedModelIds: [],
    assignments: null,
    pools: ["organization"],
    cooledDownModelIds: [],
    modelCatalog,
  };
}

function harness(
  connection: dbApi.SubscriptionCoreCodexServingConnection,
  liveSlugs: string[],
  liveDelayMs: number,
) {
  const recorded: string[][] = [];
  let fetches = 0;
  const deps = {
    listServing: async () => [connection],
    getCoreToken: async () => ({
      accessToken: "token",
      chatgptAccountId: null,
      isFedramp: false,
      credentialVersion: 1,
    }),
    fetchModels: async () => {
      fetches += 1;
      await Bun.sleep(liveDelayMs);
      return { ok: true, status: 200, slugs: liveSlugs };
    },
    recordModels: async (
      _db: unknown,
      _scope: unknown,
      _id: unknown,
      input: { slugs: string[] },
    ) => {
      recorded.push(input.slugs);
      return true;
    },
  } as unknown as Deps;
  const read = () =>
    loadWorkspaceCodexCatalogReadiness(
      db,
      settings,
      { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), subjectId: "user:a" },
      {},
      deps,
    );
  return { read, recorded, fetches: () => fetches };
}

describe("Codex catalog display reads do not wait for a slow provider", () => {
  test("an expired list is served while the slow live read records a new one", async () => {
    const now = Date.now();
    const { read, recorded, fetches } = harness(
      sharedConnection({
        slugs: [model.upstreamModelId],
        observedAt: now - 120_000,
        expiresAt: now - 60_000,
      }),
      [],
      1_500,
    );
    const started = performance.now();
    const result = await read();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    expect(elapsed).toBeGreaterThanOrEqual(CODEX_CATALOG_DISPLAY_WAIT_MS - 50);
    expect(fetches()).toBe(1);
    expect(result.active).toBe(true);
    expect(result.observations[model.definitionVersion]?.status).toBe("available");
    // The live read finishes on its own and records the new list.
    await Bun.sleep(1_700);
    expect(recorded).toEqual([[]]);
  });

  test("with no list yet, the account counts as unknown, never unavailable", async () => {
    const { read } = harness(sharedConnection(null), [], 1_500);
    const started = performance.now();
    const result = await read();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.active).toBe(true);
    expect(result.observations[model.definitionVersion]).toBeUndefined();
  });

  test("a live read that answers in time is used", async () => {
    const now = Date.now();
    const { read } = harness(
      sharedConnection({
        slugs: [model.upstreamModelId],
        observedAt: now - 120_000,
        expiresAt: now - 60_000,
      }),
      [],
      0,
    );
    const result = await read();
    expect(result.observations[model.definitionVersion]).toMatchObject({
      status: "unavailable",
      reason: "not_entitled",
    });
  });

  test("a fresh list needs no live read", async () => {
    const now = Date.now();
    const { read, fetches } = harness(
      sharedConnection({
        slugs: [model.upstreamModelId],
        observedAt: now - 1_000,
        expiresAt: now + 59_000,
      }),
      [],
      0,
    );
    const result = await read();
    expect(fetches()).toBe(0);
    expect(result.observations[model.definitionVersion]?.status).toBe("available");
  });
});
