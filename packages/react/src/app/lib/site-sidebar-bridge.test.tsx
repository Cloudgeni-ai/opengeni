import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { publishSiteSidebarBridge, useSiteSidebarActions } from "./site-sidebar-bridge";

let ownsDom = false;
beforeAll(() => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

const origin = { siteId: "site-1", title: "Opengeni usage" };
type Actions = ReturnType<typeof useSiteSidebarActions>;

function Probe({ workspaceId, seen }: { workspaceId: string; seen: Actions[] }) {
  seen.push(useSiteSidebarActions(workspaceId, origin));
  return null;
}

test("a Site's page gets the sidebar's Pin and Archive only while the sidebar publishes them", async () => {
  const seen: Actions[] = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Probe workspaceId="ws-1" seen={seen} />));
  expect(seen.at(-1)).toBeNull();

  const calls: string[] = [];
  const bridge = {
    workspaceId: "ws-1",
    pinnedSiteIds: new Set<string>(),
    pin: (site: typeof origin, pinned: boolean) => void calls.push(`pin ${site.siteId} ${pinned}`),
    archive: (site: typeof origin) => void calls.push(`archive ${site.siteId}`),
  };
  let withdraw = () => {};
  await act(async () => void (withdraw = publishSiteSidebarBridge(bridge)));
  expect(seen.at(-1)?.pinned).toBe(false);
  seen.at(-1)!.togglePin();
  seen.at(-1)!.archive();
  expect(calls).toEqual(["pin site-1 true", "archive site-1"]);

  // A newer sidebar takes over; when it goes, the older one acts again.
  const pinned = { ...bridge, pinnedSiteIds: new Set(["site-1"]) };
  let withdrawNewer = () => {};
  await act(async () => void (withdrawNewer = publishSiteSidebarBridge(pinned)));
  expect(seen.at(-1)?.pinned).toBe(true);
  await act(async () => withdrawNewer());
  expect(seen.at(-1)?.pinned).toBe(false);
  // The older one's withdrawal leaves a newer one in place.
  await act(async () => void (withdrawNewer = publishSiteSidebarBridge(pinned)));
  await act(async () => withdraw());
  expect(seen.at(-1)?.pinned).toBe(true);

  // Another workspace's sidebar doesn't act on this page.
  await act(async () => root.render(<Probe workspaceId="ws-2" seen={seen} />));
  expect(seen.at(-1)).toBeNull();

  await act(async () => root.render(<Probe workspaceId="ws-1" seen={seen} />));
  await act(async () => withdrawNewer());
  expect(seen.at(-1)).toBeNull();
  act(() => root.unmount());
});
