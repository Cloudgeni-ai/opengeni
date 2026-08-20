import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

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
