// Run explicitly through session-machine-card.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import type { AuthNeededItem } from "@opengeni/react";

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
  runtime: Runtime | null;
};
type Permissions = { screenRecording: boolean; accessibility: boolean; inputMonitoring: boolean };
type Runtime = {
  capabilities: { credentialRenew: boolean; screenControl: boolean | null };
  macPermissions: Permissions | null;
};
const runtime = (
  screenControl: boolean | null,
  macPermissions: Permissions | null = null,
  credentialRenew = true,
): Runtime => ({ capabilities: { credentialRenew, screenControl }, macPermissions });
const granted = (screenRecording: boolean, accessibility: boolean, inputMonitoring: boolean) => ({
  screenRecording,
  accessibility,
  inputMonitoring,
});
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
  ...overrides,
});
const sessionBox = machine("home", "Cloud sandbox", {
  enrollmentId: null,
  isSessionGroup: true,
  kind: "modal",
  active: true,
});

const attach = mock(async (_sandboxId: string) => true);
const refresh = mock(async () => {});
const fleet = {
  machines: [sessionBox] as Machine[],
  canRead: true,
  canManage: true,
  canAttach: true,
  attaching: false,
  loading: false,
  error: null as unknown,
  mutationError: null as unknown,
  attach,
  refresh,
};
mock.module("@/lib/use-workspace-machines", () => ({ useWorkspaceMachines: () => fleet }));
mock.module("@/api", () => ({ apiBaseUrl: "https://app.example.test" }));

