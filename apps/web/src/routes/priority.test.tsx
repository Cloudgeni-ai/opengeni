import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ApiError } from "@/api";
import { subscribeToWorkspaceSessionListChanges } from "@/lib/session-list-invalidation";
import type { Session } from "@/types";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000004";

let sessions: Session[] = [];
const listAgentTopology = mock(async (..._args: unknown[]) => ({
  sessions: [] as Array<Record<string, unknown>>,
  nextCursor: null as string | null,
}));
let permissions = ["sessions:read", "sessions:control"];
const refresh = mock(async () => undefined);
const railRefresh = mock(async () => undefined);
const otherWorkspaceRailRefresh = mock(async () => undefined);
const updateSessionArchive = mock(async (_workspaceId: string, _sessionId: string) => ({
  ...sessions[0]!,
  archived: true,
  archivedAt: "2026-08-31T12:00:00.000Z",
  archiveVersion: 1,
}));
const cancelSession = mock(
  async (
    _workspaceId: string,
    _sessionId: string,
    _options: {
      clientEventId: string;
      reason: string;
      expectedControlEtag: string;
    },
  ) => ({
    effectiveControl: sessions[0]!.effectiveControl,
  }),
);

mock.module("@opengeni/react", () => ({
  useWorkspaceSessions: () => ({
    sessions,
    nextCursor: null,
    loading: false,
    error: null,
    refresh,
  }),
  useChannels: () => ({ channels: [] }),
}));

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
  }: {
    children: ReactNode;
    params?: { workspaceId?: string; sessionId?: string };
  }) => (
    <a href={`/workspaces/${params?.workspaceId}/sessions/${params?.sessionId ?? ""}`}>
      {children}
    </a>
  ),
}));

mock.module("@/context", () => ({
  useAppContext: () => ({
    client: { updateSessionArchive, cancelSession, listAgentTopology },
    accessContext: {
      workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions }],
    },
  }),
}));

mock.module("sonner", () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { PriorityRoute } = await import("./priority");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  listAgentTopology.mockReset();
  listAgentTopology.mockResolvedValue({ sessions: [], nextCursor: null });
  sessions = [brokenSession()];
  permissions = ["sessions:read", "sessions:control"];
  refresh.mockClear();
  railRefresh.mockClear();
  otherWorkspaceRailRefresh.mockClear();
  updateSessionArchive.mockClear();
  cancelSession.mockClear();
});

function brokenSession(): Session {
  return {
    id: SESSION_ID,
    accountId: "00000000-0000-4000-8000-000000000003",
    workspaceId: WORKSPACE_ID,
    initialMessage: "Repair the deployment",
    title: "Broken deployment",
    parentSessionId: null,
    channelId: null,
    status: "failed",
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    unread: false,
    activelyWorking: false,
    attentionVersion: 0,
    archived: false,
    archivedAt: null,
    archiveVersion: 0,
    createdBy: { kind: "subject", subjectId: "user:test" },
    effectiveControl: {
      state: "active",
      controlVersion: 4,
      controlEtag: "active-4",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    treeStats: {
      directChildren: 1,
      totalDescendants: 1,
      runningDescendants: 1,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
    },
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T11:00:00.000Z",
  } as unknown as Session;
}

function buttonWithText(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

async function renderPriorityRoute() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <PriorityRoute workspaceId={WORKSPACE_ID} />
        <SessionListRefreshProbe workspaceId={WORKSPACE_ID} refresh={railRefresh} />
        <SessionListRefreshProbe
          workspaceId={OTHER_WORKSPACE_ID}
          refresh={otherWorkspaceRailRefresh}
        />
      </>,
    ),
  );
  return { container, root };
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function SessionListRefreshProbe({
  workspaceId,
  refresh: refreshProbe,
}: {
  workspaceId: string;
  refresh: () => Promise<void>;
}) {
  useEffect(
    () =>
      subscribeToWorkspaceSessionListChanges(workspaceId, () => {
        void refreshProbe();
      }),
    [refreshProbe, workspaceId],
  );
  return null;
}

