import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  OrganizationModelDefaults,
  UpdateWorkspaceModelAccountSettingsRequest,
} from "@opengeni/sdk";

import {
  actRun,
  flush,
  registerDom,
  renderHook,
} from "../../../../../packages/react/test/render-hook";
import {
  clearSharedQueries,
  invalidateSharedQueries,
  retainSharedQueries,
} from "@opengeni/react/app/lib/shared-query";
import { notifyCreditBalanceChanged } from "@opengeni/react/app/lib/credit-balance-events";

const defaults: OrganizationModelDefaults = {
  sessionDefaults: null,
  allowedProviders: null,
  allowedModels: null,
  modelCompactionThresholds: {},
  realtimeVoice: {},
  updatedAt: null,
};
const workspaceSettings = { workspaceId: "workspace-a", version: 1 };
const overview = { organization: { version: 1 }, workspaces: [], nextCursor: null };

function makeClient() {
  return {
    getOrganizationModelDefaults: mock(async (_id: string) => defaults),
    updateOrganizationModelDefaults: mock(async () => defaults),
    getModelAccountSettingsOverview: mock(async (_id: string) => overview),
    updateOrganizationModelAccountSettings: mock(async () => ({})),
    getWorkspaceModelAccountSettings: mock(async (_id: string) => workspaceSettings),
    updateWorkspaceModelAccountSettings: mock(
      async (_id: string, _request: UpdateWorkspaceModelAccountSettingsRequest) =>
        workspaceSettings,
    ),
    getBilling: mock(async (_options: { accountId: string }) => ({
      mode: "stripe",
      balance: { balanceMicros: 12_400_000, currency: "usd", plan: null },
    })),
  };
}
let client = makeClient();
const context = {
  client: client as unknown as OpenGeniBrowserClient,
  clientConfig: { billingMode: "stripe", models: [{ cost: "credits" }] },
  accessContext: {
    accountGrants: [{ accountId: "organization-a", permissions: ["billing:read"] }],
  },
};
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { error: mock(() => undefined) } }));

const { useOrganizationModelDefaults } = await import("./use-organization-model-defaults");
const { useModelAccountSettingsOverview, useWorkspaceModelAccountSettings } =
  await import("./model-account-settings");
const { useOpenGeniCredits } = await import("./opengeni-credits-row");

registerDom();
let release: () => void;
beforeEach(() => {
  client = makeClient();
  context.client = client as unknown as OpenGeniBrowserClient;
  context.accessContext.accountGrants = [
    { accountId: "organization-a", permissions: ["billing:read"] },
  ];
  release = retainSharedQueries(client);
});
afterEach(async () => {
  release();
  await flush();
  document.body.replaceChildren();
});

function useReads({
  enabled = true,
  organizationId = "organization-a",
  workspaceId = "workspace-a",
} = {}) {
  return {
    defaults: useOrganizationModelDefaults(organizationId, enabled),
    overview: useModelAccountSettingsOverview(organizationId, enabled),
    workspace: useWorkspaceModelAccountSettings(workspaceId, enabled),
    credits: useOpenGeniCredits(organizationId),
  };
}

test("supporting Models reads survive revisits and all respond to the Models refresh prefix", async () => {
  const first = await renderHook(useReads, {});
  expect(first.result.current.credits.balanceLabel).toBe("$12.40 left");
  await first.unmount();
  const second = await renderHook(useReads, {});
  try {
    expect(second.result.current.defaults.defaults).toEqual(defaults);
    expect(second.result.current.defaults.loading).toBe(false);
    expect(second.result.current.overview.loading).toBe(false);
    for (const read of [
      client.getOrganizationModelDefaults,
      client.getModelAccountSettingsOverview,
      client.getWorkspaceModelAccountSettings,
      client.getBilling,
    ]) {
      expect(read).toHaveBeenCalledTimes(1);
    }
    await actRun(() => invalidateSharedQueries(client, ["model-settings"]));
    for (const read of [
      client.getOrganizationModelDefaults,
      client.getModelAccountSettingsOverview,
      client.getWorkspaceModelAccountSettings,
      client.getBilling,
    ]) {
      expect(read).toHaveBeenCalledTimes(2);
    }
  } finally {
    await second.unmount();
  }
});

