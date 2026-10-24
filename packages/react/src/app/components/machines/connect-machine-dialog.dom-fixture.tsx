// Run explicitly through connect-machine-dialog.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import type { MachineView } from "../../../machines";

type MintInput = { scope?: string | undefined; allowScreenControl?: boolean | undefined };
type MintResult = {
  token: string;
  expiresAt: string;
  expiresInSeconds: number;
  scope?: string | undefined;
  allowScreenControl?: boolean | undefined;
};

const echo = (token: string, input: MintInput): MintResult => ({
  token,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  expiresInSeconds: 3600,
  scope: input.scope ?? "workspace",
  allowScreenControl: input.allowScreenControl ?? false,
});

let mintCount = 0;
let mintImpl: (input: MintInput) => Promise<MintResult> = async (input) =>
  echo(`oget_preview${++mintCount}.sig`, input);
const mintEnrollToken = mock(async (_workspaceId: string, input: MintInput) => mintImpl(input));
const copyTextToClipboard = mock(async (_text: string) => true);
const context = { client: { mintEnrollToken }, accessContext: { subjectId: "person" } };
mock.module("../../app-context", () => ({ useAppContext: () => context }));
mock.module("../../../clipboard", () => ({ copyTextToClipboard }));
// Outside the desktop app (the web) unless a test puts this computer here.
let desktop: unknown = null;
mock.module("../desktop/this-computer", () => ({ useDesktopThisComputer: () => desktop }));
GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
const { ConnectMachineDialog } = await import("./connect-machine-dialog");

const machine = (
  sandboxId: string,
  name: string,
  overrides: Partial<MachineView> = {},
): MachineView =>
  ({
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
    scope: "user",
    ...overrides,
  }) as unknown as MachineView;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT =
    true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  desktop = null;
  mintCount = 0;
  mintImpl = async (input) => echo(`oget_preview${++mintCount}.sig`, input);
  mintEnrollToken.mockClear();
  copyTextToClipboard.mockClear();
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
  });
});

type Props = {
  advanced?: boolean | undefined;
  workspaceId?: string | undefined;
  machines?: MachineView[] | undefined;
  loading?: boolean | undefined;
  error?: unknown | undefined;
  personalWorkspace?: boolean | undefined;
  defaultScope?: "user" | "workspace" | undefined;
  useInChat?: { canUse: boolean; onUse: (machine: MachineView) => void } | undefined;
};

async function render(initial: Props = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenChange = mock((_open: boolean) => {});
  const onConnected = mock((_machine: MachineView) => {});
  let props: Props = { machines: [], loading: false, ...initial };
  let open = true;
  const draw = async () =>
    await act(async () => {
      root.render(
        <ConnectMachineDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            open = next;
            void draw();
          }}
          workspaceId={props.workspaceId ?? "workspace"}
          origin="https://app.example.test"
          machines={props.machines ?? []}
          machinesLoading={props.loading ?? false}
          machinesError={props.error ?? null}
          personalWorkspace={props.personalWorkspace}
          defaultScope={props.defaultScope}
          onConnected={onConnected}
          useInChat={props.useInChat}
        />,
      );
      await settle();
    });
  await draw();
  const dialog = () => document.querySelector<HTMLElement>("[data-connect-machine-dialog]");
  const button = (name: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
    ) ?? null;
  const radio = (label: string) =>
    [...(dialog()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find(
      (candidate) =>
        candidate.textContent?.trim() === label || candidate.textContent?.startsWith(label),
    ) ?? null;
  const openAdvanced = async () => {
    if (props.advanced === false || dialog()?.querySelector("[data-connect-machine-setup]")) return;
    const trigger = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (candidate) => candidate.textContent?.startsWith("Connect a server instead"),
    );
    if (trigger) await click(trigger);
  };
  await openAdvanced();
  return {
    dialog,
    text: () => dialog()?.textContent ?? "",
    button,
    radio,
    command: () => dialog()?.querySelector("[data-connect-command]")?.textContent ?? "",
    onOpenChange,
    onConnected,
    update: async (next: Props) => {
      props = { ...props, ...next };
      await draw();
      await openAdvanced();
    },
    flush: async () => await act(async () => await settle()),
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
    await settle();
  });
}

