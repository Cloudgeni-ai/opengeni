import { describe, expect, test, mock } from "bun:test";
import {
  applyModelCatalogDocument,
  configuredModels,
  withCodexCatalogProvider,
} from "@opengeni/config";
import type { CodexAccountStatus, CodexCredentialForRun, Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { loadWorkspaceCodexModelAvailability } from "../src/codex-model-availability";
import { resolveWorkspaceModelSelection } from "../src/model-catalog";

const baseSettings = testSettings({ codexSubscriptionEnabled: true });
const capabilities = configuredModels(withCodexCatalogProvider(baseSettings))[0]!.capabilities;
const settings = applyModelCatalogDocument(baseSettings, {
  schemaVersion: 1,
  builtInModels: ["gpt-6-sol"],
  codexModels: [
    { id: "codex/gpt-6.1-sol", upstreamModelId: "gpt-6.1-sol", label: "GPT-6.1 Sol", capabilities },
    { id: "codex/gpt-6-sol", upstreamModelId: "gpt-6-sol", label: "GPT-6 Sol", capabilities },
    { id: "codex/gpt-6-astra", upstreamModelId: "gpt-6-astra", label: "GPT-6 Astra", capabilities },
  ],
});
const db = {} as Database;
function account(overrides: Partial<CodexAccountStatus> = {}): CodexAccountStatus {
  return {
    id: crypto.randomUUID(),
    status: "active",
    allocatorEnabled: true,
    isActive: true,
    allowedModelIds: null,
    ...overrides,
  } as CodexAccountStatus;
}
function fixture(
  accounts: CodexAccountStatus[],
  slugs: Record<string, string[] | null>,
  rotationEnabled = true,
) {
  let version = 1;
  let allowed = true;
  const deps = {
    listAccounts: mock(async () => accounts),
    getRotation: mock(async () => ({
      rotationEnabled,
      activeCredentialId: accounts[0]?.id,
      rotationStrategy: "sharded" as const,
    })),
    loadCredential: mock(async (_db: Database, _settings: unknown, _ws: string, id: string) =>
      allowed
        ? ({
            id,
            version,
            status: "active",
            tokens: { accessToken: id },
            chatgptAccountId: null,
            isFedramp: false,
          } as CodexCredentialForRun)
        : null,
    ),
    getToken: mock(async (_db: Database, _settings: unknown, _ws: string, id: string) => ({
      accessToken: id,
      chatgptAccountId: null,
      isFedramp: false,
      credentialVersion: version,
      planType: "pro",
    })),
    fetchModels: mock(async ({ accessToken }: { accessToken: string }) => ({
      ok: slugs[accessToken] !== null,
      status: slugs[accessToken] === null ? 503 : 200,
      slugs: slugs[accessToken] ?? [],
    })),
  };
  return { deps, rotate: () => version++, revoke: () => (allowed = false) };
}
function model(
  observations: Awaited<ReturnType<typeof loadWorkspaceCodexModelAvailability>>,
  id: string,
) {
  return resolveWorkspaceModelSelection({
    settings,
    policy: null,
    codexSubscriptionActive: true,
    observations,
  }).find((row) => row.model.id === id)!;
}

describe("live Codex model availability", () => {
  test("configured membership requires exact live support and preserves the actual label", async () => {
    const a = account();
    const f = fixture([a], { [a.id]: ["gpt-6-sol", "unconfigured"] });
    const observed = await loadWorkspaceCodexModelAvailability(
      db,
      settings,
      crypto.randomUUID(),
      f.deps,
    );
    expect(model(observed, "codex/gpt-6-sol")).toMatchObject({
      model: { label: "GPT-6 Sol" },
      availability: { selectable: true, status: "available" },
    });
    expect(model(observed, "codex/gpt-6.1-sol").availability).toMatchObject({
      selectable: false,
      reason: "not_entitled",
    });
    expect(Object.keys(observed)).toHaveLength(
      configuredModels(withCodexCatalogProvider(settings)).filter((m) => m.id.startsWith("codex/"))
        .length,
    );
  });

  test("pool support cannot borrow another account's model permission", async () => {
    const a = account({ allowedModelIds: ["codex/gpt-6-astra"] });
    const b = account({ allowedModelIds: ["codex/gpt-6-sol"], isActive: false });
    const f = fixture([a, b], { [a.id]: ["gpt-6-sol"], [b.id]: ["gpt-6-astra"] });
    const observed = await loadWorkspaceCodexModelAvailability(
      db,
      settings,
      crypto.randomUUID(),
      f.deps,
    );
    expect(model(observed, "codex/gpt-6-sol").availability.selectable).toBe(false);
    expect(model(observed, "codex/gpt-6-astra").availability.selectable).toBe(false);
  });

  test("rotation-off probes only the active account; rotating pools require support on every permitted account", async () => {
    const a = account();
    const b = account({ isActive: false });
    const slugs = { [a.id]: ["gpt-6-sol"], [b.id]: ["gpt-6-astra"] };
    const off = fixture([a, b], slugs, false);
    const observed = await loadWorkspaceCodexModelAvailability(
      db,
      settings,
      crypto.randomUUID(),
      off.deps,
    );
    expect(off.deps.loadCredential.mock.calls.map((call) => call[3])).toEqual([a.id]);
    expect(model(observed, "codex/gpt-6-astra").availability.selectable).toBe(false);
    const on = fixture([a, b], slugs);
    const pool = await loadWorkspaceCodexModelAvailability(
      db,
      settings,
      crypto.randomUUID(),
      on.deps,
    );
    expect(model(pool, "codex/gpt-6-astra").availability.selectable).toBe(false);
    expect(model(pool, "codex/gpt-6-sol").availability.selectable).toBe(false);
    a.allowedModelIds = ["codex/gpt-6-sol"];
    expect(
      model(
        await loadWorkspaceCodexModelAvailability(db, settings, crypto.randomUUID(), on.deps),
        "codex/gpt-6-astra",
      ).availability.selectable,
    ).toBe(true);
  });

  test("catalog probes use refreshed token snapshots and cache the refreshed revision", async () => {
    const a = account();
    const ws = crypto.randomUUID();
    const f = fixture([a], { refreshed: ["gpt-6-sol"] });
    f.deps.getToken.mockResolvedValue({
      accessToken: "refreshed",
      chatgptAccountId: null,
      isFedramp: false,
      credentialVersion: 2,
      planType: "pro",
    });
    const observed = await loadWorkspaceCodexModelAvailability(db, settings, ws, f.deps);
    expect(model(observed, "codex/gpt-6-sol").availability.selectable).toBe(true);
    expect(f.deps.fetchModels.mock.calls[0]![0].accessToken).toBe("refreshed");
    f.rotate();
    await loadWorkspaceCodexModelAvailability(db, settings, ws, f.deps);
    expect(f.deps.getToken).toHaveBeenCalledTimes(1);
    expect(f.deps.fetchModels).toHaveBeenCalledTimes(1);
  });

  test("failed catalog reads fail closed without inventing an entitlement refusal", async () => {
    const a = account();
    const f = fixture([a], { [a.id]: null });
    const observed = await loadWorkspaceCodexModelAvailability(
      db,
      settings,
      crypto.randomUUID(),
      f.deps,
    );
    expect(model(observed, "codex/gpt-6-sol").availability).toMatchObject({
      selectable: false,
      reason: "provider_unhealthy",
    });
  });

  test("cache coalesces provider reads but rechecks authority and credential revision", async () => {
    const a = account();
    const ws = crypto.randomUUID();
    const f = fixture([a], { [a.id]: ["gpt-6-sol"] });
    await Promise.all([
      loadWorkspaceCodexModelAvailability(db, settings, ws, f.deps),
      loadWorkspaceCodexModelAvailability(db, settings, ws, f.deps),
    ]);
    expect(f.deps.fetchModels).toHaveBeenCalledTimes(1);
    expect(f.deps.loadCredential).toHaveBeenCalledTimes(2);
    f.rotate();
    await loadWorkspaceCodexModelAvailability(db, settings, ws, f.deps);
    expect(f.deps.fetchModels).toHaveBeenCalledTimes(2);
    f.revoke();
    const revoked = await loadWorkspaceCodexModelAvailability(db, settings, ws, f.deps);
    expect(model(revoked, "codex/gpt-6-sol").availability.selectable).toBe(false);
    await loadWorkspaceCodexModelAvailability(db, settings, crypto.randomUUID(), f.deps);
    expect(f.deps.fetchModels).toHaveBeenCalledTimes(2);
  });

  test("disabled or paused accounts never contribute support", async () => {
    const a = account({ allocatorEnabled: false });
    const b = account({ status: "needs_relogin" });
    const f = fixture([a, b], { [a.id]: ["gpt-6-sol"], [b.id]: ["gpt-6-sol"] });
    const observed = await loadWorkspaceCodexModelAvailability(
      db,
      settings,
      crypto.randomUUID(),
      f.deps,
    );
    expect(model(observed, "codex/gpt-6-sol").availability.selectable).toBe(false);
    expect(f.deps.loadCredential).not.toHaveBeenCalled();
    expect(
      await loadWorkspaceCodexModelAvailability(
        db,
        { ...settings, codexSubscriptionEnabled: false },
        crypto.randomUUID(),
        f.deps,
      ),
    ).toEqual({});
  });
});
