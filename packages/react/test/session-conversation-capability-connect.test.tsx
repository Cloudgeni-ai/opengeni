import { afterEach, beforeEach, expect, test } from "bun:test";
import { OpenGeniApiError, type Permission, type SessionEvent } from "@opengeni/sdk";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

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

const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);

/** The card finished: Mail is connected and in this chat. */
const finished = () =>
  document.body.textContent?.includes("Available in this conversation") === true;

/** The person's own Mail login (an "Only me" account), added in another workspace. */
function ownMailLogin(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-own-mail",
    accountId: "account-1",
    workspaceId: "workspace-personal",
    subjectId: "user:me",
    authorityId: "authority-own-mail",
    providerDomain: "mail.example",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { mcpUrl: "https://mcp.mail.example/mcp", email: "me@mail.example" },
    createdBySubjectId: "user:me",
    updatedBySubjectId: "user:me",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    turnedOnHere: false,
    turnedOnHereGrantId: null,
    ...overrides,
  };
}

/** Mail as a service that connects each person's own account by default. */
const personalMail = CapabilityCatalogItem.parse({
  ...mail,
  metadata: { defaultConnectionOwnership: "personal" },
});

const SUBJECT_BINDING = {
  providerDomain: "mail.example",
  kind: "oauth2",
  subjectScope: "subject",
} as const;

/**
 * A conversation whose Mail connector is not set up in this workspace yet and
 * whose viewer has one own login for it. Records each step the card takes:
 * turning the capability on, turning the login on here and starting a sign-in.
 */
async function notSetUpHere(
  login: ReturnType<typeof ownMailLogin>,
  options: { catalogItem?: CapabilityCatalogItem; refuseEnable?: OpenGeniApiError } = {},
) {
  const catalogItem = options.catalogItem ?? personalMail;
  const steps: string[] = [];
  const enabled: unknown[] = [];
  const issued: unknown[] = [];
  let installed = false;
  const client = conversationClient(CONNECT);
  const session = await client.getSession(WORKSPACE_ID, SESSION_ID);
  const transport = (client as unknown as { connectTransport: () => object }).connectTransport();
  Object.assign(client, {
    getSession: async () => ({ ...session, toolPolicy: { mode: "explicit", selectedIds: [] } }),
    listCapabilities: async () => ({
      items: [
        installed
          ? CapabilityCatalogItem.parse({
              ...catalogItem,
              enabled: true,
              connectionRef: SUBJECT_BINDING,
            })
          : catalogItem,
      ],
    }),
    listOwnConnectionAccounts: async () => [{ ...login }],
    enableCapability: async (workspaceId: string, capabilityId: string, body: unknown) => {
      steps.push("enable");
      enabled.push({ workspaceId, capabilityId, body });
      if (options.refuseEnable) throw options.refuseEnable;
      installed = true;
      return {};
    },
    issueUserResourceGrant: async (workspaceId: string, authorityId: string, body: unknown) => {
      steps.push("turn on here");
      issued.push({ workspaceId, authorityId, body });
      login.turnedOnHere = true;
      login.turnedOnHereGrantId = "grant-1" as never;
      return { grant: { grantId: "grant-1" } };
    },
    connectTransport: () => ({
      ...transport,
      begin: async () => {
        steps.push("sign in");
        throw new Error("no sign-in expected");
      },
    }),
    continueAfterCapabilitySetup: async () => ({}),
  });
  return { client, steps, enabled, issued };
}

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

test("your login added in another workspace is offered here with one standing choice", async () => {
  const installedMail = CapabilityCatalogItem.parse({
    ...mail,
    enabled: true,
    connectionRef: { providerDomain: "mail.example", kind: "oauth2", subjectScope: "subject" },
  });
  const login = ownMailLogin();
  const issued: unknown[] = [];
  const client = conversationClient(CONNECT);
  const session = await client.getSession(WORKSPACE_ID, SESSION_ID);
  Object.assign(client, {
    getSession: async () => ({ ...session, toolPolicy: { mode: "explicit", selectedIds: [] } }),
    listCapabilities: async () => ({ items: [installedMail] }),
    listOwnConnectionAccounts: async () => [login],
    issueUserResourceGrant: async (workspaceId: string, authorityId: string, body: unknown) => {
      issued.push({ workspaceId, authorityId, body });
      return { grant: { grantId: "grant-1" } };
    },
  });
  const useItHere = () =>
    [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Use it here",
    );
  const view = await renderComponent(
    <SessionConversation
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(
      () =>
        document.body.textContent?.includes("Use it for your messages here too?") === true &&
        useItHere() !== undefined,
      "The card did not offer your login from another workspace",
    );
    // No sign-in is involved, so the card doesn't say to review access first.
    expect(document.body.textContent).toContain("You added me@mail.example in another workspace.");
    expect(document.body.textContent).not.toContain("Review access before signing in");
    expect(connectButton()).toBeUndefined();
    await actRun(() => useItHere()!.click());
    await waitFor(() => issued.length === 1, "Use it here did not turn the login on");
    expect(issued[0]).toEqual({
      workspaceId: WORKSPACE_ID,
      authorityId: "authority-own-mail",
      body: {
        scope: "user",
        resourceKind: "connection",
        mode: "always",
        context: "workspace_shared",
        workspaceSharedAcknowledged: true,
      },
    });
  } finally {
    await view.unmount();
  }
});

