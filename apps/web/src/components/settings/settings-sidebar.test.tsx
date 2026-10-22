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
const { CpuIcon, SlidersHorizontalIcon, SparklesIcon } = await import("lucide-react");
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
        label="Settings"
        back={{
          label: "Back to sessions",
          link: (
            <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId: "workspace" }} />
          ),
        }}
        home={settingsHomeLink("workspace")}
        scope={<button type="button">Switch workspace</button>}
        sections={[
          {
            id: "workspace",
            label: "Workspace",
            meta: "Design preview",
            groups: [
              {
                items: [
                  {
                    id: "workspace:general",
                    label: "General",
                    icon: SlidersHorizontalIcon,
                    link: <a href="#general" />,
                  },
                  {
                    id: "workspace:models",
                    label: "Models",
                    icon: SparklesIcon,
                    link: <a href="#models" />,
                  },
                ],
              },
            ],
          },
          {
            id: "organization",
            label: "Organization",
            meta: "Acme Robotics",
            groups: [
              {
                items: [
                  {
                    id: "organization:models",
                    label: "Models",
                    icon: CpuIcon,
                    link: <a href="#organization-models" />,
                  },
                ],
              },
            ],
          },
        ]}
        activeId={currentPage === "Models" ? "workspace:models" : "workspace:general"}
        currentPage={currentPage}
        currentScope="Workspace · Design preview"
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
    const rail = container.querySelector('nav[aria-label="Settings"]');
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
    // Workspace and organization pages sit in one rail, each under its labeled section.
    const sections = Array.from(rail!.querySelectorAll<HTMLElement>("[data-settings-section]"));
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
      "Workspace",
      "Organization",
    ]);
    const [workspaceSection, organizationSection] = sections;
    // One picker sits above the sections; each section is headed by its scope and name.
    expect(workspaceSection?.textContent).not.toContain("Switch workspace");
    expect(workspaceSection?.firstElementChild?.textContent).toBe("WorkspaceDesign preview");
    expect(workspaceSection?.querySelector('a[href="#models"]')).not.toBeNull();
    expect(organizationSection?.firstElementChild?.textContent).toBe("OrganizationAcme Robotics");
    expect(organizationSection?.querySelector('a[href="#organization-models"]')).not.toBeNull();
    expect(workspaceSection?.querySelector('a[href="#organization-models"]')).toBeNull();
    // The page renders full width beside the rail with its own header.
    const content = container.querySelector('section[aria-label="General"]');
    expect(content).not.toBeNull();
    expect(content?.querySelector("h1")?.textContent).toBe("General");
    expect(content?.textContent).toContain("Page body");
    expect(content?.contains(rail)).toBe(false);
    expect(content?.closest("main")).not.toBeNull();
    expect(container.querySelectorAll('main, [role="main"]').length).toBe(1);
    expect(container.querySelector('button[aria-label="Open settings menu"]')).toBeNull();
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
        .querySelector<HTMLButtonElement>('button[aria-label="Open settings menu"]')!
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
    expect(container.querySelector('nav[aria-label="Settings"]')).toBeNull();
    expect(container.querySelector('a[aria-label="Back to sessions"]')?.getAttribute("href")).toBe(
      "/workspaces/workspace/sessions",
    );
    expect(container.querySelector("header")?.textContent).toContain("General");
    // The narrow header names the scope of the current page.
    expect(container.querySelector("header")?.textContent).toContain("Workspace · Design preview");
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
    expect(container.querySelector('nav[aria-label="Settings"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Open settings menu"]')).toBeNull();
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

test("search finds settings by name and keeps the keyboard in the rail", async () => {
  narrow = false;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const field = () =>
    container.querySelector<HTMLInputElement>('input[placeholder="Search settings"]')!;
  const type = async (value: string) => {
    await act(async () => {
      const input = field();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(
        input,
        value,
      );
      // React's change handler, as the deletion tests drive it in this DOM.
      const propsKey = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
      const onChange = propsKey
        ? (
            input as unknown as Record<
              string,
              { onChange?: (event: { target: HTMLInputElement }) => void }
            >
          )[propsKey]?.onChange
        : undefined;
      if (onChange) onChange({ target: input });
      else input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  };
  // React's key handlers from the target up, as a bubbling keydown reaches them.
  const key = async (target: Element, value: string) => {
    await act(async () => {
      let defaultPrevented = false;
      const event = {
        key: value,
        target,
        get defaultPrevented() {
          return defaultPrevented;
        },
        preventDefault: () => {
          defaultPrevented = true;
        },
      };
      for (let node: Element | null = target; node; node = node.parentElement) {
        const propsKey = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
        const handler = propsKey
          ? (node as unknown as Record<string, { onKeyDown?: (event: unknown) => void }>)[propsKey]
              ?.onKeyDown
          : undefined;
        handler?.(event);
      }
      await Promise.resolve();
    });
  };
  const results = () =>
    Array.from(container.querySelectorAll<HTMLAnchorElement>("[data-settings-search-result]"));
  try {
    await act(async () => root.render(shell()));
    const rail = container.querySelector('nav[aria-label="Settings"]')!;
    expect(field()).not.toBeNull();
    expect(rail.querySelectorAll("[data-settings-section]")).toHaveLength(2);

    // Another word for a page finds it, and says where it lives.
    await type("claude");
    expect(rail.querySelectorAll("[data-settings-section]")).toHaveLength(0);
    expect(results().map((result) => result.getAttribute("href"))).toEqual([
      "#organization-models",
    ]);
    expect(results()[0]?.textContent).toBe("ModelsOrganization");
    expect(rail.querySelector('[role="status"]')?.textContent).toBe("1 result");

    // A setting inside a page, under its page.
    await type("voice");
    expect(results().map((result) => result.textContent)).toEqual([
      "Voice inputWorkspace · General",
    ]);
    expect(results()[0]?.getAttribute("aria-current")).toBeNull();
    // The page you're on is marked as current.
    await type("general");
    expect(results()[0]?.textContent).toBe("GeneralWorkspace");
    expect(results()[0]?.getAttribute("aria-current")).toBe("page");

    // Down moves into the results, up returns to the field, Escape clears.
    await type("models");
    expect(results()).toHaveLength(2);
    await key(field(), "ArrowDown");
    expect(document.activeElement).toBe(results()[0]!);
    await key(results()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(results()[1]!);
    await key(results()[1]!, "ArrowUp");
    await key(results()[0]!, "ArrowUp");
    expect(document.activeElement).toBe(field());
    await key(field(), "ArrowDown");
    await key(results()[0]!, "Escape");
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
    expect(rail.querySelectorAll("[data-settings-section]")).toHaveLength(2);

    // Enter opens the best result, which leaves search.
    await type("models");
    const opened: (string | null)[] = [];
    results()[0]!.addEventListener("click", (event) => {
      event.preventDefault();
      opened.push((event.currentTarget as HTMLAnchorElement).getAttribute("href"));
    });
    await key(field(), "Enter");
    expect(opened).toEqual(["#models"]);
    expect(field().value).toBe("");

    // Nothing found says so, with a way back.
    await type("zebra");
    expect(rail.textContent).toContain("No settings match “zebra”.");
    expect(rail.querySelector('[role="status"]')?.textContent).toBe("0 results");
    const clear = Array.from(rail.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear search",
    )!;
    await act(async () => clear.click());
    expect(field().value).toBe("");
    expect(rail.querySelectorAll("[data-settings-section]")).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
