import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_FREE_SITE_LIMITS,
  type SiteHostnameAvailability,
  type SitePublication,
  type UpsertSitePublicationRequest,
} from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";

mock.module("@/context", () => ({
  useAppContext: () => ({
    client: {
      getWorkspaceModelCatalog: async () => ({
        models: [],
        defaultSelection: null,
        creditsSelection: null,
      }),
    },
  }),
}));
let module: typeof import("./site-publishing");
let ownsDom = false;
let previousActEnvironment: PropertyDescriptor | undefined;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://example.test" });
  previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  module = await import("./site-publishing");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const now = "2026-10-14T10:00:00.000Z";
const published = (patch: Partial<SitePublication> = {}): SitePublication => ({
  siteId: "site",
  workspaceId: "ws",
  label: "team-crm-4k9x",
  hostname: "team-crm-4k9x.sites.example",
  url: "https://team-crm-4k9x.sites.example/",
  access: "members",
  status: "active",
  noindex: true,
  agent: { enabled: false, model: null, instructions: null, tools: null },
  limitProfile: { kind: "free", overrides: null },
  effectiveLimits: { ...DEFAULT_FREE_SITE_LIMITS },
  invitedEmails: [],
  moderation: { openReports: 0, suspendedAt: null, suspendedBy: null, suspendedReason: null },
  usage: { agentMicrosThisMonth: 0, conversationsToday: 0 },
  createdAt: now,
  updatedAt: now,
  ...patch,
});

const available = (label: string): SiteHostnameAvailability => ({
  label,
  hostname: `${label}.sites.example`,
  available: true,
  problem: null,
  message: null,
});

function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: {
    updates: UpsertSitePublicationRequest[];
    takedowns: string[];
    checks: string[];
  } = { updates: [], takedowns: [], checks: [] };
  const client = {
    getSitePublication: async () => published(),
    checkSiteHostname: async (_ws: string, label: string) => {
      calls.checks.push(label);
      return available(label);
    },
    updateSitePublication: async (
      _ws: string,
      _site: string,
      request: UpsertSitePublicationRequest,
    ) => {
      calls.updates.push(request);
      return published({ label: request.label ?? "team-crm-4k9x" });
    },
    unpublishSite: async () => published({ status: "unpublished" }),
    takeDownSite: async (_ws: string, _site: string, request: { reason: string }) => {
      calls.takedowns.push(request.reason);
      return published({ status: "suspended" });
    },
    restoreSite: async () => published(),
    listSiteAbuseReports: async () => ({ reports: [] }),
    updateSiteAbuseReport: async () => {
      throw new Error("unused");
    },
    ...overrides,
  };
  return { client, calls };
}

type PageProps = Parameters<typeof module.SitePublishPage>[0];

async function renderPage(props: Partial<PageProps> & Pick<PageProps, "client" | "load">) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const published: SitePublication[] = [];
  await act(async () =>
    root.render(
      <module.SitePublishPage
        workspaceId="ws"
        workspaceName="Sales"
        site={{ id: "site", title: "Team CRM", visibility: "workspace" }}
        onPublication={(next) => published.push(next)}
        onReload={() => {}}
        onBack={() => {}}
        canManage
        sites={{ domain: "sites.example" }}
        labelSuffix="abcd"
        {...props}
      />,
    ),
  );
  return {
    host,
    published,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await act(async () => await Promise.resolve());
};
const waitForCheck = async () => {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 400)));
  await flush();
};
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  // happy-dom input events don't reach React's change tracking; call the handler as React would.
  const key = Object.keys(element).find((property) => property.startsWith("__reactProps$"))!;
  (element as unknown as Record<string, { onChange: (event: { target: typeof element }) => void }>)[
    key
  ]!.onChange({ target: element });
}

test("a first publish suggests an address, checks it and sends the whole request", async () => {
  const { client, calls } = fakeClient();
  const page = await renderPage({ client: client as never, load: { state: "none" } });
  const input = page.host.querySelector("input");
  expect(input?.value).toBe("team-crm-abcd");
  expect(page.host.textContent).toContain(".sites.example");
  await waitForCheck();
  expect(calls.checks).toEqual(["team-crm-abcd"]);
  expect(page.host.textContent).toContain("team-crm-abcd.sites.example is available");

  await act(async () => button(page.host, "Publish")!.click());
  await flush();
  expect(calls.updates).toEqual([
    {
      label: "team-crm-abcd",
      access: "members",
      agent: { enabled: false },
      limitProfile: { kind: "free", overrides: null },
      noindex: true,
      status: "active",
    },
  ]);
  expect(page.published).toHaveLength(1);
  await page.unmount();
});

