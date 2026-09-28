import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import { Button } from "../src/components/ui/button";
import { OrganizationDirectoryProvider } from "../src/components/organization/organization-directory";
import { OrganizationPeoplePage } from "../src/components/organization/people-page";
import { OrganizationWorkspacesPage } from "../src/components/organization/workspaces-page";
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
const customMembershipId = "eeeeeeee-4444-4444-8444-444444444444";
const customWorkspaceMembershipId = "ffffffff-5555-4555-8555-555555555555";
const timestamp = "2026-08-25T10:00:00.000Z";
// Open invitations expire in the future relative to the browser clock.
const openExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

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

interface Person {
  organizationMembershipId: string;
  workspaceMembershipId: string;
  subjectId: string;
  name: string;
  email: string;
}

const people: Person[] = [
  {
    organizationMembershipId: memberMembershipId,
    workspaceMembershipId,
    subjectId: "user:ada-member",
    name: "Ada Member",
    email: "ada@example.test",
  },
  {
    organizationMembershipId: customMembershipId,
    workspaceMembershipId: customWorkspaceMembershipId,
    subjectId: "user:grace-custom",
    name: "Grace Custom",
    email: "grace@example.test",
  },
];

function organizationMember(
  id: string,
  subjectId: string,
  name: string,
  email: string,
  role: OrganizationMember["role"],
): OrganizationMember {
  return {
    id,
    organizationId,
    subjectId,
    name,
    email,
    role,
    status: "active",
    authorizationRevision: 1,
    sharedWorkspaceAccess: [],
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const initialMembers: OrganizationMember[] = [
  organizationMember(
    ownerMembershipId,
    identity.subjectId,
    "Morgan Owner",
    "morgan@example.test",
    "owner",
  ),
  ...people.map((person) =>
    organizationMember(
      person.organizationMembershipId,
      person.subjectId,
      person.name,
      person.email,
      "member",
    ),
  ),
];

function accessMember(
  person: Person,
  role: OrganizationWorkspaceAccessMember["role"],
  permissions: SdkPermission[],
  updatedAt = timestamp,
): OrganizationWorkspaceAccessMember {
  return {
    membershipId: person.workspaceMembershipId,
    organizationMembershipId: person.organizationMembershipId,
    subjectId: person.subjectId,
    name: person.name,
    email: person.email,
    subjectLabel: person.name,
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
      members: [
        accessMember(people[0]!, "viewer", [...roleDefinitions[0]!.permissions]),
        // A legacy hand-picked grant made through the API.
        accessMember(people[1]!, "custom", ["workspace:read", "files:read", "files:write"]),
      ],
    },
  ],
};

function invitation(
  suffix: string,
  targetEmail: string,
  targetName: string,
  status: OrganizationInvitation["status"],
  delivery: NonNullable<OrganizationInvitation["delivery"]>,
): OrganizationInvitation {
  return {
    id: `${suffix}-7777-4777-8777-777777777777`,
    organizationId,
    organizationName: "Acme Engineering",
    targetEmail,
    targetName,
    initialWorkspaceIds: status === "pending" ? [workspaceId] : [],
    role: "member",
    status,
    revision: 1,
    expiresAt: status === "pending" ? openExpiry : "2026-08-20T10:00:00.000Z",
    acceptedMembershipId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    delivery,
  };
}

const initialInvitations: OrganizationInvitation[] = [
  invitation("77777777", "retry-member@example.test", "Retry Member", "pending", {
    id: "88888888-8888-4888-8888-888888888888",
    state: "outcome_unknown",
    attemptCount: 1,
    revision: 3,
    errorClass: "provider_ambiguous",
    retryState: "available",
    sentAt: null,
    updatedAt: timestamp,
  }),
  invitation("aaaaaaaa", "reconcile-member@example.test", "Reconcile Member", "pending", {
    id: "bbbbbbbb-8888-4888-8888-888888888888",
    state: "outcome_unknown",
    attemptCount: 1,
    revision: 3,
    errorClass: "provider_ambiguous",
    retryState: "reconciliation_required",
    sentAt: null,
    updatedAt: timestamp,
  }),
  invitation("cccccccc", "expired-member@example.test", "Expired Member", "expired", {
    id: "dddddddd-8888-4888-8888-888888888888",
    state: "failed",
    attemptCount: 1,
    revision: 3,
    errorClass: "provider_refused",
    retryState: "available",
    sentAt: null,
    updatedAt: timestamp,
  }),
];

type Receipt = Record<string, unknown>;

function createFixtureClient(setReceipt: (receipt: Receipt) => void): OpenGeniBrowserClient {
  const overview = structuredClone(initialOverview);
  const members = structuredClone(initialMembers);
  const invitations = structuredClone(initialInvitations);
  let clock = 0;
  const nextTimestamp = () => new Date(Date.parse(timestamp) + ++clock * 1_000).toISOString();

  const findWorkspace = (targetWorkspaceId: string) => {
    const workspace = overview.workspaces.find((candidate) => candidate.id === targetWorkspaceId);
    if (!workspace) throw new Error("workspace not found");
    return workspace;
  };
  const findPerson = (organizationMembershipId: string) => {
    const person = people.find(
      (candidate) => candidate.organizationMembershipId === organizationMembershipId,
    );
    if (!person) throw new Error("workspace member not found");
    return person;
  };
  // A person's shared access follows the workspace grants.
  const membersWithAccess = () =>
    members.map((member) => ({
      ...member,
      sharedWorkspaceAccess: overview.workspaces.flatMap((workspace) =>
        workspace.members
          .filter((grant) => grant.organizationMembershipId === member.id)
          .map((grant) => ({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            membershipId: grant.membershipId,
            role: grant.role,
            updatedAt: grant.updatedAt,
          })),
      ),
    }));

  return {
    getOrganizationAdministrationOverview: async () => structuredClone(overview),
    listOrganizationAdministrationMembers: async () => ({
      members: structuredClone(membersWithAccess()),
    }),
    listOrganizationInvitationsForOrganization: async () => ({
      invitations: structuredClone(invitations),
      nextCursor: null,
    }),
    listOrganizationInvitations: async () => ({ invitations: [], nextCursor: null }),
    updateOrganizationName: async (_organizationId: string, request: { name: string }) => ({
      ...overview.organization,
      name: request.name,
      updatedAt: nextTimestamp(),
    }),
    updateOrganizationWorkspace: async (
      _organizationId: string,
      targetWorkspaceId: string,
      request: { name: string },
    ) => {
      const workspace = findWorkspace(targetWorkspaceId);
      workspace.name = request.name;
      workspace.updatedAt = nextTimestamp();
      setReceipt({ action: "rename", ...request });
      return structuredClone(workspace);
    },
    putOrganizationWorkspaceMember: async (
      _organizationId: string,
      targetWorkspaceId: string,
      targetMembershipId: string,
      request: { role: OrganizationWorkspaceAccessMember["role"]; permissions?: SdkPermission[] },
    ) => {
      const workspace = findWorkspace(targetWorkspaceId);
      const person = findPerson(targetMembershipId);
      const permissions =
        request.role === "custom"
          ? (request.permissions ?? [])
          : (roleDefinitions.find(({ role }) => role === request.role)?.permissions ?? []);
      const updated = accessMember(person, request.role, [...permissions], nextTimestamp());
      const index = workspace.members.findIndex(
        (grant) => grant.organizationMembershipId === targetMembershipId,
      );
      if (index === -1) workspace.members.push(updated);
      else workspace.members[index] = updated;
      setReceipt({
        action: "grant",
        workspaceId: targetWorkspaceId,
        organizationMembershipId: targetMembershipId,
        ...request,
      });
      return structuredClone(updated);
    },
    revokeOrganizationWorkspaceMember: async (
      _organizationId: string,
      targetWorkspaceId: string,
      targetMembershipId: string,
      request: Record<string, unknown>,
    ) => {
      const workspace = findWorkspace(targetWorkspaceId);
      findPerson(targetMembershipId);
      workspace.members = workspace.members.filter(
        (grant) => grant.organizationMembershipId !== targetMembershipId,
      );
      setReceipt({
        action: "revoke",
        workspaceId: targetWorkspaceId,
        organizationMembershipId: targetMembershipId,
        ...request,
      });
      return { removed: true, replay: false };
    },
    updateOrganizationMember: async (
      _organizationId: string,
      targetMembershipId: string,
      request: { kind: string; role?: OrganizationMember["role"] },
    ) => {
      const member = members.find((candidate) => candidate.id === targetMembershipId);
      if (!member) throw new Error("member not found");
      if (request.kind === "change_role" && request.role) member.role = request.role;
      if (request.kind === "suspend") member.status = "suspended";
      if (request.kind === "reactivate") member.status = "active";
      if (request.kind === "offboard") {
        member.status = "revoked";
        member.revokedAt = nextTimestamp();
      }
      if (request.kind === "suspend" || request.kind === "offboard") {
        for (const workspace of overview.workspaces) {
          workspace.members = workspace.members.filter(
            (grant) => grant.organizationMembershipId !== targetMembershipId,
          );
        }
      }
      member.authorizationRevision += 1;
      member.updatedAt = nextTimestamp();
      setReceipt({ action: "member", membershipId: targetMembershipId, ...request });
      return structuredClone(membersWithAccess().find(({ id }) => id === targetMembershipId)!);
    },
    createOrganizationInvitation: async (
      _organizationId: string,
      request: {
        email: string;
        name?: string;
        role: OrganizationInvitation["role"];
        initialWorkspaceIds: string[];
        expiresAt: string;
      },
    ) => {
      setReceipt({ action: "invite", ...request });
      const created = {
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
          retryState: "unavailable",
          sentAt: timestamp,
          updatedAt: timestamp,
        },
      } satisfies OrganizationInvitation;
      invitations.unshift(structuredClone(created));
      return created;
    },
    revokeOrganizationInvitation: async (
      _organizationId: string,
      invitationId: string,
      request: Record<string, unknown>,
    ) => {
      const target = invitations.find((candidate) => candidate.id === invitationId);
      if (!target) throw new Error("invitation not found");
      target.status = "revoked";
      target.revision += 1;
      target.updatedAt = nextTimestamp();
      setReceipt({ action: "revoke-invitation", invitationId, ...request });
      return structuredClone(target);
    },
    requestJson: async (_method: string, path: string, request: unknown) => {
      const match = path.match(
        /^\/v1\/organizations\/[^/]+\/invitations\/([^/]+)\/delivery\/retry$/,
      );
      if (!match) throw new Error(`unexpected fixture request: ${path}`);
      const invitationId = match[1]!;
      const retry = request as { operationId: string };
      const target = invitations.find((candidate) => candidate.id === invitationId);
      if (!target?.delivery) throw new Error("invitation delivery not found");
      target.delivery = {
        ...target.delivery,
        state: "sent",
        attemptCount: 2,
        revision: target.delivery.revision + 2,
        errorClass: null,
        retryState: "unavailable",
        sentAt: nextTimestamp(),
        updatedAt: nextTimestamp(),
      };
      setReceipt({ action: "retry-delivery", invitationId, ...retry });
      return structuredClone(target.delivery);
    },
  } as unknown as OpenGeniBrowserClient;
}

