import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_VERSION,
  createOpenGeniSiteClient,
  createSiteToolBridge,
  isOpenGeniSiteBridgeRequestMessage,
  siteConnectCardDismissals,
  siteConnectCardItemActionable,
  siteConnectCardLabel,
  siteConnectionStatus,
  type SiteToolConnectPrompt,
  type SiteToolFailurePrompt,
} from "../src/site";
import {
  SiteBridgeHost,
  siteBridgeReadyMessage,
  type SiteBridgeToolHandlers,
} from "../src/site-bridge-host";
import type { ToolGatewaySiteSetupItem } from "../src/types";

// The platform's connect card: built by the host from the App's declared
// tools, shown by the host, and reachable from Site code without any ids.
const gmail = { serverId: "gmail", toolName: "send_message" };
const calendar = { serverId: "calendar", toolName: "list_events" };
const items: ToolGatewaySiteSetupItem[] = [
  {
    key: "connect:Gmail:",
    action: "connect",
    connector: "Gmail",
    capabilityId: "capability-gmail",
    connectionId: null,
    account: null,
    shared: false,
    tools: [gmail],
    openUrl: "https://console.example/workspaces/w/sites/s?connect=connect%3AGmail%3A",
  },
  {
    key: "reconnect:Calendar:ada@example.com",
    action: "reconnect",
    connector: "Calendar",
    capabilityId: "capability-calendar",
    connectionId: "connection-1",
    account: "ada@example.com",
    shared: true,
    tools: [calendar],
    openUrl: null,
  },
];

function memoryStorage() {
  return memoryStorageImpl();
}

test("API-key tools: a shared key for admins, ask an admin for everyone else", () => {
  const stripe = { ...items[0]!, key: "connect:Stripe:", connector: "Stripe" };
  expect(siteConnectCardLabel({ ...stripe, sharedKey: "add" })).toBe("Add a shared key for Stripe");
  expect(siteConnectCardLabel({ ...stripe, sharedKey: "ask_admin" })).toBe(
    "Ask an admin to connect Stripe",
  );
  expect(siteConnectCardItemActionable({ sharedKey: "add" })).toBe(true);
  expect(siteConnectCardItemActionable({ sharedKey: "ask_admin" })).toBe(false);
  expect(siteConnectCardItemActionable({})).toBe(true);
  const status = siteConnectionStatus([{ ...stripe, sharedKey: "ask_admin", openUrl: null }]);
  expect(status.needed[0]).toMatchObject({
    sharedKey: "ask_admin",
    label: "Ask an admin to connect Stripe",
  });
  expect(siteConnectionStatus(items).needed[0]).not.toHaveProperty("sharedKey");
});

function memoryStorageImpl() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function connect(source: ConstructorParameters<typeof SiteBridgeHost>[0]) {
  const host = new SiteBridgeHost(source);
  let bootstrap: MessagePort | undefined;
  host.load({
    postMessage: (_message: unknown, _origin: string, transfer?: Transferable[]) => {
      bootstrap = transfer?.[0] as MessagePort;
    },
  } as Pick<Window, "postMessage">);
  const site = createOpenGeniSiteClient({ bootstrapPort: bootstrap!, connectTimeoutMs: 2000 });
  return { host, site };
}

const tools: SiteBridgeToolHandlers = {
  catalog: async () => {
    throw new Error("unused");
  },
  call: async () => {
    throw new Error("unused");
  },
};