test("a taken address blocks publishing, and a save race shows the conflict on the field", async () => {
  let taken = true;
  const { client, calls } = fakeClient({
    checkSiteHostname: async (_ws: string, label: string) =>
      taken
        ? {
            label,
            hostname: null,
            available: false,
            problem: "taken",
            message: null,
          }
        : available(label),
    updateSitePublication: async (
      _ws: string,
      _site: string,
      request: UpsertSitePublicationRequest,
    ) => {
      calls.updates.push(request);
      throw new OpenGeniApiError(409, "taken", { code: "site_hostname_taken" });
    },
  });
  const page = await renderPage({ client: client as never, load: { state: "none" } });
  await waitForCheck();
  expect(page.host.textContent).toContain("Another Site uses this name");
  await act(async () => button(page.host, "Publish")!.click());
  await flush();
  expect(calls.updates).toHaveLength(0);

  taken = false;
  await act(async () => typeInto(page.host.querySelector("input")!, "team-crm-efgh"));
  await waitForCheck();
  expect(page.host.textContent).toContain("is available");
  await act(async () => button(page.host, "Publish")!.click());
  await flush();
  expect(calls.updates).toHaveLength(1);
  expect(page.host.textContent).toContain("Another Site uses this name.");
  expect(page.published).toHaveLength(0);
  await page.unmount();
});

test("unavailable, forbidden and Only me Sites show one notice instead of the form", async () => {
  const { client } = fakeClient();
  const unavailable = await renderPage({
    client: client as never,
    load: { state: "unavailable" },
  });
  expect(unavailable.host.textContent).toContain("Publishing isn't set up on this server");
  expect(unavailable.host.querySelector("input")).toBeNull();
  await unavailable.unmount();

  const viewer = await renderPage({
    client: client as never,
    load: { state: "none" },
    canManage: false,
  });
  expect(viewer.host.textContent).toContain("You can't publish this Site");
  await viewer.unmount();

  let shared = 0;
  const onlyMe = await renderPage({
    client: client as never,
    load: { state: "forbidden" },
    site: { id: "site", title: "Team CRM", visibility: "private" },
    onShareWithWorkspace: () => (shared += 1),
  });
  // A forbidden answer on a private Site is the owner's own Only me Site.
  expect(onlyMe.host.textContent).toContain("You can't publish this Site");
  await onlyMe.unmount();

  const privateNone = await renderPage({
    client: client as never,
    load: { state: "none" },
    site: { id: "site", title: "Team CRM", visibility: "private" },
    onShareWithWorkspace: () => (shared += 1),
  });
  expect(privateNone.host.textContent).toContain("Share this Site with the workspace first");
  await act(async () => button(privateNone.host, "Share with workspace")!.click());
  expect(shared).toBe(1);
  await privateNone.unmount();
});

test("take down asks for a reason, and a taken-down Site offers Restore", async () => {
  const { client, calls } = fakeClient();
  const page = await renderPage({
    client: client as never,
    load: { state: "ready", publication: published({ access: "public" }) },
  });
  expect(page.host.textContent).toContain("Published");
  expect(page.host.textContent).toContain("team-crm-4k9x.sites.example");
  // Nothing changed yet, so there is nothing to save.
  expect(button(page.host, "Save changes")).toBeUndefined();

  await act(async () => button(page.host, "Take down…")!.click());
  await flush();
  const reason = document.querySelector("textarea")!;
  await act(async () => typeInto(reason, "Phishing form"));
  const confirm = [...document.querySelectorAll("button")].filter(
    (element) => element.textContent?.trim() === "Take down",
  );
  await act(async () => confirm.at(-1)!.click());
  await flush();
  expect(calls.takedowns).toEqual(["Phishing form"]);
  expect(page.published.at(-1)?.status).toBe("suspended");
  await page.unmount();

  const suspended = await renderPage({
    client: client as never,
    load: {
      state: "ready",
      publication: published({
        status: "suspended",
        moderation: {
          openReports: 1,
          suspendedAt: now,
          suspendedBy: "owner",
          suspendedReason: "Checking a report",
        },
      }),
    },
  });
  expect(suspended.host.textContent).toContain("Taken down");
  expect(suspended.host.textContent).toContain("Checking a report.");
  expect(button(suspended.host, "Restore")).toBeDefined();
  await suspended.unmount();

  const byPlatform = await renderPage({
    client: client as never,
    load: {
      state: "ready",
      publication: published({
        status: "suspended",
        moderation: {
          openReports: 0,
          suspendedAt: now,
          suspendedBy: "platform",
          suspendedReason: null,
        },
      }),
    },
  });
  expect(byPlatform.host.textContent).toContain("Contact support");
  expect(button(byPlatform.host, "Restore")).toBeUndefined();
  await byPlatform.unmount();
});
