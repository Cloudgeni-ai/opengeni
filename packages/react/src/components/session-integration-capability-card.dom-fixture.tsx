// Run explicitly through session-integration-capability-card.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConnectAttempt, ConnectProvider, ConnectTransport } from "@opengeni/connect";
import { act, StrictMode } from "react";

GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
const { SessionIntegrationCapabilityCard } = await import("./session-integration-capability-card");

const DEFINITION = "microsoft-outlook-mail";
const APPROVAL_URL =
  "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=client";

let providers: ConnectProvider[] = [];
let installed: Array<Record<string, unknown>> = [];
let afterSignIn: Partial<ConnectAttempt> = {};
let current: ConnectAttempt | null = null;
let stillSigningIn = false;
/** What the next poll after sign-in reports instead of the default, or a failure. */
let nextPoll: Partial<ConnectAttempt> | Error | null = null;
let popupBlocked = false;
// A window showing the provider's site: like a browser, the card can't close it.
let foreignWindow = false;
const cancels: unknown[] = [];
const begins: Array<Record<string, unknown>> = [];
const advances: Array<Record<string, unknown>> = [];
const policies: Array<Record<string, unknown>> = [];
const continued: unknown[][] = [];
let continuation: Record<string, unknown> = { outcome: "queued", updateId: "update-1" };

function attempt(overrides: Partial<ConnectAttempt>): ConnectAttempt {
  const next: ConnectAttempt = {
    id: "attempt-1",
    workspaceId: "workspace",
    providerId: DEFINITION,
    ownership: "personal",
    revision: (current?.revision ?? 0) + 1,
    state: "requires_user_action",
    nextAction: { type: "none" },
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "integration",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    installationTarget: { instanceKey: "account-x", displayName: "Outlook Mail" },
    ...overrides,
  };
  current = next;
  return next;
}

const transport: ConnectTransport = {
  catalog: async () => providers,
  accounts: async () => [],
  pending: async () => [],
  begin: async (_workspaceId, input) => {
    begins.push(input as Record<string, unknown>);
    current = null;
    return attempt({
      nextAction: {
        type: "authorize",
        url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=s",
      },
    });
  },
  // The provider callback has landed by the first poll, unless the person is still signing in.
  get: async () => {
    if (nextPoll instanceof Error) throw nextPoll;
    if (nextPoll && current!.nextAction.type === "authorize") return attempt(nextPoll);
    return current!.nextAction.type === "authorize" && !stillSigningIn
      ? attempt(afterSignIn)
      : structuredClone(current!);
  },
  advance: async (_workspaceId, _attemptId, input) => {
    advances.push(input as Record<string, unknown>);
    const action = (input as { action: { type: string } }).action;
    if (action.type === "retry")
      return attempt({
        state: "preview",
        nextAction: {
          type: "preview",
          previewId: "preview",
          contentHash: "hash",
          operations: [{ id: "list-messages", label: "List messages", kind: "tool" }],
        } as ConnectAttempt["nextAction"],
      });
    installed = [
      {
        definitionId: DEFINITION,
        connected: true,
        ownership: "personal",
        serverId: "api-outlook-mail-1",
        instanceKey: "account-x",
      },
    ];
    return attempt({
      state: "complete",
      credentialsCommitted: true,
      integrationInstalled: true,
      nextAction: { type: "none" },
    });
  },
  cancel: async (_workspaceId, attemptId) => {
    cancels.push(attemptId);
    return attempt({ state: "cancelled", nextAction: { type: "none" } });
  },
  disconnect: async () => {},
};

