import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import {
  OrganizationOverviewSection,
  OrganizationPeopleSection,
} from "../src/components/organization-admin";
import type { OrganizationAdminIdentity } from "../src/lib/organization-admin";
import type {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationWorkspaceAccessMember,
  SdkPermission,
} from "../src/types";
import "../src/styles.css";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const ownerMembershipId = "33333333-3333-4333-8333-333333333333";
const memberMembershipId = "44444444-4444-4444-8444-444444444444";
const workspaceMembershipId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-08-25T10:00:00.000Z";

const identity: OrganizationAdminIdentity = {
  principalGeneration: 1,
  subjectId: "user:workspace-owner",
  organizationId,
  workspaceId,
};

const roleDefinitions: OrganizationAdministrationOverview["roles"] = [
  {
    role: "viewer",
    label: "Viewer",
    description: "Can view shared workspace sessions, files, and approved knowledge.",
    permissions: [
      "workspace:read",
      "sessions:read",
      "stream:view",
      "files:read",
      "documents:search",
      "variable-sets:list",
      "connections:read",
      "rigs:use",
      "artifacts:read",
    ],
  },
  {
    role: "member",
    label: "Member",
    description: "Can create sessions and contribute shared workspace content.",
    permissions: ["workspace:read", "sessions:create", "sessions:read", "files:read"],
  },
  {
    role: "admin",
    label: "Workspace admin",
    description: "Can manage shared workspace settings, access, and integrations.",
    permissions: ["workspace:read", "workspace:admin", "members:manage"],
  },
];

