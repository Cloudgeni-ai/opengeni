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
  ...overrides,
});
const sessionBox = machine("home", "Cloud sandbox", {
  enrollmentId: null,
  isSessionGroup: true,
  kind: "modal",
  active: true,
});

const attach = mock(async (_sandboxId: string) => true);
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
