import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { workspaceId: string };
  }) => (
    <a {...props} href={to.replace("$workspaceId", params?.workspaceId ?? "")}>
      {children}
    </a>
  ),
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { SettingsSidebar } = await import("./settings-sidebar");
const originalMatchMedia = window.matchMedia;
let narrow = true;
let media: ReturnType<typeof window.matchMedia>;
beforeAll(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
  media = originalMatchMedia.call(window, "(max-width: 1023px)");
  Object.defineProperty(media, "matches", { get: () => narrow });
  window.matchMedia = () => media;
});

test("organization back control returns to workspace settings on desktop and mobile", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const isNarrow of [false, true]) {
      narrow = isNarrow;
      await act(async () => {
        root.render(
          <SettingsSidebar
            workspaceId="origin-workspace"
            backToWorkspaceSettings
            label="Organization settings"
            currentPage="Overview"
            identity="Organization"
          >
            <nav />
          </SettingsSidebar>,
        );
        media.dispatchEvent(new Event("change"));
      });
      const back = container.querySelector<HTMLAnchorElement>(
        'a[href="/workspaces/origin-workspace/settings"]',
      );
      expect(back).not.toBeNull();
      expect(isNarrow ? back?.getAttribute("aria-label") : back?.textContent).toBe(
        "Back to workspace settings",
      );
      if (!isNarrow) {
        expect(
          container.querySelector('a[href="/workspaces/origin-workspace/sessions"]')?.textContent,
        ).toContain("OpenGeni");
      }
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
  mock.restore();
  GlobalRegistrator.unregister();
});

test("narrow settings keep navigation in a dismissible drawer and restore the desktop sidebar", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (currentPage = "General") => (
    <SettingsSidebar
      workspaceId="workspace"
      label="Workspace settings"
      currentPage={currentPage}
      identity={<button>Switch workspace</button>}
    >
      <nav aria-label="Settings pages">
        <a href="#models">Models</a>
      </nav>
    </SettingsSidebar>
  );
  const open = async () => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open workspace settings menu"]')!
        .click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  };
  try {
    await act(async () => root.render(render()));
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector('a[aria-label="Back to sessions"]')?.getAttribute("href")).toBe(
      "/workspaces/workspace/sessions",
    );
    expect(container.textContent).toContain("General");
    expect(document.body.textContent).not.toContain("Switch workspace");
    await open();
    expect(document.body.textContent).toContain("Switch workspace");
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="#models"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await open();
    await act(async () => root.render(render("Models")));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await open();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await open();
    await act(async () => {
      narrow = false;
      media.dispatchEvent(new Event("change"));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("aside")).not.toBeNull();
    expect(container.querySelector('button[aria-label="Open workspace settings menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("settings without a workspace return to OpenGeni", async () => {
  narrow = false;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <SettingsSidebar label="Personal settings" currentPage="General" identity="You">
          <nav />
        </SettingsSidebar>,
      ),
    );
    const back = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent === "Back to OpenGeni",
    );
    expect(back?.getAttribute("href")).toBe("/");
  } finally {
    await act(async () => root.unmount());
  }
});
