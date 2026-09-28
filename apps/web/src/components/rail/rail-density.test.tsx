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
  Link: ({
    children,
    to,
    params: _params,
    search: _search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
    search?: unknown;
  }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}));

mock.module("@/components/rail/rail-context", () => ({
  useRail: () => rail,
}));

let needsYou = 0;
mock.module("@/components/rail/for-you-link", () => ({
  ForYouLink: () => <a href="#for-you">For you</a>,
  ForYouRailLink: () => <a href="#for-you">For you</a>,
  useForYouNeedsCount: () => needsYou,
}));
let pendingKnowledge = false;
mock.module("./use-knowledge-review-indicator", () => ({
  useKnowledgeReviewIndicator: () => pendingKnowledge,
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
  WorkspaceConfigGlyph: () => null,
}));

const client = { listKnowledgeEntries: async () => ({ entries: [] }) };
mock.module("@/context", () => ({
  useAppContext: () => ({
    client,
    accessContext: { subjectId: "subject-1", workspaceGrants: [] },
  }),
}));
/** Agents, Schedules, Artifacts, Knowledge, Capabilities and Settings; Insights is for admins. */
const MEMBER_SHORTCUTS = 6;

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { PrimaryNav, WorkspaceShortcutLinks } = await import("./primary-nav");
const railHeader = await Bun.file(new URL("./rail-header.tsx", import.meta.url)).text();
const railShell = await Bun.file(new URL("./rail-shell.tsx", import.meta.url)).text();

describe("rail overflow boundaries", () => {
  test("contains scrolling session controls below an opaque, non-shrinking footer", () => {
    expect(railShell).toContain(
      "isolate flex h-full min-h-0 flex-col overflow-hidden bg-surface/40",
    );
    expect(railShell).toMatch(
      /data-rail-scroll-viewport\s+className="relative z-0 min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain"/,
    );
    expect(railShell).toMatch(
      /data-rail-footer\s+className="relative z-10 shrink-0 border-t border-border bg-surface"/,
    );
  });
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  needsYou = 0;
  pendingKnowledge = false;
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

function railLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("a, button")].map((node) =>
    node.hasAttribute("data-rail-more") ? "More" : (node.textContent ?? "").trim(),
  );
}

function moreButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button[data-rail-more]");
  if (!button) throw new Error("Missing More");
  return button;
}

async function openMore(container: HTMLElement) {
  const button = moreButton(container);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
}

