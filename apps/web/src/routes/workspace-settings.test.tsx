import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { SlackUserLinkAccessRequest } from "@/types";

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

const listWorkspaceMembers = mock(async () => {
  throw new Error("the retired workspace member API must not be called");
});
const updateWorkspaceMember = mock(async () => {
  throw new Error("the retired workspace member API must not be called");
});
const removeWorkspaceMember = mock(async () => {
  throw new Error("the retired workspace member API must not be called");
});
const listSlackUserLinkAccessRequests = mock(
  async (_workspaceId: string): Promise<SlackUserLinkAccessRequest[]> => [slackRequest],
);
const approveSlackUserLinkAccessRequest = mock(async () => undefined);
const denySlackUserLinkAccessRequest = mock(async () => undefined);

const context = {
  client: {
    approveSlackUserLinkAccessRequest,
    denySlackUserLinkAccessRequest,
    listSlackUserLinkAccessRequests,
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

const { MembersSection } = await import("./workspace-settings");

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
  listWorkspaceMembers.mockClear();
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
  test("retires raw human member reads and mutations in favor of organization roles", async () => {
    const rendered = await renderMembers(true);
    try {
      expect(rendered.container.textContent).toContain(
        "Workspace access is managed from the organization",
      );
      expect(rendered.container.textContent).toContain(
        "single place to assign named workspace roles",
      );
      expect(rendered.container.textContent).toContain("Manage organization workspaces");
      expect(listWorkspaceMembers).not.toHaveBeenCalled();
      expect(updateWorkspaceMember).not.toHaveBeenCalled();
      expect(removeWorkspaceMember).not.toHaveBeenCalled();
      expect(rendered.container.textContent).not.toContain("custom permissions");
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
      expect(rendered.container.textContent).toContain(
        "Workspace access is managed from the organization",
      );
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