test("a five-minute-old supporting read revalidates on remount", async () => {
  const first = await renderHook(() => useOrganizationModelDefaults("organization-a", true), {});
  await first.unmount();
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 300_001);
  try {
    const second = await renderHook(() => useOrganizationModelDefaults("organization-a", true), {});
    expect(client.getOrganizationModelDefaults).toHaveBeenCalledTimes(2);
    await second.unmount();
  } finally {
    clock.mockRestore();
  }
});

test("disabled readers and lost billing permissions do not expose retained rows", async () => {
  const hook = await renderHook(useReads, { enabled: true });
  try {
    context.accessContext.accountGrants = [];
    await hook.rerender({ enabled: false });
    expect(hook.result.current.defaults.defaults).toBeNull();
    expect(hook.result.current.overview.overview).toBeNull();
    expect(hook.result.current.workspace.settings).toBeNull();
    expect(hook.result.current.credits.balanceLabel).toBeNull();
    expect(client.getBilling).toHaveBeenCalledTimes(1);
  } finally {
    await hook.unmount();
  }
});

test("credit confirmations refresh only the matching organization's retained balance", async () => {
  const hook = await renderHook(() => useOpenGeniCredits("organization-a"), {});
  try {
    await actRun(() => notifyCreditBalanceChanged("other-organization"));
    expect(client.getBilling).toHaveBeenCalledTimes(1);
    await actRun(() => notifyCreditBalanceChanged("organization-a"));
    expect(client.getBilling).toHaveBeenCalledTimes(2);
  } finally {
    await hook.unmount();
  }
});

test("access refusals remove retained defaults and are retried on revisit", async () => {
  const hook = await renderHook(() => useOrganizationModelDefaults("organization-a", true), {});
  client.getOrganizationModelDefaults.mockRejectedValueOnce(
    Object.assign(new Error("Forbidden"), { status: 403 }),
  );
  await actRun(() => invalidateSharedQueries(client, ["model-settings"]));
  expect(hook.result.current.defaults).toBeNull();
  expect(hook.result.current.error?.message).toBe("Forbidden");
  await hook.unmount();
  const next = await renderHook(() => useOrganizationModelDefaults("organization-a", true), {});
  expect(client.getOrganizationModelDefaults).toHaveBeenCalledTimes(3);
  expect(next.result.current.defaults).toEqual(defaults);
  await next.unmount();
});

test("a completed defaults mutation cannot overwrite a newer client's rows", async () => {
  let finish!: (value: OrganizationModelDefaults) => void;
  client.updateOrganizationModelDefaults.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = await renderHook(() => useOrganizationModelDefaults("organization-a", true), {});
  let saved!: Promise<OrganizationModelDefaults>;
  await actRun(() => {
    saved = hook.result.current.update({ sessionDefaults: null });
  });
  context.client = makeClient() as unknown as OpenGeniBrowserClient;
  await hook.rerender();
  const changed = { ...defaults, allowedModels: ["new-model"] };
  await actRun(async () => {
    finish(changed);
    await saved;
  });
  expect(hook.result.current.defaults).toEqual(defaults);
  await hook.unmount();
});

test("clearing the client fences a defaults save started before the clear", async () => {
  let finish!: (value: OrganizationModelDefaults) => void;
  client.updateOrganizationModelDefaults.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = await renderHook(() => useOrganizationModelDefaults("organization-a", true), {});
  let saved!: Promise<OrganizationModelDefaults>;
  await actRun(() => {
    saved = hook.result.current.update({ sessionDefaults: null });
  });
  await actRun(() => clearSharedQueries(client));
  await actRun(async () => {
    finish({ ...defaults, allowedModels: ["retired"] });
    await saved;
  });
  expect(hook.result.current.defaults).toEqual(defaults);
  await hook.unmount();
});

test("organization changes refresh workspace rules; workspace changes refresh the overview", async () => {
  const hook = await renderHook(useReads, {});
  try {
    await actRun(() => hook.result.current.overview.update("locks", { locked: [] }));
    expect(client.getModelAccountSettingsOverview).toHaveBeenCalledTimes(2);
    expect(client.getWorkspaceModelAccountSettings).toHaveBeenCalledTimes(2);
    await actRun(() =>
      hook.result.current.workspace.update("fallback", { personalFallbackAllowed: true }),
    );
    expect(client.updateWorkspaceModelAccountSettings.mock.calls[0]?.[1]).toMatchObject({
      expectedVersion: 1,
    });
    expect(client.getModelAccountSettingsOverview).toHaveBeenCalledTimes(3);
  } finally {
    await hook.unmount();
  }
});
