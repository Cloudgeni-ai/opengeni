// Settings > Computer use as people see it: a missing permission is a calm
// line with one action, never red; turning the screen on asks through the
// desktop's own asking; the folders row is macOS only. Run in its own process
// by this-computer-settings.dom.test.ts (it installs a DOM and a desktop bridge).
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
  DesktopComputerCapabilities,
  ThisComputerPermissionId,
  ThisComputerStatus,
} from "@opengeni/sdk/desktop-bridge";

let ThisComputerAgentSettings: typeof import("./this-computer-settings").ThisComputerAgentSettings;
let createRoot: typeof import("react-dom/client").createRoot;

const permissions = (granted: Partial<Record<ThisComputerPermissionId, boolean>>) =>
  (["screenRecording", "accessibility", "inputMonitoring", "files"] as const).map((id) => ({
    id,
    granted: granted[id] ?? false,
  }));

const base: ThisComputerStatus = {
  state: "connected",
  busy: false,
  error: null,
  machineName: "Bendik's MacBook",
  enrollmentId: "enrollment-1",
  management: "app",
};

let status: ThisComputerStatus = base;
/** What the app answers when the page reads the status itself. */
let fresh: ThisComputerStatus | null = null;
let capabilities: DesktopComputerCapabilities;
let capabilitiesStatus: () => Promise<DesktopComputerCapabilities>;
let platform: "macos" | "windows" = "macos";
const updates: unknown[] = [];
const allowPermissions = mock((_status?: ThisComputerStatus | null) => {});
const requestPermission = mock(async (_id: ThisComputerPermissionId) => {});
const connect = mock(async () => status);

function computer() {
  return {
    status,
    acting: false,
    actionError: null,
    canDisconnect: false,
    pending: null,
    asking: null,
    refresh: () => {},
    connect,
    pause: async () => {},
    resume: async () => {},
    disconnect: async () => {},
    turnOn: async () => status,
    turnOff: async () => {},
    allowPermissions,
    requestPermission,
  };
}

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Read when the desktop module loads, so it's in place first.
  (window as unknown as Record<string, unknown>).opengeniDesktop = {
    version: 1,
    platform: "macos",
    productName: "Opengeni",
    capabilities: [
      "thisComputer",
      "thisComputerPermissions",
      "openExternal",
      "computerCapabilities",
    ],
    openExternal: async () => {},
    thisComputer: {
      status: async () => fresh ?? status,
      connect: async () => status,
      pause: async () => {},
      resume: async () => {},
      requestPermission: async () => {},
      onChange: () => () => {},
    },
    computerCapabilities: {
      status: () => capabilitiesStatus(),
      update: async (change: Partial<DesktopComputerCapabilities["settings"]>) => {
        updates.push(change);
        capabilities = { ...capabilities, settings: { ...capabilities.settings, ...change } };
        return capabilities;
      },
      requestMicrophone: async () => capabilities,
      onChange: () => () => {},
    },
  };
  const { defaultThisComputerLabels } = await import("@opengeni/react/this-computer");
  mock.module("@opengeni/react/app/components/desktop/this-computer", () => ({
    useDesktopThisComputer: () => ({
      workspaceId: "workspace",
      computer: computer(),
      platform,
      productName: "Opengeni",
      labels: defaultThisComputerLabels(),
      allowPermissions,
      signIn: null,
    }),
  }));
  mock.module("@opengeni/react/app/app-context", () => ({
    useAppContext: () => ({ client: { listAttachedBrowsers: async () => ({ devices: [] }) } }),
  }));
  ({ createRoot } = await import("react-dom/client"));
  ({ ThisComputerAgentSettings } = await import("./this-computer-settings"));
});
afterAll(() => GlobalRegistrator.unregister());

let root: Root | null = null;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  status = base;
  fresh = null;
  platform = "macos";
  updates.length = 0;
  allowPermissions.mockClear();
  requestPermission.mockClear();
  connect.mockClear();
});

