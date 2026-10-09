import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fetchCodexModels, type CodexFetch } from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import * as dbApi from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { loadWorkspaceCodexCatalogReadiness } from "../src/codex-model-availability";

const settings = testSettings({ codexSubscriptionEnabled: true });
const models = configuredModels(withCodexCatalogProvider(settings)).filter(
  (model) =>
    model.credentialSource.kind === "connected_subscription" &&
    model.credentialSource.provider === "codex",
);
const db = {} as dbApi.Database;
const realOperationFetch = dbApi.buildSubscriptionCoreCodexOperationFetch;
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function fixture(fetchImpl: CodexFetch) {
  let disconnected = false;
  const context = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "user:catalog",
  };
  const connection: dbApi.SubscriptionCoreCodexServingConnection = {
    connectionId: crypto.randomUUID(),
    ownership: "shared",
    planType: "pro",
    allowedModelIds: null,
    excludedModelIds: [],
    assignments: null,
    cooledDownModelIds: [],
  };
  type RequestDeps = NonNullable<Parameters<typeof realOperationFetch>[5]>;
  const reserve = mock<NonNullable<RequestDeps["reserve"]>>(async () => {
    if (disconnected) throw new Error("disconnected");
    return { operationId: crypto.randomUUID() };
  });
  const settle = mock<NonNullable<RequestDeps["settle"]>>(async () => undefined);
  const wrapper = spyOn(dbApi, "buildSubscriptionCoreCodexOperationFetch").mockImplementation(
    (targetDb, scope, ref, connectionId) =>
      realOperationFetch(targetDb, scope, ref, connectionId, fetchImpl, { reserve, settle }),
  );
  restores.push(() => wrapper.mockRestore());
  const deps: NonNullable<Parameters<typeof loadWorkspaceCodexCatalogReadiness>[4]> = {
    disposition: async () => "core",
    legacyActive: async () => {
      throw new Error("no legacy access");
    },
    legacyAvailability: async () => {
      throw new Error("no legacy access");
    },
    listServing: async () => [connection],
    fetchModels: fetchCodexModels,
    getCoreToken: async () => ({
      accessToken: "fake-catalog-bearer",
      chatgptAccountId: null,
      isFedramp: false,
      credentialVersion: 1,
      planType: "pro",
    }),
  };
  const read = () => loadWorkspaceCodexCatalogReadiness(db, settings, context, {}, deps);
  return {
    context,
    connection,
    reserve,
    settle,
    deps,
    read,
    disconnect: () => (disconnected = true),
  };
}

describe("core model discovery physical request custody", () => {
  test("one cache miss reserves under the exact caller; cached catalog is not another request", async () => {
    const upstream = mock<CodexFetch>(async () =>
      Response.json({ models: models.map((model) => ({ slug: model.upstreamModelId })) }),
    );
    const f = fixture(upstream);
    const readiness = await f.read();
    expect(readiness.observations[models[0]!.definitionVersion]?.status).toBe("available");
    await f.read();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.reserve.mock.calls[0]?.slice(1, 4)).toEqual([
      { kind: "workspace", ...f.context },
      null,
      f.connection.connectionId,
    ]);
    expect(f.settle.mock.calls[0]?.[2]).toMatchObject({ outcome: "response_received" });
  });

  test("disconnect after a token load still fences the model probe", async () => {
    const upstream = mock<CodexFetch>(async () => {
      throw new Error("must not dispatch");
    });
    const f = fixture(upstream);
    f.disconnect();
    const readiness = await f.read();
    expect(readiness.observations[models[0]!.definitionVersion]).toMatchObject({
      status: "unavailable",
      reason: "provider_unhealthy",
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.settle).not.toHaveBeenCalled();
  });

  test("unknown body failure is not retried or treated as model entitlement proof", async () => {
    const upstream = mock<CodexFetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("catalog body interrupted"));
            },
          }),
        ),
    );
    const f = fixture(upstream);
    const readiness = await f.read();
    expect(readiness.observations[models[0]!.definitionVersion]).toMatchObject({
      status: "unavailable",
      reason: "provider_unhealthy",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(f.settle.mock.calls[0]?.[2]).toMatchObject({ outcome: "unknown" });
  });

  test("personal catalog availability never borrows a shared request authority", async () => {
    const upstream = mock<CodexFetch>(async () => {
      throw new Error("no personal probe");
    });
    const f = fixture(upstream);
    f.connection.ownership = "personal";
    const readiness = await f.read();
    expect(readiness.active).toBe(true);
    expect(readiness.observations).toEqual({});
    expect(f.reserve).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});
