// Run explicitly through connect-machine-dialog.test.tsx so Radix sees the DOM at import time.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

import type { MachineView } from "@opengeni/react/machines";

type MintInput = { scope?: string; allowScreenControl?: boolean };
type MintResult = {
  token: string;
  expiresAt: string;
  expiresInSeconds: number;
  scope?: string;
  allowScreenControl?: boolean;
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
const context = { client: { mintEnrollToken } };
mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@opengeni/react/clipboard", () => ({ copyTextToClipboard }));
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
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
  workspaceId?: string;
  machines?: MachineView[];
  loading?: boolean;
  error?: unknown;
  personalWorkspace?: boolean;
  defaultScope?: "user" | "workspace";
  useInChat?: { canUse: boolean; onUse: (machine: MachineView) => void };
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
  test("defaults to Only me with screen control off, and remints when access changes", async () => {
    const h = await render();
    try {
      expect(h.text()).toContain("Connect a machine");
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
      expect(h.text()).toContain("Connect a machine");
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
