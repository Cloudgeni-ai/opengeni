import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SitePublicationLink } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import type { SitePublicationLinkLoad } from "./site-public-link";

// The router isn't mounted here: a Link is a plain anchor with its target.
mock.module("../../lib/navigation", () => ({
  Link: ({
    to,
    params,
    search,
    children,
    className,
  }: {
    to: string;
    params: Record<string, string>;
    search?: Record<string, string>;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      data-to={to}
      data-params={JSON.stringify(params)}
      data-search={JSON.stringify(search ?? {})}
      className={className}
    >
      {children}
    </a>
  ),
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
afterEach(async () => {
  if (!mounted) return;
  const { root, host } = mounted;
  await act(async () => root.unmount());
  host.remove();
  mounted = null;
});

async function render(
  load: SitePublicationLinkLoad,
  props: { canPublish?: boolean; openExternal?: (url: string) => boolean } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () =>
    root.render(
      <module.SitePublicLink
        load={load}
        workspaceId="ws"
        siteId="site"
        canPublish={props.canPublish ?? true}
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

const openLink = (host: HTMLElement) =>
  host.querySelector<HTMLAnchorElement>('a[aria-label^="Open "]');
const copyButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Copy link"]');

test("a published Site's Live opens its address in a new tab on the web", async () => {
  const host = await render(ready(), { openExternal: () => false });
  const link = openLink(host)!;
  expect(link.textContent).toBe("Live");
  expect(link.getAttribute("href")).toBe("https://newsletter-4k9x.sites.example/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("aria-label")).toBe("Open newsletter-4k9x.sites.example");
  // On the web the anchor itself opens the tab: the click isn't cancelled.
  expect(await clickPrevented(link, {})).toBe(false);
});

test("copying the link confirms with Copied, then settles back", async () => {
  const writes: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void writes.push(text) },
  });
  try {
    const host = await render(ready());
    expect(copyButton(host)!.textContent).toBe("");
    await act(async () => copyButton(host)!.click());
    expect(writes).toEqual(["https://newsletter-4k9x.sites.example/"]);
    expect(copyButton(host)!.textContent).toBe("Copied");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Link copied");
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 2100)));
    expect(copyButton(host)!.textContent).toBe("");
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
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
  expect(openLink(host)!.getAttribute("href")).toBe("https://news.acme.example/");
  expect(openLink(host)!.getAttribute("aria-label")).toBe("Open news.acme.example");
  // Restricted access still links straight to the Site, without warnings.
  expect(host.textContent).toBe("Live");
});

test("an unpublished Site shows no link, and Publish for people who can", async () => {
  for (const load of [{ state: "none" } as const, ready({ status: "unpublished" })]) {
    const host = await render(load);
    expect(openLink(host)).toBeNull();
    expect(copyButton(host)).toBeNull();
    expect(host.querySelector("a[href]")).toBeNull();
    expect(host.textContent).toBe("Not publishedPublish");
    const publish = host.querySelector<HTMLAnchorElement>("a[data-to]")!;
    expect(publish.dataset.to).toBe("/workspaces/$workspaceId/artifacts/$artifactId");
    expect(JSON.parse(publish.dataset.params!)).toEqual({ workspaceId: "ws", artifactId: "site" });
    expect(JSON.parse(publish.dataset.search!)).toEqual({ tab: "settings" });
    await act(async () => mounted!.root.unmount());
    mounted!.host.remove();
    mounted = null;
  }
  const host = await render({ state: "none" }, { canPublish: false });
  expect(host.textContent).toBe("Not published");
  expect(module.publishedSiteLink(ready({ status: "suspended" }))).toBeNull();
  expect(module.publishedSiteLink({ state: "loading" })).toBeNull();
});

test("in the desktop app Live opens the default browser through the shell", async () => {
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
  expect(await clickPrevented(openLink(host)!, {})).toBe(true);
  expect(opened).toEqual(["https://a.example/", "https://newsletter-4k9x.sites.example/"]);
  // A modified click keeps the browser's own behaviour.
  expect(await clickPrevented(openLink(host)!, { metaKey: true })).toBe(false);
  expect(opened).toHaveLength(2);
});

test("someone who can open the Site but not publish still gets open and copy", async () => {
  const host = await render(ready(), { canPublish: false, openExternal: () => false });
  expect(openLink(host)!.getAttribute("href")).toBe("https://newsletter-4k9x.sites.example/");
  expect(copyButton(host)).not.toBeNull();
  expect(host.querySelector("a[data-to]")).toBeNull();
  expect(host.textContent).toBe("Live");
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
  ];
  const client = {
    getSitePublicationLink: (workspaceId: string, siteId: string) => {
      calls.push(`${workspaceId}/${siteId}`);
      return answers.shift()!();
    },
  };
  const seen: SitePublicationLinkLoad[] = [];
  function Probe({ siteId }: { siteId: string }) {
    const load = module.useSitePublicationLink({ client, workspaceId: "ws", siteId });
    seen.push(load);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  for (const siteId of ["a", "b", "c"]) {
    await act(async () => root.render(<Probe siteId={siteId} />));
    await act(async () => await Promise.resolve());
  }
  expect(calls).toEqual(["ws/a", "ws/b", "ws/c"]);
  const settled = seen.filter((load) => load.state !== "loading").map((load) => load.state);
  expect(settled).toEqual(["ready", "none", "unavailable"]);
});
