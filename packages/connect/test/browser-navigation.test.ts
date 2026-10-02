import { expect, test } from "bun:test";
import {
  authorizeConnectAttempt,
  createBrowserConnectNavigation,
  reserveBrowserConnectNavigation,
  type ConnectAttempt,
} from "../src";

for (const reserved of [false, true]) {
  test(`${reserved ? "reserved" : "direct"} popup keeps polling when COOP severs its window reference`, async () => {
    let detached = false;
    const browser = {
      open: () => ({
        opener: {} as unknown,
        get closed() {
          return detached;
        },
        location: {
          replace() {
            detached = true;
          },
        },
        close() {},
      }),
      location: { assign() {} },
    };
    const navigation = reserved
      ? reserveBrowserConnectNavigation(browser).navigation
      : createBrowserConnectNavigation(browser);
    const attempt: ConnectAttempt = {
      id: "attempt",
      workspaceId: "workspace",
      providerId: "provider",
      ownership: "workspace",
      revision: 1,
      state: "requires_user_action",
      credentialsCommitted: false,
      integrationInstalled: false,
      completionRequirement: "connection",
      nextAction: { type: "authorize", url: "https://provider.example/authorize" },
      expiresAt: "2030-01-01T00:00:00Z",
    };
    let reads = 0;
    const result = await authorizeConnectAttempt(
      {
        get: async () =>
          ++reads < 4
            ? attempt
            : {
                ...attempt,
                revision: 2,
                state: "complete",
                credentialsCommitted: true,
                nextAction: { type: "none" },
              },
      },
      attempt,
      navigation,
      { mode: "popup", timeoutMs: 5_000 },
    );
    expect(detached).toBe(true);
    expect(reads).toBe(4);
    expect(result?.state).toBe("complete");
  });
}

test("reserves an isolated popup before discovery and navigates without another click", async () => {
  const destinations: string[] = [];
  let opens = 0;
  let closed = false;
  const popup = {
    opener: {} as unknown,
    location: {
      replace(url: string) {
        destinations.push(url);
      },
    },
    close() {
      closed = true;
    },
  };
  const reserved = reserveBrowserConnectNavigation({
    open() {
      opens++;
      return popup;
    },
    location: {
      assign() {
        throw new Error("unexpected redirect");
      },
    },
  });
  expect(opens).toBe(1);
  expect(popup.opener).toBeNull();
  expect(destinations).toEqual([]);
  await Promise.resolve();
  expect(() => reserved.navigation.openPopup("http://provider.example")).toThrow();
  reserved.navigation.openPopup("https://provider.example/authorize?state=exact");
  expect(opens).toBe(1);
  expect(destinations).toEqual(["https://provider.example/authorize?state=exact"]);
  reserved.close();
  expect(closed).toBe(true);
});

test("isolates fresh popup before navigating and preserves exact destination", () => {
  const url = "https://provider.example/oauth?state=%2f#original";
  const events: unknown[] = [];
  const popup = {
    opener: {} as unknown,
    location: {
      replace(value: string) {
        expect(popup.opener).toBeNull();
        events.push(value);
      },
    },
    close() {
      events.push("close");
    },
  };
  const navigation = createBrowserConnectNavigation({
    open(...args) {
      events.push(args);
      return popup;
    },
    location: {
      assign() {
        throw new Error("unexpected redirect");
      },
    },
  });
  const handle = navigation.openPopup(url);
  expect(events).toEqual([["about:blank", "_blank", "popup,width=520,height=720"], url]);
  handle!.close();
  expect(events.at(-1)).toBe("close");
});

test("popup blocker does not cause a redirect", () => {
  const navigation = createBrowserConnectNavigation({
    open: () => null,
    location: {
      assign() {
        throw new Error("unexpected redirect");
      },
    },
  });
  expect(navigation.openPopup("https://provider.example")).toBeNull();
});

for (const reserved of [false, true]) {
  test(`${reserved ? "reserved" : "direct"} navigation skips inaccessible provider-window cleanup`, () => {
    let navigated = false;
    let closes = 0;
    const popup = {
      opener: {} as unknown,
      location: {
        get href() {
          if (navigated) throw new DOMException("Cross-origin window", "SecurityError");
          return "about:blank";
        },
        replace() {
          navigated = true;
        },
      },
      close() {
        closes++;
      },
    };
    const browser = { open: () => popup, location: { assign() {} } };
    const navigation = reserved
      ? reserveBrowserConnectNavigation(browser).navigation
      : createBrowserConnectNavigation(browser);
    const handle = navigation.openPopup("https://provider.example/authorize")!;
    expect(popup.opener).toBeNull();
    expect(() => handle.close()).not.toThrow();
    expect(closes).toBe(0);
    // A same-origin callback can restore cleanup access independently of success.
    navigated = false;
    handle.close();
    expect(closes).toBe(1);
  });
}

test("reserved blank-window cleanup still runs when discovery fails", () => {
  let closes = 0;
  const reserved = reserveBrowserConnectNavigation({
    open: () => ({
      opener: {} as unknown,
      location: { href: "about:blank", replace() {} },
      close() {
        closes++;
      },
    }),
    location: { assign() {} },
  });
  reserved.close();
  expect(closes).toBe(1);
});

test("failed opener isolation closes blank popup before provider navigation", () => {
  let closed = false;
  const navigation = createBrowserConnectNavigation({
    open: () => ({
      get opener() {
        return {};
      },
      set opener(_value: unknown) {},
      location: {
        replace() {
          throw new Error("must not navigate");
        },
      },
      close() {
        closed = true;
      },
    }),
    location: { assign() {} },
  });
  expect(() => navigation.openPopup("https://provider.example")).toThrow("safely");
  expect(closed).toBe(true);
});

test("redirect rejects credentials and retains an allowed URL unchanged", () => {
  let destination = "";
  const navigation = createBrowserConnectNavigation({
    open: () => null,
    location: {
      assign(url) {
        destination = url;
      },
    },
  });
  expect(() => navigation.redirect("https://user:secret@provider.example")).toThrow(
    "without credentials",
  );
  expect(destination).toBe("");
  navigation.redirect("https://provider.example?state=%2f#done");
  expect(destination).toBe("https://provider.example?state=%2f#done");
});
