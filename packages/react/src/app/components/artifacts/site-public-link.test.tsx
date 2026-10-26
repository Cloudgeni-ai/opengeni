import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  createContext,
  useContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SitePublicationLink } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import type { SitePublicationLinkLoad } from "./site-public-link";

// The menu renders open, so its rows can be read and clicked directly. A row
// closes it as Radix does, calling onCloseAutoFocus unless it kept it open.
// The real menu is tested in site-public-link-menu.test.tsx.
const MenuClosed = createContext<((event: Event) => void) | undefined>(undefined);
function MockMenuItem({
  children,
  onSelect,
  asChild,
}: {
  children: ReactNode;
  onSelect?: (event: ReactMouseEvent) => void;
  asChild?: boolean;
}) {
  const closed = useContext(MenuClosed);
  return asChild ? (
    children
  ) : (
    <button
      type="button"
      role="menuitem"
      onClick={(event) => {
        onSelect?.(event);
        if (!event.defaultPrevented) closed?.(new Event("focus", { cancelable: true }));
      }}
    >
      {children}
    </button>
  );
}
mock.module("../../../ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (event: Event) => void;
  }) => (
    <MenuClosed.Provider value={onCloseAutoFocus}>
      <div role="menu">{children}</div>
    </MenuClosed.Provider>
  ),
  DropdownMenuItem: MockMenuItem,
  DropdownMenuLabel: ({ children, title }: { children: ReactNode; title?: string }) => (
    <p data-menu-label="" title={title}>
      {children}
    </p>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

let module: typeof import("./site-public-link");
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  module = await import("./site-public-link");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const publicationLink = (patch: Partial<SitePublicationLink> = {}): SitePublicationLink => ({
  siteId: "site",
  hostname: "newsletter-4k9x.sites.example",
  url: "https://newsletter-4k9x.sites.example/",
  status: "active",
  ...patch,
});
const ready = (patch: Partial<SitePublicationLink> = {}): SitePublicationLinkLoad => ({
  state: "ready",
  link: publicationLink(patch),
});

let mounted: { root: Root; host: HTMLElement } | null = null;
async function unmount() {
  if (!mounted) return;
  const { root, host } = mounted;
  await act(async () => root.unmount());
  host.remove();
  mounted = null;
}
afterEach(unmount);

async function render(
  load: SitePublicationLinkLoad,
  props: {
    canPublish?: boolean;
    onOpenPublishing?: () => void;
    openExternal?: (url: string) => boolean;
  } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () =>
    root.render(
      <module.SitePublicationControl
        load={load}
        canPublish={props.canPublish ?? true}
        onOpenPublishing={props.onOpenPublishing ?? (() => {})}
        {...(props.openExternal ? { openExternal: props.openExternal } : {})}
      />,
    ),
  );
  return host;
}

/**
 * Click and report whether the component cancelled it. A document listener,
 * after React's root listener, records that and then stops the test DOM
 * from navigating.
 */
async function clickPrevented(target: HTMLElement, init: MouseEventInit): Promise<boolean> {
  let prevented: boolean | null = null;
  const record = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", record, { once: true });
  await act(
    async () =>
      void target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
      ),
  );
  document.removeEventListener("click", record);
  return prevented!;
}

const trigger = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[data-site-publication="published"]');
const openRow = (host: HTMLElement) => host.querySelector<HTMLAnchorElement>("a[href]");
const row = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.startsWith(text),
  ) ?? null;

test("a published Site says Published, and its menu names the address and opens it", async () => {
  const host = await render(ready(), { openExternal: () => false });
  expect(trigger(host)!.textContent).toBe("Published");
  expect(trigger(host)!.getAttribute("aria-label")).toBe(
    "Published at newsletter-4k9x.sites.example",
  );
  // Never the old "Live", which reads as the live preview.
  expect(host.textContent).not.toContain("Live");
  const label = host.querySelector<HTMLElement>("[data-menu-label]")!;
  expect(label.textContent).toBe("newsletter-4k9x.sites.example");
  expect(label.title).toBe("https://newsletter-4k9x.sites.example/");
  const link = openRow(host)!;
  expect(link.textContent).toBe("Open");
  expect(link.getAttribute("href")).toBe("https://newsletter-4k9x.sites.example/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  // On the web the anchor itself opens the tab: the click isn't cancelled.
  expect(await clickPrevented(link, {})).toBe(false);
});

test("Copy link copies the address and says Copied in the open menu, then settles back", async () => {
  const writes: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void writes.push(text) },
  });
  try {
    const host = await render(ready());
    const copy = row(host, "Copy link")!;
    // The menu stays open (its select is cancelled) so the confirmation shows.
    expect(await clickPrevented(copy, {})).toBe(true);
    expect(writes).toEqual(["https://newsletter-4k9x.sites.example/"]);
    expect(copy.textContent).toBe("Copied");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Link copied");
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 2100)));
    expect(copy.textContent).toBe("Copy link");
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("a copy the browser refuses says it couldn't copy", async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const previousExec = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  try {
    const host = await render(ready());
    await act(async () => row(host, "Copy link")!.click());
    expect(row(host, "Couldn't copy")).not.toBeNull();
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Couldn't copy the link");
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (previousExec) Object.defineProperty(document, "execCommand", previousExec);
    else Reflect.deleteProperty(document, "execCommand");
  }
});

