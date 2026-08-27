import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  SlackUserLinkAccessRequest,
  WorkspaceMember,
  WorkspaceMemberCandidate,
} from "@/types";

const workspaceA = "22222222-2222-4222-8222-222222222222";
const workspaceB = "33333333-3333-4333-8333-333333333333";

const slackRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: workspaceA,
  workspaceDisplayName: "Workspace A",
  subjectLabel: "Slack Requester",
  status: "pending",
  version: 1,
  expiresAt: "2026-08-12T12:00:00.000Z",
  requestedAt: "2026-08-11T12:00:00.000Z",
  decidedAt: null,
  completedAt: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
} satisfies SlackUserLinkAccessRequest;

const callerMember = {
  subjectId: "user:caller",
  subjectLabel: "owner@example.com",
  role: "admin",
  permissions: ["workspace:read", "workspace:admin", "members:manage"],
  createdAt: "2026-08-10T12:00:00.000Z",
} satisfies WorkspaceMember;
const collaboratorMember = {
  subjectId: "user:collaborator",
  subjectLabel: "Ada Member",
  role: "viewer",
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
  createdAt: "2026-08-11T12:00:00.000Z",
} satisfies WorkspaceMember;
const listWorkspaceMembers = mock(
  async (): Promise<WorkspaceMember[]> => [callerMember, collaboratorMember],
);
const candidateMember = {
  organizationMembershipId: "55555555-5555-4555-8555-555555555555",
  subjectId: "user:candidate",
  name: "Grace Hopper",
  email: "grace@example.com",
  organizationRole: "member",
} satisfies WorkspaceMemberCandidate;
const listWorkspaceMemberCandidates = mock(
  async (): Promise<WorkspaceMemberCandidate[]> => [candidateMember],
);
const addWorkspaceMember = mock(async (): Promise<WorkspaceMember> => callerMember);
const updateWorkspaceMember = mock(async (): Promise<WorkspaceMember> => callerMember);
const removeWorkspaceMember = mock(async () => undefined);
const listSlackUserLinkAccessRequests = mock(
  async (_workspaceId: string): Promise<SlackUserLinkAccessRequest[]> => [slackRequest],
);
const approveSlackUserLinkAccessRequest = mock(async () => undefined);
const denySlackUserLinkAccessRequest = mock(async () => undefined);

const context = {
  client: {
    approveSlackUserLinkAccessRequest,
    addWorkspaceMember,
    denySlackUserLinkAccessRequest,
    listSlackUserLinkAccessRequests,
    listWorkspaceMemberCandidates,
    listWorkspaceMembers,
    removeWorkspaceMember,
    updateWorkspaceMember,
  },
  accessContext: { subjectId: "user:caller" },
};

mock.module("@/context", () => ({ useAppContext: () => context }));
mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#organization">{children}</a>,
  useNavigate: () => () => undefined,
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { MembersSection } = await import("./workspace-settings");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  listWorkspaceMembers.mockClear();
  listWorkspaceMemberCandidates.mockClear();
  addWorkspaceMember.mockClear();
  updateWorkspaceMember.mockClear();
  removeWorkspaceMember.mockClear();
  listSlackUserLinkAccessRequests.mockClear();
  approveSlackUserLinkAccessRequest.mockClear();
  denySlackUserLinkAccessRequest.mockClear();
  listSlackUserLinkAccessRequests.mockImplementation(async () => [slackRequest]);
});

async function renderMembers(canManage: boolean, workspaceId = workspaceA) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (nextWorkspaceId: string, nextCanManage: boolean) => {
    await act(async () => {
      root.render(<MembersSection workspaceId={nextWorkspaceId} canManage={nextCanManage} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await render(workspaceId, canManage);
  return {
    container,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("workspace access settings convergence", () => {
  test("shows the workspace-scoped member manager", async () => {
    const rendered = await renderMembers(true);
    try {
      expect(rendered.container.textContent).toContain("owner@example.com");
      expect(rendered.container.textContent).toContain("Ada Member");
      expect(rendered.container.textContent).toContain("Add member");
      expect(rendered.container.textContent).toContain("Fine-tune");
      expect(rendered.container.textContent).toContain("Remove");
      expect(listWorkspaceMembers).toHaveBeenCalledWith(workspaceA);
      expect(updateWorkspaceMember).not.toHaveBeenCalled();
      expect(removeWorkspaceMember).not.toHaveBeenCalled();
      expect(rendered.container.textContent).not.toContain("organization-admin action");
    } finally {
      await rendered.unmount();
    }
  });

  test("selects an existing organization member instead of asking for an email", async () => {
    const rendered = await renderMembers(true);
    try {
      const addButton = Array.from(rendered.container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Add member",
      );
      await act(async () => {
        addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(listWorkspaceMemberCandidates).toHaveBeenCalledWith(workspaceA);
      expect(document.body.textContent).toContain("Grace Hopper");
      expect(document.body.textContent).toContain("grace@example.com");
      expect(document.body.textContent).not.toContain("Enter their email");
      expect(document.body.querySelector('input[type="email"]')).toBeNull();
      expect(document.body.querySelector('input[type="search"]')).not.toBeNull();

      const option = document.body.querySelector<HTMLButtonElement>('[role="option"]');
      await act(async () => option?.click());
      const submit = Array.from(document.body.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Add to workspace",
      );
      expect(submit?.disabled).toBe(false);
      await act(async () => {
        submit?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(addWorkspaceMember).toHaveBeenCalledWith(
        workspaceA,
        expect.objectContaining({
          organizationMembershipId: candidateMember.organizationMembershipId,
          role: "member",
        }),
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("preserves the separate manager-only Slack access-request queue", async () => {
    const rendered = await renderMembers(true);
    try {
      expect(listSlackUserLinkAccessRequests).toHaveBeenCalledWith(workspaceA);
      expect(rendered.container.textContent).toContain("Pending Slack access requests");
      expect(rendered.container.textContent).toContain("Slack Requester");
    } finally {
      await rendered.unmount();
    }
  });

  test("does not enumerate Slack requests without member-management authority", async () => {
    const rendered = await renderMembers(false);
    try {
      expect(listSlackUserLinkAccessRequests).not.toHaveBeenCalled();
      expect(listWorkspaceMembers).toHaveBeenCalledWith(workspaceA);
      expect(rendered.container.textContent).not.toContain("Add member");
      expect(rendered.container.textContent).not.toContain("Slack Requester");
    } finally {
      await rendered.unmount();
    }
  });

  test("discards a stale Slack response after switching workspaces", async () => {
    let resolveStale!: (value: SlackUserLinkAccessRequest[]) => void;
    const stale = new Promise<SlackUserLinkAccessRequest[]>((resolve) => {
      resolveStale = resolve;
    });
    const current = {
      ...slackRequest,
      id: "44444444-4444-4444-8444-444444444444",
      workspaceId: workspaceB,
      subjectLabel: "Current applicant",
    };
    listSlackUserLinkAccessRequests.mockImplementation((workspaceId) =>
      workspaceId === workspaceA ? stale : Promise.resolve([current]),
    );
    const rendered = await renderMembers(true, workspaceA);
    try {
      await rendered.render(workspaceB, true);
      expect(rendered.container.textContent).toContain("Current applicant");
      await act(async () => {
        resolveStale([slackRequest]);
        await stale;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(rendered.container.textContent).toContain("Current applicant");
      expect(rendered.container.textContent).not.toContain("Slack Requester");
    } finally {
      await rendered.unmount();
    }
  });
});
