import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { SlackUserLinkAccessRequest, WorkspaceMember } from "@/types";

const workspaceA = "22222222-2222-4222-8222-222222222222";
const workspaceB = "33333333-3333-4333-8333-333333333333";

const member: WorkspaceMember = {
  subjectId: "user:member-a",
  subjectLabel: "Ada Member",
  role: "member",
  permissions: ["sessions:read"],
  createdAt: "2026-08-11T12:00:00.000Z",
};
const nextWorkspaceMember: WorkspaceMember = {
  ...member,
  subjectId: "user:member-b",
  subjectLabel: "Bea Member",
};

const slackAccessRequest: SlackUserLinkAccessRequest = {
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
};
const nextWorkspaceSlackAccessRequest: SlackUserLinkAccessRequest = {
  ...slackAccessRequest,
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId: workspaceB,
  workspaceDisplayName: "Workspace B",
  subjectLabel: "Current Slack Applicant",
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

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({ open, title }: { open: boolean; title: ReactNode }) =>
    open ? <div data-testid="confirm-dialog">{title}</div> : null,
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function renderMembers(canManage: boolean, workspaceId = workspaceA) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  async function render(nextWorkspaceId: string, nextCanManage: boolean) {
    await act(async () => {
      root.render(<MembersSection workspaceId={nextWorkspaceId} canManage={nextCanManage} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  await render(workspaceId, canManage);

  return {
    container,
    rerender: render,
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
      expect(listWorkspaceMembers).toHaveBeenCalledWith(workspaceA);
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

  for (const staleSlackOutcome of ["response", "error"] as const) {
    test(`ignores stale workspace members and Slack ${staleSlackOutcome} after switching workspaces`, async () => {
      const staleMembers = deferred<WorkspaceMember[]>();
      const staleSlackAccessRequests = deferred<SlackUserLinkAccessRequest[]>();
      listWorkspaceMembers.mockImplementation((workspaceId) =>
        workspaceId === workspaceA ? staleMembers.promise : Promise.resolve([nextWorkspaceMember]),
      );
      listSlackUserLinkAccessRequests.mockImplementation((workspaceId) =>
        workspaceId === workspaceA
          ? staleSlackAccessRequests.promise
          : Promise.resolve([nextWorkspaceSlackAccessRequest]),
      );
      const rendered = await renderMembers(true, workspaceA);

      try {
        await rendered.rerender(workspaceB, true);
        expect(rendered.container.textContent).toContain("Bea Member");
        expect(rendered.container.textContent).toContain("Current Slack Applicant");

        await act(async () => {
          staleMembers.resolve([member]);
          if (staleSlackOutcome === "response") {
            staleSlackAccessRequests.resolve([slackAccessRequest]);
          } else {
            staleSlackAccessRequests.reject(new Error("Stale Slack returned 500"));
          }
          await Promise.allSettled([staleMembers.promise, staleSlackAccessRequests.promise]);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(rendered.container.textContent).toContain("Bea Member");
        expect(rendered.container.textContent).toContain("Current Slack Applicant");
        expect(rendered.container.textContent).not.toContain("Ada Member");
        expect(rendered.container.textContent).not.toContain("Slack Requester");
        expect(rendered.container.textContent).not.toContain("Stale Slack returned 500");
        expect(rendered.container.textContent).not.toContain(
          "Pending Slack access requests unavailable",
        );
      } finally {
        await rendered.unmount();
      }
    });
  }

  test("ignores a stale primary member error after switching workspaces", async () => {
    const staleMembers = deferred<WorkspaceMember[]>();
    const staleSlackAccessRequests = deferred<SlackUserLinkAccessRequest[]>();
    listWorkspaceMembers.mockImplementation((workspaceId) =>
      workspaceId === workspaceA ? staleMembers.promise : Promise.resolve([nextWorkspaceMember]),
    );
    listSlackUserLinkAccessRequests.mockImplementation((workspaceId) =>
      workspaceId === workspaceA
        ? staleSlackAccessRequests.promise
        : Promise.resolve([nextWorkspaceSlackAccessRequest]),
    );
    const rendered = await renderMembers(true, workspaceA);

    try {
      await rendered.rerender(workspaceB, true);
      expect(rendered.container.textContent).toContain("Bea Member");
      expect(rendered.container.textContent).toContain("Current Slack Applicant");

      await act(async () => {
        staleMembers.reject(new Error("Stale members returned 500"));
        staleSlackAccessRequests.resolve([slackAccessRequest]);
        await Promise.allSettled([staleMembers.promise, staleSlackAccessRequests.promise]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(rendered.container.textContent).toContain("Bea Member");
      expect(rendered.container.textContent).toContain("Current Slack Applicant");
      expect(rendered.container.textContent).not.toContain("Couldn't load members");
      expect(rendered.container.textContent).not.toContain("Stale members returned 500");
      expect(rendered.container.textContent).not.toContain("Slack Requester");
    } finally {
      await rendered.unmount();
    }
  });

  test("clears stale member, Slack error, edit, and removal state at the workspace boundary", async () => {
    listSlackUserLinkAccessRequests.mockImplementation(async () => {
      throw new Error("Workspace A Slack returned 500");
    });
    const rendered = await renderMembers(true, workspaceA);

    try {
      const editButton = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Edit",
      );
      expect(editButton).toBeDefined();

      await act(async () => {
        editButton?.click();
      });
      expect(rendered.container.textContent).toContain("Save");

      const removeButton = rendered.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove Ada Member"]',
      );
      expect(removeButton).not.toBeNull();
      await act(async () => {
        removeButton?.click();
      });
      expect(document.body.textContent).toContain("Remove Ada Member from this workspace?");
      expect(rendered.container.textContent).toContain("Workspace A Slack returned 500");

      const currentMembers = deferred<WorkspaceMember[]>();
      const currentSlackAccessRequests = deferred<SlackUserLinkAccessRequest[]>();
      listWorkspaceMembers.mockImplementation((workspaceId) =>
        workspaceId === workspaceB ? currentMembers.promise : Promise.resolve([member]),
      );
      listSlackUserLinkAccessRequests.mockImplementation((workspaceId) =>
        workspaceId === workspaceB
          ? currentSlackAccessRequests.promise
          : Promise.resolve([slackAccessRequest]),
      );

      await rendered.rerender(workspaceB, true);

      expect(rendered.container.textContent).toContain("Loading members");
      expect(rendered.container.textContent).not.toContain("Ada Member");
      expect(rendered.container.textContent).not.toContain("Save");
      expect(rendered.container.textContent).not.toContain("Workspace A Slack returned 500");
      expect(document.body.textContent).not.toContain("Remove Ada Member from this workspace?");

      await act(async () => {
        currentMembers.resolve([nextWorkspaceMember]);
        currentSlackAccessRequests.resolve([nextWorkspaceSlackAccessRequest]);
        await Promise.all([currentMembers.promise, currentSlackAccessRequests.promise]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(rendered.container.textContent).toContain("Bea Member");
    } finally {
      await rendered.unmount();
    }
  });

  test("clears a stale primary member error while the next workspace loads", async () => {
    listWorkspaceMembers.mockImplementation(async () => {
      throw new Error("Workspace A members returned 500");
    });
    const rendered = await renderMembers(true, workspaceA);

    try {
      expect(rendered.container.textContent).toContain("Couldn't load members");
      expect(rendered.container.textContent).toContain("Workspace A members returned 500");

      const currentMembers = deferred<WorkspaceMember[]>();
      const currentSlackAccessRequests = deferred<SlackUserLinkAccessRequest[]>();
      listWorkspaceMembers.mockImplementation(() => currentMembers.promise);
      listSlackUserLinkAccessRequests.mockImplementation(() => currentSlackAccessRequests.promise);

      await rendered.rerender(workspaceB, true);

      expect(rendered.container.textContent).toContain("Loading members");
      expect(rendered.container.textContent).not.toContain("Couldn't load members");
      expect(rendered.container.textContent).not.toContain("Workspace A members returned 500");

      await act(async () => {
        currentMembers.resolve([nextWorkspaceMember]);
        currentSlackAccessRequests.resolve([nextWorkspaceSlackAccessRequest]);
        await Promise.all([currentMembers.promise, currentSlackAccessRequests.promise]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(rendered.container.textContent).toContain("Bea Member");
    } finally {
      await rendered.unmount();
    }
  });

  test("keeps the newest overlapping refresh authoritative in the same workspace", async () => {
    listSlackUserLinkAccessRequests.mockImplementation(async () => {
      throw new Error("Initial Slack returned 500");
    });
    const rendered = await renderMembers(true, workspaceA);

    try {
      const olderMembers = deferred<WorkspaceMember[]>();
      const olderSlackAccessRequests = deferred<SlackUserLinkAccessRequest[]>();
      const newerMembers = deferred<WorkspaceMember[]>();
      const newerSlackAccessRequests = deferred<SlackUserLinkAccessRequest[]>();
      let membersRefresh = 0;
      let slackRefresh = 0;
      listWorkspaceMembers.mockImplementation(() =>
        ++membersRefresh === 1 ? olderMembers.promise : newerMembers.promise,
      );
      listSlackUserLinkAccessRequests.mockImplementation(() =>
        ++slackRefresh === 1 ? olderSlackAccessRequests.promise : newerSlackAccessRequests.promise,
      );

      const retryButton = [...rendered.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retryButton).toBeDefined();
      await act(async () => {
        retryButton?.click();
        retryButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(rendered.container.textContent).toContain("Loading members");
      expect(rendered.container.textContent).not.toContain("Initial Slack returned 500");

      const newestSlackAccessRequest = {
        ...slackAccessRequest,
        id: "55555555-5555-4555-8555-555555555555",
        subjectLabel: "Newest Slack Applicant",
      };
      await act(async () => {
        newerMembers.resolve([nextWorkspaceMember]);
        newerSlackAccessRequests.resolve([newestSlackAccessRequest]);
        await Promise.all([newerMembers.promise, newerSlackAccessRequests.promise]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(rendered.container.textContent).toContain("Bea Member");
      expect(rendered.container.textContent).toContain("Newest Slack Applicant");
      expect(rendered.container.textContent).not.toContain("Loading members");

      await act(async () => {
        olderMembers.resolve([member]);
        olderSlackAccessRequests.reject(new Error("Older Slack returned 500"));
        await Promise.allSettled([olderMembers.promise, olderSlackAccessRequests.promise]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(rendered.container.textContent).toContain("Bea Member");
      expect(rendered.container.textContent).toContain("Newest Slack Applicant");
      expect(rendered.container.textContent).not.toContain("Ada Member");
      expect(rendered.container.textContent).not.toContain("Older Slack returned 500");
      expect(rendered.container.textContent).not.toContain(
        "Pending Slack access requests unavailable",
      );
      expect(rendered.container.textContent).not.toContain("Loading members");
    } finally {
      await rendered.unmount();
    }
  });
});