test("Publishing settings opens the publish form, only for people who can publish", async () => {
  let opened = 0;
  const host = await render(ready(), { onOpenPublishing: () => (opened += 1) });
  await act(async () => row(host, "Publishing settings")!.click());
  expect(opened).toBe(1);
  await unmount();

  const viewer = await render(ready(), {
    canPublish: false,
    openExternal: () => false,
    onOpenPublishing: () => (opened += 1),
  });
  // Someone who can open the Site but not publish still opens and copies it.
  expect(trigger(viewer)!.textContent).toBe("Published");
  expect(openRow(viewer)!.getAttribute("href")).toBe("https://newsletter-4k9x.sites.example/");
  expect(row(viewer, "Copy link")).not.toBeNull();
  expect(row(viewer, "Publishing settings")).toBeNull();
  expect(viewer.querySelector("hr")).toBeNull();
});

test("a custom hostname uses the primary URL the publication API reports", async () => {
  const load = ready({
    hostname: "newsletter.sites.example",
    url: "https://news.acme.example/",
  });
  expect(module.publishedSiteLink(load)).toEqual({
    url: "https://news.acme.example/",
    hostname: "news.acme.example",
  });
  const host = await render(load);
  expect(openRow(host)!.getAttribute("href")).toBe("https://news.acme.example/");
  expect(host.querySelector("[data-menu-label]")!.textContent).toBe("news.acme.example");
  expect(trigger(host)!.getAttribute("aria-label")).toBe("Published at news.acme.example");
});

test("an unpublished Site offers Publish to people who can, and nothing to anyone else", async () => {
  for (const load of [{ state: "none" } as const, ready({ status: "unpublished" })]) {
    let opened = 0;
    const host = await render(load, { onOpenPublishing: () => (opened += 1) });
    expect(trigger(host)).toBeNull();
    expect(host.querySelector("a[href]")).toBeNull();
    const publish = host.querySelector<HTMLButtonElement>('[data-site-publication="unpublished"]')!;
    // One word, no "Not published" beside it: Publish says it isn't.
    expect(host.textContent).toBe("Publish");
    await act(async () => publish.click());
    expect(opened).toBe(1);
    await unmount();
  }
  const host = await render({ state: "none" }, { canPublish: false });
  expect(host.innerHTML).toBe("");
  expect(module.publishedSiteLink(ready({ status: "suspended" }))).toBeNull();
  expect(module.publishedSiteLink({ state: "loading" })).toBeNull();
});

test("nothing shows until the answer, or when publishing isn't available", async () => {
  for (const load of [
    { state: "loading" },
    { state: "unavailable" },
    { state: "forbidden" },
    { state: "error", error: new Error("boom") },
  ] as const) {
    const host = await render(load);
    expect(host.innerHTML).toBe("");
    await unmount();
  }
});

