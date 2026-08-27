import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import { destructiveActionFocusTarget } from "@/components/ui/confirm-dialog";
import { type OrganizationAdminIdentity } from "@/lib/organization-admin";
import type {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationPrivateSessionSettings,
  OrganizationRetentionPolicy,
} from "@/types";

const toastSuccess = mock((_message: string) => undefined);
const toastError = mock((_message: string) => undefined);

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    {
      error: toastError,
      success: toastSuccess,
    },
  ),
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  destructiveActionFocusTarget,
  ConfirmDialog: ({
    confirmLabel,
    onConfirm,
    open,
    title,
  }: {
    confirmLabel: string;
    onConfirm: () => unknown;
    open: boolean;
    title: ReactNode;
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button type="button" onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

const {
  OrganizationOverviewSection,
  OrganizationPeopleSection,
  OrganizationPrivateSessionsSection,
  OrganizationRetentionSection,
} = await import("./organization-admin");

const identityA: OrganizationAdminIdentity = {
  principalGeneration: 1,
  subjectId: "user:actor-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
};
const identityB: OrganizationAdminIdentity = {
  principalGeneration: 2,
  subjectId: "user:actor-b",
  organizationId: "org-b",
  workspaceId: "workspace-b",
};
const timestamp = "2026-08-20T10:00:00.000Z";

function member(
  identity: OrganizationAdminIdentity,
  suffix: string,
  role: OrganizationMember["role"] = "owner",
): OrganizationMember {
  return {
    id: `membership-${suffix}`,
    organizationId: identity.organizationId,
    subjectId: identity.subjectId,
    name: "Test person",
    email: "person@example.com",
    role,
    status: "active",
    authorizationRevision: 1,
    sharedWorkspaceAccess: [],
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function invitation(role: OrganizationInvitation["role"]): OrganizationInvitation {
  return {
    id: `invite-${role}`,
    organizationId: identityA.organizationId,
    organizationName: "Organization A",
    targetEmail: `${role}@example.test`,
    targetName: null,
    initialWorkspaceIds: [],
    role,
    status: "pending",
    revision: 1,
    expiresAt: timestamp,
    acceptedMembershipId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    delivery: null,
  };
}

function policy(identity: OrganizationAdminIdentity, retentionDays: number | null = null) {
  return {
    organizationId: identity.organizationId,
    mode: retentionDays === null ? "retain" : "delete_after",
    retentionDays,
    version: 1,
    updatedAt: timestamp,
  } satisfies OrganizationRetentionPolicy;
}

function overview(identity: OrganizationAdminIdentity): OrganizationAdministrationOverview {
  return {
    organization: {
      id: identity.organizationId,
      name: "Acme Engineering",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    roles: [
      {
        role: "viewer",
        label: "Viewer",
        description: "Can read workspace content",
        permissions: ["workspace:read"],
      },
      {
        role: "member",
        label: "Member",
        description: "Can work in this workspace",
        permissions: ["workspace:read", "sessions:create"],
      },
      {
        role: "admin",
        label: "Workspace administrator",
        description: "Can manage workspace content and access",
        permissions: ["workspace:read", "workspace:admin", "members:manage"],
      },
    ],
    workspaces: [
      {
        id: "workspace-company",
        name: "Company platform",
        slug: "company-platform",
        createdAt: timestamp,
        updatedAt: timestamp,
        members: [
          {
            membershipId: "workspace-member-a",
            organizationMembershipId: "organization-member-a",
            subjectId: "user:alice",
            name: "Alice Example",
            email: "alice@example.com",
            subjectLabel: "Alice Example",
            principalKind: "human",
            organizationRole: "member",
            role: "admin",
            permissions: ["workspace:read", "sessions:read"],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            membershipId: "workspace-service-a",
            organizationMembershipId: null,
            subjectId: "service:deploy",
            name: null,
            email: null,
            subjectLabel: "Deployment automation",
            principalKind: "service",
            organizationRole: null,
            role: "custom",
            permissions: ["workspace:read"],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      },
    ],
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function enterText(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const onChange = reactPropsKey
      ? (
          input as unknown as Record<
            string,
            { onChange?: (event: { target: HTMLInputElement }) => void }
          >
        )[reactPropsKey]?.onChange
      : undefined;
    if (onChange) onChange({ target: input });
    else input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("organization administration component fences", () => {
  test("lets an administrator enable Only me chats without loading organization members", async () => {
    const current = {
      organizationId: identityA.organizationId,
      enabled: false,
      available: true,
      version: 0,
      updatedAt: timestamp,
    } satisfies OrganizationPrivateSessionSettings;
    const requestJson = mock(
      async (
        method: string,
        _path: string,
        _request?: { enabled: boolean; expectedVersion: number; operationId: string },
      ) =>
        method === "GET"
          ? current
          : {
              ...current,
              enabled: true,
              version: 1,
              changed: true,
            },
    );
    const client = { requestJson } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationPrivateSessionsSection
          client={client}
          identity={identityA}
          actorRole="admin"
          managedSession
        />,
      );
    });
    await flush();
    expect(container.textContent).toContain("Only me chats");
    await act(async () => button(container, "Enable").click());
    await flush();

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson.mock.calls[1]?.[0]).toBe("PATCH");
    expect(requestJson.mock.calls[1]?.[1]).toBe(
      `/v1/organizations/${identityA.organizationId}/private-session-settings`,
    );
    expect(requestJson.mock.calls[1]?.[2]).toMatchObject({
      enabled: true,
      expectedVersion: 0,
    });
    expect(container.textContent).toContain("permission to start chats");

    await act(async () => root.unmount());
    container.remove();
  });

  test("makes a delayed organization A private-session read inert after switching to B", async () => {
    const pendingA = deferred<OrganizationPrivateSessionSettings>();
    const settingsB = {
      organizationId: identityB.organizationId,
      enabled: true,
      available: true,
      version: 4,
      updatedAt: timestamp,
    } satisfies OrganizationPrivateSessionSettings;
    const requestJson = mock(async (_method: string, path: string) =>
      path.includes(identityA.organizationId) ? pendingA.promise : settingsB,
    );
    const client = { requestJson } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationPrivateSessionsSection
          key="a"
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
        />,
      );
    });
    await act(async () => {
      root.render(
        <OrganizationPrivateSessionsSection
          key="b"
          client={client}
          identity={identityB}
          actorRole="owner"
          managedSession
        />,
      );
    });
    await flush();
    expect(container.textContent).toContain("Members who have permission to start chats");

    pendingA.resolve({
      organizationId: identityA.organizationId,
      enabled: false,
      available: true,
      version: 0,
      updatedAt: timestamp,
    });
    await flush();

    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Members who have permission to start chats");
    expect(container.textContent).not.toContain("workspace-visible chats only");

    await act(async () => root.unmount());
    container.remove();
  });

  test("renders shared workspace access and keeps rename owned through StrictMode", async () => {
    const getOrganizationAdministrationOverview = mock(async () => overview(identityA));
    const updateOrganizationName = mock(async () => ({
      ...overview(identityA).organization,
      name: "Acme Research",
      updatedAt: "2026-08-20T11:00:00.000Z",
    }));
    const onOrganizationChanged = mock(() => undefined);
    const client = {
      getOrganizationAdministrationOverview,
      listOrganizationAdministrationMembers: mock(async () => ({
        members: [member(identityA, "overview")],
      })),
      updateOrganizationName,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <OrganizationOverviewSection
            client={client}
            identity={identityA}
            actorRole="owner"
            managedSession
            accessibleWorkspaceIds={new Set(["workspace-company"])}
            onOrganizationChanged={onOrganizationChanged}
            onCreateWorkspace={async () => undefined}
          />
        </StrictMode>,
      );
    });
    await flush();

    expect(getOrganizationAdministrationOverview.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("Acme Engineering");
    expect(container.textContent).toContain("Company platform");
    expect(container.textContent).toContain("2 members");
    expect(container.textContent).not.toContain("Private roadmap");
    await act(async () => button(container, "Rename").click());
    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Organization name"]',
    );
    if (!nameInput) throw new Error("Missing organization name input");
    await enterText(nameInput, "Acme Research");
    await act(async () => button(container, "Save").click());
    await flush();

    expect(updateOrganizationName).toHaveBeenCalledWith(identityA.organizationId, {
      name: "Acme Research",
      expectedUpdatedAt: timestamp,
      operationId: expect.any(String),
    });
    expect(container.textContent).toContain("Acme Research");
    expect(onOrganizationChanged).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Organization name updated");

    await act(async () => root.unmount());
    container.remove();
  });

  test("uses the organization control plane for shared-workspace settings and access", async () => {
    const updateOrganizationWorkspace = mock(async () => ({
      id: "workspace-company",
      accountId: identityA.organizationId,
      name: "Company systems",
    }));
    const putOrganizationWorkspaceMember = mock(async () => ({
      subjectId: "user:alice",
      subjectLabel: "Alice Example",
      role: "admin",
      permissions: ["workspace:admin"],
      createdAt: timestamp,
    }));
    const client = {
      getOrganizationAdministrationOverview: mock(async () => overview(identityA)),
      listOrganizationAdministrationMembers: mock(async () => ({
        members: [member(identityA, "overview")],
      })),
      updateOrganizationWorkspace,
      putOrganizationWorkspaceMember,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationOverviewSection
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
          accessibleWorkspaceIds={new Set()}
          onOrganizationChanged={() => undefined}
          onCreateWorkspace={async () => undefined}
        />,
      );
    });
    await flush();

    const workspaceName = container.querySelector<HTMLInputElement>(
      'input[aria-label="Workspace name for Company platform"]',
    );
    if (!workspaceName) throw new Error("Missing workspace name input");
    await enterText(workspaceName, "Company systems");
    await act(async () => button(container, "Save name").click());
    await flush();
    expect(updateOrganizationWorkspace).toHaveBeenCalledWith(
      identityA.organizationId,
      "workspace-company",
      {
        name: "Company systems",
        expectedUpdatedAt: timestamp,
        operationId: expect.any(String),
      },
    );

    const access = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Workspace access for Alice Example"]',
    );
    if (!access) throw new Error("Missing workspace access select");
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(access), "value")?.set?.call(
        access,
        "admin",
      );
      access.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    expect(putOrganizationWorkspaceMember).toHaveBeenCalledWith(
      identityA.organizationId,
      "workspace-company",
      "organization-member-a",
      {
        role: "admin",
        expectedUpdatedAt: timestamp,
        operationId: expect.any(String),
      },
    );

    await act(async () => root.unmount());
    container.remove();
  });

  test("retries an outcome-unknown rename with the exact operation id", async () => {
    const getOrganizationAdministrationOverview = mock(async () => overview(identityA));
    const uncertain = Object.assign(new Error("response lost"), {
      outcomeUnknown: true,
    });
    const updateOrganizationName = mock(async (...args: unknown[]) => {
      if (updateOrganizationName.mock.calls.length === 1) throw uncertain;
      const request = args[1] as { name: string };
      return {
        ...overview(identityA).organization,
        name: request.name,
        updatedAt: "2026-08-20T11:00:00.000Z",
      };
    });
    const client = {
      getOrganizationAdministrationOverview,
      listOrganizationAdministrationMembers: mock(async () => ({
        members: [member(identityA, "overview")],
      })),
      updateOrganizationName,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationOverviewSection
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
          accessibleWorkspaceIds={new Set()}
          onOrganizationChanged={() => undefined}
          onCreateWorkspace={async () => undefined}
        />,
      );
    });
    await flush();
    await act(async () => button(container, "Rename").click());
    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Organization name"]',
    );
    if (!nameInput) throw new Error("Missing organization name input");
    await enterText(nameInput, "Acme Research");
    await act(async () => button(container, "Save").click());
    await flush();
    await act(async () => button(container, "Save").click());
    await flush();

    expect(updateOrganizationName).toHaveBeenCalledTimes(2);
    const firstRequest = updateOrganizationName.mock.calls[0]?.[1] as {
      operationId: string;
    };
    const secondRequest = updateOrganizationName.mock.calls[1]?.[1] as {
      operationId: string;
    };
    expect(secondRequest.operationId).toBe(firstRequest.operationId);
    expect(container.textContent).toContain("Acme Research");

    await act(async () => root.unmount());
    container.remove();
  });

  test("reports a failed account-menu refresh without misreporting a committed rename", async () => {
    const getOrganizationAdministrationOverview = mock(async () => overview(identityA));
    const updateOrganizationName = mock(async () => ({
      ...overview(identityA).organization,
      name: "Acme Research",
      updatedAt: "2026-08-20T11:00:00.000Z",
    }));
    const client = {
      getOrganizationAdministrationOverview,
      listOrganizationAdministrationMembers: mock(async () => ({
        members: [member(identityA, "overview")],
      })),
      updateOrganizationName,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationOverviewSection
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
          accessibleWorkspaceIds={new Set()}
          onOrganizationChanged={() => Promise.reject(new Error("access refresh unavailable"))}
          onCreateWorkspace={async () => undefined}
        />,
      );
    });
    await flush();
    await act(async () => button(container, "Rename").click());
    const nameInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Organization name"]',
    );
    if (!nameInput) throw new Error("Missing organization name input");
    await enterText(nameInput, "Acme Research");
    await act(async () => button(container, "Save").click());
    await flush();

    expect(container.textContent).toContain("Acme Research");
    expect(toastSuccess).toHaveBeenCalledWith("Organization name updated");
    expect(toastError).toHaveBeenCalledWith(
      "Organization name updated, but the account menu couldn't refresh",
      { description: "access refresh unavailable" },
    );
    expect(toastError).not.toHaveBeenCalledWith(
      "Couldn't update organization name",
      expect.anything(),
    );

    await act(async () => root.unmount());
    container.remove();
  });

  test("keeps people reads and mutations owned through StrictMode setup cleanup setup", async () => {
    const actor = member(identityA, "strict-actor");
    const secondOwner = {
      ...member(identityA, "strict-owner-2"),
      subjectId: "user:owner-2",
      name: "Second Owner",
      email: "owner-2@example.com",
    };
    const listOrganizationAdministrationMembers = mock(async () => ({
      members: [actor, secondOwner],
    }));
    const updateOrganizationMember = mock(async () => ({
      ...actor,
      status: "suspended" as const,
      authorizationRevision: 2,
    }));
    const onAuthorityChanged = mock(() => undefined);
    const client = {
      listOrganizationAdministrationMembers,
      listOrganizationInvitationsForOrganization: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      listOrganizationInvitations: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      updateOrganizationMember,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <OrganizationPeopleSection
            client={client}
            identity={identityA}
            actorRole="owner"
            managedSession
            onAuthorityChanged={onAuthorityChanged}
          />
        </StrictMode>,
      );
    });
    await flush();

    expect(listOrganizationAdministrationMembers.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("No organization invitations yet.");
    expect(container.textContent).toContain("Second Owner");
    const roleSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Organization role for Test person (you)"]',
    );
    expect(roleSelect).not.toBeNull();
    expect(roleSelect?.parentElement?.classList.contains("relative")).toBe(true);
    expect(Array.from(roleSelect?.options ?? []).map((option) => option.textContent)).toContain(
      "Administrator",
    );
    expect(container.textContent).not.toContain("Suspend");
    expect(container.textContent).not.toContain("Offboard");
    expect(container.textContent).toContain("Remove");
    await act(async () => button(container, "Pause access").click());
    await act(async () => button(container, "Confirm pause").click());
    await flush();

    expect(updateOrganizationMember).toHaveBeenCalledTimes(1);
    expect(onAuthorityChanged).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Member access paused");

    await act(async () => root.unmount());
    container.remove();
  });

  test("keeps retention reads and mutations owned through StrictMode setup cleanup setup", async () => {
    const getOrganizationRetentionPolicy = mock(async () => policy(identityA));
    const updateOrganizationRetentionPolicy = mock(async () => ({
      ...policy(identityA, 30),
      version: 2,
    }));
    const client = {
      getOrganizationRetentionPolicy,
      updateOrganizationRetentionPolicy,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <OrganizationRetentionSection
            client={client}
            identity={identityA}
            actorRole="owner"
            managedSession
          />
        </StrictMode>,
      );
    });
    await flush();

    expect(getOrganizationRetentionPolicy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("Retain removed members' personal data indefinitely");
    const deleteAfter = Array.from(container.querySelectorAll("input")).find(
      (input) =>
        input.getAttribute("type") === "radio" &&
        input.nextSibling?.textContent?.includes("eligible"),
    );
    if (!(deleteAfter instanceof HTMLInputElement)) throw new Error("Missing delete-after radio");
    await act(async () => deleteAfter.click());
    await act(async () => button(container, "Review retention change").click());
    await act(async () => button(container, "Change retention policy").click());
    await flush();

    expect(updateOrganizationRetentionPolicy).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Retention policy updated");
    expect(container.textContent).toContain("operator cleanup after 30 days");

    await act(async () => root.unmount());
    container.remove();
  });

  test("serializes organization invitation reads with create and revoke in both orders", async () => {
    const listedInvite = invitation("member");
    const pageRead = deferred<{
      invitations: OrganizationInvitation[];
      nextCursor: string | null;
    }>();
    const createResult = deferred<OrganizationInvitation>();
    const revokeResult = deferred<OrganizationInvitation>();
    let listCall = 0;
    const listOrganizationInvitationsForOrganization = mock(async () => {
      listCall += 1;
      return listCall === 1
        ? { invitations: [listedInvite], nextCursor: "page-1" }
        : pageRead.promise;
    });
    const createOrganizationInvitation = mock(() => createResult.promise);
    const revokeOrganizationInvitation = mock(() => revokeResult.promise);
    const requestJson = mock(async (_method: string, _path: string, _request: unknown) => ({
      id: "delivery-created",
      state: "sent" as const,
      attemptCount: 1,
      revision: 3,
      errorClass: null,
      retryState: "unavailable" as const,
      sentAt: timestamp,
      updatedAt: timestamp,
    }));
    const client = {
      listOrganizationAdministrationMembers: async () => ({
        members: [
          member(identityA, "actor"),
          { ...member(identityA, "owner-2"), subjectId: "user:owner-2" },
        ],
      }),
      listOrganizationInvitationsForOrganization,
      listOrganizationInvitations: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      createOrganizationInvitation,
      revokeOrganizationInvitation,
      requestJson,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationPeopleSection
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
          onAuthorityChanged={() => undefined}
        />,
      );
    });
    await flush();
    const email = container.querySelector<HTMLInputElement>("#organization-invite-email");
    if (!email) throw new Error("Missing invitation email field");
    await enterText(email, "new-member@example.test");

    await act(async () => button(container, "Load more invitations").click());
    expect(button(container, "Invite").disabled).toBe(true);
    expect(button(container, "Revoke invitation for member@example.test").disabled).toBe(true);
    expect(createOrganizationInvitation).not.toHaveBeenCalled();
    expect(revokeOrganizationInvitation).not.toHaveBeenCalled();

    pageRead.resolve({ invitations: [], nextCursor: "page-2" });
    await flush();
    expect(button(container, "Invite").disabled).toBe(false);
    expect(button(container, "Revoke invitation for member@example.test").disabled).toBe(false);

    await act(async () => button(container, "Invite").click());
    expect(createOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(button(container, "Load more invitations").disabled).toBe(true);
    createResult.resolve({
      ...listedInvite,
      id: "invite-created",
      targetEmail: "new-member@example.test",
    });
    await flush();
    expect(container.textContent).toContain("new-member@example.test");
    expect(container.textContent).toContain(
      "Invitation recorded for new-member@example.test; delivery has not started.",
    );
    expect(toastSuccess).toHaveBeenCalledWith("Organization invitation recorded");
    expect(button(container, "Load more invitations").disabled).toBe(false);
    const sendInvitation = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send invitation to new-member@example.test"]',
    );
    expect(sendInvitation).not.toBeNull();
    await act(async () => sendInvitation?.click());
    await flush();
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Email sent");

    await act(async () => button(container, "Revoke invitation for member@example.test").click());
    await act(async () => button(container, "Revoke invitation").click());
    expect(revokeOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(button(container, "Load more invitations").disabled).toBe(true);
    revokeResult.resolve({ ...listedInvite, status: "revoked", revision: 2 });
    await flush();
    expect(container.textContent).toContain("Member · revoked");
    expect(button(container, "Load more invitations").disabled).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  test("serializes incoming invitation reads with acceptance in both orders", async () => {
    const incomingInvite = invitation("member");
    const pageRead = deferred<{
      invitations: OrganizationInvitation[];
      nextCursor: string | null;
    }>();
    const acceptResult = deferred<unknown>();
    let listCall = 0;
    const listOrganizationInvitations = mock(async () => {
      listCall += 1;
      return listCall === 1
        ? { invitations: [incomingInvite], nextCursor: "page-1" }
        : pageRead.promise;
    });
    const acceptOrganizationInvitation = mock(() => acceptResult.promise);
    const onAuthorityChanged = mock(() => undefined);
    const client = {
      listOrganizationAdministrationMembers: async () => ({
        members: [
          member(identityA, "actor"),
          { ...member(identityA, "owner-2"), subjectId: "user:owner-2" },
        ],
      }),
      listOrganizationInvitationsForOrganization: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      listOrganizationInvitations,
      acceptOrganizationInvitation,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const acceptLabel = `Accept invitation to organization ${identityA.organizationId.slice(0, 8)}`;

    await act(async () => {
      root.render(
        <OrganizationPeopleSection
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
          onAuthorityChanged={onAuthorityChanged}
        />,
      );
    });
    await flush();

    await act(async () => button(container, "Load more incoming invitations").click());
    expect(button(container, acceptLabel).disabled).toBe(true);
    expect(acceptOrganizationInvitation).not.toHaveBeenCalled();
    pageRead.resolve({ invitations: [], nextCursor: "page-2" });
    await flush();
    expect(button(container, acceptLabel).disabled).toBe(false);

    await act(async () => button(container, acceptLabel).click());
    expect(acceptOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(button(container, "Load more incoming invitations").disabled).toBe(true);
    acceptResult.resolve(undefined);
    await flush();
    expect(onAuthorityChanged).toHaveBeenCalledTimes(1);
    expect(button(container, "Load more incoming invitations").disabled).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });

  test("makes a delayed people mutation inert after keyed A to B remount", async () => {
    const pendingUpdate = deferred<OrganizationMember>();
    const actorA = member(identityA, "actor-a");
    const secondOwner = {
      ...member(identityA, "owner-2"),
      subjectId: "user:owner-2",
      name: "Second Owner",
      email: "owner-2@example.com",
    };
    const actorB = member(identityB, "actor-b");
    const updateOrganizationMember = mock(() => pendingUpdate.promise);
    const onAuthorityChanged = mock(() => undefined);
    const client = {
      listOrganizationAdministrationMembers: async (organizationId: string) => ({
        members: organizationId === identityA.organizationId ? [actorA, secondOwner] : [actorB],
      }),
      listOrganizationInvitationsForOrganization: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      listOrganizationInvitations: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      updateOrganizationMember,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationPeopleSection
          key="a"
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
          onAuthorityChanged={onAuthorityChanged}
        />,
      );
    });
    await flush();
    await act(async () => button(container, "Pause access").click());
    await act(async () => button(container, "Confirm pause").click());

    await act(async () => {
      root.render(
        <OrganizationPeopleSection
          key="b"
          client={client}
          identity={identityB}
          actorRole="owner"
          managedSession
          onAuthorityChanged={onAuthorityChanged}
        />,
      );
    });
    await flush();
    pendingUpdate.resolve({
      ...actorA,
      status: "suspended",
      authorizationRevision: 2,
    });
    await flush();

    expect(updateOrganizationMember).toHaveBeenCalledTimes(1);
    expect(onAuthorityChanged).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(container.textContent).toContain("You");
    expect(container.textContent).not.toContain("Second Owner");

    await act(async () => root.unmount());
    container.remove();
  });

  test("makes a delayed retention mutation inert after keyed A to B remount", async () => {
    const pendingUpdate = deferred<OrganizationRetentionPolicy>();
    const updateOrganizationRetentionPolicy = mock(() => pendingUpdate.promise);
    const client = {
      getOrganizationRetentionPolicy: async (organizationId: string) =>
        organizationId === identityA.organizationId ? policy(identityA) : policy(identityB, 60),
      updateOrganizationRetentionPolicy,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationRetentionSection
          key="a"
          client={client}
          identity={identityA}
          actorRole="owner"
          managedSession
        />,
      );
    });
    await flush();
    const deleteAfter = Array.from(container.querySelectorAll("input")).find(
      (input) =>
        input.getAttribute("type") === "radio" &&
        input.nextSibling?.textContent?.includes("eligible"),
    );
    if (!(deleteAfter instanceof HTMLInputElement)) throw new Error("Missing delete-after radio");
    await act(async () => deleteAfter.click());
    await act(async () => button(container, "Review retention change").click());
    await act(async () => button(container, "Change retention policy").click());

    await act(async () => {
      root.render(
        <OrganizationRetentionSection
          key="b"
          client={client}
          identity={identityB}
          actorRole="owner"
          managedSession
        />,
      );
    });
    await flush();
    pendingUpdate.reject(new Error("stale organization A retention failure"));
    await flush();

    expect(updateOrganizationRetentionPolicy).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(container.textContent).toContain("operator cleanup after 60 days");
    expect(container.textContent).not.toContain("operator cleanup after 30 days");

    await act(async () => root.unmount());
    container.remove();
  });

  test("does not expose or invoke owner/admin invitation revocation for an admin", async () => {
    const revokeOrganizationInvitation = mock(async () => invitation("member"));
    const client = {
      listOrganizationAdministrationMembers: async () => ({
        members: [member(identityA, "admin", "admin")],
      }),
      listOrganizationInvitationsForOrganization: async () => ({
        invitations: [invitation("owner"), invitation("admin"), invitation("member")],
        nextCursor: null,
      }),
      listOrganizationInvitations: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      revokeOrganizationInvitation,
    } as unknown as OpenGeniBrowserClient;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrganizationPeopleSection
          client={client}
          identity={identityA}
          actorRole="admin"
          managedSession
          onAuthorityChanged={() => undefined}
        />,
      );
    });
    await flush();

    expect(container.textContent).not.toContain("Revoke invitation for owner@example.test");
    expect(container.textContent).not.toContain("Revoke invitation for admin@example.test");
    expect(container.textContent).toContain("Revoke invitation for member@example.test");
    for (const row of Array.from(container.querySelectorAll("div")).filter((candidate) =>
      /^(owner|admin)@example\.test/.test(candidate.textContent?.trim() ?? ""),
    )) {
      await act(async () => row.click());
    }
    expect(revokeOrganizationInvitation).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });
});
