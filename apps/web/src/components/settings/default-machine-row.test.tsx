import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
const sharedWorkspaceId = "33333333-3333-4333-8333-333333333333";
let workspaceGrants: { workspaceId: string; accountId: string; permissions: string[] }[] = [];

mock.module("@opengeni/react/app/app-context", () => ({
  useAppContext: () => ({
    workspaces: [
      { id: personalWorkspaceId, accountId, name: "Personal workspace", kind: "personal" },
      { id: sharedWorkspaceId, accountId, name: "Projects", kind: "shared" },
    ],
    clientConfig: { defaultSandboxBackend: "modal" },
    managedSelfContext: {
      identity: { credentialGeneration: 1, managedUserId: "alex", subjectId: "user:alex" },
      memberships: [
        { id: "membership", organizationId: accountId, status: "active", personalWorkspaceId },
      ],
    },
    accessContext: {
      mode: "managed",
      subjectId: "user:alex",
      defaultAccountId: accountId,
      accountGrants: [],
      workspaceGrants,
    },
    captureWorkspaceInvocation: () => null,
    ownsWorkspaceInvocation: () => false,
    updateWorkspaceSettings: async () => undefined,
  }),
}));

mock.module("@opengeni/react/app/lib/use-workspace-machines", () => ({
  useWorkspaceMachines: () => ({ machines: [], loading: false }),
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { DefaultMachineRow } = await import("./default-machine-row");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
});

async function picker(workspaceId: string): Promise<HTMLButtonElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(createElement(DefaultMachineRow, { workspaceId }));
  });
  const button = container.querySelector("button");
  if (!button) throw new Error("the default machine picker did not render");
  return button;
}

describe("Default machine", () => {
  test("the owner of a Personal workspace can change it", async () => {
    // A Personal workspace never grants workspace:admin to its owner.
    workspaceGrants = [
      { workspaceId: personalWorkspaceId, accountId, permissions: ["workspace:read"] },
    ];
    expect((await picker(personalWorkspaceId)).disabled).toBe(false);
  });

  test("in a shared workspace only its administrators can change it", async () => {
    workspaceGrants = [
      { workspaceId: sharedWorkspaceId, accountId, permissions: ["workspace:read"] },
    ];
    expect((await picker(sharedWorkspaceId)).disabled).toBe(true);
    workspaceGrants = [
      {
        workspaceId: sharedWorkspaceId,
        accountId,
        permissions: ["workspace:read", "workspace:admin"],
      },
    ];
    expect((await picker(sharedWorkspaceId)).disabled).toBe(false);
  });
});
