import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as SonnerPackage from "sonner";

import { destructiveActionFocusTarget } from "@/components/ui/confirm-dialog";
import {
  maskedOrganizationSubject,
  type OrganizationAdminIdentity,
} from "@/lib/organization-admin";
import type {
  OrganizationInvitation,
  OrganizationMember,
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

const { OrganizationPeopleSection, OrganizationRetentionSection } =
  await import("./organization-admin");

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
    role,
    status: "active",
    authorizationRevision: 1,
    personalWorkspaceId: null,
    revokedAt: null,
    personalRetentionUntil: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function invitation(role: OrganizationInvitation["role"]): OrganizationInvitation {
  return {
    id: `invite-${role}`,
    organizationId: identityA.organizationId,
    targetEmail: `${role}@example.test`,
    role,
    status: "pending",
    revision: 1,
    expiresAt: timestamp,
    acceptedMembershipId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
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
  test("keeps people reads and mutations owned through StrictMode setup cleanup setup", async () => {
    const actor = member(identityA, "strict-actor");
    const secondOwner = { ...member(identityA, "strict-owner-2"), subjectId: "user:owner-2" };
    const listOrganizationMembers = mock(async () => ({ members: [actor, secondOwner] }));
    const updateOrganizationMember = mock(async () => ({
      ...actor,
      status: "suspended" as const,
      authorizationRevision: 2,
    }));
    const onAuthorityChanged = mock(() => undefined);
    const client = {
      listOrganizationMembers,
      listOrganizationInvitationsForOrganization: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      listOrganizationInvitations: async () => ({ invitations: [], nextCursor: null }),
      updateOrganizationMember,
    } as unknown as OpenGeniCoreClient;
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

    expect(listOrganizationMembers.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain(maskedOrganizationSubject(secondOwner.subjectId));
    await act(async () => button(container, "Suspend You").click());
    await act(async () => button(container, "Suspend member").click());
    await flush();

    expect(updateOrganizationMember).toHaveBeenCalledTimes(1);
    expect(onAuthorityChanged).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Member suspended");

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
    } as unknown as OpenGeniCoreClient;
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
    expect(container.textContent).toContain(
      "Retain offboarded members' personal data indefinitely",
    );
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
    const client = {
      listOrganizationMembers: async () => ({
        members: [
          member(identityA, "actor"),
          { ...member(identityA, "owner-2"), subjectId: "user:owner-2" },
        ],
      }),
      listOrganizationInvitationsForOrganization,
      listOrganizationInvitations: async () => ({ invitations: [], nextCursor: null }),
      createOrganizationInvitation,
      revokeOrganizationInvitation,
    } as unknown as OpenGeniCoreClient;
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
    expect(button(container, "Invite registered user").disabled).toBe(true);
    expect(button(container, "Revoke invitation for member@example.test").disabled).toBe(true);
    expect(createOrganizationInvitation).not.toHaveBeenCalled();
    expect(revokeOrganizationInvitation).not.toHaveBeenCalled();

    pageRead.resolve({ invitations: [], nextCursor: "page-2" });
    await flush();
    expect(button(container, "Invite registered user").disabled).toBe(false);
    expect(button(container, "Revoke invitation for member@example.test").disabled).toBe(false);

    await act(async () => button(container, "Invite registered user").click());
    expect(createOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(button(container, "Load more invitations").disabled).toBe(true);
    createResult.resolve({
      ...listedInvite,
      id: "invite-created",
      targetEmail: "new-member@example.test",
    });
    await flush();
    expect(container.textContent).toContain("new-member@example.test");
    expect(button(container, "Load more invitations").disabled).toBe(false);

    await act(async () => button(container, "Revoke invitation for member@example.test").click());
    await act(async () => button(container, "Revoke invitation").click());
    expect(revokeOrganizationInvitation).toHaveBeenCalledTimes(1);
    expect(button(container, "Load more invitations").disabled).toBe(true);
    revokeResult.resolve({ ...listedInvite, status: "revoked", revision: 2 });
    await flush();
    expect(container.textContent).toContain("member · revoked");
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
      listOrganizationMembers: async () => ({
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
    } as unknown as OpenGeniCoreClient;
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
    const secondOwner = { ...member(identityA, "owner-2"), subjectId: "user:owner-2" };
    const actorB = member(identityB, "actor-b");
    const updateOrganizationMember = mock(() => pendingUpdate.promise);
    const onAuthorityChanged = mock(() => undefined);
    const client = {
      listOrganizationMembers: async (organizationId: string) => ({
        members: organizationId === identityA.organizationId ? [actorA, secondOwner] : [actorB],
      }),
      listOrganizationInvitationsForOrganization: async () => ({
        invitations: [],
        nextCursor: null,
      }),
      listOrganizationInvitations: async () => ({ invitations: [], nextCursor: null }),
      updateOrganizationMember,
    } as unknown as OpenGeniCoreClient;
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
    await act(async () => button(container, "Suspend You").click());
    await act(async () => button(container, "Suspend member").click());

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
    pendingUpdate.resolve({ ...actorA, status: "suspended", authorizationRevision: 2 });
    await flush();

    expect(updateOrganizationMember).toHaveBeenCalledTimes(1);
    expect(onAuthorityChanged).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(container.textContent).toContain("You");
    expect(container.textContent).not.toContain(maskedOrganizationSubject(secondOwner.subjectId));

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
    } as unknown as OpenGeniCoreClient;
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
      listOrganizationMembers: async () => ({ members: [member(identityA, "admin", "admin")] }),
      listOrganizationInvitationsForOrganization: async () => ({
        invitations: [invitation("owner"), invitation("admin"), invitation("member")],
        nextCursor: null,
      }),
      listOrganizationInvitations: async () => ({ invitations: [], nextCursor: null }),
      revokeOrganizationInvitation,
    } as unknown as OpenGeniCoreClient;
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
