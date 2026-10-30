import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import type { OrganizationAdminIdentity } from "@opengeni/react/app/lib/organization-admin";
import type { OrganizationPrivacySettings } from "@opengeni/react/app/types";

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
const { OwnMachinesRow } = await import("./security-page");
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

let privacy: OrganizationPrivacySettings;
const updatePrivacy = mock(
  async (_organizationId: string, change: Partial<OrganizationPrivacySettings>) => {
    privacy = { ...privacy, ...change };
    return privacy;
  },
);
const client = {
  getOrganizationPrivacySettings: async () => privacy,
  updateOrganizationPrivacySettings: updatePrivacy,
} as unknown as OpenGeniBrowserClient;

beforeEach(() => {
  document.body.replaceChildren();
  updatePrivacy.mockClear();
  toastSuccess.mockClear();
  privacy = {
    organizationId: identity.organizationId,
    membersConnectOwnMachines: true,
    defaultVisibility: "workspace",
    personalWorkspaces: true,
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
    root.render(<OwnMachinesRow client={client} identity={identity} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { container, root };
}

const LABEL = "Members connect their own machines";
const switchIn = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${LABEL}"]`)!;

test("owners keep members' own machines to owners and admins, and turn it back on", async () => {
  const { container, root } = await render();
  expect(container.textContent).toContain(LABEL);
  expect(switchIn(container).getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("Owners and admins always can.");

  await act(async () => {
    switchIn(container).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // Only this choice is sent, so it never undoes another admin's change.
  expect(updatePrivacy).toHaveBeenLastCalledWith(identity.organizationId, {
    membersConnectOwnMachines: false,
  });
  expect(switchIn(container).getAttribute("aria-checked")).toBe("false");
  expect(toastSuccess).toHaveBeenLastCalledWith(
    "Only owners and admins can connect their own machines now",
  );
  // Off says what still works.
  expect(container.textContent).toContain("including in Personal workspaces");
  expect(container.textContent).toContain(
    "Machines already connected keep working until they're removed or need connecting again.",
  );

  await act(async () => {
    switchIn(container).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(updatePrivacy).toHaveBeenLastCalledWith(identity.organizationId, {
    membersConnectOwnMachines: true,
  });
  expect(toastSuccess).toHaveBeenLastCalledWith("Members can connect their own machines");
  await act(async () => root.unmount());
});

test("an older server without the setting reads as on", async () => {
  const { membersConnectOwnMachines: _omitted, ...older } = privacy;
  privacy = older as OrganizationPrivacySettings;
  const { container, root } = await render();
  expect(switchIn(container).getAttribute("aria-checked")).toBe("true");
  await act(async () => root.unmount());
});