function settings(
  settingsChange: Partial<DesktopComputerCapabilities["settings"]> = {},
): DesktopComputerCapabilities {
  return {
    settings: { screenControl: true, browserExtension: true, microphone: true, ...settingsChange },
    microphone: "granted",
    unavailable: [],
    screenControlConnected: true,
    problems: {},
  };
}

async function render(next: ThisComputerStatus, caps = settings()) {
  status = next;
  capabilities = caps;
  capabilitiesStatus ??= async () => capabilities;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ThisComputerAgentSettings />);
  });
  // The capabilities and Chrome reads settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const actions = (name: string) =>
  [...container.querySelectorAll("button, a")].filter(
    (element) => element.textContent?.trim() === name,
  );
/** Shown in red now: an unconditional danger colour, not a state variant such as aria-invalid. */
const red = () =>
  [...container.querySelectorAll("*")].filter((element) =>
    [...element.classList].some((name) => /^(text|bg|border)-(danger|destructive)\b/u.test(name)),
  );

describe("a permission macOS hasn't given", () => {
  test("is a calm line with one Open System Settings, and the folders get no second button", async () => {
    capabilitiesStatus = async () => capabilities;
    await render({ ...base, permissions: permissions({ screenRecording: true }) });
    expect(container.textContent).toContain("Not allowed yet.");
    // Input Monitoring is its own step only once Accessibility is allowed.
    expect(container.textContent).toContain("Accessibility");
    expect(container.textContent).not.toContain("Accessibility and Input Monitoring");
    expect(actions("Open System Settings")).toHaveLength(1);
    expect(actions("Allow")).toHaveLength(0);
    expect(red()).toHaveLength(0);

    await act(async () => {
      (actions("Open System Settings")[0] as HTMLElement).click();
    });
    expect(allowPermissions).toHaveBeenCalledTimes(1);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  test("only the folders missing: still the one action, on the Computer use row", async () => {
    await render({
      ...base,
      permissions: permissions({
        screenRecording: true,
        accessibility: true,
        inputMonitoring: true,
      }),
    });
    expect(actions("Open System Settings")).toHaveLength(1);
    expect(actions("Allow")).toHaveLength(0);
    expect(red()).toHaveLength(0);
  });

  test("with screen control off the folders row has its own Allow", async () => {
    await render({ ...base, folders: false }, settings({ screenControl: false }));
    expect(actions("Open System Settings")).toHaveLength(0);
    expect(actions("Allow")).toHaveLength(1);
    await act(async () => {
      (actions("Allow")[0] as HTMLElement).click();
    });
    expect(requestPermission).toHaveBeenCalledWith("files");
  });

  test("red stays for real failures", async () => {
    await render({
      ...base,
      error: "The agent stopped unexpectedly.",
      permissions: permissions({ screenRecording: true }),
    });
    expect(red().length).toBeGreaterThan(0);
  });
});

describe("turning Control the screen on", () => {
  test("asks through the desktop's own asking, from what macOS says after the restart", async () => {
    await render({ ...base, folders: false }, settings({ screenControl: false }));
    fresh = { ...base, permissions: permissions({}) };
    const screen = container.querySelectorAll('[role="switch"]')[1] as HTMLElement;
    await act(async () => {
      screen.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(updates).toEqual([{ screenControl: true }]);
    expect(allowPermissions).toHaveBeenCalledTimes(1);
    expect(allowPermissions.mock.calls[0]?.[0]).toEqual(fresh);
    // Never a second asking chain of its own.
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("off macOS and while loading", () => {
  test("Windows has no folders row, even with Computer use off", async () => {
    platform = "windows";
    await render({ ...base, state: "paused" });
    expect(container.textContent).not.toContain("Desktop, Documents and Downloads");
  });

  test("switches wait while the app's answer is on its way, without asking for an update", async () => {
    capabilitiesStatus = () => new Promise(() => {});
    try {
      await render({ ...base, permissions: permissions({ screenRecording: true }) });
      expect(container.textContent).not.toContain("Update the Opengeni app");
    } finally {
      capabilitiesStatus = async () => capabilities;
    }
  });
});