describe("Connect a machine dialog", () => {
  test("ordinary setup offers the app and an account-bound handoff without minting or rendering a command", async () => {
    const h = await render({ advanced: false });
    try {
      expect(h.text()).toContain("Download for Mac");
      expect(h.text()).toContain("Open app and connect");
      expect(h.command()).toBe("");
      expect(h.text()).not.toContain("curl");
      expect(mintEnrollToken).not.toHaveBeenCalled();
      const links = [...h.dialog()!.querySelectorAll<HTMLAnchorElement>("a")];
      expect(links.find((link) => link.textContent === "Download for Mac")?.href).toBe(
        "https://app.example.test/desktop/latest/Opengeni-mac.dmg",
      );
      const handoff = new URL(
        links.find((link) => link.textContent === "Open app and connect")!.href,
      );
      expect(handoff.protocol).toBe("opengeni:");
      expect(handoff.searchParams.get("subject")).toBe("person");
      expect(handoff.searchParams.get("url")).toBe("https://app.example.test/workspaces/workspace");
      expect(h.text()).not.toContain("replacing the old version");
      await click(links.find((link) => link.textContent === "Open app and connect")!);
      expect(h.text()).toContain("opens without connecting");
      expect(h.text()).toContain("replacing the old version");
      expect(h.text()).not.toContain("Machine connected");
      expect(h.onConnected).not.toHaveBeenCalled();
      expect(mintEnrollToken).not.toHaveBeenCalled();
      await click(h.button("Windows"));
      expect(h.text()).toContain("Download for Windows");
      await click(h.button("Linux"));
      expect(h.text()).toContain("Download .deb");
      expect(h.text()).toContain("Download AppImage");
      expect(mintEnrollToken).not.toHaveBeenCalled();
      await h.update({ machines: [machine("new-computer", "My computer")] });
      expect(h.text()).toContain("Machine connected");
      expect(h.text()).not.toContain("replacing the old version");
      expect(h.onConnected).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
  });

  test("defaults to Only me with screen control off, and remints when access changes", async () => {
    const h = await render();
    try {
      expect(h.text()).toContain("Use your computer");
      expect(h.text()).toContain("Who can use it?");
      expect(h.radio("Only me")?.getAttribute("aria-checked")).toBe("true");
      expect(h.radio("This workspace")?.getAttribute("aria-checked")).toBe("false");
      expect(h.text()).toContain("Nobody else can use it.");
      expect(h.text()).toContain("Everyone in this workspace can run chats on it.");
      const screen = h.dialog()?.querySelector('button[role="switch"]');
      expect(screen?.getAttribute("aria-checked")).toBe("false");
      expect(mintEnrollToken.mock.calls).toEqual([
        ["workspace", { scope: "user", allowScreenControl: false }],
      ]);
      expect(h.command()).toContain("OPENGENI_ENROLL_TOKEN=oget_preview1.sig");

      await click(h.radio("This workspace"));
      expect(mintEnrollToken.mock.calls.at(-1)).toEqual([
        "workspace",
        { scope: "workspace", allowScreenControl: false },
      ]);
      // The copied command is the one minted for the visible choice.
      expect(h.command()).toContain("oget_preview2.sig");
      await click(h.button("Copy command"));
      expect(copyTextToClipboard.mock.calls.at(-1)![0]).toContain("oget_preview2.sig");
      expect(h.text()).toContain("Waiting for the machine to connect");

      // Changing the choice again invalidates the copied state.
      await click(h.dialog()?.querySelector<HTMLElement>('button[role="switch"]') ?? null);
      expect(mintEnrollToken.mock.calls.at(-1)).toEqual([
        "workspace",
        { scope: "workspace", allowScreenControl: true },
      ]);
      expect(h.command()).toContain("oget_preview3.sig");
      expect(h.text()).not.toContain("Waiting for the machine to connect");
    } finally {
      await h.close();
    }
  });

  test("a slow command for an earlier choice never replaces the current one", async () => {
    const pending: Array<{
      input: MintInput;
      reply: ReturnType<typeof deferred<MintResult>>;
    }> = [];
    mintImpl = (input) => {
      const reply = deferred<MintResult>();
      pending.push({ input, reply });
      return reply.promise;
    };
    const h = await render();
    try {
      expect(pending).toHaveLength(1);
      expect(h.text()).toContain("Preparing your command");
      await click(h.radio("This workspace"));
      expect(pending).toHaveLength(2);

      // The newer request answers first.
      pending[1]!.reply.resolve(echo("oget_workspace.sig", pending[1]!.input));
      await h.flush();
      expect(h.command()).toContain("oget_workspace.sig");

      // The stale Only me answer arrives late and is ignored.
      pending[0]!.reply.resolve(echo("oget_stale_user.sig", pending[0]!.input));
      await h.flush();
      expect(h.command()).toContain("oget_workspace.sig");
      expect(h.command()).not.toContain("oget_stale_user.sig");

      // Switching back hides the workspace command until Only me's own arrives.
      await click(h.radio("Only me"));
      expect(h.command()).toBe("");
      await click(h.button("Copy command"));
      expect(copyTextToClipboard).not.toHaveBeenCalled();
      pending[2]!.reply.resolve(echo("oget_user.sig", pending[2]!.input));
      await h.flush();
      expect(h.command()).toContain("oget_user.sig");
    } finally {
      await h.close();
    }
  });

  test("a copy that finishes after the choice changed never marks the new command copied", async () => {
    const clipboard = deferred<boolean>();
    copyTextToClipboard.mockImplementationOnce(async () => await clipboard.promise);
    const h = await render();
    try {
      expect(h.command()).toContain("oget_preview1.sig");
      await click(h.button("Copy command"));
      expect(copyTextToClipboard.mock.calls.at(-1)![0]).toContain("oget_preview1.sig");
      // The person switches to This workspace before the clipboard answers.
      await click(h.radio("This workspace"));
      expect(h.command()).toContain("oget_preview2.sig");
      await act(async () => {
        clipboard.resolve(true);
        await settle();
      });
      expect(h.button("Copied")).toBeNull();
      expect(h.button("Copy command")).not.toBeNull();
      expect(h.text()).not.toContain("Waiting for the machine to connect");
      // Copying the command that is shown marks it.
      await click(h.button("Copy command"));
      expect(copyTextToClipboard.mock.calls.at(-1)![0]).toContain("oget_preview2.sig");
      expect(h.button("Copied")).not.toBeNull();
      expect(h.text()).toContain("Waiting for the machine to connect");
    } finally {
      await h.close();
    }
  });

  test("can start from This workspace", async () => {
    const h = await render({ defaultScope: "workspace" });
    try {
      expect(h.radio("This workspace")?.getAttribute("aria-checked")).toBe("true");
      expect(mintEnrollToken.mock.calls).toEqual([
        ["workspace", { scope: "workspace", allowScreenControl: false }],
      ]);
    } finally {
      await h.close();
    }
  });

  test("a server that cannot mint a personal command says so instead of sharing", async () => {
    // An older server ignores the scope and echoes nothing: a workspace token.
    mintImpl = async () => ({
      token: "oget_legacy.sig",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresInSeconds: 3600,
    });
    const h = await render();
    try {
      expect(h.command()).toBe("");
      expect(h.text()).toContain("This server can't connect a machine for you only yet.");
      expect(h.text()).not.toContain("oget_legacy.sig");
      // This workspace accepts the same echo.
      await click(h.radio("This workspace"));
      expect(h.command()).toContain("oget_legacy.sig");
    } finally {
      await h.close();
    }
  });

  test("a failed mint offers Try again", async () => {
    let fail = true;
    mintImpl = async (input) => {
      if (fail) throw new Error("Network unavailable");
      return echo("oget_retry.sig", input);
    };
    const h = await render();
    try {
      expect(h.text()).toContain("Couldn't create a connect command");
      fail = false;
      await click(h.button("Try again"));
      expect(h.command()).toContain("oget_retry.sig");
    } finally {
      await h.close();
    }
  });

  test("shows Mac, Linux and Windows with the detected OS selected", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });
    const h = await render();
    try {
      const tabs = [
        ...(h.dialog()?.querySelectorAll('[aria-label="Operating system"] [role="radio"]') ?? []),
      ];
      expect(tabs.map((tab) => tab.textContent)).toEqual(["Mac", "Linux", "Windows"]);
      expect(h.radio("Windows")?.getAttribute("aria-checked")).toBe("true");
      expect(h.command()).toContain("irm 'https://app.example.test/install.ps1' | iex");
      expect(h.text()).toContain("PowerShell");
      await click(h.radio("Linux"));
      expect(h.command()).toContain("https://app.example.test/install.sh");
      expect(h.text()).toContain("Linux machine");
      // One token for every OS: switching tabs never remints.
      expect(mintEnrollToken).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
  });

  test("pairing with a code is a secondary disclosure with the device-flow command", async () => {
    const h = await render();
    try {
      const trigger =
        [...(h.dialog()?.querySelectorAll<HTMLButtonElement>("button[aria-expanded]") ?? [])].find(
          (candidate) => candidate.textContent?.includes("Pair with a code instead"),
        ) ?? null;
      const panel = () =>
        h.dialog()?.querySelector("[data-manual-command]")?.closest("[data-state]") ?? null;
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(panel()?.getAttribute("data-state")).toBe("closed");
      await click(trigger);
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
      expect(panel()?.getAttribute("data-state")).toBe("open");
      const manual = h.dialog()?.querySelector("[data-manual-command]")?.textContent ?? "";
      expect(manual).toContain("OPENGENI_WORKSPACE_ID=workspace");
      expect(manual).not.toContain("OPENGENI_ENROLL_TOKEN");
      const link = h.dialog()?.querySelector<HTMLAnchorElement>("a[href]");
      expect(link?.getAttribute("href")).toBe("https://app.example.test/device");
      expect(link?.target).toBe("_blank");
    } finally {
      await h.close();
    }
  });

  test("a machine that comes online finishes with its name and access; Done closes", async () => {
    const existing = machine("old", "Old laptop", { scope: "workspace" });
    const h = await render({ machines: [existing], loading: true });
    try {
      // The snapshot waits for the first load, so existing machines never count.
      await h.update({ loading: false });
      expect(h.text()).toContain("Use your computer");
      await h.update({ machines: [existing, machine("mac", "Studio Mac")] });
      expect(h.text()).toContain("Machine connected");
      expect(h.text()).toContain("Studio Mac");
      expect(h.text()).toContain("Connected");
      expect(h.text()).toContain("Only me");
      expect(h.button("Use in this chat")).toBeNull();
      expect(h.onConnected).toHaveBeenCalledTimes(1);
      await click(h.button("Done"));
      expect(h.onOpenChange).toHaveBeenCalledWith(false);
      expect(h.dialog()).toBeNull();
    } finally {
      await h.close();
    }
  });

  test("a failed first load is no baseline: machines online all along never count", async () => {
    const existing = machine("old", "Old laptop", { scope: "workspace" });
    const h = await render({ machines: [], loading: true });
    try {
      // The first load fails, so the host has no machines to show.
      await h.update({ loading: false, error: new Error("Network unavailable") });
      // The next load succeeds with a machine that was online all along.
      await h.update({ error: null, machines: [existing] });
      expect(h.text()).not.toContain("Machine connected");
      expect(h.onConnected).not.toHaveBeenCalled();
      // A machine that really comes online afterwards still finishes.
      await h.update({ machines: [existing, machine("mac", "Studio Mac")] });
      expect(h.text()).toContain("Machine connected");
      expect(h.text()).toContain("Studio Mac");
    } finally {
      await h.close();
    }
  });

  test("switching workspaces starts over: the other workspace's machines never count", async () => {
    const h = await render({ machines: [machine("a-mac", "Workspace A Mac")] });
    try {
      // Browser back or forward can change the workspace while the dialog is open.
      const otherPc = machine("b-pc", "Workspace B PC", { scope: "workspace" });
      await h.update({ workspaceId: "workspace-b", machines: [otherPc] });
      expect(h.text()).not.toContain("Machine connected");
      expect(h.onConnected).not.toHaveBeenCalled();
      expect(mintEnrollToken.mock.calls.at(-1)).toEqual([
        "workspace-b",
        { scope: "user", allowScreenControl: false },
      ]);
      expect(h.command()).toContain("oget_preview2.sig");
      // A machine that really comes online in the new workspace still finishes.
      await h.update({ machines: [otherPc, machine("b-mac", "New Mac")] });
      expect(h.text()).toContain("Machine connected");
      expect(h.text()).toContain("New Mac");
    } finally {
      await h.close();
    }
  });

  test("from a chat, Use in this chat hands the machine to the attach flow", async () => {
    const onUse = mock((_machine: MachineView) => {});
    const h = await render({ useInChat: { canUse: true, onUse } });
    try {
      await h.update({
        machines: [machine("pc", "Office PC", { os: "windows", scope: "workspace" })],
      });
      expect(h.text()).toContain("Office PC");
      expect(h.text()).toContain("Workspace");
      expect(h.button("Done")).not.toBeNull();
      await click(h.button("Use in this chat"));
      expect(onUse).toHaveBeenCalledTimes(1);
      expect(onUse.mock.calls[0]![0].sandboxId).toBe("pc");
      expect(h.dialog()).toBeNull();
    } finally {
      await h.close();
    }
  });
});

