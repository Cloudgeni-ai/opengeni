import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

import type { AppContextValue } from "../../app-context";
import type { Session } from "../../types";

// The real menus: Radix reads the DOM when it loads, so everything that
// renders is imported once the DOM exists.
let React: typeof import("react");
let createReactRoot: typeof import("react-dom/client").createRoot;
let AppContext: typeof import("../../app-context").AppContext;
let SessionHeader: typeof import("./session-header").SessionHeader;
let ownsDom = false;
let copied: string[] = [];
let clipboard: PropertyDescriptor | undefined;

beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  React = await import("react");
  ({ createRoot: createReactRoot } = await import("react-dom/client"));
  ({ AppContext } = await import("../../app-context"));
  ({ SessionHeader } = await import("./session-header"));
  clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
});

afterAll(() => {
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  if (ownsDom) GlobalRegistrator.unregister();
});

afterEach(() => {
  copied = [];
  document.body.innerHTML = "";
});

// None of these actions reads the app context; any read fails loudly.
const appContext = new Proxy({} as AppContextValue, {
  get(_target, key) {
    throw new Error(`The SessionHeader copy test's app context has no ${String(key)}`);
  },
});

const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  initialMessage: "Run the usage report.",
  title: "Quarterly usage review",
  titleSource: "user",
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Waits, a frame at a time, for what the UI does after a menu has closed. */
async function waitForElement<T extends Element>(find: () => T | null): Promise<T | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = find();
    if (found) return found;
    await React.act(settle);
  }
  return find();
}

async function renderHeader() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createReactRoot(container);
  const node: ReactNode = (
    <AppContext.Provider value={appContext}>
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
      />
    </AppContext.Provider>
  );
  await React.act(async () => root.render(node));
  return {
    container,
    unmount: () => React.act(async () => root.unmount()),
  };
}

const menuItems = (selector: string) => [
  ...document.querySelectorAll<HTMLElement>(`${selector} [role='menuitem']`),
];
const click = (element: HTMLElement) =>
  React.act(async () => {
    element.click();
    await settle();
  });

test("right-clicking the title copies it, copies the chat's link or renames it", async () => {
  const { container, unmount } = await renderHeader();
  const openMenu = () =>
    React.act(async () => {
      container.querySelector("[data-session-title-text]")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
      await settle();
    });
  try {
    await openMenu();
    const items = menuItems("[data-session-title-menu]");
    expect(items.map((item) => item.textContent)).toEqual(["Copy title", "Copy link", "Rename"]);
    await click(items[0]!);
    expect(copied).toEqual(["Quarterly usage review"]);
    expect(document.querySelector("[data-session-title-menu]")).toBeNull();

    // Rename opens the field once the menu has closed, with the title in it.
    await openMenu();
    await click(menuItems("[data-session-title-menu]")[2]!);
    const field = await waitForElement(() => container.querySelector<HTMLInputElement>("input"));
    expect(field?.value).toBe("Quarterly usage review");
  } finally {
    await unmount();
  }
});

test("the header's menu copies the chat's title, after its link", async () => {
  const { container, unmount } = await renderHeader();
  try {
    await React.act(async () => {
      container
        .querySelector('[aria-label="More session actions"]')!
        .dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
        );
      await settle();
    });
    const items = menuItems("[role='menu']");
    const labels = items.map((item) => item.textContent?.trim() ?? "");
    const copyTitle = labels.indexOf("Copy title");
    expect(copyTitle).toBeGreaterThan(0);
    expect(labels[copyTitle - 1]).toStartWith("Copy link");
    await click(items[copyTitle]!);
    expect(copied).toEqual(["Quarterly usage review"]);
  } finally {
    await unmount();
  }
});
