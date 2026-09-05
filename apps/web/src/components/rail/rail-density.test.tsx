import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const rail = {
  workspaceId: "workspace-1",
  collapsed: false,
  isMobile: false,
  setDrawerOpen: mock((_open: boolean) => undefined),
};
let pathname = "/workspaces/workspace-1/sessions/session-1";

mock.module("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));

mock.module("@/components/rail/rail-context", () => ({
  useRail: () => rail,
}));

mock.module("@/components/rail/for-you-link", () => ({
  ForYouLink: () => <a href="#for-you">For you</a>,
}));

mock.module("@/components/rail/session-list", () => ({
  NewSessionLink: ({ children, ...props }: { children: ReactNode }) => (
    <a href="#new-session" {...props}>
      {children}
    </a>
  ),
}));

mock.module("@/components/rail/workspace-config-link", () => ({
  WorkspaceConfigLink: ({ item }: { item: { label: string } }) => (
    <a data-workspace-shortcut="true" href={`#${item.label.toLowerCase()}`}>
      {item.label}
    </a>
  ),
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { PrimaryNav, WorkspaceShortcutLinks } = await import("./primary-nav");
const railShell = await Bun.file(new URL("./rail-shell.tsx", import.meta.url)).text();

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  rail.collapsed = false;
  rail.isMobile = false;
  pathname = "/workspaces/workspace-1/sessions/session-1";
  rail.setDrawerOpen.mockClear();
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, root };
}

function exploreDisclosure(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Explore",
  );
  if (!button) throw new Error("Missing Explore disclosure");
  return button;
}

function showLessButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Show less",
  );
  if (!button) throw new Error("Missing Show less control");
  return button;
}

describe("session-first rail density", () => {
  test("defaults desktop shortcuts open and remembers when the user collapses them", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    const first = await render(<PrimaryNav />);
    try {
      expect(first.container.textContent).not.toContain("Explore");
      expect(first.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(4);

      await act(async () => showLessButton(first.container).click());
      expect(exploreDisclosure(first.container).getAttribute("aria-expanded")).toBe("false");
      expect(first.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(0);
      expect(window.localStorage.getItem("opengeni.rail.nav")).toBe("false");
    } finally {
      await act(async () => first.root.unmount());
      first.container.remove();
    }

    const persisted = await render(<PrimaryNav />);
    try {
      expect(exploreDisclosure(persisted.container).getAttribute("aria-expanded")).toBe("false");
      expect(persisted.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(
        0,
      );
    } finally {
      await act(async () => persisted.root.unmount());
      persisted.container.remove();
    }
  });

  test("keeps workspace shortcuts out of the mobile Sessions section", async () => {
    rail.isMobile = true;
    const primary = await render(<PrimaryNav />);
    try {
      expect(primary.container.textContent).toContain("New session");
      expect(primary.container.textContent).not.toContain("For you");
      expect(primary.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(
        0,
      );
      expect(primary.container.querySelector("button[aria-expanded]")).toBeNull();
    } finally {
      await act(async () => primary.root.unmount());
      primary.container.remove();
    }

    const workspace = await render(<WorkspaceShortcutLinks />);
    try {
      expect(workspace.container.textContent).toContain("For you");
      expect(workspace.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(
        4,
      );
      expect(railShell).toMatch(
        /id="mobile-nav-panel-workspace"[\s\S]*?<SwitcherBlock \/>[\s\S]*?<WorkspaceShortcutLinks className="px-2" \/>/,
      );
      expect(railShell).toMatch(/\{rail\.isMobile \? null : <SwitcherBlock \/>\}/);
    } finally {
      await act(async () => workspace.root.unmount());
      workspace.container.remove();
    }
  });

  test("identifies an active shortcut when the compact disclosure hides its link", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    window.localStorage.setItem("opengeni.rail.nav", "false");
    pathname = "/workspaces/workspace-1/plugins";
    const rendered = await render(<PrimaryNav />);
    try {
      const disclosure = exploreDisclosure(rendered.container);
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure.getAttribute("data-active")).toBe("true");
      expect(disclosure.getAttribute("aria-label")).toBe("Explore, current section Plugins");
      expect(rendered.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(
        0,
      );
    } finally {
      await act(async () => rendered.root.unmount());
      rendered.container.remove();
    }
  });

  test("identifies For you when the compact disclosure hides its link", async () => {
    window.localStorage.setItem("opengeni.rail.nav", "false");
    pathname = "/workspaces/workspace-1/priority";
    const rendered = await render(<PrimaryNav />);
    try {
      const disclosure = exploreDisclosure(rendered.container);
      expect(disclosure.getAttribute("data-active")).toBe("true");
      expect(disclosure.getAttribute("aria-label")).toBe("Explore, current section For you");
    } finally {
      await act(async () => rendered.root.unmount());
      rendered.container.remove();
    }
  });
});