describe("connect card model", () => {
  test("one plain action per item", () => {
    expect(siteConnectCardLabel(items[0]!)).toBe("Connect Gmail");
    expect(siteConnectCardLabel(items[1]!)).toBe("Reconnect Calendar");
  });

  test("Site code sees what to connect, never ids or addresses", () => {
    const status = siteConnectionStatus(items);
    expect(status).toEqual({
      supported: true,
      ready: false,
      needed: [
        {
          key: "connect:Gmail:",
          action: "connect",
          connector: "Gmail",
          account: null,
          label: "Connect Gmail",
          tools: [gmail],
        },
        {
          key: "reconnect:Calendar:ada@example.com",
          action: "reconnect",
          connector: "Calendar",
          account: "ada@example.com",
          label: "Reconnect Calendar",
          tools: [calendar],
        },
      ],
    });
    expect(JSON.stringify(status)).not.toMatch(/capability-|connection-1|console\.example/u);
    expect(siteConnectionStatus([])).toEqual({ supported: true, ready: true, needed: [] });
    expect(siteConnectionStatus(null)).toEqual({ supported: false, ready: true, needed: [] });
  });

  test("closing hides those items until something new is missing or the App shows it again", () => {
    const storage = memoryStorage();
    const card = siteConnectCardDismissals("site-1", storage);
    expect(card.visible(items)).toEqual(items);
    card.dismiss([items[0]!.key]);
    expect(card.visible(items)).toEqual([items[1]!]);
    // Per App.
    expect(siteConnectCardDismissals("site-2", storage).visible(items)).toEqual(items);
    card.reset();
    expect(card.visible(items)).toEqual(items);
  });

  test("storage that fails just forgets", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const card = siteConnectCardDismissals("site-1", broken);
    card.dismiss(["x"]);
    card.reset();
    expect(card.visible(items)).toEqual(items);
    expect(siteConnectCardDismissals("site-1", null).visible(items)).toEqual(items);
  });
});

describe("site.connections through the bridge host", () => {
  test("a host with a card advertises it and answers status, connect and showCard", async () => {
    const connected: string[] = [];
    let shown = 0;
    const withCard: SiteBridgeToolHandlers = {
      ...tools,
      connections: {
        items: async () => items,
        connect: async (item) => {
          connected.push(item.key);
          return true;
        },
        show: () => {
          shown += 1;
          return true;
        },
      },
    };
    expect(siteBridgeReadyMessage(withCard)).toMatchObject({ connections: 1 });
    const { host, site } = connect({ tools: () => withCard });
    try {
      const status = await site.connections.status();
      expect(status.ready).toBe(false);
      expect(status.needed.map((need) => need.label)).toEqual([
        "Connect Gmail",
        "Reconnect Calendar",
      ]);
      expect(JSON.stringify(status)).not.toContain("capability-gmail");
      expect(await site.connections.connect(status.needed[1]!.key)).toEqual({ connected: true });
      // Without a key: the first need.
      expect(await site.connections.connect()).toEqual({ connected: true });
      // A key that isn't on the card: nothing happens.
      expect(await site.connections.connect("connect:Nothing:")).toEqual({ connected: false });
      expect(connected).toEqual(["reconnect:Calendar:ada@example.com", "connect:Gmail:"]);
      expect(await site.connections.showCard()).toEqual({ shown: true });
      expect(shown).toBe(1);
    } finally {
      site.close();
      host.close();
    }
  });

  test("a host without a card (or a viewer with nothing to connect here) answers unsupported", async () => {
    expect(siteBridgeReadyMessage(tools)).not.toHaveProperty("connections");
    const { host, site } = connect({ tools: () => tools });
    try {
      expect(await site.connections.status()).toEqual({
        supported: false,
        ready: true,
        needed: [],
      });
      expect(await site.connections.connect()).toEqual({ connected: false });
      expect(await site.connections.showCard()).toEqual({ shown: false });
    } finally {
      site.close();
      host.close();
    }
    const guest: SiteBridgeToolHandlers = {
      ...tools,
      connections: { items: async () => null, connect: async () => true },
    };
    const second = connect({ tools: () => guest });
    try {
      expect(await second.site.connections.status()).toMatchObject({ supported: false });
      expect(await second.site.connections.connect()).toEqual({ connected: false });
    } finally {
      second.site.close();
      second.host.close();
    }
  });

  test("the connections methods are bridge requests", () => {
    const base = {
      type: "opengeni.site.request",
      version: OPENGENI_SITE_BRIDGE_VERSION,
      requestId: "r",
    };
    expect(isOpenGeniSiteBridgeRequestMessage({ ...base, method: "connections.status" })).toBe(
      true,
    );
    expect(isOpenGeniSiteBridgeRequestMessage({ ...base, method: "connections.show" })).toBe(true);
    expect(
      isOpenGeniSiteBridgeRequestMessage({ ...base, method: "connections.connect", payload: {} }),
    ).toBe(true);
    expect(
      isOpenGeniSiteBridgeRequestMessage({
        ...base,
        method: "connections.connect",
        payload: { key: 3 },
      }),
    ).toBe(false);
    expect(OPENGENI_SITE_BRIDGE_READY).toBe("opengeni.site.ready");
  });
});