interface OrganizationSearch {
  section?: "people" | "workspaces";
  view?: "invite" | "new-workspace";
  person?: string;
  invitation?: string;
  workspace?: string;
}

function Frame() {
  const [receipt, setReceipt] = useState<Receipt>({});
  const clientRef = useRef<OpenGeniBrowserClient>();
  clientRef.current ??= createFixtureClient(setReceipt);
  return (
    <OrganizationDirectoryProvider
      client={clientRef.current}
      identity={identity}
      actorRole="owner"
      managedSession
      singleUser={false}
      accessibleWorkspaceIds={new Set([workspaceId])}
      youLabel="Morgan Owner"
      onAuthorityChanged={() => undefined}
      onCreateWorkspace={async (name, operationId) => {
        setReceipt({ action: "create", name, operationId });
        return null;
      }}
      onDeleteWorkspace={async (deletedId) => {
        setReceipt({ action: "delete-workspace", workspaceId: deletedId });
      }}
    >
      <main className="mx-auto grid max-w-5xl min-w-0 gap-8 p-4 sm:p-8">
        <Outlet />
        <output data-testid="operation-receipt" className="sr-only">
          {JSON.stringify(receipt)}
        </output>
      </main>
      <Toaster richColors theme="dark" />
    </OrganizationDirectoryProvider>
  );
}

