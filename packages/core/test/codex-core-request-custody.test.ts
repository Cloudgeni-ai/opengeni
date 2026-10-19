import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fetchCodexModels, type CodexFetch } from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import * as dbApi from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import {
  refreshCoreCodexModelEntitlements,
  loadWorkspaceCodexCatalogReadiness,
} from "../src/codex-model-availability";
import { resolveWorkspaceModelSelection } from "../src/model-catalog";

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
    pools: ["organization"],
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
    recordModels: mock(async () => true),
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
  test("a refused fresh-token hint does not renew credentials or persist an entitlement denial", async () => {
    const upstream = mock<CodexFetch>(async () => new Response("unauthorized", { status: 401 }));
    const f = fixture(upstream);
    const fresh = f.deps.getCoreToken;
    const credentialModes: boolean[] = [];
    f.deps.getCoreToken = async (...args) => {
      credentialModes.push(args[4]);
      return fresh(...args);
    };
    await refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps, {
      refreshCredentials: false,
    });
    expect(credentialModes).toEqual([false]);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(f.deps.recordModels).not.toHaveBeenCalled();
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.settle).toHaveBeenCalledTimes(1);
  });

  test("typing skips a refresh-due credential without probing or poisoning normal access", async () => {
    const upstream = mock<CodexFetch>(async () => Response.json({ models: [] }));
    const f = fixture(upstream);
    const normal = f.deps.getCoreToken;
    f.deps.getCoreToken = mock(async (...args) => (args[4] ? normal(...args) : null));
    const before = Date.now();
    const until = await refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps, {
      refreshCredentials: false,
    });
    expect(until).toBeGreaterThanOrEqual(before + 5_000);
    expect(upstream).not.toHaveBeenCalled();
    expect(f.deps.recordModels).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    await refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  test("a fresh persisted catalog is reusable without credentials or provider I/O", async () => {
    const upstream = mock<CodexFetch>(async () => {
      throw new Error("must not dispatch");
    });
    const f = fixture(upstream);
    const observedAt = Date.now() - 1_000;
    f.connection.modelCatalog = {
      slugs: [models[0]!.upstreamModelId],
      observedAt,
      expiresAt: observedAt + 60_000,
    };
    f.deps.getCoreToken = mock(async () => {
      throw new Error("must not load credentials");
    });
    const readiness = await f.read();
    expect(readiness.observations[models[0]!.definitionVersion]).toEqual({
      status: "available",
      reason: null,
      checkedAt: new Date(observedAt).toISOString(),
    });
    expect(await refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps)).toBe(
      observedAt + 60_000,
    );
    expect(f.deps.getCoreToken).not.toHaveBeenCalled();
    expect(f.deps.recordModels).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    // Live scope/revocation still wins over reusable observations.
    f.deps.listServing = async () => [];
    expect(await f.read()).toEqual({ active: false, observations: {} });
  });

  test("empty persisted catalogs are definitive, but expired/future observations refresh", async () => {
    const f = fixture(async () => Response.json({ models: [] }));
    const now = Date.now();
    f.connection.modelCatalog = { slugs: [], observedAt: now - 100, expiresAt: now + 60_000 };
    expect((await f.read()).observations[models[0]!.definitionVersion]?.reason).toBe(
      "not_entitled",
    );
    expect(f.reserve).not.toHaveBeenCalled();
    f.connection.modelCatalog.expiresAt = now - 1;
    await f.read();
    expect(f.reserve).toHaveBeenCalledTimes(1);

    const future = fixture(async () => Response.json({ models: [] }));
    future.connection.modelCatalog = {
      slugs: [],
      observedAt: now + 60_000,
      expiresAt: now + 120_000,
    };
    await future.read();
    expect(future.reserve).toHaveBeenCalledTimes(1);
  });

  test("SUB-ELIG-03: an unreachable eligible account stays selectable and unknown, not a pooled entitlement denial", async () => {
    const f = fixture(async () => Response.json({ models: [] }));
    const uncertain = { ...f.connection, connectionId: crypto.randomUUID() };
    f.deps.listServing = async () => [f.connection, uncertain];
    f.deps.getCoreToken = async (_db, _settings, _context, id) => ({
      accessToken: id,
      chatgptAccountId: null,
      isFedramp: false,
      credentialVersion: 1,
      planType: "pro",
    });
    f.deps.fetchModels = async ({ accessToken }) => ({
      ok: accessToken !== uncertain.connectionId,
      status: accessToken === uncertain.connectionId ? 503 : 200,
      slugs: [models[0]!.upstreamModelId],
    });
    const read = await f.read();
    expect(read.observations[models[0]!.definitionVersion]?.status).toBe("available");
    expect(read.observations[models[1]!.definitionVersion]).toBeUndefined();
    expect(
      resolveWorkspaceModelSelection({
        settings,
        policy: null,
        codexSubscriptionActive: read.active,
        observations: read.observations,
      }).find((model) => model.model.id === models[1]!.id)?.availability,
    ).toMatchObject({ status: "unknown", selectable: true, reason: null });
    // An account outside this model's allowlist cannot introduce uncertainty.
    uncertain.allowedModelIds = [models[0]!.id];
    const restricted = await f.read();
    expect(restricted.observations[models[1]!.definitionVersion]?.reason).toBe("not_entitled");
  });
  test("placement reads the picker's per-credential facts and refresh invalidates old entitlements", async () => {
    let slugs = [models[0]!.upstreamModelId];
    const upstream = mock<CodexFetch>(async () =>
      Response.json({ models: slugs.map((slug) => ({ slug })) }),
    );
    const f = fixture(upstream);
    const read = () => refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps);
    await f.read();
    await read();
    expect(f.deps.recordModels).toHaveBeenCalledTimes(1);
    expect((f.deps.recordModels as ReturnType<typeof mock>).mock.calls[0]?.[3]).toMatchObject({
      refreshGeneration: 1,
      slugs: [models[0]!.upstreamModelId],
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    const token = await f.deps.getCoreToken(db, settings, f.context, f.connection.connectionId);
    f.deps.getCoreToken = async () => ({ ...token, credentialVersion: 2 });
    slugs = models.map((model) => model.upstreamModelId);
    slugs.push("retired-but-accepted-model");
    await read();
    expect((f.deps.recordModels as ReturnType<typeof mock>).mock.calls[1]?.[3]).toMatchObject({
      refreshGeneration: 2,
      slugs,
    });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  test("failed catalogs, maintenance, and personal connections produce no entitlement exclusions", async () => {
    const upstream = mock<CodexFetch>(async () => {
      throw new Error("unreachable");
    });
    const f = fixture(upstream);
    await refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps);
    expect(f.deps.recordModels).not.toHaveBeenCalled();
    f.connection.ownership = "personal";
    await refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps);
    expect(f.deps.recordModels).not.toHaveBeenCalled();
    f.deps.disposition = async () => "maintenance";
    f.deps.listServing = async () => {
      throw new Error("must not read disabled core");
    };
    await refreshCoreCodexModelEntitlements(db, settings, f.context, f.deps);
    expect(f.deps.recordModels).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
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
    expect(readiness.observations[models[0]!.definitionVersion]).toBeUndefined();
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
    expect(readiness.observations[models[0]!.definitionVersion]).toBeUndefined();
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