describe("the console's Site bridge offers the card", () => {
  const bridgeFor = (overrides: {
    connectForToolCall?: (prompt: SiteToolConnectPrompt) => Promise<boolean>;
    recoverToolCall?: (prompt: SiteToolFailurePrompt) => Promise<boolean>;
  }) => {
    const requests: Array<{ path: string; body: unknown }> = [];
    let readinessHeard = 0;
    const bridge = createSiteToolBridge({
      workspaceId: "workspace",
      artifactId: "site",
      siteVersionId: "version",
      requestedTools: [gmail, calendar],
      workspaceTools: {
        $catalog: async () => {
          throw new Error("unused");
        },
      },
      callTool: async () => {
        throw new Error("unused");
      },
      fetchResponse: async (path, init) => {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        return Response.json({ version: 1, items });
      },
      connectCard: { show: () => true },
      ...overrides,
    });
    bridge.subscribeReadiness?.(() => {
      readinessHeard += 1;
    });
    return { bridge, requests, heard: () => readinessHeard };
  };

  test("reads the pinned version's card and runs Connect and Reconnect with the frame's dialogs", async () => {
    const connects: SiteToolConnectPrompt[] = [];
    const recovers: SiteToolFailurePrompt[] = [];
    const { bridge, requests, heard } = bridgeFor({
      connectForToolCall: async (prompt) => {
        connects.push(prompt);
        return true;
      },
      recoverToolCall: async (prompt) => {
        recovers.push(prompt);
        return true;
      },
    });
    const signal = new AbortController().signal;
    const read = await bridge.connections!.items({ signal });
    expect(read).toEqual(items);
    expect(requests).toEqual([
      {
        path: "/v1/workspaces/workspace/tools/site-setup",
        body: { siteArtifactId: "site", siteVersionId: "version" },
      },
    ]);
    expect(await bridge.connections!.connect(items[0]!, { signal })).toBe(true);
    expect(connects[0]!.connect).toEqual({
      capabilityId: "capability-gmail",
      name: "Gmail",
      providerDomain: "",
    });
    expect(await bridge.connections!.connect(items[1]!, { signal })).toBe(true);
    expect(recovers[0]!.failure).toMatchObject({
      code: "site_tool_reconnect_required",
      reconnect: {
        connectionId: "connection-1",
        capabilityId: "capability-calendar",
        name: "Calendar",
        shared: true,
      },
    });
    // Each finished connect tells the App to ask again.
    expect(heard()).toBe(2);
    expect(await bridge.connections!.show!({ signal })).toBe(true);
  });

  test("a cancelled dialog changes nothing; no card without the frame's dialogs or a pinned Site", async () => {
    const { bridge, heard } = bridgeFor({ connectForToolCall: async () => false });
    const signal = new AbortController().signal;
    expect(await bridge.connections!.connect(items[0]!, { signal })).toBe(false);
    // No reconnect dialog here: nothing to run.
    expect(await bridge.connections!.connect(items[1]!, { signal })).toBe(false);
    expect(heard()).toBe(0);
    expect(bridgeFor({}).bridge.connections).toBeUndefined();
    const unpinned = createSiteToolBridge({
      workspaceId: "workspace",
      workspaceTools: {
        $catalog: async () => {
          throw new Error("unused");
        },
      },
      callTool: async () => {
        throw new Error("unused");
      },
      fetchResponse: async () => Response.json({}),
      connectForToolCall: async () => true,
    });
    expect(unpinned.connections).toBeUndefined();
  });
});
