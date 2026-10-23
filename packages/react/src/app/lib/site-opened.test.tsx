import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const otherSiteId = "33333333-3333-4333-8333-333333333333";
const sitePath = `/workspaces/${workspaceId}/sites/${siteId}`;

type SiteOpenedModule = typeof import("./site-opened");
let useRecordSiteOpened: SiteOpenedModule["useRecordSiteOpened"];
let visibility: DocumentVisibilityState = "visible";
let root: Root | null = null;
let failing = false;
const opens: Array<[string, string]> = [];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "https://app.example.test/" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  ({ useRecordSiteOpened } = await import("./site-opened"));
});
afterEach(async () => {
  await close();
  opens.length = 0;
  visibility = "visible";
  failing = false;
  window.sessionStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());

function client(name = "client") {
  return {
    recordSiteOpened: async (_workspace: string, opened: string) => {
      if (failing) throw new Error("offline");
      opens.push([name, opened]);
      return { openedAt: new Date().toISOString() };
    },
  };
}

function Probe(props: { client: ReturnType<typeof client>; siteId: string }) {
  useRecordSiteOpened(props.client, workspaceId, props.siteId);
  return null;
}

/** Shows the Site view on the page the router keyed `entry`. */
async function show(entry: string | null, props = { client: client(), siteId }) {
  if (root === null) {
    window.history.replaceState(entry === null ? null : { __TSR_key: entry }, "", sitePath);
    root = createRoot(document.createElement("div"));
  }
  await act(async () => root!.render(<Probe {...props} />));
}

/** Leaves the Site view; a reload is closing it and showing the same page again. */
async function close() {
  await act(async () => root?.unmount());
  root = null;
}

const opened = () => opens.map(([, site]) => site);

test("one open per page: a new client for the same person does not open the Site again", async () => {
  await show("a");
  await show("a", { client: client(), siteId });
  await show("a", { client: client(), siteId });
  expect(opened()).toEqual([siteId]);
  await show("a", { client: client(), siteId: otherSiteId });
  expect(opened()).toEqual([siteId, otherSiteId]);
});

test("a reload, restored tab or return to a page where it was opened is not another open", async () => {
  await show("a");
  await close();
  await show("a");
  await close();
  expect(opened()).toEqual([siteId]);
  // Going to the Site again is a new page and a new open.
  await show("b");
  expect(opened()).toEqual([siteId, siteId]);
});

test("a reload after the open was never recorded still opens the Site", async () => {
  // The Site view never loaded (or its write failed) before the app reloaded.
  failing = true;
  await show("a");
  await close();
  failing = false;
  await show("a");
  expect(opened()).toEqual([siteId]);
});

test("pages the open Site view moves to belong to the same open", async () => {
  // Opened, then a conversation is chosen in the Site view, then a reload.
  await show("a");
  window.history.pushState({ __TSR_key: "b" }, "", `${sitePath}?conversation=x`);
  await show("b");
  await close();
  await show("b");
  await close();
  // Reloaded onto a recorded page, then another conversation, then a reload.
  await show("b");
  window.history.pushState({ __TSR_key: "c" }, "", `${sitePath}?conversation=y`);
  await show("c");
  await close();
  await show("c");
  expect(opened()).toEqual([siteId]);
});

test("without a router key every visit opens the Site", async () => {
  await show(null);
  await close();
  await show(null);
  expect(opened()).toEqual([siteId, siteId]);
});

test("a page that loads hidden opens the Site, with the latest client, once it is shown", async () => {
  visibility = "hidden";
  await show("a", { client: client("first"), siteId });
  await show("a", { client: client("refreshed"), siteId });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(opens).toEqual([]);
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(opens).toEqual([["refreshed", siteId]]);
});

test("a page left hidden and closed never opens the Site", async () => {
  visibility = "hidden";
  await show("a");
  await close();
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(opens).toEqual([]);
});
