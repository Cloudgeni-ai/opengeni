import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SlackInstallationBinding } from "@/types";

const context: { current: Record<string, unknown> } = { current: {} };
mock.module("@/context", () => ({ useAppContext: () => context.current }));
const { useSlackInstallationDiscovery } = await import("./use-slack-installation-discovery");
const { localConnectedSlackPreview } = await import("./use-slack-integration");
beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const accountId = "00000000-0000-4000-8000-000000000001";
function grant(workspaceId: string, account = accountId, permissions = ["connections:read"]) {
  return { workspaceId, accountId: account, permissions };
}
const bot = localConnectedSlackPreview("?previewSlack=connected", "home", true)!.bot;
const binding = {
  id: "binding",
  workspaceId: "home",
  accountId,
  connectionId: bot.id,
  connectionVersion: bot.version,
  connectionStatus: "active",
  state: "active",
  slackTeamId: bot.metadata.slackTeamId,
  botId: bot.metadata.botId,
  botUserId: bot.metadata.botUserId,
} as SlackInstallationBinding;

async function mount() {
  let result!: ReturnType<typeof useSlackInstallationDiscovery>;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    result = useSlackInstallationDiscovery("current", true);
    return null;
  }
  await act(async () => root.render(<Probe />));
  return {
    get result() {
      return result;
    },
    rerender: async () => {
      await act(async () => root.render(<Probe />));
    },
    close: async () => {
      await act(async () => root.unmount());
    },
  };
}

test("discovers only readable same-organization workspaces and verifies the exact bot", async () => {
  const list = mock(async (_workspaceId: string) => [binding]);
  context.current = {
    accessContext: {
      subjectId: "owner",
      workspaceGrants: [
        grant("current"),
        grant("home"),
        grant("other-org", "other"),
        grant("private", accountId, []),
      ],
    },
    client: { listSlackInstallationBindings: list, listConnections: async () => [bot] },
  };
  const mounted = await mount();
  try {
    expect(list.mock.calls).toEqual([["home"]]);
    expect(mounted.result.bindings).toEqual([binding]);
    expect(mounted.result.verifiedIds).toEqual([binding.id]);
    expect(mounted.result.loading).toBe(false);
  } finally {
    await mounted.close();
  }
});

test("an active binding with a stale credential version is not reported healthy", async () => {
  context.current = {
    accessContext: { subjectId: "owner", workspaceGrants: [grant("current"), grant("home")] },
    client: {
      listSlackInstallationBindings: async () => [binding],
      listConnections: async () => [{ ...bot, version: bot.version + 1 }],
    },
  };
  const mounted = await mount();
  try {
    expect(mounted.result.bindings).toHaveLength(1);
    expect(mounted.result.verifiedIds).toEqual([]);
  } finally {
    await mounted.close();
  }
});

test("a partial discovery failure blocks a false disconnected result and can retry", async () => {
  let fail = true;
  context.current = {
    accessContext: { subjectId: "owner", workspaceGrants: [grant("current"), grant("home")] },
    client: {
      listSlackInstallationBindings: async () => {
        if (fail) throw new Error("unavailable");
        return [];
      },
    },
  };
  const mounted = await mount();
  try {
    expect(mounted.result.failed).toBe(true);
    fail = false;
    await act(async () => mounted.result.retry());
    expect(mounted.result.failed).toBe(false);
    expect(mounted.result.bindings).toEqual([]);
  } finally {
    await mounted.close();
  }
});

test("a late response from the previous subject cannot populate the new subject's status", async () => {
  let finish!: (rows: SlackInstallationBinding[]) => void;
  const client = {
    listSlackInstallationBindings: () =>
      new Promise<SlackInstallationBinding[]>((resolve) => {
        finish = resolve;
      }),
    listConnections: async () => [bot],
  };
  context.current = {
    accessContext: { subjectId: "owner", workspaceGrants: [grant("current"), grant("home")] },
    client,
  };
  const mounted = await mount();
  try {
    expect(mounted.result.loading).toBe(true);
    context.current = {
      accessContext: { subjectId: "member", workspaceGrants: [grant("current")] },
      client,
    };
    await mounted.rerender();
    await act(async () => finish([binding]));
    expect(mounted.result.bindings).toEqual([]);
    expect(mounted.result.verifiedIds).toEqual([]);
  } finally {
    await mounted.close();
  }
});