describe("brief rail", () => {
  test("shows the default destinations, then More, with Settings last", async () => {
    const rendered = await render(<PrimaryNav />);
    try {
      expect(railLabels(rendered.container)).toEqual([
        "New session",
        "Schedules",
        "Artifacts",
        "Knowledge",
        "Capabilities",
        "More",
        "Settings",
      ]);
    } finally {
      await act(async () => rendered.root.unmount());
    }
  });

  test("More lists the hidden destinations and Customize rail", async () => {
    const rendered = await render(<PrimaryNav />);
    try {
      await openMore(rendered.container);
      const menu = document.querySelector('[role="menu"]');
      expect(menu).not.toBeNull();
      const items = [...menu!.querySelectorAll('[role="menuitem"]')].map((node) =>
        (node.textContent ?? "").trim(),
      );
      expect(items).toEqual(["For you", "Agents", "Customize rail"]);
    } finally {
      await act(async () => rendered.root.unmount());
    }
  });

  test("Customize rail saves the checked destinations for this person", async () => {
    const rendered = await render(<PrimaryNav />);
    try {
      await openMore(rendered.container);
      const customize = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (node) => node.textContent?.trim() === "Customize rail",
      )!;
      await act(async () => customize.click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain("Customize rail");
      const box = (label: string) =>
        [...dialog!.querySelectorAll<HTMLLabelElement>("label")]
          .find((node) => node.textContent === label)!
          .closest("div")!
          .querySelector<HTMLInputElement>("input")!;
      expect(box("Schedules").checked).toBe(true);
      expect(box("Agents").checked).toBe(false);
      await act(async () => box("Agents").click());
      await act(async () => box("Artifacts").click());
      const form = dialog!.querySelector("form")!;
      await act(async () => {
        form.requestSubmit();
      });
      expect(JSON.parse(window.localStorage.getItem("og.rail.destinations:v1:subject-1")!)).toEqual(
        ["agents", "schedules", "knowledge", "capabilities"],
      );
      expect(railLabels(rendered.container)).toEqual([
        "New session",
        "Agents",
        "Schedules",
        "Knowledge",
        "Capabilities",
        "More",
        "Settings",
      ]);
    } finally {
      await act(async () => rendered.root.unmount());
    }
  });

  test("uses the saved choice for this person", async () => {
    window.localStorage.setItem(
      "og.rail.destinations:v1:subject-1",
      JSON.stringify(["agents", "for-you"]),
    );
    const rendered = await render(<PrimaryNav />);
    try {
      expect(railLabels(rendered.container)).toEqual([
        "New session",
        "For you",
        "Agents",
        "More",
        "Settings",
      ]);
    } finally {
      await act(async () => rendered.root.unmount());
    }
  });

  test("surfaces the For you count and the Knowledge review on More when hidden", async () => {
    window.localStorage.setItem("og.rail.destinations:v1:subject-1", JSON.stringify(["agents"]));
    needsYou = 3;
    pendingKnowledge = true;
    const rendered = await render(<PrimaryNav />);
    try {
      const more = moreButton(rendered.container);
      expect(more.querySelector("[data-rail-more-count]")?.textContent).toBe("3");
      expect(more.querySelector("[data-rail-more-dot]")).not.toBeNull();
      expect(more.getAttribute("aria-label")).toBe("More, 3 need you, Knowledge needs review");
    } finally {
      await act(async () => rendered.root.unmount());
    }
  });

  test("keeps attention off More while those destinations are in the rail", async () => {
    needsYou = 3;
    pendingKnowledge = true;
    window.localStorage.setItem(
      "og.rail.destinations:v1:subject-1",
      JSON.stringify(["for-you", "knowledge"]),
    );
    const rendered = await render(<PrimaryNav />);
    try {
      const more = moreButton(rendered.container);
      expect(more.querySelector("[data-rail-more-count]")).toBeNull();
      expect(more.querySelector("[data-rail-more-dot]")).toBeNull();
      expect(more.getAttribute("aria-label")).toBe("More");
    } finally {
      await act(async () => rendered.root.unmount());
    }
  });

  test("marks More current when the open page is a hidden destination", async () => {
    pathname = "/workspaces/workspace-1/agents";
    const rendered = await render(<PrimaryNav />);
    try {
      const more = moreButton(rendered.container);
      expect(more.getAttribute("data-active")).toBe("true");
      expect(more.getAttribute("aria-label")).toBe("More, current section Agents");
    } finally {
      await act(async () => rendered.root.unmount());
    }
    pathname = "/workspaces/workspace-1/priority";
    const forYou = await render(<PrimaryNav />);
    try {
      expect(moreButton(forYou.container).getAttribute("aria-label")).toBe(
        "More, current section For you",
      );
    } finally {
      await act(async () => forYou.root.unmount());
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
      expect(primary.container.querySelector("button[data-rail-more]")).toBeNull();
    } finally {
      await act(async () => primary.root.unmount());
      primary.container.remove();
    }

    const workspace = await render(<WorkspaceShortcutLinks />);
    try {
      expect(workspace.container.textContent).toContain("For you");
      expect(workspace.container.querySelectorAll('[data-workspace-shortcut="true"]')).toHaveLength(
        MEMBER_SHORTCUTS,
      );
      expect(railShell).toMatch(
        /id="mobile-nav-panel-workspace"[\s\S]*?<WorkspaceShortcutLinks className="px-2" \/>/,
      );
      expect(railHeader).toMatch(/\{!rail\.collapsed \? <SwitcherBlock inline \/> : null\}/);
    } finally {
      await act(async () => workspace.root.unmount());
      workspace.container.remove();
    }
  });
});