async function renderConversation(client: ReturnType<typeof conversationClient>) {
  return await renderComponent(
    <SessionConversation
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
}

const forbidden = () =>
  new OpenGeniApiError(
    403,
    JSON.stringify({ error: { status: 403, code: "forbidden", message: "forbidden" } }),
    { mutation: true },
  );

test("your login already on here is used for a connector not set up here, without a sign-in", async () => {
  const login = ownMailLogin({ turnedOnHere: true, turnedOnHereGrantId: "grant-standing" });
  const { client, steps, enabled, issued } = await notSetUpHere(login);
  const view = await renderConversation(client);
  try {
    await waitFor(
      () =>
        document.body.textContent?.includes("Use it for your messages here too?") === true &&
        buttonNamed("Use it here") !== undefined,
      "The card did not offer your login that is already on here",
    );
    expect(document.body.textContent).toContain("You added me@mail.example in another workspace.");
    expect(connectButton()).toBeUndefined();
    await actRun(() => buttonNamed("Use it here")!.click());
    await waitFor(finished, "Use it here did not finish");
    // Set up for each person's own account; the login is already on here.
    expect(enabled).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        capabilityId: "mcp:mail",
        body: { connectionRef: SUBJECT_BINDING },
      },
    ]);
    expect(issued).toEqual([]);
    expect(steps).toEqual(["enable"]);
  } finally {
    await view.unmount();
  }
});

test("a shareable connector asks who can use it first, then offers your login that is on here", async () => {
  // Mail shares one workspace connection by default and the workspace has
  // other people: who can use a new connection comes first.
  const login = ownMailLogin({ turnedOnHere: true, turnedOnHereGrantId: "grant-standing" });
  const { client, steps, enabled, issued } = await notSetUpHere(login, { catalogItem: mail });
  const view = await renderConversation(client);
  const radio = (label: string) =>
    [...document.querySelectorAll("label")]
      .find((node) => node.textContent?.trim() === label)
      ?.querySelector("input") as HTMLInputElement | undefined;
  try {
    await waitFor(() => connectButton() !== undefined, "The Connect card did not render");
    expect(buttonNamed("Use it here")).toBeUndefined();
    await actRun(() => connectButton()!.click());
    await waitFor(
      () => document.body.textContent?.includes("Who can use this connection?") === true,
      "The card did not ask who can use the connection",
    );
    expect(buttonNamed("Use it here")).toBeUndefined();
    expect(buttonNamed("Continue to Mail")).toBeDefined();
    await actRun(() => radio("Only me")!.click());
    await waitFor(
      () => buttonNamed("Use it here") !== undefined,
      "Choosing Only me did not offer your login",
    );
    expect(document.body.textContent).toContain("You added me@mail.example in another workspace.");
    // The choice stays visible, so the person can go back to a shared connection.
    await actRun(() => radio("Everyone in this workspace")!.click());
    await waitFor(
      () =>
        buttonNamed("Use it here") === undefined && buttonNamed("Continue to Mail") !== undefined,
      "Choosing everyone did not go back to a new shared connection",
    );
    await actRun(() => radio("Only me")!.click());
    await waitFor(() => buttonNamed("Use it here") !== undefined, "No offer after Only me again");
    await actRun(() => buttonNamed("Use it here")!.click());
    await waitFor(finished, "Use it here did not finish");
    expect(enabled).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        capabilityId: "mcp:mail",
        body: { connectionRef: SUBJECT_BINDING },
      },
    ]);
    expect(issued).toEqual([]);
    expect(steps).toEqual(["enable"]);
  } finally {
    await view.unmount();
  }
});

test("a login connected in this workspace is offered again when its connector isn't on here", async () => {
  const login = ownMailLogin({ workspaceId: WORKSPACE_ID, turnedOnHere: true });
  const { client, steps } = await notSetUpHere(login);
  const view = await renderConversation(client);
  try {
    await waitFor(
      () => buttonNamed("Use it here") !== undefined,
      "The card did not offer the login connected here",
    );
    expect(document.body.textContent).toContain(
      "You already connected me@mail.example. Use it for your messages here?",
    );
    expect(document.body.textContent).not.toContain("in another workspace");
    await actRun(() => buttonNamed("Use it here")!.click());
    await waitFor(finished, "Use it here did not finish");
    expect(steps).toEqual(["enable"]);
  } finally {
    await view.unmount();
  }
});

test("a login off here is set up and turned on for a connector not set up here, as before", async () => {
  const login = ownMailLogin();
  const { client, steps, enabled, issued } = await notSetUpHere(login);
  const view = await renderConversation(client);
  try {
    await waitFor(
      () => buttonNamed("Use it here") !== undefined,
      "The card did not offer your login that is off here",
    );
    await actRun(() => buttonNamed("Use it here")!.click());
    await waitFor(finished, "Use it here did not finish");
    // Turned on for each person's own account first, so a refusal leaves the
    // login as it was; then the login is turned on here.
    expect(steps).toEqual(["enable", "turn on here"]);
    expect(enabled).toHaveLength(1);
    expect(issued).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        authorityId: "authority-own-mail",
        body: {
          scope: "user",
          resourceKind: "connection",
          mode: "always",
          context: "workspace_shared",
          workspaceSharedAcknowledged: true,
        },
      },
    ]);
  } finally {
    await view.unmount();
  }
});

test("when only an admin can turn the connector on, using your login says so and changes nothing", async () => {
  const login = ownMailLogin({ turnedOnHere: true, turnedOnHereGrantId: "grant-standing" });
  const { client, steps, issued } = await notSetUpHere(login, { refuseEnable: forbidden() });
  const view = await renderConversation(client);
  try {
    await waitFor(() => buttonNamed("Use it here") !== undefined, "No offer to use your login");
    await actRun(() => buttonNamed("Use it here")!.click());
    await waitFor(
      () => document.body.textContent?.includes("Only an admin can turn on Mail.") === true,
      "The card did not say an admin has to turn it on",
    );
    expect(steps).toEqual(["enable"]);
    expect(issued).toEqual([]);
  } finally {
    await view.unmount();
  }
});
