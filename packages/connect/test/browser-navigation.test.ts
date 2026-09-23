import { expect, test } from "bun:test";
import { createBrowserConnectNavigation, reserveBrowserConnectNavigation } from "../src";

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