/** The organization settings frame, reduced to the People and Workspaces pages. */
function OrganizationSettings() {
  const search = organizationRoute.useSearch();
  const navigate = useNavigate();
  const section = search.section === "workspaces" ? "workspaces" : "people";
  const subPage = Boolean(search.view || search.person || search.invitation || search.workspace);
  const open = (next: OrganizationSearch) =>
    void navigate({
      to: "/workspaces/$workspaceId/organization",
      params: { workspaceId },
      search: next,
    });
  return (
    <>
      {subPage ? null : (
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Organization settings</h1>
            <nav aria-label="Organization settings pages" className="mt-2 flex gap-2">
              <Button
                type="button"
                variant={section === "people" ? "secondary" : "ghost"}
                aria-current={section === "people" ? "page" : undefined}
                onClick={() => open({ section: "people" })}
              >
                People
              </Button>
              <Button
                type="button"
                variant={section === "workspaces" ? "secondary" : "ghost"}
                aria-current={section === "workspaces" ? "page" : undefined}
                onClick={() => open({ section: "workspaces" })}
              >
                Workspaces
              </Button>
            </nav>
          </div>
          {section === "people" ? (
            <Button type="button" onClick={() => open({ section: "people", view: "invite" })}>
              Invite people
            </Button>
          ) : null}
        </header>
      )}
      {section === "people" ? (
        <OrganizationPeoplePage
          workspaceId={workspaceId}
          person={search.person}
          invitation={search.invitation}
          view={search.view === "invite" ? "invite" : undefined}
        />
      ) : (
        <OrganizationWorkspacesPage
          workspaceId={workspaceId}
          workspace={search.workspace}
          view={search.view === "new-workspace" ? "new-workspace" : undefined}
        />
      )}
    </>
  );
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const rootRoute = createRootRoute({ component: Frame });
const organizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/organization",
  validateSearch: (search: Record<string, unknown>): OrganizationSearch => ({
    section: search.section === "workspaces" ? "workspaces" : "people",
    view: search.view === "invite" || search.view === "new-workspace" ? search.view : undefined,
    person: stringParam(search.person),
    invitation: stringParam(search.invitation),
    workspace: stringParam(search.workspace),
  }),
  component: OrganizationSettings,
});
// "Open workspace" links here; the fixture only needs the route to exist.
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/sessions",
  component: () => <h1>Workspace sessions</h1>,
});

if (!window.location.hash) {
  window.location.hash = `/workspaces/${workspaceId}/organization?section=people`;
}
// Every organization page has its own URL, kept in the hash so a reload stays put.
const router = createRouter({
  routeTree: rootRoute.addChildren([organizationRoute, sessionsRoute]),
  history: createHashHistory(),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