test("a taken-down Site says so, with no link; its settings are for people who can publish", async () => {
  let opened = 0;
  const host = await render(ready({ status: "suspended" }), {
    onOpenPublishing: () => (opened += 1),
  });
  expect(host.textContent).toBe("Taken down");
  expect(host.querySelector("a")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(opened).toBe(1);
  await unmount();
  const viewer = await render(ready({ status: "suspended" }), { canPublish: false });
  expect(viewer.textContent).toBe("Taken down");
  expect(viewer.querySelector("button")).toBeNull();
});

test("in the desktop app Open opens the default browser through the shell", async () => {
  const opened: string[] = [];
  const bridge = {
    openExternal: async (url: string) => {
      opened.push(url);
    },
  };
  expect(module.openPublishedSite("https://a.example/", bridge)).toBe(true);
  expect(module.openPublishedSite("https://a.example/", null)).toBe(false);
  expect(opened).toEqual(["https://a.example/"]);

  const host = await render(ready(), {
    openExternal: (url) => module.openPublishedSite(url, bridge),
  });
  // The shell opened it, so the page itself doesn't navigate.
  expect(await clickPrevented(openRow(host)!, {})).toBe(true);
  expect(opened).toEqual(["https://a.example/", "https://newsletter-4k9x.sites.example/"]);
  // A modified click keeps the browser's own behaviour.
  expect(await clickPrevented(openRow(host)!, { metaKey: true })).toBe(false);
  expect(opened).toHaveLength(2);
});

test("the header reads the Site's address with the viewer's own read, not the publisher API", async () => {
  const calls: string[] = [];
  const answers: Array<() => Promise<SitePublicationLink>> = [
    async () => publicationLink(),
    async () => {
      throw new OpenGeniApiError(404, JSON.stringify({ error: { code: "site_not_published" } }));
    },
    async () => {
      throw new OpenGeniApiError(
        404,
        JSON.stringify({ error: { code: "sites_publishing_disabled" } }),
      );
    },
    // An older API without the route: never Publish for a Site that may be live.
    async () => {
      throw new OpenGeniApiError(404, "Not Found");
    },
  ];
  const client = {
    getSitePublicationLink: (workspaceId: string, siteId: string) => {
      calls.push(`${workspaceId}/${siteId}`);
      return answers.shift()!();
    },
  };
  const seen: SitePublicationLinkLoad[] = [];
  function Probe({ siteId }: { siteId: string }) {
    seen.push(module.useSitePublicationLink({ client, workspaceId: "ws", siteId }).load);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  for (const siteId of ["a", "b", "c", "d"]) {
    await act(async () => root.render(<Probe siteId={siteId} />));
    await act(async () => await Promise.resolve());
  }
  expect(calls).toEqual(["ws/a", "ws/b", "ws/c", "ws/d"]);
  const settled = seen.filter((load) => load.state !== "loading").map((load) => load.state);
  expect(settled).toEqual(["ready", "none", "unavailable", "unavailable"]);
});

test("a late answer for the previous Site never shows on the next one", async () => {
  const pending = new Map<string, (link: SitePublicationLink) => void>();
  const client = {
    getSitePublicationLink: (_workspaceId: string, siteId: string) =>
      new Promise<SitePublicationLink>((resolve) => pending.set(siteId, resolve)),
  };
  let latest = { state: "loading" } as SitePublicationLinkLoad;
  function Probe({ siteId }: { siteId: string }) {
    latest = module.useSitePublicationLink({ client, workspaceId: "ws", siteId }).load;
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<Probe siteId="a" />));
  await act(async () => root.render(<Probe siteId="b" />));
  await act(async () => pending.get("a")!(publicationLink({ url: "https://a.example/" })));
  expect(latest).toEqual({ state: "loading" });
  await act(async () => pending.get("b")!(publicationLink({ url: "https://b.example/" })));
  expect(latest.state === "ready" && latest.link.url).toBe("https://b.example/");

  // Coming back to the window reads the address again (published meanwhile, say).
  await act(async () => void window.dispatchEvent(new Event("focus")));
  expect([...pending.keys()]).toEqual(["a", "b"]);
  await act(async () => pending.get("b")!(publicationLink({ status: "unpublished" })));
  expect(latest.state === "ready" && latest.link.status).toBe("unpublished");
});

test("a publication changed here shows at once, and a read already on its way can't undo it", async () => {
  const pending: Array<(link: SitePublicationLink) => void> = [];
  const client = {
    getSitePublicationLink: () =>
      new Promise<SitePublicationLink>((resolve) => pending.push(resolve)),
  };
  let latest: ReturnType<typeof module.useSitePublicationLink> | null = null;
  function Probe() {
    latest = module.useSitePublicationLink({ client, workspaceId: "ws", siteId: "site" });
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<Probe />));
  expect(latest!.load).toEqual({ state: "loading" });
  await act(async () =>
    latest!.update({
      siteId: "site",
      hostname: "fresh.sites.example",
      url: "https://fresh.sites.example/",
      status: "active",
    }),
  );
  expect(module.publishedSiteLink(latest!.load)?.hostname).toBe("fresh.sites.example");
  // The read from before the publish answers "not published": it is stale.
  await act(async () => pending[0]!(publicationLink({ status: "unpublished" })));
  expect(module.publishedSiteLink(latest!.load)?.hostname).toBe("fresh.sites.example");
});
