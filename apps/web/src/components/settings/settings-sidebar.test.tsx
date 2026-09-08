import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    ...props
  }: {
    children: ReactNode;
    to: unknown;
    params: unknown;
  }) => (
    <a {...props} href="#sessions">
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
