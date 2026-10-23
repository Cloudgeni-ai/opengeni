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
let navigationType: NavigationTimingType | null = null;
let firstUrl = "";
let visibility: DocumentVisibilityState = "visible";
let root: Root | null = null;
const opens: string[] = [];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "https://app.example.test/" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // This document's first page is the Site, in history entry "first".
  window.history.replaceState({ __TSR_key: "first" }, "", sitePath);
  firstUrl = window.location.href;
  const entries = performance.getEntriesByType.bind(performance);
  performance.getEntriesByType = ((type: string) =>
    type === "navigation" && navigationType
      ? [{ type: navigationType, name: firstUrl } as unknown as PerformanceEntry]
      : entries(type)) as typeof performance.getEntriesByType;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  ({ useRecordSiteOpened } = await import("./site-opened"));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  opens.length = 0;
  navigationType = null;
  visibility = "visible";
});
afterAll(() => GlobalRegistrator.unregister());

function client() {
  return {
    recordSiteOpened: async (_workspace: string, opened: string) => {
      opens.push(opened);
      return { openedAt: new Date().toISOString() };
    },
  };
}

function Probe(props: { client: ReturnType<typeof client>; siteId: string }) {
  useRecordSiteOpened(props.client, workspaceId, props.siteId);
  return null;
}

async function show(props: { client: ReturnType<typeof client>; siteId: string }) {
  root ??= createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe {...props} />));
}

test("one open per visit: a new client for the same person does not open the Site again", async () => {
  await show({ client: client(), siteId });
  expect(opens).toEqual([siteId]);
  // Refreshed credentials replace the client while the Site stays open.
  await show({ client: client(), siteId });
  await show({ client: client(), siteId });
  expect(opens).toEqual([siteId]);
  await show({ client: client(), siteId: otherSiteId });
  expect(opens).toEqual([siteId, otherSiteId]);
});

test("a page that loads hidden opens the Site only once it is shown", async () => {
  visibility = "hidden";
  await show({ client: client(), siteId });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(opens).toEqual([]);
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(opens).toEqual([siteId]);
});

test("a page left hidden and closed never opens the Site", async () => {
  visibility = "hidden";
  await show({ client: client(), siteId });
  await act(async () => root?.unmount());
  root = null;
  visibility = "visible";
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(opens).toEqual([]);
});

test("a reload or restored tab showing the Site again is not an open; going there is", async () => {
  for (const type of ["reload", "back_forward"] as const) {
    navigationType = type;
    await show({ client: client(), siteId });
    await act(async () => root?.unmount());
    root = null;
  }
  expect(opens).toEqual([]);
  // A link opened in a new page, or another Site, is an open.
  navigationType = "navigate";
  await show({ client: client(), siteId });
  await act(async () => root?.unmount());
  root = null;
  navigationType = "reload";
  await show({ client: client(), siteId: otherSiteId });
  expect(opens).toEqual([siteId, otherSiteId]);
  await act(async () => root?.unmount());
  root = null;

  // After a reload, navigating away and back to the Site opens it.
  window.history.pushState({ __TSR_key: "second" }, "", `/workspaces/${workspaceId}/sessions/x`);
  window.history.pushState({ __TSR_key: "third" }, "", sitePath);
  await show({ client: client(), siteId });
  await act(async () => root?.unmount());
  root = null;
  // So does going back to the first page.
  window.history.replaceState({ __TSR_key: "first" }, "", sitePath);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  await show({ client: client(), siteId });
  expect(opens).toEqual([siteId, otherSiteId, siteId, siteId]);
});
