import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import type { AppContextValue } from "../../app-context";
import type { AppHost } from "../../lib/app-host";
import type { SiteRowActions } from "./site-session-group-heading";

// The real menus: Radix reads the DOM when it loads, so everything that
// renders is imported once the DOM exists.
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let AppContext: typeof import("../../app-context").AppContext;
let AppHostProvider: typeof import("../../lib/app-host").AppHostProvider;
let heading: typeof import("./site-session-group-heading");
let ownsDom = false;

beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://app.example.test/" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ AppContext } = await import("../../app-context"));
  ({ AppHostProvider } = await import("../../lib/app-host"));
  heading = await import("./site-session-group-heading");
});

afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

afterEach(() => {
  document.body.innerHTML = "";
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const origin = { siteId: "22222222-2222-4222-8222-222222222222", title: "Opengeni usage" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function TestLink({
  to,
  params,
  search,
  activeOptions: _activeOptions,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  activeOptions?: unknown;
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  children?: ReactNode;
}) {
  let href = to;
  for (const [key, value] of Object.entries(params ?? {})) href = href.replace(`$${key}`, value);
  const query = new URLSearchParams(search).toString();
  return (
    <a {...props} href={query ? `${href}?${query}` : href}>
      {children}
    </a>
  );
}

async function renderRow({
  permissions,
  publication,
}: {
  permissions: string[];
  publication?: { status: string; url: string; hostname: string };
}) {
  const calls: string[] = [];
  const actions: SiteRowActions = {
    pin: (site, pinned) => void calls.push(`pin ${site.siteId} ${pinned}`),
    archive: (site) => void calls.push(`archive ${site.siteId}`),
    move: (site, from, to) => void calls.push(`move ${site.siteId} ${from} ${to}`),
  };
  const client = {
    getSitePublicationLink: async () =>
      publication
        ? { siteId: origin.siteId, ...publication }
        : { siteId: origin.siteId, hostname: "", url: "", status: "inactive" },
  };
  const appContext = {
    client,
    accessContext: { subjectId: "me", workspaceGrants: [{ workspaceId, permissions }] },
  } as unknown as AppContextValue;
  const host = {
    navigation: {
      Link: TestLink,
      useNavigate: () => async () => {},
      page: null,
    },
  } as unknown as AppHost;
  // One value per render, as a provider above the row would hold them.
  const contexts = { app: appContext, row: actions };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () =>
    root.render(
      <AppHostProvider host={host}>
        <AppContext.Provider value={contexts.app}>
          <heading.SiteRowActionsContext.Provider value={contexts.row}>
            <heading.SiteSessionGroupHeading
              origin={origin}
              workspaceId={workspaceId}
              expanded={false}
              onToggle={() => undefined}
              summary={{ kind: "idle" } as never}
              count={0}
              channelId={null}
              channels={[{ id: "channel-1", name: "Bugfixes" } as never]}
            />
          </heading.SiteRowActionsContext.Provider>
        </AppContext.Provider>
      </AppHostProvider>,
    ),
  );
  const openMenu = () =>
    React.act(async () => {
      container.querySelector(`[data-site-row="${origin.siteId}"] a`)!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
      await settle();
    });
  return {
    calls,
    openMenu,
    items: () => [
      ...document.querySelectorAll<HTMLElement>(
        `[data-site-menu="${origin.siteId}"] [role='menuitem']`,
      ),
    ],
    unmount: () => React.act(async () => root.unmount()),
  };
}

test("a Site row's menu offers its own actions before the sidebar's Move", async () => {
  const row = await renderRow({ permissions: ["artifacts:publish"] });
  try {
    await row.openMenu();
    expect(row.items().map((item) => item.textContent)).toEqual([
      "Copy link",
      "Copy title",
      "Pin",
      "Duplicate",
      "Site details",
      "Archive",
      "Default",
      "Bugfixes",
    ]);
    const details = row.items().find((item) => item.textContent === "Site details")!;
    expect(details.getAttribute("href")).toBe(
      `/workspaces/${workspaceId}/artifacts/${origin.siteId}?tab=settings`,
    );
    await React.act(async () => {
      row
        .items()
        .find((item) => item.textContent === "Pin")!
        .click();
      await settle();
    });
    await row.openMenu();
    await React.act(async () => {
      row
        .items()
        .find((item) => item.textContent === "Archive")!
        .click();
      await settle();
    });
    expect(row.calls).toEqual([`pin ${origin.siteId} true`, `archive ${origin.siteId}`]);
  } finally {
    await row.unmount();
  }
});

test("people who can't publish get no Duplicate; a published Site opens on the web", async () => {
  const row = await renderRow({
    permissions: ["artifacts:read"],
    publication: {
      status: "active",
      url: "https://usage-4k9x.sites.example/",
      hostname: "usage-4k9x.sites.example",
    },
  });
  try {
    await row.openMenu();
    expect(row.items().map((item) => item.textContent)).toEqual([
      "Copy link",
      "Copy title",
      "Pin",
      "Site details",
      "Open published Site",
      "Archive",
      "Default",
      "Bugfixes",
    ]);
    const open = row.items().find((item) => item.textContent === "Open published Site")!;
    expect(open.getAttribute("href")).toBe("https://usage-4k9x.sites.example/");
    expect(open.getAttribute("target")).toBe("_blank");
  } finally {
    await row.unmount();
  }
});
