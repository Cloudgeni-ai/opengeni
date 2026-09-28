import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { act, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as RouterPackage from "@tanstack/react-router";
import * as SonnerPackage from "sonner";

import * as DestructiveModule from "@/components/ui/destructive-confirm";
import * as DropdownModule from "@/components/ui/dropdown-menu";
import type { OrganizationAdminIdentity } from "@/lib/organization-admin";
import type {
  OrganizationAdministrationOverview,
  OrganizationInvitation,
  OrganizationMember,
} from "@/types";

const toastSuccess = mock((_message: string, _options?: unknown) => undefined);
const toastError = mock((_message: string, _options?: unknown) => undefined);
const undoToast = mock((_options: { title: ReactNode; onUndo: () => void }) => 1);
const navigate = mock((_options: unknown) => undefined);

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { error: toastError, success: toastSuccess, warning: mock(() => undefined) },
  ),
}));
mock.module("@tanstack/react-router", () => ({
  ...RouterPackage,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
  useNavigate: () => navigate,
}));
mock.module("@/components/ui/dropdown-menu", () => ({
  ...DropdownModule,
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));
mock.module("@/components/ui/destructive-confirm", () => ({
  ...DestructiveModule,
  showUndoToast: undoToast,
  DestructiveConfirm: ({
    open,
    title,
    consequences,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: ReactNode;
    consequences?: ReactNode[];
    confirmLabel?: string;
    onConfirm?: () => unknown;
  }) =>
    open ? (
      <div data-testid="confirm">
        <h2>{title}</h2>
        <ul>
          {consequences?.map((line) => (
            <li key={String(line)}>{line}</li>
          ))}
        </ul>
        <button type="button" onClick={() => void onConfirm?.()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { OrganizationDirectoryProvider, useOrganizationDirectory } =
  await import("./organization-directory");
const { OrganizationPeoplePage } = await import("./people-page");
const { OrganizationWorkspacesPage } = await import("./workspaces-page");

const timestamp = "2026-08-20T10:00:00.000Z";
const identityA: OrganizationAdminIdentity = {
  principalGeneration: 1,
  subjectId: "user:owner",
  organizationId: "org-a",
  workspaceId: "workspace-a",
};
const identityB: OrganizationAdminIdentity = { ...identityA, organizationId: "org-b" };

function person(
  id: string,
  name: string,
  role: OrganizationMember["role"],
  extra: Partial<OrganizationMember> = {},
): OrganizationMember {
  return {
    id,
    organizationId: "org-a",
    subjectId: `user:${id}`,
    name,
    email: `${id}@example.test`,
    role,
    status: "active",
    authorizationRevision: 3,
    sharedWorkspaceAccess: [],
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  } as OrganizationMember;
}

const owner = person("owner", "Olivia Owner", "owner", { subjectId: "user:owner" });
const maria = person("maria", "Maria Chen", "member", {
  sharedWorkspaceAccess: [
    {
      workspaceId: "ws-platform",
      workspaceName: "Platform engineering",
      membershipId: "wm-maria",
      role: "member",
      updatedAt: timestamp,
    },
  ],
});

function overview(name = "Acme Robotics"): OrganizationAdministrationOverview {
  return {
    organization: { id: "org-a", name, createdAt: timestamp, updatedAt: timestamp },
    roles: [
      {
        role: "viewer",
        label: "Viewer",
        description: "Can view.",
        permissions: ["workspace:read"],
      },
      {
        role: "member",
        label: "Member",
        description: "Can work.",
        permissions: ["workspace:read"],
      },
      {
        role: "admin",
        label: "Workspace admin",
        description: "Can manage.",
        permissions: ["workspace:read"],
      },
    ],
    workspaces: [
      {
        id: "ws-platform",
        name: "Platform engineering",
        slug: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        members: [
          {
            membershipId: "wm-maria",
            organizationMembershipId: "maria",
            subjectId: "user:maria",
            name: "Maria Chen",
            email: "maria@example.test",
            subjectLabel: null,
            principalKind: "human",
            organizationRole: "member",
            role: "member",
            permissions: [],
            createdAt: timestamp,
            updatedAt: "2026-08-21T10:00:00.000Z",
          },
        ],
      },
    ],
  } as OrganizationAdministrationOverview;
}

function invitation(role: OrganizationInvitation["role"]): OrganizationInvitation {
  return {
    id: `invite-${role}`,
    organizationId: "org-a",
    organizationName: "Acme Robotics",
    targetEmail: `${role}@example.test`,
    targetName: null,
    initialWorkspaceIds: [],
    role,
    status: "pending",
    revision: 1,
    expiresAt: "2026-09-30T10:00:00.000Z",
    acceptedMembershipId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    delivery: null,
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    getOrganizationAdministrationOverview: mock(async () => overview()),
    listOrganizationAdministrationMembers: mock(async () => ({ members: [owner, maria] })),
    listOrganizationInvitationsForOrganization: mock(async () => ({
      invitations: [invitation("member"), invitation("owner")],
      nextCursor: null,
    })),
    updateOrganizationName: mock(async () => overview().organization),
    putOrganizationWorkspaceMember: mock(async () => ({})),
    revokeOrganizationWorkspaceMember: mock(async () => ({ removed: true, replay: false })),
    updateOrganizationMember: mock(async (_org: string, id: string, request: { kind: string }) => ({
      ...(id === "maria" ? maria : owner),
      status: request.kind === "suspend" ? "suspended" : "active",
    })),
    createOrganizationInvitation: mock(async (_org: string, request: { email: string }) => ({
      ...invitation("member"),
      id: `created-${request.email}`,
      targetEmail: request.email,
    })),
    revokeOrganizationInvitation: mock(async () => ({
      ...invitation("member"),
      status: "revoked",
    })),
    ...overrides,
  };
}

type Client = ReturnType<typeof makeClient>;
type InvitationRequest = Parameters<OpenGeniBrowserClient["createOrganizationInvitation"]>[1] &
  Pick<OrganizationInvitation, "role" | "initialWorkspaceIds">;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    render: async (next: ReactNode) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    initial: node,
  };
}

function Provider({
  client,
  identity = identityA,
  actorRole = "owner",
  singleUser = false,
  children,
}: {
  client: Client;
  identity?: OrganizationAdminIdentity;
  actorRole?: "owner" | "admin" | "member";
  singleUser?: boolean;
  children: ReactNode;
}) {
  return (
    <OrganizationDirectoryProvider
      client={client as unknown as OpenGeniBrowserClient}
      identity={identity}
      actorRole={actorRole}
      managedSession
      singleUser={singleUser}
      accessibleWorkspaceIds={new Set(["workspace-a"])}
      onAuthorityChanged={() => undefined}
      onCreateWorkspace={async () => "ws-new"}
      onDeleteWorkspace={async () => undefined}
    >
      {children}
    </OrganizationDirectoryProvider>
  );
}

function button(container: ParentNode, label: string | RegExp): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find((candidate) => {
    const text = candidate.textContent?.trim() ?? "";
    const name = candidate.getAttribute("aria-label") ?? "";
    return typeof label === "string"
      ? text === label || name === label
      : label.test(text) || label.test(name);
  });
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${String(label)}`);
  return match;
}

let captured: ReturnType<typeof useOrganizationDirectory> | null = null;
function Capture() {
  captured = useOrganizationDirectory();
  return null;
}

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
  undoToast.mockClear();
  navigate.mockClear();
  captured = null;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("organization directory", () => {
  test("replays the complete committed invitation after a lost response and clock advance", async () => {
    let now = Date.parse("2026-09-28T12:00:00.000Z");
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const requests: InvitationRequest[] = [];
    const receipts = new Map<
      string,
      { request: InvitationRequest; invitation: OrganizationInvitation }
    >();
    let deliveries = 0;
    const create = mock(async (_org: string, request: InvitationRequest) => {
      requests.push(structuredClone(request));
      const receipt = receipts.get(request.operationId);
      if (receipt) {
        // The server hashes the whole command, not just the operation id.
        if (JSON.stringify(receipt.request) !== JSON.stringify(request)) {
          throw Object.assign(new Error("operation id reused with different input"), {
            status: 409,
          });
        }
        return receipt.invitation;
      }
      const committed = {
        ...invitation(request.role),
        id: `created-${request.email}`,
        targetEmail: request.email,
        initialWorkspaceIds: request.initialWorkspaceIds,
        expiresAt: request.expiresAt,
      };
      receipts.set(request.operationId, {
        request: structuredClone(request),
        invitation: committed,
      });
      deliveries += 1;
      throw Object.assign(new Error("response lost after commit"), { outcomeUnknown: true });
    });
    const client = makeClient({
      createOrganizationInvitation: create,
      listOrganizationInvitationsForOrganization: mock(async () => ({
        invitations: [...receipts.values()].map((receipt) => receipt.invitation),
        nextCursor: null,
      })),
    });
    const view = mount(null);
    try {
      await view.render(
        <Provider client={client}>
          <Capture />
        </Provider>,
      );
      await flush();
      const input = {
        emails: ["alex@example.test"],
        role: "member" as const,
        workspaceIds: ["ws-platform", "ws-design"],
      };
      let first!: Awaited<ReturnType<NonNullable<typeof captured>["invite"]>>;
      await act(async () => {
        first = await captured!.invite(input);
      });
      expect(first.sent).toHaveLength(0);
      expect(first.failed).toEqual([
        { email: "alex@example.test", message: expect.stringContaining("couldn't confirm") },
      ]);
      expect(receipts.size).toBe(1);
      expect(deliveries).toBe(1);

      now += 3 * 60 * 1000;
      let replay!: Awaited<ReturnType<NonNullable<typeof captured>["invite"]>>;
      await act(async () => {
        replay = await captured!.invite({
          ...input,
          workspaceIds: [...input.workspaceIds].reverse(),
        });
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[1]!.operationId).toBe(requests[0]!.operationId);
      expect(requests[1]!.expiresAt).toBe("2026-10-05T12:00:00.000Z");
      expect(requests[1]!.initialWorkspaceIds).toEqual(["ws-design", "ws-platform"]);
      expect(replay.failed).toEqual([]);
      expect(replay.sent).toEqual([receipts.values().next().value!.invitation]);
      expect(receipts.size).toBe(1);
      expect(deliveries).toBe(1);
      expect(captured!.invitations.value.invitations).toHaveLength(1);
    } finally {
      await view.unmount();
      clock.mockRestore();
    }
  });

  test.each([
    { field: "email", change: { emails: ["blair@example.test"] } },
    { field: "role", change: { role: "admin" as const } },
    { field: "workspaces", change: { workspaceIds: ["ws-design"] } },
  ])(
    "a changed invitation $field starts a new request after an unknown outcome",
    async ({ change }) => {
      let now = Date.parse("2026-09-28T12:00:00.000Z");
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const requests: InvitationRequest[] = [];
      const create = mock(async (_org: string, request: InvitationRequest) => {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          throw Object.assign(new Error("response lost"), { outcomeUnknown: true });
        }
        return { ...invitation(request.role), targetEmail: request.email };
      });
      const client = makeClient({ createOrganizationInvitation: create });
      const view = mount(null);
      try {
        await view.render(
          <Provider client={client}>
            <Capture />
          </Provider>,
        );
        await flush();
        const input = {
          emails: ["alex@example.test"],
          role: "member" as const,
          workspaceIds: ["ws-platform"],
        };
        await act(async () => {
          await captured!.invite(input);
        });
        now += 3 * 60 * 1000;
        await act(async () => {
          const result = await captured!.invite({
            ...input,
            ...change,
            emails: [...(change.emails ?? input.emails)],
            workspaceIds: [...(change.workspaceIds ?? input.workspaceIds)],
          });
          expect(result.failed).toEqual([]);
          expect(result.sent).toHaveLength(1);
        });
        expect(requests).toHaveLength(2);
        expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
        expect(requests[1]!.expiresAt).toBe("2026-10-05T12:03:00.000Z");
        expect(requests[1]).toMatchObject({
          email: (change.emails ?? input.emails)[0],
          role: change.role ?? input.role,
          initialWorkspaceIds: change.workspaceIds ?? input.workspaceIds,
        });
      } finally {
        await view.unmount();
        clock.mockRestore();
      }
    },
  );

  test("retries an outcome-unknown workspace role change with the same operation id", async () => {
    const outcomeUnknown = Object.assign(new Error("network"), { outcomeUnknown: true });
    const put = mock(async () => {
      throw outcomeUnknown;
    });
    const client = makeClient({ putOrganizationWorkspaceMember: put });
    const view = mount(null);
    await view.render(
      <Provider client={client}>
        <Capture />
      </Provider>,
    );
    await flush();
    const request = {
      workspaceId: "ws-platform",
      organizationMembershipId: "maria",
      role: "admin" as const,
      current: overview().workspaces[0]!.members[0]!,
    };
    await expect(captured!.setWorkspaceRole(request)).rejects.toThrow(/couldn't confirm/);
    put.mockImplementation(async () => ({}) as never);
    await act(async () => captured!.setWorkspaceRole(request));
    const calls = put.mock.calls as unknown as Array<
      [string, string, string, { operationId: string; expectedUpdatedAt: string }]
    >;
    expect(calls).toHaveLength(2);
    expect(calls[0]![3].operationId).toBe(calls[1]![3].operationId);
    expect(calls[0]![3].expectedUpdatedAt).toBe("2026-08-21T10:00:00.000Z");
    await view.unmount();
  });

  test("drops a slow read that lands after the organization changed", async () => {
    let resolveSlow!: (value: OrganizationAdministrationOverview) => void;
    const slow = new Promise<OrganizationAdministrationOverview>((resolve) => {
      resolveSlow = resolve;
    });
    const client = makeClient({
      getOrganizationAdministrationOverview: mock(async (organizationId: string) =>
        organizationId === "org-a" ? slow : overview("Beta Org"),
      ),
    });
    const view = mount(null);
    await view.render(
      <Provider client={client}>
        <Capture />
      </Provider>,
    );
    await view.render(
      <Provider client={client} identity={identityB}>
        <Capture />
      </Provider>,
    );
    await flush();
    await act(async () => resolveSlow(overview("Late Acme")));
    await flush();
    expect(captured!.overview.value?.organization.name).toBe("Beta Org");
    await view.unmount();
  });

  test("single-user mode never loads people or invitations", async () => {
    const client = makeClient();
    const view = mount(null);
    await view.render(
      <StrictMode>
        <Provider client={client} singleUser>
          <Capture />
        </Provider>
      </StrictMode>,
    );
    await flush();
    expect(client.listOrganizationAdministrationMembers).not.toHaveBeenCalled();
    expect(client.listOrganizationInvitationsForOrganization).not.toHaveBeenCalled();
    expect(captured!.overview.value?.workspaces).toHaveLength(1);
    await view.unmount();
  });

  test("invites several addresses and reports the ones that failed", async () => {
    const create = mock(async (_org: string, request: { email: string; operationId: string }) => {
      if (request.email === "bad@example.test") throw new Error("rejected by the server");
      return { ...invitation("member"), id: `id-${request.email}`, targetEmail: request.email };
    });
    const client = makeClient({ createOrganizationInvitation: create });
    const view = mount(null);
    await view.render(
      <Provider client={client}>
        <Capture />
      </Provider>,
    );
    await flush();
    let result!: Awaited<ReturnType<NonNullable<typeof captured>["invite"]>>;
    await act(async () => {
      result = await captured!.invite({
        emails: ["a@example.test", "bad@example.test"],
        role: "member",
        workspaceIds: ["ws-platform"],
      });
    });
    expect(result.sent.map((each) => each.targetEmail)).toEqual(["a@example.test"]);
    expect(result.failed).toEqual([
      { email: "bad@example.test", message: "rejected by the server" },
    ]);
    const first = (
      create.mock.calls[0] as unknown as [string, { initialWorkspaceIds: string[] }]
    )[1];
    expect(first.initialWorkspaceIds).toEqual(["ws-platform"]);
    await view.unmount();
  });
});

describe("People page", () => {
  test("names the person in the suspend confirmation and says access is removed", async () => {
    const client = makeClient();
    const view = mount(null);
    await view.render(
      <Provider client={client}>
        <OrganizationPeoplePage workspaceId="workspace-a" />
      </Provider>,
    );
    await flush();
    expect(view.container.textContent).toContain("Maria Chen");
    expect(view.container.textContent).toContain("Platform engineering");
    await act(async () => button(view.container, "Suspend…").click());
    const confirm = view.container.querySelector('[data-testid="confirm"]')!;
    expect(confirm.textContent).toContain("Suspend Maria Chen?");
    expect(confirm.textContent).toContain(
      "Their access to Platform engineering is removed. Restoring doesn't bring it back.",
    );
    await act(async () => button(confirm, "Suspend").click());
    await flush();
    const call = client.updateOrganizationMember.mock.calls[0] as unknown as [
      string,
      string,
      { kind: string; expectedAuthorizationRevision: number },
    ];
    expect(call[1]).toBe("maria");
    expect(call[2]).toMatchObject({ kind: "suspend", expectedAuthorizationRevision: 3 });
    expect(toastSuccess).toHaveBeenCalledWith("Suspended Maria Chen", expect.anything());
    await view.unmount();
  });

  test("an admin can't revoke an owner's invitation", async () => {
    const client = makeClient();
    const view = mount(null);
    await view.render(
      <Provider client={client} actorRole="admin">
        <OrganizationPeoplePage workspaceId="workspace-a" />
      </Provider>,
    );
    await flush();
    const revokes = Array.from(view.container.querySelectorAll('[role="menuitem"]')).filter(
      (item) => item.textContent?.includes("Revoke invitation"),
    );
    expect(revokes).toHaveLength(1);
    await view.unmount();
  });

  test("the only owner's role is locked with the reason", async () => {
    const client = makeClient();
    const view = mount(null);
    await view.render(
      <Provider client={client}>
        <OrganizationPeoplePage workspaceId="workspace-a" person="owner" />
      </Provider>,
    );
    await flush();
    expect(view.container.textContent).toContain(
      "You're the only owner. Make someone else an owner first.",
    );
    await view.unmount();
  });
});

describe("Workspace page", () => {
  test("removing someone's access offers Undo that gives the same role back", async () => {
    const client = makeClient();
    const view = mount(null);
    await view.render(
      <Provider client={client}>
        <OrganizationWorkspacesPage workspaceId="workspace-a" workspace="ws-platform" />
      </Provider>,
    );
    await flush();
    const remove = Array.from(view.container.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes("Remove"),
    ) as HTMLButtonElement;
    await act(async () => remove.click());
    await flush();
    expect(client.revokeOrganizationWorkspaceMember).toHaveBeenCalledTimes(1);
    expect(undoToast).toHaveBeenCalledTimes(1);
    const undo = undoToast.mock.calls[0]![0];
    expect(String(undo.title)).toContain("Maria Chen no longer has access to Platform engineering");
    await act(async () => undo.onUndo());
    await flush();
    const put = client.putOrganizationWorkspaceMember.mock.calls.at(-1) as unknown as [
      string,
      string,
      string,
      { role: string; expectedUpdatedAt: string | null },
    ];
    expect(put[2]).toBe("maria");
    expect(put[3]).toMatchObject({ role: "member", expectedUpdatedAt: null });
    await view.unmount();
  });
});