const client = {
  connectTransport: () => transport,
  listApiIntegrations: async () => ({ integrations: installed }),
  getSession: async () => ({
    id: "session",
    tools: [{ kind: "mcp", id: "linear" }],
    toolPolicy: { mode: "explicit" },
    toolPolicyVersion: 4,
    firstPartyMcpTools: [],
    effectiveToolPolicy: { mandatoryIds: [], effectiveIds: ["linear"], idsTruncated: false },
  }),
  updateSessionToolPolicy: async (_w: string, _s: string, request: Record<string, unknown>) => {
    policies.push(request);
    return {};
  },
  continueAfterCapabilitySetup: async (...args: unknown[]) => {
    continued.push(args);
    return continuation;
  },
};

const popups: Array<{ closed: boolean; urls: string[]; focused: number }> = [];
window.open = (() => {
  if (popupBlocked) return null;
  const popup = {
    opener: {} as unknown,
    closed: false,
    focused: 0,
    urls: [] as string[],
    location: { replace: (url: string) => popup.urls.push(url) },
    close: () => {
      if (!foreignWindow) popup.closed = true;
    },
    focus: () => {
      popup.focused += 1;
    },
  };
  popups.push(popup);
  return popup;
}) as unknown as typeof window.open;

const provider = (
  id: string,
  readiness: ConnectProvider["readiness"],
  ownership: ConnectProvider["ownership"] = ["workspace", "personal"],
): ConnectProvider =>
  ({
    id,
    label: id,
    family: "microsoft",
    readiness,
    ownership,
    setup: ["oauth"],
  }) as ConnectProvider;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  providers = [provider(DEFINITION, "available"), provider("mcp-install", "available")];
  installed = [];
  afterSignIn = { state: "connected_but_incomplete", nextAction: { type: "none" } };
  current = null;
  begins.length = 0;
  advances.length = 0;
  policies.length = 0;
  continued.length = 0;
  continuation = { outcome: "queued", updateId: "update-1" };
  popups.length = 0;
  stillSigningIn = false;
  nextPoll = null;
  popupBlocked = false;
  foreignWindow = false;
  cancels.length = 0;
  sessionStorage.clear();
});

async function mount({ strict = false } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const configured = mock(async () => {});
  const card = (
    <SessionIntegrationCapabilityCard
      client={client as never}
      workspaceId="workspace"
      sessionId="session"
      capabilityId={`api:integration:${DEFINITION}`}
      name="Outlook Mail"
      rationale="Reading your newest emails needs your Hotmail inbox."
      returnUrl="https://app.example.test/chat"
      onConfigured={configured}
    />
  );
  await act(async () => {
    root.render(strict ? <StrictMode>{card}</StrictMode> : card);
  });
  return { host, root, configured };
}

async function until(check: () => boolean, label: string) {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const connected = (host: HTMLElement) =>
  !button(host, "Connect Outlook Mail") &&
  (host.textContent?.includes("Your account is connected") ?? false);

function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
}

test("one click signs in, installs the reviewed tools, adds them to this chat and continues", async () => {
  const { host, root, configured } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  expect(host.textContent).toContain("Reading your newest emails needs your Hotmail inbox.");
  // Before sign-in nothing steers a personal Hotmail account toward
  // organization approval; the approval link appears only if Microsoft asks.
  expect(host.textContent).toContain("Only your chats use it.");
  expect(host.textContent).not.toContain("administrator");
  expect(host.textContent).not.toContain("organization");
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(() => connected(host) && continued.length > 0, "complete");
  expect(begins).toHaveLength(1);
  expect(begins[0]).toMatchObject({
    providerId: DEFINITION,
    ownership: "personal",
    returnUrl: "https://app.example.test/chat",
  });
  // A new account gets a fresh instance the server names after the attempt.
  expect(begins[0]!.installationTarget).toBeUndefined();
  expect(popups).toHaveLength(1);
  expect(popups[0]!.urls[0]).toStartWith("https://login.microsoftonline.com/");
  expect(advances.map((entry) => (entry as { action: { type: string } }).action.type)).toEqual([
    "retry",
    "install",
  ]);
  expect(advances[1]).toMatchObject({ action: { operationIds: ["list-messages"] } });
  expect(policies).toEqual([
    {
      mode: "explicit",
      tools: [
        { kind: "mcp", id: "linear" },
        { kind: "mcp", id: "api-outlook-mail-1", optional: true },
      ],
      firstPartyMcpTools: [],
      expectedVersion: 4,
    },
  ]);
  expect(configured).toHaveBeenCalledTimes(1);
  // The agent continues the request that asked for this connection.
  expect(continued).toEqual([
    ["workspace", "session", { capabilityId: `api:integration:${DEFINITION}` }],
  ]);
  await act(async () => root.unmount());
  host.remove();
});

