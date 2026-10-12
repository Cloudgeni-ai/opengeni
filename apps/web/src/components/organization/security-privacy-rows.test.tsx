import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import type { OrganizationAdminIdentity } from "@/lib/organization-admin";
import type { OrganizationPrivacySettings } from "@/types";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const toastSuccess = mock((_message: string) => undefined);
mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { success: toastSuccess, error: mock(() => undefined) },
  ),
}));
const { PrivateChatsRow } = await import("./security-page");
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const identity: OrganizationAdminIdentity = {
  principalGeneration: 1,
  subjectId: "user:owner",
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

let onlyMe = { enabled: true, available: true };
let privacy: OrganizationPrivacySettings;
const updatePrivacy = mock(
  async (_organizationId: string, change: Partial<OrganizationPrivacySettings>) => {
    privacy = { ...privacy, ...change };
    return privacy;
  },
);
const client = {
  requestJson: async () => ({
    organizationId: identity.organizationId,
    ...onlyMe,
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
  }),
  getOrganizationPrivacySettings: async () => privacy,
  updateOrganizationPrivacySettings: updatePrivacy,
} as unknown as OpenGeniBrowserClient;

beforeEach(() => {
  document.body.replaceChildren();
  updatePrivacy.mockClear();
  onlyMe = { enabled: true, available: true };
  privacy = {
    organizationId: identity.organizationId,
    defaultVisibility: "workspace",
    adminsSeePrivateSchedules: true,
    limits: {
      onlyMeAllowed: true,
      defaultVisibilityLocked: false,
      adminsSeePrivateSchedulesLocked: false,
    },
    updatedAt: null,
  };
});

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PrivateChatsRow client={client} identity={identity} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { container, root };
}

function radio(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (option) => option.textContent === label,
  );
}

function switchFor(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
}

test("owners pick the default audience and whether admins see Only me schedules", async () => {
  const { container, root } = await render();
  expect(container.textContent).toContain("Only me chats and schedules");
  expect(container.textContent).toContain("New chats and schedules");
  expect(radio(container, "Workspace")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    radio(container, "Only me")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(updatePrivacy).toHaveBeenCalledWith(identity.organizationId, {
    defaultVisibility: "private",
  });
  expect(radio(container, "Only me")!.getAttribute("aria-checked")).toBe("true");

  expect(container.textContent).toContain("Never its name, message or chats.");
  await act(async () => {
    switchFor(container, "Admins see Only me schedules")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(updatePrivacy).toHaveBeenLastCalledWith(identity.organizationId, {
    adminsSeePrivateSchedules: false,
  });
  expect(container.textContent).toContain(
    "Admins can't see other people's Only me schedules at all, like Only me chats.",
  );
  await act(async () => root.unmount());
});

test("choices this app fixes are shown locked, with the reason", async () => {
  onlyMe = { enabled: true, available: false };
  privacy = {
    ...privacy,
    adminsSeePrivateSchedules: true,
    limits: {
      onlyMeAllowed: false,
      defaultVisibilityLocked: true,
      adminsSeePrivateSchedulesLocked: true,
    },
  };
  const { container, root } = await render();
  const onlyMeSwitch = switchFor(container, "Only me chats and schedules")!;
  expect(onlyMeSwitch.getAttribute("aria-checked")).toBe("false");
  expect(onlyMeSwitch.disabled).toBe(true);
  expect(container.textContent).toContain(
    "Only me is off. This is set for everyone using this app.",
  );
  // The default only matters while Only me is on.
  expect(container.textContent).not.toContain("New chats and schedules");
  expect(switchFor(container, "Admins see Only me schedules")!.disabled).toBe(true);
  await act(async () => root.unmount());
});
