import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

// The macOS window bar names where a page is ("Agents › Meeting preparation"),
// not only its title, and a detail page keeps its own heading.
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
let React: typeof import("react");
let ReactDomClient: typeof import("react-dom/client");
let windowBar: typeof import("../app/components/window-bar");
let detail: typeof import("./detail-page");
let pageHeader: typeof import("./page-header");
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ReactDomClient = await import("react-dom/client");
  windowBar = await import("../app/components/window-bar");
  detail = await import("./detail-page");
  pageHeader = await import("./page-header");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

async function mount(node: ReactNode, check: (host: HTMLElement) => void | Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = ReactDomClient.createRoot(host);
  try {
    await React.act(async () => root.render(node));
    await check(host);
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
  }
}

const crumbs = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-window-bar-title] nav[aria-label="Location"] > span')].map(
    (each) => each.textContent,
  );
const BACK_LINK = '[data-slot="detail-page"] > a, [data-slot="detail-page"] > button';
const barTitle = (host: HTMLElement) =>
  host.querySelector("[data-window-bar-title-text]")?.textContent ?? null;

describe("windowBarTrail", () => {
  test("puts the section, then the list, before the title", () => {
    expect(
      windowBar
        .windowBarTrail("Meeting preparation", { label: "Knowledge" }, { label: "Library" })
        .map((crumb) => crumb.label),
    ).toEqual(["Knowledge", "Library"]);
  });

  test("skips a step that repeats the section or the title", () => {
    expect(
      windowBar
        .windowBarTrail("Meeting preparation", { label: "Knowledge" }, { label: "knowledge" })
        .map((crumb) => crumb.label),
    ).toEqual(["Knowledge"]);
    expect(windowBar.windowBarTrail("Agents", { label: "Agents" }, null)).toEqual([]);
  });
});

describe("page identity in the window bar", () => {
  test("a detail page's bar reads section › list › title, and the page keeps its title", async () => {
    await mount(
      <windowBar.WindowBarPageTitle enabled section={{ label: "Knowledge" }}>
        <detail.DetailPage
          back={{ label: "Meeting preparation", onClick: () => {} }}
          section={{ label: "Agents", onClick: () => {} }}
        >
          <detail.DetailPageHeader title="Memory" />
        </detail.DetailPage>
      </windowBar.WindowBarPageTitle>,
      (host) => {
        expect(crumbs(host)).toEqual(["Agents", "Meeting preparation"]);
        expect(barTitle(host)).toBe("Memory");
        const heading = host.querySelector('[data-slot="detail-page-title"]');
        expect(heading?.textContent).toBe("Memory");
        expect(heading?.className ?? "").not.toContain("sr-only");
        // The back link is the bar's trail now, not drawn twice.
        expect(host.querySelector(BACK_LINK)).toBeNull();
      },
    );
  });

  test("without the bar (the web app), the detail page keeps its back link", async () => {
    await mount(
      <windowBar.WindowBarPageTitle enabled={false}>
        <detail.DetailPage back={{ label: "Library", onClick: () => {} }}>
          <detail.DetailPageHeader title="Meeting preparation" />
        </detail.DetailPage>
      </windowBar.WindowBarPageTitle>,
      (host) => {
        expect(host.querySelector("[data-window-bar-title]")).toBeNull();
        expect(host.querySelector(BACK_LINK)?.textContent).toContain("Library");
      },
    );
  });

  test("a section page shows its section in the bar and hides its duplicate title", async () => {
    await mount(
      <windowBar.WindowBarPageTitle enabled section={{ label: "Agents" }}>
        <pageHeader.PageHeader title="Agents" />
      </windowBar.WindowBarPageTitle>,
      (host) => {
        expect(crumbs(host)).toEqual([]);
        expect(barTitle(host)).toBe("Agents");
        expect(host.querySelector('[data-slot="page-header"]')?.className ?? "").toContain(
          "sr-only",
        );
      },
    );
  });

  test("a page header inside a detail page keeps its title on the page", async () => {
    await mount(
      <windowBar.WindowBarPageTitle enabled section={{ label: "Settings" }}>
        <detail.DetailPage back={{ label: "Integrations", onClick: () => {} }}>
          <pageHeader.PageHeader title="Gmail" />
        </detail.DetailPage>
      </windowBar.WindowBarPageTitle>,
      (host) => {
        expect(crumbs(host)).toEqual(["Settings", "Integrations"]);
        expect(host.querySelector('[data-slot="page-header"]')?.className ?? "").not.toContain(
          "sr-only",
        );
      },
    );
  });
});