test("under StrictMode the replayed mount still signs in", async () => {
  const { host, root } = await mount({ strict: true });
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(() => connected(host), "complete");
  expect(host.textContent).not.toContain("disposed");
  expect(begins).toHaveLength(1);
  await act(async () => root.unmount());
  host.remove();
});

async function waitingForSignIn() {
  stillSigningIn = true;
  const mounted = await mount();
  const { host } = mounted;
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(() => host.textContent?.includes("in the window that opened") ?? false, "waiting");
  return mounted;
}

test("while the sign-in window is open the card offers one way out, and it ends the attempt", async () => {
  const { host, root } = await waitingForSignIn();
  // One status line, a way to get the window back and one Cancel: no second
  // sign-in, status check or setup cancel.
  for (const label of ["Sign in", "Check status", "Cancel setup", "Stop waiting"])
    expect(button(host, label)).toBeUndefined();
  // Focus follows the step to its status line, not a button a second Enter
  // would press.
  expect(document.activeElement?.getAttribute("role")).toBe("status");
  expect(document.activeElement?.textContent).toContain("in the window that opened");
  await act(async () => {
    button(host, "Cancel")!.click();
  });
  await until(() => !!button(host, "Try again"), "try again");
  // The attempt itself is cancelled and its window closed, so finishing there can't connect.
  expect(cancels).toEqual(["attempt-1"]);
  expect(popups[0]!.closed).toBe(true);
  expect(host.textContent).toContain("Setup cancelled");
  expect(host.textContent).not.toContain("Sign-in window closed");
  // The window did close, so nothing asks the person to close it.
  expect(host.textContent).not.toContain("close the sign-in window");
  expect(document.activeElement).toBe(button(host, "Try again")!);
  await act(async () => root.unmount());
  host.remove();
});

test("a sign-in window the card can't close is left for the person to close, and the card says so", async () => {
  foreignWindow = true;
  const { host, root } = await waitingForSignIn();
  await act(async () => {
    button(host, "Cancel")!.click();
  });
  await until(() => !!button(host, "Try again"), "try again");
  expect(cancels).toEqual(["attempt-1"]);
  expect(popups[0]!.closed).toBe(false);
  expect(host.textContent).toContain("Setup cancelled");
  expect(host.textContent).toContain("You can close the sign-in window.");
  // Once the person moves on, the reminder goes with the step it was for.
  foreignWindow = false;
  stillSigningIn = false;
  await act(async () => {
    button(host, "Try again")!.click();
  });
  await until(() => connected(host), "complete");
  expect(host.textContent).not.toContain("close the sign-in window");
  await act(async () => root.unmount());
  host.remove();
});

test("a lost sign-in window can be reopened, and a blocked window says so", async () => {
  const { host, root } = await waitingForSignIn();
  // A window still open behind others comes forward: no second window.
  await act(async () => {
    button(host, "Reopen window")!.click();
  });
  expect(popups).toHaveLength(1);
  expect(popups[0]!.focused).toBe(1);
  // One the person closed opens again, for the same attempt.
  popups[0]!.closed = true;
  await act(async () => {
    button(host, "Reopen window")!.click();
  });
  await until(() => popups.length === 2, "second window");
  expect(host.textContent).toContain("in the window that opened");
  expect(cancels).toEqual([]);
  expect(begins).toHaveLength(1);
  popups[1]!.closed = true;
  popupBlocked = true;
  await act(async () => {
    button(host, "Reopen window")!.click();
  });
  await until(() => host.textContent?.includes("blocked the sign-in window") ?? false, "blocked");
  expect(host.textContent).not.toContain("Refresh its status");
  expect(button(host, "Try signing in again")).toBeDefined();
  // In a chat card nothing asks the person to check status after a sign-in window.
  expect(button(host, "Check status")).toBeUndefined();
  await act(async () => root.unmount());
  host.remove();
});