const members: OrganizationMember[] = [
  {
    id: ownerMembershipId,
    organizationId,
    subjectId: identity.subjectId,
    name: "Morgan Owner",
    email: "morgan@example.test",
    role: "owner",
    status: "active",
    authorizationRevision: 1,
    sharedWorkspaceAccess: [],
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: memberMembershipId,
    organizationId,
    subjectId: "user:ada-member",
    name: "Ada Member",
    email: "ada@example.test",
    role: "member",
    status: "active",
    authorizationRevision: 1,
    sharedWorkspaceAccess: [
      {
        workspaceId,
        workspaceName: "Product engineering",
        membershipId: workspaceMembershipId,
        role: "viewer",
        updatedAt: timestamp,
      },
    ],
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

function accessMember(
  role: OrganizationWorkspaceAccessMember["role"],
  permissions: SdkPermission[],
  updatedAt = timestamp,
): OrganizationWorkspaceAccessMember {
  return {
    membershipId: workspaceMembershipId,
    organizationMembershipId: memberMembershipId,
    subjectId: "user:ada-member",
    name: "Ada Member",
    email: "ada@example.test",
    subjectLabel: "Ada Member",
    principalKind: "human",
    organizationRole: "member",
    role,
    permissions,
    createdAt: timestamp,
    updatedAt,
  };
}

const initialOverview: OrganizationAdministrationOverview = {
  organization: {
    id: organizationId,
    name: "Acme Engineering",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  roles: roleDefinitions,
  workspaces: [
    {
      id: workspaceId,
      name: "Product engineering",
      slug: "product-engineering",
      createdAt: timestamp,
      updatedAt: timestamp,
      members: [accessMember("viewer", [...roleDefinitions[0]!.permissions])],
    },
  ],
};

const invitations: OrganizationInvitation[] = [
  {
    id: "77777777-7777-4777-8777-777777777777",
    organizationId,
    organizationName: "Acme Engineering",
    targetEmail: "retry-member@example.test",
    targetName: "Retry Member",
    initialWorkspaceIds: [workspaceId],
    role: "member",
    status: "pending",
    revision: 1,
    expiresAt: "2026-09-01T10:00:00.000Z",
    acceptedMembershipId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    delivery: {
      id: "88888888-8888-4888-8888-888888888888",
      state: "outcome_unknown",
      attemptCount: 1,
      revision: 3,
      errorClass: "provider_ambiguous",
      sentAt: null,
      updatedAt: timestamp,
    },
  },
];

function Fixture() {
  const overviewRef = useRef(structuredClone(initialOverview));
  const [receipt, setReceipt] = useState<Record<string, unknown>>({});
  const clientRef = useRef<OpenGeniCoreClient>();

  clientRef.current ??= {
    getOrganizationAdministrationOverview: async () => structuredClone(overviewRef.current),
    listOrganizationAdministrationMembers: async () => ({
      members: structuredClone(members),
    }),
    listOrganizationInvitationsForOrganization: async () => ({
      invitations: structuredClone(invitations),
      nextCursor: null,
    }),
    listOrganizationInvitations: async () => ({ invitations: [], nextCursor: null }),
    updateOrganizationName: async (_organizationId, request) => ({
      ...overviewRef.current.organization,
      name: request.name,
      updatedAt: "2026-08-25T10:00:01.000Z",
    }),
    updateOrganizationWorkspace: async (_organizationId, targetWorkspaceId, request) => {
      const workspace = overviewRef.current.workspaces.find(
        (candidate) => candidate.id === targetWorkspaceId,
      );
      if (!workspace) throw new Error("workspace not found");
      workspace.name = request.name;
      workspace.updatedAt = "2026-08-25T10:00:02.000Z";
      setReceipt({ action: "rename", ...request });
      return structuredClone(workspace);
    },
    putOrganizationWorkspaceMember: async (
      _organizationId,
      targetWorkspaceId,
      targetMembershipId,
      request,
    ) => {
      const workspace = overviewRef.current.workspaces.find(
        (candidate) => candidate.id === targetWorkspaceId,
      );
      if (!workspace || targetMembershipId !== memberMembershipId) {
        throw new Error("workspace member not found");
      }
      const permissions =
        request.role === "custom"
          ? request.permissions
          : (roleDefinitions.find(({ role }) => role === request.role)?.permissions ?? []);
      const updated = accessMember(request.role, [...permissions], "2026-08-25T10:00:03.000Z");
      workspace.members = [updated];
      setReceipt({
        action: "grant",
        workspaceId: targetWorkspaceId,
        organizationMembershipId: targetMembershipId,
        ...request,
      });
      return structuredClone(updated);
    },
    revokeOrganizationWorkspaceMember: async (
      _organizationId,
      targetWorkspaceId,
      targetMembershipId,
      request,
    ) => {
      const workspace = overviewRef.current.workspaces.find(
        (candidate) => candidate.id === targetWorkspaceId,
      );
      if (!workspace || targetMembershipId !== memberMembershipId) {
        throw new Error("workspace member not found");
      }
      workspace.members = [];
      setReceipt({
        action: "revoke",
        workspaceId: targetWorkspaceId,
        organizationMembershipId: targetMembershipId,
        ...request,
      });
      return { removed: true, replay: false };
    },
    createOrganizationInvitation: async (_organizationId, request) => {
      setReceipt({ action: "invite", ...request });
      return {
        id: "66666666-6666-4666-8666-666666666666",
        organizationId,
        organizationName: "Acme Engineering",
        targetEmail: request.email,
        targetName: request.name ?? null,
        initialWorkspaceIds: request.initialWorkspaceIds,
        role: request.role,
        status: "pending",
        revision: 1,
        expiresAt: request.expiresAt,
        acceptedMembershipId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        delivery: {
          id: "99999999-9999-4999-8999-999999999999",
          state: "sent",
          attemptCount: 1,
          revision: 3,
          errorClass: null,
          sentAt: timestamp,
          updatedAt: timestamp,
        },
      } satisfies OrganizationInvitation;
    },
    retryOrganizationUserSetupDelivery: async (_organizationId, invitationId, request) => {
      const invitation = invitations.find((candidate) => candidate.id === invitationId);
      if (!invitation?.delivery) throw new Error("invitation delivery not found");
      invitation.delivery = {
        ...invitation.delivery,
        state: "sent",
        attemptCount: 2,
        revision: invitation.delivery.revision + 2,
        errorClass: null,
        sentAt: "2026-08-25T10:00:04.000Z",
        updatedAt: "2026-08-25T10:00:04.000Z",
      };
      setReceipt({ action: "retry-delivery", invitationId, ...request });
      return structuredClone(invitation.delivery);
    },
  } as unknown as OpenGeniCoreClient;

  return (
    <main className="mx-auto grid max-w-5xl gap-8 p-4 sm:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Organization settings</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Product fixture for named shared-workspace roles and Personal boundaries.
        </p>
      </header>
      <OrganizationOverviewSection
        client={clientRef.current}
        identity={identity}
        actorRole="owner"
        managedSession
        accessibleWorkspaceIds={new Set([workspaceId])}
        onOrganizationChanged={() => undefined}
        onCreateWorkspace={async (name, operationId) => {
          setReceipt({ action: "create", name, operationId });
        }}
      />
      <OrganizationPeopleSection
        client={clientRef.current}
        identity={identity}
        actorRole="owner"
        managedSession
        onAuthorityChanged={() => undefined}
      />
      <output data-testid="operation-receipt" className="sr-only">
        {JSON.stringify(receipt)}
      </output>
      <Toaster richColors theme="dark" />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
