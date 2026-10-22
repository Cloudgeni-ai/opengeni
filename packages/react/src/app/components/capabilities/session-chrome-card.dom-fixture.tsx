// Run explicitly through session-chrome-card.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import type { AuthNeededItem } from "../../../timeline";

const STORE_URL =
  "https://chromewebstore.google.com/detail/opengeni-browser/phpmmcbeelfkcinjfbbggegjdcdmnnch";

type Machine = {
  sandboxId: string;
  enrollmentId: string | null;
  name: string;
  kind: string;
  state: string;
  active: boolean;
  isSessionGroup: boolean;
  os: string;
  hasDisplay: boolean;
  allowScreenControl: boolean;
  desktopUnavailableReason: string | null;
  runtime: null;
  scope: "user" | "workspace" | "organization";
};
const machine = (sandboxId: string, name: string, overrides: Partial<Machine> = {}): Machine => ({
  sandboxId,
  enrollmentId: `enrollment-${sandboxId}`,
  name,
  kind: "selfhosted",
  state: "online",
  active: false,
  isSessionGroup: false,
  os: "macos",
  hasDisplay: true,
  allowScreenControl: false,
  desktopUnavailableReason: null,
  runtime: null,
  scope: "user",
  ...overrides,
});
const sessionBox = machine("home", "Cloud sandbox", {
  enrollmentId: null,
  isSessionGroup: true,
  kind: "modal",
  active: true,
});

const fleet = {
  machines: [sessionBox] as Machine[],
  canRead: true,
  canManage: true,
  canAttach: true,
  attaching: false,
  loading: false,
  error: null as unknown,
  mutationError: null as unknown,
  attach: mock(async (_sandboxId: string) => true),
  refresh: mock(async () => {}),
};
mock.module("../../lib/use-workspace-machines", () => ({ useWorkspaceMachines: () => fleet }));
mock.module("../../lib/app-api", () => ({
  useAppApi: () => ({ apiBaseUrl: "https://app.example.test" }),
}));
mock.module("../desktop/this-computer", () => ({ useDesktopThisComputer: () => null }));
mock.module("../../../clipboard", () => ({ copyTextToClipboard: mock(async () => true) }));