test("a sign-in that fails after the first attempt still says so in plain words", async () => {
  const { host, root } = await waitingForSignIn();
  nextPoll = new Error("upstream 502 with internal detail");
  popups[0]!.closed = true;
  await act(async () => {
    button(host, "Reopen window")!.click();
  });
  await until(() => host.textContent?.includes("Sign-in couldn't continue") ?? false, "failed");
  expect(host.textContent).not.toContain("internal detail");
  expect(host.textContent).not.toContain("Refresh its status");
  expect(button(host, "Try signing in again")).toBeDefined();
  // Cancelling then leaves only what is true now: the error was for sign-in.
  await act(async () => {
    button(host, "Cancel setup")!.click();
  });
  await until(() => !!button(host, "Try again"), "try again");
  expect(host.textContent).toContain("Setup cancelled");
  expect(host.textContent).not.toContain("Sign-in couldn't continue");
  await act(async () => root.unmount());
  host.remove();
});

test("a pop-up blocked on the first Connect says so and keeps keyboard focus on the card", async () => {
  popupBlocked = true;
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    const connect = button(host, "Connect Outlook Mail")!;
    connect.focus();
    connect.click();
  });
  await until(() => host.textContent?.includes("blocked the sign-in window") ?? false, "blocked");
  expect(document.activeElement).toBe(button(host, "Try again")!);
  await act(async () => root.unmount());
  host.remove();
});

test("when the provider moves setup elsewhere the card shows that step right away", async () => {
  nextPoll = {
    state: "requires_user_action",
    nextAction: {
      type: "wait",
      pollAfterMs: 5000,
      userCode: "ABCD-1234",
      verificationUrl: "https://microsoft.com/devicelogin",
    },
  };
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(() => host.textContent?.includes("ABCD-1234") ?? false, "code");
  expect(host.textContent).not.toContain("in the window that opened");
  expect(button(host, "Check status")).toBeDefined();
  await act(async () => root.unmount());
  host.remove();
});

test("an organization that needs admin approval gets the approval link and can try again", async () => {
  afterSignIn = {
    state: "failed",
    nextAction: { type: "none" },
    error: {
      code: "admin_consent_required",
      message: `Your organization requires a Microsoft 365 administrator to approve this app first. Send your administrator this approval link: ${APPROVAL_URL} After they approve, connect again.`,
      retryable: true,
    },
  };
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(() => !!button(host, "Try again"), "Try again");
  const link = host.querySelector<HTMLAnchorElement>(`a[href="${APPROVAL_URL}"]`);
  expect(link?.textContent).toBeTruthy();
  expect(host.textContent).toContain("Copy");
  afterSignIn = { state: "connected_but_incomplete", nextAction: { type: "none" } };
  await act(async () => {
    button(host, "Try again")!.click();
  });
  await until(() => connected(host), "complete");
  expect(begins).toHaveLength(2);
  await act(async () => root.unmount());
  host.remove();
});

test("connecting your own account needs no integration management", async () => {
  providers = [provider(DEFINITION, "available"), provider("mcp-install", "unsupported")];
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => root.unmount());
  host.remove();
});

