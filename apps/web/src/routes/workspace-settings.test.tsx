import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { SlackUserLinkAccessRequest, WorkspaceMember } from "@/types";

const member: WorkspaceMember = {
  subjectId: "user:member-a",
  subjectLabel: "Ada Member",
  role: "member",
  permissions: ["sessions:read"],
  createdAt: "2026-08-11T12:00:00.000Z",
};

const slackAccessRequest: SlackUserLinkAccessRequest = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
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
};

const listWorkspaceMembers = mock(
  async (_workspaceId: string): Promise<WorkspaceMember[]> => [member],
);
const listSlackUserLinkAccessRequests = mock(
  async (_workspaceId: string): Promise<SlackUserLinkAccessRequest[]> => [slackAccessRequest],
);
const context = {
  client: {
    listWorkspaceMembers,
    listSlackUserLinkAccessRequests,
  },
  accessContext: { subjectId: "user:caller" },
};

mock.module("@/context", () => ({
  useAppContext: () => context,
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
  listSlackUserLinkAccessRequests.mockClear();
  listWorkspaceMembers.mockImplementation(async () => [member]);
  listSlackUserLinkAccessRequests.mockImplementation(async () => [slackAccessRequest]);
});

async function renderMembers(canManage: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MembersSection workspaceId="22222222-2222-4222-8222-222222222222" canManage={canManage} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("workspace members loading", () => {
  test("keeps loaded members visible when Slack access requests fail", async () => {
    listSlackUserLinkAccessRequests.mockImplementation(async () => {
      throw new Error("Slack returned 500");
    });
    const rendered = await renderMembers(true);

    try {
      expect(rendered.container.textContent).toContain("Ada Member");
      expect(rendered.container.textContent).toContain("Pending Slack access requests unavailable");
      expect(rendered.container.textContent).toContain("Slack returned 500");
      expect(rendered.container.textContent).not.toContain("Couldn't load members");
    } finally {
      await rendered.unmount();
    }
  });

  test("preserves the primary member error when members fail", async () => {
    listWorkspaceMembers.mockImplementation(async () => {
      throw new Error("Members returned 500");
    });
    const rendered = await renderMembers(true);

    try {
      expect(rendered.container.textContent).toContain("Couldn't load members");
      expect(rendered.container.textContent).toContain("Members returned 500");
      expect(rendered.container.textContent).not.toContain("Slack Requester");
      expect(rendered.container.textContent).not.toContain(
        "Pending Slack access requests unavailable",
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("skips Slack access requests for non-managers", async () => {
    const rendered = await renderMembers(false);

    try {
      expect(listWorkspaceMembers).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
      expect(listSlackUserLinkAccessRequests).not.toHaveBeenCalled();
      expect(rendered.container.textContent).toContain("Ada Member");
      expect(rendered.container.textContent).not.toContain("Slack Requester");
    } finally {
      await rendered.unmount();
    }
  });

  test("renders members and pending Slack access requests when both load", async () => {
    const rendered = await renderMembers(true);

    try {
      expect(rendered.container.textContent).toContain("Ada Member");
      expect(rendered.container.textContent).toContain("Pending Slack access requests");
      expect(rendered.container.textContent).toContain("Slack Requester");
      expect(rendered.container.textContent).not.toContain("Couldn't load members");
    } finally {
      await rendered.unmount();
    }
  });
});
