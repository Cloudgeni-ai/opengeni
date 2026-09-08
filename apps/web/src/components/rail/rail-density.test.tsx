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
const originalMatchMedia = window.matchMedia;
window.matchMedia = (query) => {
  const media = originalMatchMedia.call(window, query);
  Object.defineProperty(media, "matches", { get: () => window.innerHeight < 720 });
  return media;
};
const railShell = await Bun.file(new URL("./rail-shell.tsx", import.meta.url)).text();

afterAll(() => {
  window.matchMedia = originalMatchMedia;
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

function moreDisclosure(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "More",
  );
  if (!button) throw new Error("Missing More disclosure");
  return button;
}

function lessButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === "Less",
  );
  if (!button) throw new Error("Missing Less control");
  return button;
}

describe("session-first rail density", () => {
  test("shows all shortcuts on tall screens regardless of the saved compact choice", async () => {
    window.localStorage.setItem("opengeni.rail.nav", "false");
    const rendered = await render(<PrimaryNav />);
    try {
      expect(rendered.container.textContent).toContain("For you");
      expect(rendered.container.textContent).toContain("Plugins");
      expect(rendered.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(
        4,
      );
      expect(rendered.container.querySelector("button[aria-expanded]")).toBeNull();
    } finally {
      await act(async () => rendered.root.unmount());
    }
  });

  test("offers More and Less on short screens and remembers the compact-screen choice", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    const first = await render(<PrimaryNav />);
    try {
      expect(moreDisclosure(first.container).getAttribute("aria-expanded")).toBe("false");
      expect(first.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(0);
      await act(async () => moreDisclosure(first.container).click());
      expect(first.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(4);
      expect(lessButton(first.container).getAttribute("aria-expanded")).toBe("true");
      await act(async () => lessButton(first.container).click());
      expect(window.localStorage.getItem("opengeni.rail.nav")).toBe("false");
    } finally {
      await act(async () => first.root.unmount());
    }
    const persisted = await render(<PrimaryNav />);
    try {
      expect(moreDisclosure(persisted.container).getAttribute("aria-expanded")).toBe("false");
    } finally {
      await act(async () => persisted.root.unmount());
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
      const disclosure = moreDisclosure(rendered.container);
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      expect(disclosure.getAttribute("data-active")).toBe("true");
      expect(disclosure.getAttribute("aria-label")).toBe("More, current section Plugins");
      expect(rendered.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(
        0,
      );
    } finally {
      await act(async () => rendered.root.unmount());
      rendered.container.remove();
    }
  });

  test("identifies For you when the compact disclosure hides its link", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    window.localStorage.setItem("opengeni.rail.nav", "false");
    pathname = "/workspaces/workspace-1/priority";
    const rendered = await render(<PrimaryNav />);
    try {
      const disclosure = moreDisclosure(rendered.container);
      expect(disclosure.getAttribute("data-active")).toBe("true");
      expect(disclosure.getAttribute("aria-label")).toBe("More, current section For you");
    } finally {
      await act(async () => rendered.root.unmount());
      rendered.container.remove();
    }
  });
});