test("never connects a workspace account: where a personal one is not possible it says so", async () => {
  providers = [
    provider(DEFINITION, "available", ["workspace"]),
    provider("mcp-install", "available"),
  ];
  const { host, root } = await mount();
  await until(
    () => host.textContent?.includes("can only be connected to your own account") ?? false,
    "personal-only note",
  );
  expect(button(host, "Connect Outlook Mail")).toBeUndefined();
  expect(begins).toHaveLength(0);
  await act(async () => root.unmount());
  host.remove();
});

test("an expired or revoked account of yours is reconnected, not duplicated", async () => {
  installed = [
    {
      definitionId: DEFINITION,
      connected: false,
      ownership: "personal",
      connectionId: "connection-old",
      serverId: "api-outlook-mail-old",
      instanceKey: "account-old",
      displayName: "Outlook Mail",
      instanceVersion: 3,
    },
  ];
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(() => begins.length > 0, "begin");
  expect(begins[0]).toMatchObject({
    ownership: "personal",
    reconnectAccountId: "connection-old",
    installationTarget: {
      instanceKey: "account-old",
      displayName: "Outlook Mail",
      expectedInstanceVersion: 3,
    },
  });
  await act(async () => root.unmount());
  host.remove();
});

test("with several accounts that lost their sign-in, the most recently used one is reconnected", async () => {
  installed = [
    {
      definitionId: DEFINITION,
      connected: false,
      ownership: "personal",
      connectionId: "connection-older",
      connectionLastUsedAt: "2026-09-01T10:00:00.000Z",
      serverId: "api-outlook-mail-older",
      instanceKey: "account-a",
      displayName: "Outlook Mail",
      instanceVersion: 2,
    },
    {
      definitionId: DEFINITION,
      connected: false,
      ownership: "personal",
      connectionId: "connection-recent",
      connectionLastUsedAt: "2026-10-20T10:00:00.000Z",
      serverId: "api-outlook-mail-recent",
      instanceKey: "account-b",
      displayName: "Outlook Mail (work)",
      instanceVersion: 5,
    },
    {
      definitionId: DEFINITION,
      connected: false,
      ownership: "personal",
      connectionId: "connection-never",
      connectionLastUsedAt: null,
      serverId: "api-outlook-mail-never",
      instanceKey: "account-0",
      displayName: "Outlook Mail (old)",
      instanceVersion: 1,
    },
  ];
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(() => begins.length > 0, "begin");
  expect(begins[0]).toMatchObject({
    ownership: "personal",
    reconnectAccountId: "connection-recent",
    installationTarget: {
      instanceKey: "account-b",
      displayName: "Outlook Mail (work)",
      expectedInstanceVersion: 5,
    },
  });
  await act(async () => root.unmount());
  host.remove();
});

test("a workspace account is not the viewer's own, so the card still offers Connect", async () => {
  installed = [
    {
      definitionId: DEFINITION,
      connected: true,
      ownership: "workspace",
      serverId: "api-outlook-mail-shared",
    },
  ];
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => root.unmount());
  host.remove();
});

test("a teammate connecting in a shared chat learns the agent waits for the person who asked", async () => {
  continuation = { outcome: "not_needed", reason: "not_requester" };
  const { host, root } = await mount();
  await until(
    () => !!button(host, "Connect Outlook Mail") && !button(host, "Connect Outlook Mail")!.disabled,
    "Connect",
  );
  await act(async () => {
    button(host, "Connect Outlook Mail")!.click();
  });
  await until(
    () => connected(host) && (host.textContent?.includes("person who asked") ?? false),
    "not-requester note",
  );
  await act(async () => root.unmount());
  host.remove();
});

test("an account already connected shows as connected", async () => {
  installed = [
    {
      definitionId: DEFINITION,
      connected: true,
      ownership: "personal",
      serverId: "api-outlook-mail-1",
    },
  ];
  const { host, root } = await mount();
  await until(() => connected(host), "connected");
  expect(begins).toHaveLength(0);
  expect(continued).toHaveLength(0);
  await act(async () => root.unmount());
  host.remove();
});
