import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Permission, SessionEvent } from "@opengeni/sdk";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const { SessionConversation } = await import("../src/components/session-conversation");

let previousObserver: PropertyDescriptor | undefined;
beforeEach(() => {
  previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});
afterEach(() => {
  if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
  else Reflect.deleteProperty(globalThis, "IntersectionObserver");
});

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`${message}\n${document.body.textContent}`);
    await flush(10);
  }
}

function event(sequence: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(0).toISOString(),
    turnId: "turn-1",
    clientEventId: null,
  } as unknown as SessionEvent;
}

const mail = CapabilityCatalogItem.parse({
  id: "mcp:mail",
  name: "Mail",
  kind: "mcp",
  source: "built_in",
  authKind: "oauth2",
  mcpUrl: "https://mcp.mail.example/mcp",
  providerDomain: "mail.example",
});

const history = [
  event(1, "user.message", { text: "check my email" }),
  event(2, "tool.auth_needed", {
    serverId: "opengeni",
    toolName: "capability_authorization_request",
    providerDomain: "mail.example",
    reason: "not_connected",
    capability: {
      id: "mcp:mail",
      name: "Mail",
      kind: "mcp",
      source: "built_in",
      action: "connect",
      rationale: "Read your inbox.",
      requiredVariables: [],
    },
  }),
  event(3, "turn.completed", { output: "Connect Mail to continue." }),
];

function conversationClient(
  permissions: Permission[],
  chatConnections?: boolean,
  events: SessionEvent[] = history,
) {
  const effectiveControl = {
    state: "running",
    directState: "running",
    override: null,
    primaryBlocker: null,
    settlement: null,
  };
  const base = fakeClient({});
  return fakeClient({
    getClientConfig: async () =>
      ({
        ...(await base.getClientConfig()),
        ...(chatConnections === undefined ? {} : { chatConnections }),
      }) as never,
    getSession: async () =>
      ({
        id: SESSION_ID,
        status: "idle",
        effectiveControl,
        unread: false,
        tools: [],
        lastSequence: 3,
      }) as never,
    getQueue: async () => ({ items: [], pendingInputs: [], effectiveControl }) as never,
    listHumanInputRequests: async () => [],
    listEvents: async () => events,
    streamEvents: async function* (_workspace, _session, options) {
      yield* events;
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    updateSessionAttention: async () => ({}) as never,
    ...({
      getAccessContext: async () => ({
        workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions }],
      }),
      listCapabilities: async () => ({ items: [mail] }),
      listConnections: async () => [],
      listOwnConnectionAccounts: async () => [],
      // The Connect catalog offers each reviewed integration for personal accounts.
      connectTransport: () => ({
        catalog: async () => [
          {
            id: "microsoft-outlook-mail",
            label: "Outlook Mail",
            family: "microsoft",
            readiness: "available",
            ownership: ["personal"],
            setup: ["oauth"],
          },
        ],
        get: async () => {
          throw new Error("no saved attempt");
        },
      }),
      listApiIntegrations: async () => ({ integrations: [] }),
      updateSessionToolPolicy: async () => ({}),
    } as object),
  });
}

const CONNECT: Permission[] = [
  "sessions:read",
  "sessions:control",
  "connections:read",
  "connections:write",
  "capabilities:manage",
];

const connectButton = () =>
  [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Connect Mail"),
  );

test("the stock conversation offers the shared connect card for an agent's request", async () => {
  const view = await renderComponent(
    <SessionConversation
      client={conversationClient(CONNECT)}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(() => connectButton() !== undefined, "The connect card did not render");
  } finally {
    await view.unmount();
  }
});

test("without connect authority the card says setup is unavailable here", async () => {
  const view = await renderComponent(
    <SessionConversation
      client={conversationClient(["sessions:read", "sessions:control"])}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(
      () => document.body.textContent?.includes("Mail can't be connected from here") === true,
      "The unavailable line did not render",
    );
    expect(connectButton()).toBeUndefined();
  } finally {
    await view.unmount();
  }
});

test("a host renderAuthNeeded and server-owned chat setup keep the host in charge", async () => {
  const overridden = await renderComponent(
    <SessionConversation
      client={conversationClient(CONNECT)}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
      timelineProps={{ renderAuthNeeded: () => <p>Host connect flow</p> }}
    />,
  );
  try {
    await waitFor(
      () => document.body.textContent?.includes("Host connect flow") === true,
      "The host renderer was not used",
    );
    await flush(100);
    expect(connectButton()).toBeUndefined();
  } finally {
    await overridden.unmount();
  }
  const owned = await renderComponent(
    <SessionConversation
      client={conversationClient(CONNECT, false)}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(
      () => document.body.textContent?.includes("check my email") === true,
      "The history did not render",
    );
    await flush(150);
    expect(connectButton()).toBeUndefined();
    expect(document.body.textContent?.includes("can't be connected from here")).toBe(false);
  } finally {
    await owned.unmount();
  }
});

test("an agent's reviewed-integration card offers a one-click Connect to people who can connect their own account", async () => {
  const outlookHistory = [
    event(1, "user.message", { text: "can you read my newest Hotmail emails?" }),
    event(2, "tool.auth_needed", {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: "graph.microsoft.com",
      reason: "not_connected",
      capability: {
        id: "api:integration:microsoft-outlook-mail",
        name: "Outlook Mail",
        kind: "api",
        source: "built_in",
        action: "connect",
        rationale: "Reading your newest emails needs your Hotmail inbox.",
        requiredVariables: [],
      },
    }),
    event(3, "turn.completed", { output: "Connect Outlook Mail to continue." }),
  ];
  const own: Permission[] = [
    "sessions:read",
    "sessions:control",
    "connections:read",
    "connections:write",
  ];
  const outlookButton = () =>
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Connect Outlook Mail"),
    );
  const view = await renderComponent(
    <SessionConversation
      client={conversationClient(own, undefined, outlookHistory)}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(
      () => outlookButton() !== undefined && !outlookButton()!.disabled,
      "The Outlook Connect card did not render",
    );
  } finally {
    await view.unmount();
  }
  const readOnly = await renderComponent(
    <SessionConversation
      client={conversationClient(["sessions:read", "sessions:control"], undefined, outlookHistory)}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(
      () => document.body.textContent?.includes("can't be connected from here") === true,
      "The unavailable line did not render",
    );
    expect(outlookButton()).toBeUndefined();
  } finally {
    await readOnly.unmount();
  }
});