const { defaultThisComputerLabels } = await import("../../../this-computer");
describe("Connect a machine inside the desktop app", () => {
  const labels = defaultThisComputerLabels();
  function inDesktop(status: Record<string, unknown> | null) {
    const allowPermissions = mock(() => {});
    const turnOn = mock(async () => null);
    const turnOff = mock(async () => {});
    desktop = {
      workspaceId: "workspace",
      platform: "macos",
      productName: "Opengeni",
      labels,
      allowPermissions,
      signIn: null,
      computer: {
        status: status && {
          busy: false,
          error: null,
          machineName: "Kari's Mac",
          management: "service",
          ...status,
        },
        acting: false,
        actionError: null,
        canDisconnect: true,
        pending: null,
        asking: null,
        allowPermissions,
        refresh: () => {},
        connect: async () => null,
        pause: async () => {},
        resume: async () => {},
        disconnect: async () => {},
        turnOn,
        turnOff,
        requestPermission: async () => {},
      },
    };
    return { allowPermissions, turnOn, turnOff };
  }
  const toggle = (h: Awaited<ReturnType<typeof render>>) =>
    h.dialog()!.querySelector<HTMLButtonElement>('[role="switch"]');

  test("never offers a download or the app hand-off for the computer it runs on", async () => {
    const { turnOn, allowPermissions } = inDesktop({ state: "not_connected" });
    const h = await render({ advanced: false });
    try {
      expect(h.text()).toContain("Connect a machine");
      expect(h.text()).toContain("Computer use");
      expect(h.text()).toContain("Let agents use Kari's Mac.");
      expect(h.text()).not.toContain("Download for Mac");
      expect(h.text()).not.toContain("Open app and connect");
      expect(h.text()).not.toMatch(/reconnect/i);
      expect(h.dialog()!.querySelectorAll("a")).toHaveLength(0);
      expect(mintEnrollToken).not.toHaveBeenCalled();
      // The same switch as on Machines: on, right here.
      expect(toggle(h)?.getAttribute("aria-checked")).toBe("false");
      await click(toggle(h));
      expect(turnOn).toHaveBeenCalledTimes(1);
      expect(allowPermissions).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test("says when computer use is on, and other machines still connect with a command", async () => {
    const { turnOff } = inDesktop({ state: "connected" });
    const h = await render({ advanced: false });
    try {
      expect(h.text()).toContain("Agents can use Kari's Mac");
      expect(toggle(h)?.getAttribute("aria-checked")).toBe("true");
      const other = [...h.dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.startsWith("Connect another computer or server"),
      );
      await click(other!);
      expect(h.dialog()?.querySelector("[data-connect-machine-setup]")).not.toBeNull();
      expect(h.text()).not.toContain("Computer use");
      await h.flush();
      expect(h.command()).toContain("oget_preview1.sig");
      expect(turnOff).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test("a computer removed on the server is off like any other, and turns on in one step", async () => {
    const { turnOn } = inDesktop({
      state: "not_connected",
      errorCode: "removed",
      error: "This computer is no longer in this workspace.",
    });
    const h = await render({ advanced: false });
    try {
      expect(h.text()).toContain("Let agents use Kari's Mac.");
      expect(h.text()).not.toContain("removed");
      expect(h.text()).not.toContain("no longer");
      expect(h.text()).not.toContain("Couldn't reach");
      expect(toggle(h)?.getAttribute("aria-checked")).toBe("false");
      await click(toggle(h));
      expect(turnOn).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
  });

  test("a missing permission or a problem shows with the switch on and exactly one fix", async () => {
    const permissions = inDesktop({
      state: "connected",
      permissions: [{ id: "accessibility", granted: false }],
    });
    let h = await render({ advanced: false });
    try {
      expect(toggle(h)?.getAttribute("aria-checked")).toBe("true");
      expect(h.text()).toContain("To let agents see and control the screen, allow Opengeni");
      await click(h.button("Open System Settings"));
      expect(permissions.allowPermissions).toHaveBeenCalledTimes(1);
      expect(h.onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await h.close();
    }
    const offline = inDesktop({
      state: "connected",
      reconnecting: true,
      errorCode: "offline",
      error: "fetch failed",
    });
    h = await render({ advanced: false });
    try {
      expect(h.text()).toContain("Couldn't reach the server");
      await click(h.button("Try again"));
      expect(offline.turnOn).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
    inDesktop({
      state: "connected",
      reconnecting: true,
      errorCode: "unknown",
      error: "Couldn't check this computer's connection: API 503",
    });
    h = await render({ advanced: false });
    try {
      // The server answered: its own words, never a network message.
      expect(h.text()).toContain("API 503");
      expect(h.text()).not.toContain("Couldn't reach");
      expect(h.button("Try again")).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  test("a computer that can't be used here leaves only other machines", async () => {
    inDesktop({ state: "unavailable" });
    const h = await render({ advanced: false });
    try {
      expect(h.text()).not.toContain("Computer use");
      expect(h.text()).not.toContain("Download for Mac");
      expect(h.dialog()?.querySelector("[data-connect-machine-setup]")).not.toBeNull();
    } finally {
      await h.close();
    }
  });
});
