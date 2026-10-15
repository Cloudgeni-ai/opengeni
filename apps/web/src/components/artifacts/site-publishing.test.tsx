import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_SITE_LIMITS,
  type SiteHostnameAvailability,
  type SitePublication,
  type UpsertSitePublicationRequest,
} from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";

// One stable context: the model catalog hook refetches whenever its client changes.
const appContext = {
  client: {
    getWorkspaceModelCatalog: async () => ({
      models: [],
      defaultSelection: null,
      creditsSelection: null,
    }),
  },
};
mock.module("@/context", () => ({ useAppContext: () => appContext }));
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
  agent: { enabled: false, model: null, instructions: null, tools: null, guestTools: false },
  limitProfile: { kind: "standard", overrides: null },
  effectiveLimits: { ...DEFAULT_SITE_LIMITS },
  invitedEmails: [],
  moderation: { openReports: 0, suspendedAt: null, suspendedBy: null, suspendedReason: null },
  usage: { agentMicrosThisMonth: 0, agentMicrosToday: 0, conversationsToday: 0 },
  warnings: [],
  outsideAgentModel: null,
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
    applySitePublicationFix: async () => published(),
    ...overrides,
  };
  return { client, calls };
}

type PageProps = Parameters<typeof module.SitePublishPage>[0];

async function renderPage(props: Partial<PageProps> & Pick<PageProps, "client" | "load">) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const publications: SitePublication[] = [];
  await act(async () =>
    root.render(
      <module.SitePublishPage
        workspaceId="ws"
        workspaceName="Sales"
        site={{ id: "site", title: "Team CRM", visibility: "workspace" }}
        onPublication={(next) => publications.push(next)}
        onReload={() => {}}
        onBack={() => {}}
        canManage
        isAdmin
        sites={{ domain: "sites.example" }}
        labelSuffix="abcd"
        {...props}
      />,
    ),
  );
  return {
    host,
    published: publications,
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

test("a taken-down Site keeps its address, and only admins restore an admin's takedown", async () => {
  const { client } = fakeClient();
  const byAdmin = published({
    status: "suspended",
    moderation: { openReports: 0, suspendedAt: now, suspendedBy: "admin", suspendedReason: null },
  });
  const owner = await renderPage({
    client: client as never,
    load: { state: "ready", publication: byAdmin },
    isAdmin: false,
  });
  expect(owner.host.querySelector("input")?.disabled).toBe(true);
  expect(owner.host.textContent).toContain("Restore the Site to change its address.");
  expect(owner.host.textContent).toContain("A workspace admin can restore it.");
  expect(button(owner.host, "Restore")).toBeUndefined();
  await owner.unmount();

  const admin = await renderPage({
    client: client as never,
    load: { state: "ready", publication: byAdmin },
  });
  expect(button(admin.host, "Restore")).toBeDefined();
  await admin.unmount();
});

const withAgent = (patch: Partial<SitePublication> = {}) =>
  published({
    access: "public",
    agent: { enabled: true, model: null, instructions: null, tools: ["linear"], guestTools: false },
    usage: { agentMicrosThisMonth: 1_200_000, agentMicrosToday: 0, conversationsToday: 4 },
    ...patch,
  });
const input = (root: ParentNode, label: string) =>
  root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

test("invited and public Sites show one Site limit, an optional per-person limit and usage", async () => {
  const { client, calls } = fakeClient();
  const page = await renderPage({
    client: client as never,
    load: { state: "ready", publication: withAgent() },
  });
  const text = page.host.textContent ?? "";
  expect(text).toContain("Agent for people outside the workspace");
  expect(text).toContain("People outside the workspace can only use this Site's own data.");
  expect(text).toContain("$1.20 of $10 used this month");
  // No workspace tools for people outside the workspace, and no guard fields.
  expect(text).not.toContain("Let everyone use these tools");
  expect(text).not.toContain("Messages per conversation");
  expect(input(page.host, "Limit amount")?.value).toBe("10");
  expect(input(page.host, "Per person amount")).toBeNull();

  await act(async () => button(page.host, "Limit per person")!.click());
  await act(async () => typeInto(input(page.host, "Per person amount")!, "0.20"));
  await act(async () => typeInto(input(page.host, "Limit amount")!, "25"));
  await act(async () => button(page.host, "Save changes")!.click());
  await flush();
  expect(calls.updates.at(-1)).toEqual({
    limitProfile: {
      kind: "custom",
      overrides: {
        agentsEnabled: true,
        agentMicrosPerSitePerMonth: 25_000_000,
        agentMicrosPerSitePerDay: null,
        agentMicrosPerVisitorPerDay: 200_000,
        agentMicrosPerVisitorPerMonth: null,
      },
    },
  });
  await page.unmount();
});

test("turning the outside agent off hides its limits and saves it", async () => {
  const { client, calls } = fakeClient();
  const page = await renderPage({
    client: client as never,
    load: { state: "ready", publication: withAgent({ access: "invited" }) },
  });
  const toggle = page.host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle.click());
  expect(input(page.host, "Limit amount")).toBeNull();
  await act(async () => button(page.host, "Save changes")!.click());
  await flush();
  expect(calls.updates.at(-1)?.limitProfile?.overrides).toMatchObject({ agentsEnabled: false });
  await page.unmount();
});