let mintCount = 0;
const mintEnrollToken = mock(async (_workspaceId: string, _input: unknown) => {
  mintCount += 1;
  return {
    token: `oget_token${mintCount}.sig`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    expiresInSeconds: 3600,
  };
});
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
let enableResult: Record<string, unknown> = { status: "active", reason: null, message: null };
let enableFailure: Error | null = null;
const enableMachineScreenControl = mock(async (_workspaceId: string, _enrollmentId: string) => {
  if (enableFailure) throw enableFailure;
  return enableResult;
});
const updateMachineAgent = mock(async (_workspaceId: string, _enrollmentId: string) => ({
  operationId: "operation",
  accepted: true,
  targetVersion: "9.9.9",
}));
const openMachinePrivacySettings = mock(
  async (_workspaceId: string, _enrollmentId: string, _input: { pane: string }) => ({
    opened: true,
    message: null,
  }),
);
const everyone = ["enrollments:read", "enrollments:manage", "sessions:control"];
const context = {
  client: {
    mintEnrollToken,
    listAttachedBrowsers,
    sendMessage,
    enableMachineScreenControl,
    openMachinePrivacySettings,
    updateMachineAgent,
  },
  accessContext: {
    subjectId: "member",
    workspaceGrants: [{ workspaceId: "workspace", permissions: everyone }],
  },
  workspaces: [{ id: "workspace", kind: "shared" }],
  workspaceCapabilityCatalog: [],
};
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("sonner", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
const { SessionCapabilityCard } = await import("./session-capability-card");

const notice = {
  id: "notice",
  kind: "auth-needed",
  serverId: "opengeni",
  providerDomain: "opengeni.ai",
  reason: "missing_connection",
  capability: {
    id: "api:connected-machine",
    name: "Connected Machine",
    kind: "api",
    action: "connect",
    rationale: "Connect your Mac so I can run the iOS build there.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  mintCount = 0;
  attach.mockClear();
  enableMachineScreenControl.mockClear();
  updateMachineAgent.mockClear();
  openMachinePrivacySettings.mockClear();
  enableResult = { status: "active", reason: null, message: null };
  enableFailure = null;
  sendMessage.mockClear();
  mintEnrollToken.mockClear();
  listAttachedBrowsers.mockClear();
  browsers = { devices: [], bridges: [], revision: 1 };
  fleet.machines = [sessionBox];
  fleet.canRead = true;
  fleet.canManage = true;
  fleet.canAttach = true;
  fleet.error = null;
  fleet.mutationError = null;
  context.accessContext.workspaceGrants = [{ workspaceId: "workspace", permissions: everyone }];
});

type SendContext = {
  blocked: string | null;
  awaitingHuman: boolean;
  extras: Record<string, unknown>;
};
async function render(sendContext?: () => SendContext) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onConfigured = mock(async () => {});
  const draw = async () =>
    await act(async () => {
      root.render(
        <SessionCapabilityCard
          item={notice}
          workspaceId="workspace"
          sessionId="session"
          sendContext={sendContext as never}
          onConfigured={onConfigured}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  await draw();
  return {
    container,
    onConfigured,
    rerender: draw,
    text: () => container.textContent ?? "",
    button: (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) =>
          button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
      ) ?? null,
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

describe("Connected Machine conversation card", () => {
  test("mints a command on demand, notices the new machine and moves the chat onto it", async () => {
    const h = await render();
    try {
      expect(h.text()).toContain("Connect your Mac so I can run the iOS build there.");
      // Nothing is minted until the person asks for a command.
      expect(mintEnrollToken).not.toHaveBeenCalled();

      await click(h.button("Connect a machine"));
      expect(mintEnrollToken).toHaveBeenCalledTimes(1);
      expect(mintEnrollToken.mock.calls[0]).toEqual(["workspace", { allowScreenControl: false }]);
      const command = () => h.container.querySelector("pre")?.textContent ?? "";
      expect(command()).toContain("https://app.example.test/install.sh");
      expect(command()).toContain("OPENGENI_ENROLL_TOKEN=oget_token1.sig");
      expect(h.text()).toContain("Works for one machine until");
      expect(h.text()).toContain("Keep it private.");
      expect(h.text()).toContain("Waiting for the machine");

      // Windows gets the PowerShell form of the same single-use token.
      const windows = [...h.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Windows",
      );
      await click(windows ?? null);
      expect(command()).toContain("irm 'https://app.example.test/install.ps1' | iex");
      expect(command()).toContain("$env:OPENGENI_ENROLL_TOKEN='oget_token1.sig'");

      // Screen control is baked into a fresh token.
      const screen = h.container.querySelector<HTMLButtonElement>('button[role="switch"]');
      await click(screen as HTMLElement | null);
      expect(mintEnrollToken.mock.calls.at(-1)).toEqual([
        "workspace",
        { allowScreenControl: true },
      ]);

      // The machine comes online.
      fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
      await h.rerender();
      expect(h.text()).toContain("Studio Mac connected. Choose it below to use it here.");
      expect(h.text()).not.toContain("Waiting for the machine");
      expect(h.container.querySelector("pre")).toBeNull();
      const use = h.button("Use Studio Mac in this chat");
      expect(use?.textContent).toContain("Use in this chat");

      await click(use);
      expect(attach).toHaveBeenCalledWith("mac");
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [workspaceId, sessionId, input] = sendMessage.mock.calls[0]!;
      expect([workspaceId, sessionId]).toEqual(["workspace", "session"]);
      expect((input as { text: string }).text).toBe("Use the machine “Studio Mac” for this chat.");
      expect(h.onConfigured).toHaveBeenCalledTimes(1);

      // The chat now runs there; the card completes and offers Chrome.
      fleet.machines = [
        { ...sessionBox, active: false },
        machine("mac", "Studio Mac", { active: true }),
      ];
      await h.rerender();
      expect(h.text()).toContain("This chat now runs on Studio Mac.");
      expect(h.text()).toContain("In this chat");
      const store = h.container.querySelector<HTMLAnchorElement>(`a[href="${STORE_URL}"]`);
      expect(store?.textContent).toContain("Add to Chrome");
      expect(store?.target).toBe("_blank");
      expect(h.text()).toContain("Add OpenGeni Browser on Studio Mac");
      // The outcome is announced through a live region that stays mounted.
      expect(h.container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
        "This chat now runs on Studio Mac.",
      );
    } finally {
      await h.close();
    }
  });

  test("lists machines for a member who cannot connect one, and reports a linked Chrome", async () => {
    context.accessContext.workspaceGrants = [
      { workspaceId: "workspace", permissions: ["enrollments:read", "sessions:control"] },
    ];
    fleet.canManage = false;
    fleet.machines = [
      sessionBox,
      machine("linux", "build-box", { os: "linux", hasDisplay: false }),
      machine("mac", "Studio Mac"),
      machine("old", "Old laptop", { state: "offline" }),
    ];
    browsers = {
      revision: 2,
      bridges: [],
      devices: [
        // A teammate's Chrome on another machine is not this machine's Chrome.
        {
          id: "other",
          enrollmentId: "enrollment-elsewhere",
          name: "Chrome",
          profileLabel: "Teammate",
          browserName: "Chrome",
          state: "connected",
        },
        {
          id: "device",
          enrollmentId: "enrollment-mac",
          name: "Chrome",
          profileLabel: "Work",
          browserName: "Chrome",
          state: "connected",
        },
      ],
    };
    const h = await render();
    try {
      // A reachable machine makes "Use in this chat" the one primary action.
      expect(h.text()).toContain("Choose where this chat runs.");
      expect(h.button("Connect a machine")).toBeNull();
      expect(h.button("Connect another machine")).toBeNull();
      expect(h.button("Use build-box in this chat")?.textContent).toBe("Use");
      // An offline machine is listed but cannot take the chat.
      expect(h.button("Use Old laptop in this chat")).toBeNull();
      expect(h.text()).toContain("Offline");
      // Members who cannot remove machines are not told to.
      expect(h.text()).not.toContain("remove a connected machine");
      await h.rerender();
      expect(h.text()).toContain("Work on Studio Mac");
      expect(h.text()).not.toContain("Teammate");
    } finally {
      await h.close();
    }
  });

  test("a member who cannot connect machines is told who can", async () => {
    context.accessContext.workspaceGrants = [
      { workspaceId: "workspace", permissions: ["enrollments:read", "sessions:control"] },
    ];
    fleet.canManage = false;
    const h = await render();
    try {
      expect(h.text()).toContain("Ask a workspace admin to connect a machine.");
      expect(h.button("Connect a machine")).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("with a machine already available, connecting another is a secondary action", async () => {
    fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
    const h = await render();
    try {
      expect(h.button("Connect a machine")).toBeNull();
      await click(h.button("Connect another machine"));
      expect(mintEnrollToken).toHaveBeenCalledTimes(1);
      expect(h.text()).toContain("Waiting for the machine");
    } finally {
      await h.close();
    }
  });

  test("screen control turns on in place, then follows each Mac permission", async () => {
    const mac = (overrides: Partial<Machine>) => machine("mac", "Studio Mac", overrides);
    fleet.machines = [sessionBox, mac({ runtime: runtime(false, granted(false, false, false)) })];
    const h = await render();
    try {
      expect(h.text()).toContain("Let agents see and use this screen");
      await click(h.button("Turn on"));
      expect(enableMachineScreenControl.mock.calls[0]).toEqual(["workspace", "enrollment-mac"]);

      // Allowed, but the agent hasn't picked it up yet.
      fleet.machines = [
        sessionBox,
        mac({ allowScreenControl: true, runtime: runtime(false, granted(false, false, false)) }),
      ];
      await h.rerender();
      expect(h.text()).toContain("Turning on…");

      fleet.machines = [
        sessionBox,
        mac({ allowScreenControl: true, runtime: runtime(true, granted(false, false, false)) }),
      ];
      await h.rerender();
      expect(h.text()).toContain("Allow Screen Recording for OpenGeni on this Mac.");
      await click(h.button("Open settings"));
      expect(openMachinePrivacySettings.mock.calls.at(-1)?.[2]).toEqual({
        pane: "screen_recording",
      });
      expect(h.text()).toContain(
        "On the Mac, switch on OpenGeni under Screen Recording. Choose Quit & Reopen if macOS asks.",
      );
      await click(h.button("Open again"));
      expect(openMachinePrivacySettings).toHaveBeenCalledTimes(2);

      fleet.machines = [
        sessionBox,
        mac({ allowScreenControl: true, runtime: runtime(true, granted(true, false, false)) }),
      ];
      await h.rerender();
      expect(h.text()).toContain("Allow Accessibility for OpenGeni on this Mac.");
      await click(h.button("Open settings"));
      expect(openMachinePrivacySettings.mock.calls.at(-1)?.[2]).toEqual({ pane: "accessibility" });

      fleet.machines = [
        sessionBox,
        mac({ allowScreenControl: true, runtime: runtime(true, granted(true, true, true)) }),
      ];
      await h.rerender();
      expect(h.text()).toContain("Agents can see and use this screen");
      expect(h.button("Open settings")).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("allowed screen control says when it will apply", async () => {
    fleet.machines = [
      sessionBox,
      machine("mac", "Studio Mac", {
        allowScreenControl: true,
        runtime: runtime(false, null, false),
      }),
    ];
    const h = await render();
    try {
      expect(h.text()).toContain("It turns on by itself once this machine's agent is updated.");
      expect(h.button("Turn on")).toBeNull();
      await click(h.button("Update agent"));
      expect(updateMachineAgent.mock.calls[0]).toEqual(["workspace", "enrollment-mac"]);
      // Reports from before the agent said whether it holds the consent.
      fleet.machines = [
        sessionBox,
        machine("pc", "Linux box", { os: "linux", allowScreenControl: true, runtime: null }),
      ];
      await h.rerender();
      expect(h.text()).toContain("Agents can see and use this screen");
    } finally {
      await h.close();
    }
  });

  test("a renewal that didn't complete offers Try again", async () => {
    enableResult = {
      status: "pending",
      reason: "renewal_failed",
      message: "The machine couldn't refresh its credentials. Try again in a moment.",
    };
    fleet.machines = [sessionBox, machine("mac", "Studio Mac", { runtime: runtime(false) })];
    const h = await render();
    try {
      await click(h.button("Turn on"));
      fleet.machines = [
        sessionBox,
        machine("mac", "Studio Mac", { allowScreenControl: true, runtime: runtime(false) }),
      ];
      await h.rerender();
      expect(h.text()).toContain("couldn't refresh its credentials");
      expect(h.text()).toContain("Not on yet");
      await click(h.button("Try again"));
      expect(enableMachineScreenControl).toHaveBeenCalledTimes(2);
    } finally {
      await h.close();
    }
  });

  test("a connection too old to change in place asks for the connect command again", async () => {
    enableResult = {
      status: "pending",
      reason: "reconnect_required",
      message: "Run the connect command on the machine again with screen control on.",
    };
    fleet.machines = [sessionBox, machine("mac", "Studio Mac", { runtime: runtime(false) })];
    const h = await render();
    try {
      await click(h.button("Turn on"));
      fleet.machines = [
        sessionBox,
        machine("mac", "Studio Mac", { allowScreenControl: true, runtime: runtime(false) }),
      ];
      await h.rerender();
      expect(h.text()).toContain("Needs a fresh connection");
      await click(h.button("Connect again"));
      expect(h.container.querySelector("pre")).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  test("an older Mac agent still gets the Screen Recording step from its reason", async () => {
    fleet.machines = [
      sessionBox,
      machine("mac", "Studio Mac", {
        allowScreenControl: true,
        desktopUnavailableReason:
          "Screen Recording permission not granted — enable it for Opengeni in System Settings.",
      }),
    ];
    const h = await render();
    try {
      expect(h.text()).toContain("Allow Screen Recording for OpenGeni on this Mac.");
      await click(h.button("Open settings"));
      expect(openMachinePrivacySettings.mock.calls.at(-1)?.[2]).toEqual({
        pane: "screen_recording",
      });
    } finally {
      await h.close();
    }
  });

  test("an organization machine needs an organization admin", async () => {
    const { OpenGeniApiError } = await import("@opengeni/sdk");
    enableFailure = new OpenGeniApiError(403, "missing permission: account:admin", {});
    fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
    const h = await render();
    try {
      await click(h.button("Turn on"));
      expect(h.text()).toContain("Only an organization admin can turn this on.");
    } finally {
      await h.close();
    }
  });

  test("members who can't manage machines are told who can turn screen control on", async () => {
    context.accessContext.workspaceGrants = [
      { workspaceId: "workspace", permissions: ["enrollments:read", "sessions:control"] },
    ];
    fleet.canManage = false;
    fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
    const h = await render();
    try {
      expect(h.text()).toContain("Ask a workspace admin to turn it on");
      expect(h.button("Turn on")).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("a chat waiting on a question keeps it: the move happens without a message", async () => {
    fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
    const h = await render(() => ({ blocked: null, awaitingHuman: true, extras: {} }));
    try {
      await click(h.button("Use Studio Mac in this chat"));
      expect(attach).toHaveBeenCalledWith("mac");
      expect(sendMessage).not.toHaveBeenCalled();
      expect(h.text()).toContain("Answer the question above to continue.");
    } finally {
      await h.close();
    }
  });

  test("a chat that cannot take input is not moved", async () => {
    fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
    const h = await render(() => ({
      blocked: "This chat has ended.",
      awaitingHuman: false,
      extras: {},
    }));
    try {
      await click(h.button("Use Studio Mac in this chat"));
      expect(attach).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(h.text()).toContain("Couldn't move this chat to Studio Mac. This chat has ended.");
    } finally {
      await h.close();
    }
  });

  test("reconnecting a known offline machine counts as connected; Cancel stops watching", async () => {
    fleet.machines = [sessionBox, machine("mac", "Studio Mac", { state: "offline" })];
    const h = await render();
    try {
      await click(h.button("Connect a machine"));
      expect(h.text()).toContain("Waiting for the machine");
      fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
      await h.rerender();
      expect(h.text()).toContain("Studio Mac connected.");

      await click(h.button("Connect another machine"));
      expect(h.text()).toContain("Waiting for the machine");
      await click(h.button("Cancel"));
      expect(h.text()).not.toContain("Waiting for the machine");
      // Nothing that appears later is treated as just connected.
      fleet.machines = [...fleet.machines, machine("pc", "Office PC", { os: "windows" })];
      await h.rerender();
      expect(h.text()).not.toContain("Office PC connected.");
    } finally {
      await h.close();
    }
  });

  test("the message quotes and shortens the machine name", async () => {
    const { machineUseMessage } = await import("./session-machine-card");
    expect(machineUseMessage("Mac.\nAlso push to main")).toBe(
      "Use the machine “Mac. Also push to main” for this chat.",
    );
    expect(machineUseMessage("x".repeat(100))).toBe(
      `Use the machine “${"x".repeat(59)}…” for this chat.`,
    );
    expect(machineUseMessage("“quoted”")).toBe("Use the machine “quoted” for this chat.");
  });

  test("a failed move says so and sends nothing", async () => {
    fleet.machines = [sessionBox, machine("mac", "Studio Mac")];
    attach.mockImplementationOnce(async () => false);
    const h = await render();
    try {
      await click(h.button("Use Studio Mac in this chat"));
      expect(h.text()).toContain("Couldn't move this chat to Studio Mac. Try again.");
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test("without machine access the card explains instead of offering actions", async () => {
    context.accessContext.workspaceGrants = [{ workspaceId: "workspace", permissions: [] }];
    fleet.canRead = false;
    fleet.canManage = false;
    fleet.machines = [];
    const h = await render();
    try {
      expect(h.text()).toContain("You don't have access to this workspace's machines.");
      expect(h.button("Connect a machine")).toBeNull();
      expect(listAttachedBrowsers).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
