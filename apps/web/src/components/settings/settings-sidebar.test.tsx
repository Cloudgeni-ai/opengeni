import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search: _search,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    params?: { workspaceId: string };
    search?: unknown;
  }) => (
    <a {...props} href={to.replace("$workspaceId", params?.workspaceId ?? "")}>
      {children}
    </a>
  ),
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { Link } = await import("@tanstack/react-router");
const { SettingsShell, settingsHomeLink } = await import("./settings-sidebar");
const { SlidersHorizontalIcon, SparklesIcon } = await import("lucide-react");
const originalMatchMedia = window.matchMedia;
let narrow = true;
let media: ReturnType<typeof window.matchMedia>;
beforeAll(() => {
  media = originalMatchMedia.call(window, "(max-width: 1023px)");
  Object.defineProperty(media, "matches", { get: () => narrow });
  window.matchMedia = () => media;
});
afterAll(() => {
  window.matchMedia = originalMatchMedia;
  mock.restore();
  GlobalRegistrator.unregister();
});

function shell(currentPage = "General", page: { title: string } | null = { title: currentPage }) {
  return (
    // The application owns the main landmark; settings supplies a named region.
    <main>
      <SettingsShell
        label="Workspace settings"
        back={{
          label: "Back to sessions",
          link: (
            <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId: "workspace" }} />
          ),
        }}
        home={settingsHomeLink("workspace")}
        scope={<button type="button">Switch workspace</button>}
        groups={[
          {
            items: [
              {
                id: "general",
                label: "General",
                icon: SlidersHorizontalIcon,
                link: <a href="#general" />,
              },
              { id: "models", label: "Models", icon: SparklesIcon, link: <a href="#models" /> },
            ],
          },
        ]}
        activeId={currentPage === "Models" ? "models" : "general"}
        currentPage={currentPage}
        page={page}
      >
        <p>Page body</p>
      </SettingsShell>
    </main>
  );
}

test("desktop settings draw the settings rail in place of the main rail, with a way back", async () => {
  narrow = false;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(shell()));
    const rail = container.querySelector('nav[aria-label="Workspace settings"]');
    expect(rail).not.toBeNull();
    expect(rail?.getAttribute("data-variant")).toBe("rail");
    const back = Array.from(rail!.querySelectorAll("a")).find(
      (link) => link.textContent === "Back to sessions",
    );
    expect(back?.getAttribute("href")).toBe("/workspaces/workspace/sessions");
    expect(rail?.querySelector('a[aria-label="Opengeni home"]')?.getAttribute("href")).toBe(
      "/workspaces/workspace/sessions",
    );
    expect(rail?.textContent).toContain("Switch workspace");
    expect(rail?.querySelector('a[href="#general"]')?.getAttribute("aria-current")).toBe("page");
    // The page renders full width beside the rail with its own header.
    const content = container.querySelector('section[aria-label="General"]');
    expect(content).not.toBeNull();
    expect(content?.querySelector("h1")?.textContent).toBe("General");
    expect(content?.textContent).toContain("Page body");
    expect(content?.contains(rail)).toBe(false);
    expect(content?.closest("main")).not.toBeNull();
    expect(container.querySelectorAll('main, [role="main"]').length).toBe(1);
    expect(container.querySelector('button[aria-label="Open workspace settings menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("narrow settings keep navigation in a dismissible drawer and restore the desktop rail", async () => {
  narrow = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const open = async () => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Open workspace settings menu"]')!
        .click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  };
  try {
    await act(async () => root.render(shell()));
    const content = container.querySelector('section[aria-label="General"]');
    expect(content?.querySelector("h1")?.textContent).toBe("General");
    expect(content?.textContent).toContain("Page body");
    expect(container.querySelectorAll('main, [role="main"]').length).toBe(1);
    expect(container.querySelector('nav[aria-label="Workspace settings"]')).toBeNull();
    expect(container.querySelector('a[aria-label="Back to sessions"]')?.getAttribute("href")).toBe(
      "/workspaces/workspace/sessions",
    );
    expect(container.querySelector("header")?.textContent).toContain("General");
    expect(document.body.textContent).not.toContain("Switch workspace");
    await open();
    expect(document.body.textContent).toContain("Switch workspace");
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="#models"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await open();
    await act(async () => root.render(shell("Models")));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('section[aria-label="General"]')).toBeNull();
    expect(container.querySelector('section[aria-label="Models"] h1')?.textContent).toBe("Models");
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
    expect(container.querySelector('nav[aria-label="Workspace settings"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Open workspace settings menu"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a sub-page brings its own header", async () => {
  narrow = false;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(shell("Models", null)));
    const content = container.querySelector('section[aria-label="Models"]');
    expect(content).not.toBeNull();
    expect(content?.querySelector("h1")).toBeNull();
    expect(content?.textContent).toContain("Page body");
    expect(content?.closest("main")).not.toBeNull();
    expect(container.querySelectorAll('main, [role="main"]').length).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});