test("non-admins see the outside limits but can't change them; members Sites have none", async () => {
  const { client } = fakeClient();
  const member = await renderPage({
    client: client as never,
    load: { state: "ready", publication: withAgent() },
    isAdmin: false,
  });
  expect(input(member.host, "Limit amount")?.disabled).toBe(true);
  expect(button(member.host, "Limit per person")).toBeUndefined();
  expect(member.host.textContent).toContain("Only workspace admins change this.");
  await member.unmount();

  const membersOnly = await renderPage({
    client: client as never,
    load: { state: "ready", publication: withAgent({ access: "members" }) },
  });
  expect(membersOnly.host.textContent).not.toContain("Agent for people outside the workspace");
  expect(input(membersOnly.host, "Limit amount")).toBeNull();
  expect(membersOnly.host.textContent).not.toContain("View as visitor");
  await membersOnly.unmount();
});

test("a subscription model names the credit-billed model outside people use", async () => {
  const { client } = fakeClient();
  const page = await renderPage({
    client: client as never,
    load: {
      state: "ready",
      publication: withAgent({
        agent: {
          enabled: true,
          model: "codex/gpt-6.1-sol",
          instructions: null,
          tools: null,
          guestTools: false,
        },
        outsideAgentModel: "gpt-6",
      }),
    },
  });
  expect(page.host.textContent).toContain(
    "People outside the workspace use gpt-6 (paid with credits).",
  );
  await page.unmount();
});

test("readiness warnings open to a list with one-click fixes", async () => {
  const fixes: unknown[] = [];
  const fix = {
    kind: "site_data_guest_access" as const,
    collection: "votes",
    guestAccess: "append" as const,
  };
  const { client } = fakeClient({
    applySitePublicationFix: async (_ws: string, _site: string, request: unknown) => {
      fixes.push(request);
      return withAgent();
    },
  });
  const page = await renderPage({
    client: client as never,
    load: {
      state: "ready",
      publication: withAgent({
        warnings: [
          {
            code: "site_data_guest_write",
            message: "Public visitors can't add to votes.",
            suggestion: "Let guests append to votes.",
            fix,
          },
          {
            code: "workspace_tools_members_only",
            message: "The page calls workspace tools, which only members can use.",
            suggestion: "Use Site Data or Site SQL instead.",
            fix: null,
          },
        ],
      }),
    },
  });
  const line = [...page.host.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("2 things won't work for public visitors"),
  )!;
  expect(line.getAttribute("aria-expanded")).toBe("false");
  await act(async () => line.click());
  expect(line.getAttribute("aria-expanded")).toBe("true");
  expect(page.host.textContent).toContain("Public visitors can't add to votes.");
  expect(page.host.textContent).toContain("Use Site Data or Site SQL instead.");
  await act(async () => button(page.host, "Fix")!.click());
  await flush();
  expect(fixes).toEqual([fix]);
  expect(page.published).toHaveLength(1);
  await page.unmount();
});

test("View as visitor opens the Site as its visitors' role", async () => {
  const { client } = fakeClient();
  const page = await renderPage({
    client: client as never,
    load: { state: "ready", publication: withAgent({ access: "invited" }) },
  });
  const link = [...page.host.querySelectorAll("a")].find(
    (element) => element.textContent === "View as visitor",
  );
  expect(link?.getAttribute("href")).toBe(
    "https://team-crm-4k9x.sites.example/?og_view_as=invited",
  );
  await page.unmount();
});

test("a platform refusal explains itself instead of failing the form", async () => {
  const { client } = fakeClient({
    updateSitePublication: async () => {
      throw new OpenGeniApiError(
        402,
        JSON.stringify({
          error: {
            code: "payment_required",
            message: "Sites allowance used up",
            details: { code: "site_platform_quota_exhausted" },
          },
        }),
        { mutation: true },
      );
    },
  });
  const page = await renderPage({ client: client as never, load: { state: "none" } });
  await waitForCheck();
  await act(async () => button(page.host, "Publish")!.click());
  await flush();
  expect(page.host.textContent).toContain("Sites allowance used up");
  expect(page.host.textContent).toContain("Add credits to publish again.");
  expect(page.published).toHaveLength(0);
  await page.unmount();
});

test("a non-admin's first publish leaves limits to the workspace default", async () => {
  const { client, calls } = fakeClient();
  const page = await renderPage({
    client: client as never,
    load: { state: "none" },
    isAdmin: false,
  });
  await waitForCheck();
  await act(async () => button(page.host, "Publish")!.click());
  await flush();
  expect(calls.updates).toHaveLength(1);
  expect(calls.updates[0]).not.toHaveProperty("limitProfile");
  await page.unmount();
});
