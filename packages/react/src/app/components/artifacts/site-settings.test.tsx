import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceArtifact } from "@opengeni/sdk";

import type { AppContextValue } from "../../app-context";
import type { AppHost } from "../../lib/app-host";
import type { SiteManagement } from "./site-settings";

// Everyone who can open an app sees its Settings; what each person can change
// there follows their permission. Imported once the DOM exists.
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let AppContext: typeof import("../../app-context").AppContext;
let AppHostProvider: typeof import("../../lib/app-host").AppHostProvider;
let settings: typeof import("./site-settings");
let ownsDom = false;

beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://app.example.test/" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ AppContext } = await import("../../app-context"));
  ({ AppHostProvider } = await import("../../lib/app-host"));
  settings = await import("./site-settings");
}, 20_000);

afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

afterEach(() => {
  document.body.innerHTML = "";
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";

function site(patch: Partial<WorkspaceArtifact> = {}): WorkspaceArtifact {
  return {
    id: siteId,
    accountId: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    slug: "usage",
    title: "Opengeni usage",
    description: null,
    status: "active",
    visibility: "workspace",
    ownerSubjectId: "someone-else",
    currentVersion: { id: "44444444-4444-4444-8444-444444444444" },
    createdBySubjectId: "someone-else",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...patch,
  } as WorkspaceArtifact;
}

async function renderSettings({
  canPublish,
  artifact = site(),
}: {
  canPublish: boolean;
  artifact?: WorkspaceArtifact;
}) {
  const requests: string[] = [];
  // Any call the panel makes is recorded; a viewer's panel should make none.
  const client = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === "string"
          ? async () => {
              requests.push(name);
              return {};
            }
          : undefined,
    },
  );
  const appContext = {
    client,
    clientConfig: {},
    accessContext: { subjectId: "me", workspaceGrants: [] },
  } as unknown as AppContextValue;
  const host = {
    api: { request: async () => ({}) },
    navigation: { useNavigate: () => async () => {}, page: null },
  } as unknown as AppHost;
  const management = {
    canPublish,
    isAdmin: false,
    manageData: false,
    workspaceName: "Cloudgeni",
    publication: { load: { state: "unavailable" } },
    audience: { share: null, limit: null },
    statusBusy: false,
    setSiteStatus: async () => true,
  } as unknown as SiteManagement;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(async () =>
    root.render(
      <AppHostProvider host={host}>
        <AppContext.Provider value={appContext}>
          <settings.SiteSettings
            workspaceId={workspaceId}
            artifact={artifact}
            management={management}
          />
        </AppContext.Provider>
      </AppHostProvider>,
    ),
  );
  const buttons = () =>
    [...container.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
  const expandMore = () =>
    React.act(async () => {
      const more = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.trim().startsWith("More"),
      );
      more?.click();
    });
  return { container, requests, buttons, expandMore };
}

test("someone who can't publish sees no controls that change the app", async () => {
  const view = await renderSettings({ canPublish: false });
  const text = view.container.textContent ?? "";
  expect(text).toContain("Workspace access");
  expect(text).toContain("Only its owner can change this.");
  // Their own allowed actions are the one thing they reset, shown as it is.
  expect(text).toContain("Allowed actions");
  expect(view.buttons()).toEqual(["Reset"]);
  for (const label of ["Duplicate", "Export", "Upgrade", "Archive", "Restore"])
    expect(text).not.toContain(label);
  expect(view.requests).toEqual([]);
});

test("an owner who can't publish is told why workspace access can't change", async () => {
  const view = await renderSettings({
    canPublish: false,
    artifact: site({ ownerSubjectId: "me" }),
  });
  expect(view.container.textContent).toContain("You need permission to publish to change this.");
});

test("a publisher's rarer actions sit under More", async () => {
  const view = await renderSettings({ canPublish: true });
  expect(view.buttons().some((label) => label.startsWith("More"))).toBe(true);
  await view.expandMore();
  const buttons = view.buttons();
  for (const label of ["Duplicate", "Export", "Upgrade", "Reset", "Archive"])
    expect(buttons).toContain(label);
  expect(buttons).not.toContain("Restore");
});

test("an archived app offers Restore up front and nothing that edits it", async () => {
  const view = await renderSettings({
    canPublish: true,
    artifact: site({ status: "archived" }),
  });
  expect(view.buttons()).toContain("Restore");
  await view.expandMore();
  const buttons = view.buttons();
  expect(buttons).toContain("Duplicate");
  for (const label of ["Upgrade", "Reset", "Archive"]) expect(buttons).not.toContain(label);
});