const mintEnrollToken = mock(
  async (_workspaceId: string, input: { scope?: string; allowScreenControl?: boolean }) => ({
    token: "oget_token.sig",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    expiresInSeconds: 3600,
    scope: input.scope ?? "workspace",
    allowScreenControl: input.allowScreenControl ?? false,
  }),
);
let browsers: { devices: unknown[]; bridges: unknown[]; revision: number } = {
  devices: [],
  bridges: [],
  revision: 1,
};
const listAttachedBrowsers = mock(async () => browsers);
const sendMessage = mock(async (_workspaceId: string, _sessionId: string, _input: unknown) => ({
  id: "accepted",
  type: "user.message",
  payload: { routing: "accepted_for_execution" },
}));
const everyone = ["enrollments:read", "enrollments:manage", "sessions:control"];
const context = {
  client: { mintEnrollToken, listAttachedBrowsers, sendMessage },
  accessContext: {
    subjectId: "member",
    workspaceGrants: [{ workspaceId: "workspace", permissions: everyone }],
  },
  workspaces: [{ id: "workspace", kind: "shared" }],
  workspaceCapabilityCatalog: [],
};
mock.module("../../app-context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
GlobalRegistrator.register();
const opened: unknown[][] = [];
window.open = ((...args: unknown[]) => {
  opened.push(args);
  return null;
}) as typeof window.open;
const { createRoot } = await import("react-dom/client");
const { SessionCapabilityCard } = await import("./session-capability-card");
const { OpenGeniApiError } = await import("@opengeni/sdk");

const chromeNotice = {
  id: "chrome-notice",
  kind: "auth-needed",
  serverId: "opengeni",
  providerDomain: "opengeni.ai",
  reason: "missing_connection",
  toolName: "browser_open",
  purpose: "chrome",
  capability: {
    id: "api:connected-machine",
    name: "Connected Machine",
    kind: "api",
    action: "connect",
    rationale: "Connect your Chrome so the agent can use it.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;

const chromeProfile = (name: string, enrollmentId = "enrollment-mac") => ({
  id: `device-${name}`,
  enrollmentId,
  name,
  profileLabel: name,
  browserName: "Chrome",
  state: "connected",
  capabilities: { debuggerAttachment: true },
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT =
    true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  opened.length = 0;
  sendMessage.mockClear();
  mintEnrollToken.mockClear();
  listAttachedBrowsers.mockClear();
  browsers = { devices: [], bridges: [], revision: 1 };
  fleet.machines = [sessionBox];
  fleet.canRead = true;
  fleet.canManage = true;
  fleet.error = null;
  context.accessContext.workspaceGrants = [{ workspaceId: "workspace", permissions: everyone }];
});

type SendContext = {
  blocked: string | null;
  awaitingHuman: boolean;
  extras: Record<string, unknown>;
};
async function render(item: AuthNeededItem = chromeNotice, sendContext?: () => SendContext) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const paint = async () =>
    act(async () => {
      root.render(
        <SessionCapabilityCard
          item={item}
          workspaceId="workspace"
          sessionId="session"
          sendContext={sendContext as never}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  await paint();
  const dialog = () => document.querySelector<HTMLElement>("[data-connect-machine-dialog]");
  return {
    text: () => container.textContent ?? "",
    note: () => container.querySelector(".og-session-capability-note")?.textContent ?? "",
    button: (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === name,
      ) ?? null,
    dialog,
    /** Render again after the mocked machines or browsers changed. */
    rerender: async () => {
      await paint();
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    },
    command: () => dialog()?.querySelector("[data-connect-command]")?.textContent ?? "",
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(element: HTMLElement | null) {
  if (!element) throw new Error("Missing element");
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Chrome setup card", () => {
  test("without a computer, its one action connects a computer", async () => {
    const view = await render();
    expect(view.text()).toContain("Chrome");
    expect(view.text()).toContain(
      "Connect your Chrome so the agent can use it. First connect a computer, then add the extension.",
    );
    // It is about Chrome, not about where this chat runs.
    expect(view.text()).not.toContain("Choose where this chat runs");
    expect(view.text()).not.toContain("Use in this chat");
    expect(view.button("Add to Chrome")).toBeNull();
    await click(view.button("Connect a computer"));
    expect(view.dialog()).not.toBeNull();
    // The shared connect dialog, opened on its first step.
    expect(view.dialog()?.textContent).toContain("Open app and connect");
    await view.close();
  });

  test("with a computer online, its one action adds the extension and then waits for Chrome", async () => {
    fleet.machines = [sessionBox, machine("mac", "Ada's MacBook")];
    const view = await render();
    expect(view.text()).toContain("Add the extension to Chrome on Ada's MacBook.");
    expect(view.button("Connect a computer")).toBeNull();
    await click(view.button("Add to Chrome"));
    expect(opened).toEqual([[STORE_URL, "_blank", "noopener,noreferrer"]]);
    expect(view.note()).toBe("Waiting for Chrome to connect…");
    await view.close();
  });

  test("an offline computer or one without a screen still needs a computer connected", async () => {
    fleet.machines = [
      sessionBox,
      machine("mac", "Ada's MacBook", { state: "offline" }),
      machine("box", "Build server", { os: "linux", hasDisplay: false }),
    ];
    const view = await render();
    expect(view.button("Connect a computer")).not.toBeNull();
    expect(view.button("Add to Chrome")).toBeNull();
    await view.close();
  });

  test("once Chrome is connected, Continue tells the agent to go on", async () => {
    fleet.machines = [sessionBox, machine("mac", "Ada's MacBook")];
    const view = await render(chromeNotice, () => ({
      blocked: null,
      awaitingHuman: false,
      extras: { model: "codex/test" },
    }));
    expect(view.button("Continue")).toBeNull();
    browsers = { devices: [chromeProfile("Work")], bridges: [], revision: 2 };
    await click(view.button("Add to Chrome"));
    expect(view.text()).toContain("Chrome is connected (Work).");
    await click(view.button("Continue"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [workspaceId, sessionId, input] = sendMessage.mock.calls[0]!;
    expect([workspaceId, sessionId]).toEqual(["workspace", "session"]);
    expect(input).toMatchObject({ text: "Chrome is connected. Continue.", model: "codex/test" });
    expect(view.text()).toContain("The agent continues.");
    expect(view.button("Continue")).toBeNull();
    await view.close();
  });

  test("Continue waits for an open question and follows the composer's block", async () => {
    fleet.machines = [sessionBox, machine("mac", "Ada's MacBook")];
    const waiting = await render(chromeNotice, () => ({
      blocked: null,
      awaitingHuman: true,
      extras: {},
    }));
    browsers = { devices: [chromeProfile("Work")], bridges: [], revision: 2 };
    await click(waiting.button("Add to Chrome"));
    expect(waiting.text()).toContain("Chrome is connected (Work).");
    expect(waiting.button("Continue")).toBeNull();
    await waiting.close();

    browsers = { devices: [], bridges: [], revision: 1 };
    const blocked = await render(chromeNotice, () => ({
      blocked: "Choose a model first.",
      awaitingHuman: false,
      extras: {},
    }));
    browsers = { devices: [chromeProfile("Work")], bridges: [], revision: 2 };
    await click(blocked.button("Add to Chrome"));
    await click(blocked.button("Continue"));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(blocked.text()).toContain("Choose a model first.");
    await blocked.close();
  });

  test("a Chrome profile the agent cannot drive does not count as connected", async () => {
    fleet.machines = [sessionBox, machine("mac", "Ada's MacBook")];
    browsers = {
      devices: [{ ...chromeProfile("Work"), capabilities: { debuggerAttachment: false } }],
      bridges: [],
      revision: 2,
    };
    const view = await render();
    expect(view.text()).not.toContain("Chrome is connected");
    expect(view.button("Add to Chrome")).not.toBeNull();
    await view.close();
  });

  test("when a computer comes online with Chrome already linked, Continue appears without Add to Chrome", async () => {
    const view = await render();
    expect(view.button("Connect a computer")).not.toBeNull();
    fleet.machines = [sessionBox, machine("mac", "Ada's MacBook")];
    browsers = { devices: [chromeProfile("Work")], bridges: [], revision: 2 };
    await view.rerender();
    expect(opened).toEqual([]);
    expect(view.text()).toContain("Chrome is connected (Work).");
    expect(view.button("Continue")).not.toBeNull();
    await view.close();
  });

  test("a card shown after Chrome already connected offers no Continue", async () => {
    fleet.machines = [sessionBox, machine("mac", "Ada's MacBook")];
    browsers = { devices: [chromeProfile("Work")], bridges: [], revision: 2 };
    const view = await render(chromeNotice, () => ({
      blocked: null,
      awaitingHuman: false,
      extras: {},
    }));
    expect(view.text()).toContain("Chrome is connected (Work).");
    expect(view.button("Continue")).toBeNull();
    await view.close();
  });

  test("says who can connect when this person cannot", async () => {
    fleet.canManage = false;
    const member = await render();
    expect(member.text()).toContain("Ask a workspace admin to connect a computer.");
    expect(member.button("Connect a computer")).toBeNull();
    await member.close();

    fleet.error = new OpenGeniApiError(404, "not found", {});
    const off = await render();
    expect(off.text()).toContain("Connected Machines aren't available on this deployment.");
    await off.close();
  });

  test("an earlier copy is a short note, and the machine card itself is unchanged", async () => {
    const repeated = await render({ ...chromeNotice, askedAgainLater: true } as AuthNeededItem);
    expect(repeated.text()).toBe("The agent asked to connect Chrome. It asked again below.");
    await repeated.close();

    const { purpose: _purpose, ...machineNotice } = chromeNotice as AuthNeededItem & {
      purpose?: string;
    };
    const machineCard = await render(machineNotice as AuthNeededItem);
    expect(machineCard.text()).toContain("Connected Machine");
    expect(machineCard.text()).not.toContain("Opengeni Browser extension");
    await machineCard.close();
  });
});