describe("For you broken-session actions", () => {
  test("dismisses a broken session into the personal archive", async () => {
    const { container, root } = await renderPriorityRoute();
    try {
      expect(container.textContent).toContain("Broken deployment");
      await act(async () => {
        buttonWithText(container, "Dismiss")!.click();
        await Promise.resolve();
      });

      expect(updateSessionArchive).toHaveBeenCalledWith(WORKSPACE_ID, SESSION_ID, {
        archived: true,
        expectedVersion: 0,
      });
      expect(container.textContent).not.toContain("Broken deployment");
      expect(refresh).toHaveBeenCalled();
      expect(railRefresh).toHaveBeenCalledTimes(1);
      expect(otherWorkspaceRailRefresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("confirms a terminal stop, refreshes the rail, and restores stable focus", async () => {
    const { container, root } = await renderPriorityRoute();
    try {
      const trigger = buttonWithText(container, "Stop workstream")!;
      trigger.focus();
      await act(async () => trigger.click());
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain("1 spawned session");

      await act(async () => {
        buttonWithText(dialog!, "Stop workstream")!.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(cancelSession).toHaveBeenCalledTimes(1);
      expect(cancelSession.mock.calls[0]?.[0]).toBe(WORKSPACE_ID);
      expect(cancelSession.mock.calls[0]?.[1]).toBe(SESSION_ID);
      expect(cancelSession.mock.calls[0]?.[2]).toMatchObject({
        reason: "Stopped from For you",
        expectedControlEtag: "active-4",
      });
      expect(cancelSession.mock.calls[0]?.[2]?.clientEventId).toBeString();
      expect(container.textContent).not.toContain("Broken deployment");
      expect(updateSessionArchive).not.toHaveBeenCalled();
      expect(railRefresh).toHaveBeenCalledTimes(1);
      expect(otherWorkspaceRailRefresh).not.toHaveBeenCalled();
      expect(trigger.isConnected).toBe(false);
      const heading = container.querySelector("h1");
      await waitFor(
        () =>
          document.body.querySelector('[role="dialog"]') === null &&
          document.activeElement === heading,
        `Expected focus on the For you heading after dialog close; active element was ${
          document.activeElement?.tagName ?? "none"
        }`,
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("reopens a conflicted stop with the refreshed control ETag", async () => {
    cancelSession.mockImplementationOnce(async () => {
      throw new ApiError(409, "control changed");
    });
    refresh.mockImplementationOnce(async () => {
      const refreshed = brokenSession();
      sessions = [
        {
          ...refreshed,
          effectiveControl: {
            ...refreshed.effectiveControl,
            controlVersion: 5,
            controlEtag: "paused-5",
            state: "paused",
            directState: "paused",
          },
        },
      ];
    });
    const { container, root } = await renderPriorityRoute();
    try {
      await act(async () => buttonWithText(container, "Stop workstream")!.click());
      const firstDialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      await act(async () => {
        buttonWithText(firstDialog, "Stop workstream")!.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(
        () => document.body.querySelector('[role="dialog"]') === null,
        "Expected the stale confirmation to close after the control conflict",
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(cancelSession.mock.calls[0]?.[2]?.expectedControlEtag).toBe("active-4");
      const firstClientEventId = cancelSession.mock.calls[0]?.[2]?.clientEventId;

      await act(async () => buttonWithText(container, "Stop workstream")!.click());
      const secondDialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      await act(async () => {
        buttonWithText(secondDialog, "Stop workstream")!.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(cancelSession).toHaveBeenCalledTimes(2);
      expect(cancelSession.mock.calls[1]?.[2]).toMatchObject({
        expectedControlEtag: "paused-5",
      });
      expect(cancelSession.mock.calls[1]?.[2]?.clientEventId).not.toBe(firstClientEventId);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("describes a truncated descendant count as a lower bound", async () => {
    const session = brokenSession();
    sessions = [
      {
        ...session,
        treeStats: {
          ...session.treeStats!,
          totalDescendants: 1_000,
          truncated: true,
        },
      },
    ];
    const { container, root } = await renderPriorityRoute();
    try {
      await act(async () => buttonWithText(container, "Stop workstream")!.click());
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');

      expect(dialog?.textContent).toContain("at least 1,000 spawned sessions");
      expect(dialog?.textContent).not.toContain("its 1,000 spawned sessions");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("keeps personal dismissal available without shared session control", async () => {
    permissions = ["sessions:read"];
    const { container, root } = await renderPriorityRoute();
    try {
      expect(buttonWithText(container, "Dismiss")).not.toBeNull();
      expect(buttonWithText(container, "Stop workstream")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("For you exact waiting agent navigation", () => {
  test("offers discovery when a truncated tree has no known waiting descendants", async () => {
    sessions[0]!.treeStats!.attentionDescendants = 0;
    sessions[0]!.treeStats!.truncated = true;
    listAgentTopology.mockResolvedValueOnce({
      sessions: [
        {
          id: "late-child",
          title: "Reviewer beyond summary",
          status: "requires_action",
          pause: { state: "active" },
        },
      ],
      nextCursor: null,
    });
    const { container, root } = await renderPriorityRoute();
    try {
      expect(listAgentTopology).not.toHaveBeenCalled();
      const check = buttonWithText(container, "Check waiting agents");
      expect(check).not.toBeNull();
      await act(async () => check!.click());
      expect(container.textContent).toContain("Reviewer beyond summary");
      expect(container.querySelector('a[href$="/sessions/late-child"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("loads authorized child pages on demand while preserving the parent failure", async () => {
    sessions[0]!.treeStats!.attentionDescendants = 2;
    listAgentTopology.mockResolvedValueOnce({
      sessions: [
        {
          id: "child-one",
          title: "Waiting reviewer",
          status: "requires_action",
          pause: { state: "active" },
        },
      ],
      nextCursor: "next-page",
    });
    listAgentTopology.mockResolvedValueOnce({
      sessions: [
        {
          id: "child-two",
          title: "Paused reviewer",
          status: "requires_action",
          pause: { state: "paused" },
        },
      ],
      nextCursor: null,
    });
    const { container, root } = await renderPriorityRoute();
    try {
      expect(listAgentTopology).not.toHaveBeenCalled();
      await act(async () => {
        buttonWithText(container, "Show waiting agents")!.click();
      });
      expect(listAgentTopology).toHaveBeenCalledWith(WORKSPACE_ID, {
        rootSessionId: SESSION_ID,
        statuses: ["requires_action"],
        limit: 20,
      });
      const child = [...container.querySelectorAll("a")].find(
        (link) => link.textContent === "Waiting reviewer",
      );
      expect(child?.getAttribute("href")).toBe(`/workspaces/${WORKSPACE_ID}/sessions/child-one`);
      expect(container.textContent).toContain("Broken deployment");
      expect(container.textContent).toContain("since update");
      await act(async () => {
        buttonWithText(container, "Load more waiting agents")!.click();
      });
      expect(listAgentTopology.mock.calls[1]?.[1]).toMatchObject({ cursor: "next-page" });
      expect(container.textContent).toContain("Paused; request still pending");
      expect(container.textContent).toContain("Waiting reviewer");
      await act(async () => {
        buttonWithText(container, "Refresh waiting agents")!.click();
      });
      expect(container.textContent).not.toContain("Waiting reviewer");
      expect(container.textContent).toContain("No waiting agents were found");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("does not call a partial empty page empty and labels results retained after a failed refresh", async () => {
    sessions[0]!.treeStats!.attentionDescendants = 1;
    listAgentTopology.mockResolvedValueOnce({ sessions: [], nextCursor: "more" });
    listAgentTopology.mockResolvedValueOnce({
      sessions: [
        {
          id: "child-one",
          title: "Previously checked child",
          status: "requires_action",
          pause: { state: "active" },
        },
      ],
      nextCursor: null,
    });
    listAgentTopology.mockRejectedValueOnce(new Error("refresh unavailable"));
    const { container, root } = await renderPriorityRoute();
    try {
      await act(async () => buttonWithText(container, "Show waiting agents")!.click());
      expect(container.textContent).not.toContain("No waiting agents were found");
      await act(async () => buttonWithText(container, "Load more waiting agents")!.click());
      await act(async () => buttonWithText(container, "Refresh waiting agents")!.click());
      expect(container.textContent).toContain("Previously checked child");
      expect(container.textContent).toContain("The listed agents are from the previous check.");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("ignores child discovery from a workspace that has been left", async () => {
    sessions[0]!.treeStats!.attentionDescendants = 1;
    let resolveOld!: (page: { sessions: Array<Record<string, unknown>>; nextCursor: null }) => void;
    const pending = new Promise<{ sessions: Array<Record<string, unknown>>; nextCursor: null }>(
      (resolve) => {
        resolveOld = resolve;
      },
    );
    listAgentTopology.mockImplementationOnce(() => pending);
    const { container, root } = await renderPriorityRoute();
    try {
      await act(async () => {
        buttonWithText(container, "Show waiting agents")!.click();
      });
      await act(async () => {
        root.render(<PriorityRoute workspaceId={OTHER_WORKSPACE_ID} />);
      });
      await act(async () => {
        resolveOld({
          sessions: [
            {
              id: "old-child",
              title: "Previous workspace child",
              status: "requires_action",
              pause: { state: "active" },
            },
          ],
          nextCursor: null,
        });
        await pending;
      });
      expect(container.textContent).not.toContain("Previous workspace child");
      expect(buttonWithText(container, "Show waiting agents")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("presents retry when child discovery fails", async () => {
    sessions[0]!.treeStats!.attentionDescendants = 1;
    listAgentTopology.mockRejectedValueOnce(new Error("unavailable"));
    const { container, root } = await renderPriorityRoute();
    try {
      await act(async () => {
        buttonWithText(container, "Show waiting agents")!.click();
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be loaded",
      );
      await act(async () => {
        buttonWithText(container, "Refresh waiting agents")!.click();
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
