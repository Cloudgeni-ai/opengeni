import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_VERSION,
  createOpenGeniSiteClient,
  isOpenGeniSiteBridgeEventMessage,
  isOpenGeniSiteBridgeRequestMessage,
  isOpenGeniReservedSitePath,
  openGeniSiteLinkTarget,
  openGeniSiteLocationValue,
  openGeniSitePath,
  resolveOpenGeniSiteLocation,
  type OpenGeniSiteLocation,
  type OpenGeniSiteLocationValue,
} from "../src/site";
import {
  SiteBridgeHost,
  siteBridgeReadyMessage,
  type SiteBridgeLocationHandlers,
  type SiteBridgeToolHandlers,
} from "../src/site-bridge-host";

const tools: SiteBridgeToolHandlers = {
  catalog: async () => {
    throw new Error("unused");
  },
  call: async () => {
    throw new Error("unused");
  },
};

function connect(
  source: ConstructorParameters<typeof SiteBridgeHost>[0],
  linkTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">,
) {
  const host = new SiteBridgeHost(source);
  let bootstrap: MessagePort | undefined;
  host.load({
    postMessage: (_message: unknown, _origin: string, transfer?: Transferable[]) => {
      bootstrap = transfer?.[0] as MessagePort;
    },
  } as Pick<Window, "postMessage">);
  const site = createOpenGeniSiteClient({
    bootstrapPort: bootstrap!,
    connectTimeoutMs: 2000,
    ...(linkTarget ? { linkTarget } : {}),
  });
  return { host, site };
}

/** A click on `<a>` with these attributes, as the document's listener sees it. */
function linkClick(attributes: Record<string, string>, init: Partial<MouseEvent> = {}) {
  const link = {
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
  };
  let prevented = false;
  const event = {
    button: 0,
    ...init,
    target: { closest: (selector: string) => (selector === "a[href]" ? link : null) },
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
  return event as unknown as Event;
}

function fakeDocument() {
  const listeners = new Set<(event: Event) => void>();
  return {
    listeners,
    addEventListener: (_type: string, listener: (event: Event) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: Event) => void) =>
      listeners.delete(listener),
    click(event: Event) {
      for (const listener of listeners) listener(event);
      return event.defaultPrevented;
    },
  };
}

/** A host that keeps the Site's location in memory, like the console frame. */
function memoryLocation(start: OpenGeniSiteLocationValue, host: () => SiteBridgeHost) {
  let current = start;
  const moves: Array<{ href: string; replace: boolean }> = [];
  const handlers: SiteBridgeLocationHandlers = {
    get: () => current,
    navigate: (to, { replace }) => {
      current = to;
      moves.push({ href: `${to.path}${to.search}${to.hash}`, replace });
      host().notifyLocation(current);
      return current;
    },
  };
  return {
    handlers,
    moves,
    /** The host's own Back/Forward. */
    set(next: OpenGeniSiteLocationValue) {
      current = next;
      host().notifyLocation(next);
    },
  };
}

function nextChange(site: ReturnType<typeof createOpenGeniSiteClient>) {
  return new Promise<OpenGeniSiteLocation>((resolve) => {
    const stop = site.onLocationChange((location) => {
      stop();
      resolve(location);
    });
  });
}

