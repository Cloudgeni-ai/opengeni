import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";

import { AppContext, type AppContextValue } from "../../app-context";
import type { Session } from "../../types";

// The header only renders inside the session shell, which always has the app
// context; its chat actions (copy link, pin) run through it. This test runs
// none of them, so any read of the context fails loudly.
const appContext = new Proxy({} as AppContextValue, {
  get(_target, key) {
    throw new Error(`The SessionHeader mute test's app context has no ${String(key)}`);
  },
});

function createRoot(container: Element) {
  const root = createReactRoot(container);
  return {
    render: (node: ReactNode) =>
      root.render(<AppContext.Provider value={appContext}>{node}</AppContext.Provider>),
    unmount: () => root.unmount(),
  };
}

// The menu's items, rendered inline so the test reads what the person sees.
mock.module("../../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuMeta: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => (
    <span aria-hidden>{children}</span>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onSelect?: (() => void) | undefined;
    disabled?: boolean | undefined;
  }) => (
    <button type="button" data-menu-item="" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

const { SessionHeader } = await import("./session-header");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  initialMessage: "Keep an eye on the release.",
  title: null,
  titleSource: null,
  parentSessionId: null,
  model: "codex/gpt-5.6-sol",
  reasoningEffort: "high",
  latencyMode: "standard",
  metadata: {},
  status: "idle",
  pinned: false,
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as Session;

test("the session menu mutes and unmutes replies only where it applies", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const toggles: boolean[] = [];
  const render = (repliesMute: { muted: boolean; scope?: "session" | "schedule" } | null) => (
    <SessionHeader
      session={session}
      ancestors={[]}
      connectionState="live"
      status="idle"
      keyAuthRequired={false}
      onForgetAccessKey={() => undefined}
      inspectorOpen={false}
      onToggleInspector={() => undefined}
      onRename={async () => null}
      onPin={async () => null}
      repliesMute={
        repliesMute
          ? { ...repliesMute, busy: false, toggle: () => toggles.push(repliesMute.muted) }
          : null
      }
    />
  );
  const items = () =>
    [...container.querySelectorAll("[data-menu-item]")].map((item) => item.textContent?.trim());
  const item = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("[data-menu-item]")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  try {
    // Not offered where it doesn't apply.
    await act(async () => root.render(render(null)));
    expect(items()).toContain("Rename");
    expect(items()).not.toContain("Mute replies");
    expect(items()).not.toContain("Unmute replies");
    await act(async () => root.render(render({ muted: false })));
    await act(async () => item("Mute replies")!.click());
    expect(toggles).toEqual([false]);
    await act(async () => root.render(render({ muted: true })));
    expect(items()).toContain("Unmute replies");
    expect(items()).not.toContain("Mute replies");
    // A run of a schedule that starts a new chat each time: the mute covers
    // the schedule, and the menu says so.
    await act(async () => root.render(render({ muted: false, scope: "schedule" })));
    await act(async () => item("Mute this automation's replies")!.click());
    expect(toggles).toEqual([false, false]);
    await act(async () => root.render(render({ muted: true, scope: "schedule" })));
    expect(items()).toContain("Unmute this automation's replies");
    expect(items()).not.toContain("Unmute replies");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