describe("Site location", () => {
  test("resolves addresses within the Site and refuses everything else", () => {
    const at = { path: "/admin/users", search: "?q=1", hash: "#top" };
    expect(resolveOpenGeniSiteLocation(at, "/unsubscribe?t=abc")).toEqual({
      path: "/unsubscribe",
      search: "?t=abc",
      hash: "",
    });
    expect(resolveOpenGeniSiteLocation(at, "?tab=2")).toEqual({
      path: "/admin/users",
      search: "?tab=2",
      hash: "",
    });
    expect(resolveOpenGeniSiteLocation(at, "#bottom")).toEqual({
      path: "/admin/users",
      search: "?q=1",
      hash: "#bottom",
    });
    expect(resolveOpenGeniSiteLocation(at, "../x")?.path).toBe("/x");
    // A full address on the Site's own origin is the Site too.
    expect(
      resolveOpenGeniSiteLocation(at, "https://news.sites.test/a?b=1", "https://news.sites.test"),
    ).toEqual({ path: "/a", search: "?b=1", hash: "" });
    for (const outside of [
      "https://evil.test/",
      "//evil.test/x",
      "javascript:alert(1)",
      "mailto:a@example.com",
    ])
      expect(resolveOpenGeniSiteLocation(at, outside)).toBeNull();
    // A path never starts with `//`, so it can't read as another origin.
    for (const sneaky of ["/.//evil.test/x", "/%2e%2e//evil.test/x", "/a/..//evil.test/x"])
      expect(resolveOpenGeniSiteLocation(at, sneaky)?.path).toBe("/evil.test/x");
    expect(
      resolveOpenGeniSiteLocation({ path: "//evil.test/a", search: "", hash: "" }, "b"),
    ).toEqual({ path: "/evil.test/b", search: "", hash: "" });
    expect(resolveOpenGeniSiteLocation(at, `/${"a".repeat(2048)}`)).toBeNull();
    expect(openGeniSitePath("///x//y")).toBe("/x//y");
    for (const reserved of ["/_og", "/_og/auth/login", "/__opengeni/site-tools/client.js"])
      expect(isOpenGeniReservedSitePath(reserved)).toBe(true);
    for (const own of ["/", "/_ogre", "/admin/_og", "/__opengenius"])
      expect(isOpenGeniReservedSitePath(own)).toBe(false);
  });

  test("validates wire values", () => {
    expect(openGeniSiteLocationValue({ path: "/", search: "", hash: "" })).toEqual({
      path: "/",
      search: "",
      hash: "",
    });
    for (const bad of [
      null,
      { path: "x", search: "", hash: "" },
      { path: "//evil.test", search: "", hash: "" },
      { path: "/", search: "a=1", hash: "" },
      { path: "/", search: "", hash: "top" },
      { path: "/", search: "" },
    ])
      expect(openGeniSiteLocationValue(bad)).toBeNull();
    expect(
      isOpenGeniSiteBridgeRequestMessage({
        type: "opengeni.site.request",
        version: 2,
        requestId: "r1",
        method: "location",
      }),
    ).toBe(true);
    expect(
      isOpenGeniSiteBridgeRequestMessage({
        type: "opengeni.site.request",
        version: 2,
        requestId: "r1",
        method: "location.navigate",
        payload: { to: "/x" },
      }),
    ).toBe(true);
    expect(
      isOpenGeniSiteBridgeRequestMessage({
        type: "opengeni.site.request",
        version: 2,
        requestId: "r1",
        method: "location.navigate",
      }),
    ).toBe(false);
    expect(
      isOpenGeniSiteBridgeEventMessage({
        type: "opengeni.site.event",
        version: 2,
        event: "location",
        location: { path: "/", search: "", hash: "" },
      }),
    ).toBe(true);
  });

  test("reads the location, navigates and hears Back/Forward", async () => {
    let bridge: SiteBridgeHost | null = null;
    const memory = memoryLocation(
      { path: "/unsubscribe", search: "?t=abc%20d", hash: "" },
      () => bridge!,
    );
    expect(siteBridgeReadyMessage(tools, undefined, memory.handlers)).toEqual({
      type: OPENGENI_SITE_BRIDGE_READY,
      version: OPENGENI_SITE_BRIDGE_VERSION,
      location: 1,
    });
    const { host, site } = connect({ tools: () => tools, location: () => memory.handlers });
    bridge = host;
    try {
      const start = await site.location;
      expect(start).toMatchObject({ path: "/unsubscribe", href: "/unsubscribe?t=abc%20d" });
      expect(start?.params.get("t")).toBe("abc d");

      const changed = nextChange(site);
      const moved = await site.navigate("/admin?tab=2#list");
      expect(moved).toMatchObject({ path: "/admin", search: "?tab=2", hash: "#list" });
      expect((await changed).href).toBe("/admin?tab=2#list");
      await site.navigate("?tab=3", { replace: true });
      expect(memory.moves).toEqual([
        { href: "/admin?tab=2#list", replace: false },
        { href: "/admin?tab=3", replace: true },
      ]);

      const back = nextChange(site);
      memory.set({ path: "/", search: "", hash: "" });
      expect((await back).href).toBe("/");
      expect((await site.location)?.path).toBe("/");

      const refused = await site.navigate("https://evil.test/").then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({ code: "invalid_location" });
      // Opengeni's own addresses are refused by every host, before it moves.
      for (const reserved of ["/_og/auth/login", "/__opengeni/site-tools/client.js"]) {
        const error = await site.navigate(reserved).then(
          () => null,
          (failure: unknown) => failure,
        );
        expect(error).toMatchObject({ code: "invalid_location" });
      }
      expect(memory.moves).toHaveLength(2);
    } finally {
      site.close();
      host.close();
    }
  });

  test("a refused address keeps the Site where it is", async () => {
    const handlers: SiteBridgeLocationHandlers = {
      get: () => ({ path: "/", search: "", hash: "" }),
      navigate: () => {
        throw Object.assign(new Error("Addresses under /_og belong to Opengeni"), {
          code: "invalid_location",
        });
      },
    };
    const { host, site } = connect({ tools: () => tools, location: () => handlers });
    try {
      await expect(site.navigate("/_og/auth/login")).rejects.toMatchObject({
        code: "invalid_location",
      });
      expect((await site.location)?.href).toBe("/");
    } finally {
      site.close();
      host.close();
    }
  });

  test("older hosts report no location and refuse navigation", async () => {
    const { host, site } = connect({ tools: () => tools });
    try {
      expect(await site.location).toBeNull();
      await expect(site.navigate("/admin")).rejects.toMatchObject({
        code: "location_unsupported",
      });
      // Listening is harmless: nothing is ever reported.
      site.onLocationChange(() => {
        throw new Error("unexpected");
      })();
    } finally {
      site.close();
      host.close();
    }
  });

  test("picks out ordinary clicks on links to the Site's own pages", () => {
    for (const href of ["/admin", "?tab=2", "../x", "next", "/unsubscribe?t=a#done"])
      expect(openGeniSiteLinkTarget(linkClick({ href }))).toBe(href);
    expect(openGeniSiteLinkTarget(linkClick({ href: "/a", target: "_self" }))).toBe("/a");
    for (const attributes of [
      { href: "#top" },
      { href: "" },
      { href: "https://example.com/" },
      { href: "//example.com/x" },
      { href: "mailto:a@example.com" },
      { href: "javascript:void 0" },
      { href: "/a", target: "_blank" },
      { href: "/a", download: "" },
    ])
      expect(openGeniSiteLinkTarget(linkClick(attributes))).toBeNull();
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }])
      expect(openGeniSiteLinkTarget(linkClick({ href: "/a" }, init))).toBeNull();
    // The Site's own handler took the click (a router, a confirm dialog).
    const handled = linkClick({ href: "/a" });
    handled.preventDefault();
    expect(openGeniSiteLinkTarget(handled)).toBeNull();
    // Not on a link at all.
    expect(
      openGeniSiteLinkTarget({ button: 0, target: { closest: () => null } } as unknown as Event),
    ).toBeNull();
  });

  test("link clicks move the Site once the host reports location", async () => {
    let bridge: SiteBridgeHost | null = null;
    const memory = memoryLocation({ path: "/", search: "", hash: "" }, () => bridge!);
    const page = fakeDocument();
    const { host, site } = connect({ tools: () => tools, location: () => memory.handlers }, page);
    bridge = host;
    try {
      await site.location;
      const heard = nextChange(site);
      expect(page.click(linkClick({ href: "/admin?tab=2" }))).toBe(true);
      expect((await heard).href).toBe("/admin?tab=2");
      // Links elsewhere still behave as links.
      expect(page.click(linkClick({ href: "https://example.com/" }))).toBe(false);
      expect(page.click(linkClick({ href: "#top" }))).toBe(false);
    } finally {
      site.close();
      host.close();
    }
    expect(page.listeners.size).toBe(0);
  });

  test("links are left alone on older hosts or when the Site handles them", async () => {
    const older = fakeDocument();
    const first = connect({ tools: () => tools }, older);
    const page = fakeDocument();
    const memory = memoryLocation({ path: "/", search: "", hash: "" }, () => first.host);
    const host = new SiteBridgeHost({ tools: () => tools, location: () => memory.handlers });
    let bootstrap: MessagePort | undefined;
    host.load({
      postMessage: (_message: unknown, _origin: string, transfer?: Transferable[]) => {
        bootstrap = transfer?.[0] as MessagePort;
      },
    } as Pick<Window, "postMessage">);
    const optedOut = createOpenGeniSiteClient({
      bootstrapPort: bootstrap!,
      links: false,
      linkTarget: page,
    });
    try {
      expect(await first.site.location).toBeNull();
      expect(older.click(linkClick({ href: "/admin" }))).toBe(false);
      expect(page.listeners.size).toBe(0);
    } finally {
      first.site.close();
      first.host.close();
      optedOut.close();
      host.close();
    }
  });

  test("a local preview moves the page itself and tells every client on it", async () => {
    const page = new URL("http://localhost:3000/");
    const popListeners = new Set<() => void>();
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = {
      location: scope.location,
      history: scope.history,
      addEventListener: scope.addEventListener,
      removeEventListener: scope.removeEventListener,
    };
    const move = (href: string) => {
      const next = new URL(href, page);
      page.pathname = next.pathname;
      page.search = next.search;
      page.hash = next.hash;
    };
    Object.assign(scope, {
      location: {
        get origin() {
          return page.origin;
        },
        get pathname() {
          return page.pathname;
        },
        get search() {
          return page.search;
        },
        get hash() {
          return page.hash;
        },
      },
      history: {
        state: null,
        pushState: (_state: unknown, _title: string, href: string) => move(href),
        replaceState: (_state: unknown, _title: string, href: string) => move(href),
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "popstate") popListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === "popstate") popListeners.delete(listener);
      },
    });
    const local = { localCodemodePath: "/__opengeni/site-tools" };
    const first = createOpenGeniSiteClient(local);
    const second = createOpenGeniSiteClient(local);
    try {
      expect((await first.location)?.href).toBe("/");
      const heard = nextChange(second);
      expect((await first.navigate("/admin?tab=2")).href).toBe("/admin?tab=2");
      expect((await heard).href).toBe("/admin?tab=2");
      const refused = await first.navigate("/__opengeni/site-tools/client.js").then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({ code: "invalid_location" });
      // Back/Forward is watched only while someone listens.
      const stop = second.onLocationChange(() => undefined);
      expect(popListeners.size).toBe(1);
      const back = nextChange(first);
      move("/");
      for (const listener of popListeners) listener();
      expect((await back).href).toBe("/");
      stop();
      expect(popListeners.size).toBe(0);
    } finally {
      first.close();
      second.close();
      Object.assign(scope, saved);
    }
  });

  test("a listener's error does not stop the others", async () => {
    let bridge: SiteBridgeHost | null = null;
    const memory = memoryLocation({ path: "/", search: "", hash: "" }, () => bridge!);
    const { host, site } = connect({ tools: () => tools, location: () => memory.handlers });
    bridge = host;
    const swallowed: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (callback) =>
      original(() => {
        try {
          callback();
        } catch (error) {
          swallowed.push(error);
        }
      });
    try {
      site.onLocationChange(() => {
        throw new Error("listener bug");
      });
      const heard = nextChange(site);
      await site.navigate("/next");
      expect((await heard).path).toBe("/next");
      await Promise.resolve();
      expect(swallowed).toHaveLength(1);
    } finally {
      globalThis.queueMicrotask = original;
      site.close();
      host.close();
    }
  });
});
