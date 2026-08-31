import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type { Session } from "@/types";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";

let sessions: Session[] = [];
let permissions = ["sessions:read", "sessions:control"];
const refresh = mock(async () => undefined);
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
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
}));

mock.module("@/context", () => ({
  useAppContext: () => ({
    client: { updateSessionArchive, cancelSession },
    accessContext: {
      workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions }],
    },
  }),
}));

mock.module("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: (props: {
    open: boolean;
    title: ReactNode;
    description?: ReactNode;
    confirmLabel: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void | boolean | Promise<void | boolean>;
  }) =>
    props.open ? (
      <div role="dialog">
        <div>{props.title}</div>
        <div>{props.description}</div>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(props.onConfirm()).then((result) => {
              if (result !== false) props.onOpenChange(false);
            });
          }}
        >
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));

mock.module("sonner", () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { PriorityRoute } = await import("./priority");

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  sessions = [brokenSession()];
  permissions = ["sessions:read", "sessions:control"];
  refresh.mockClear();
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
  await act(async () => root.render(<PriorityRoute workspaceId={WORKSPACE_ID} />));
  return { container, root };
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
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("confirms a terminal stop with one stable command id", async () => {
    const { container, root } = await renderPriorityRoute();
    try {
      await act(async () => buttonWithText(container, "Stop workstream")!.click());
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.textContent).toContain("1 spawned session");

      await act(async () => {
        buttonWithText(dialog!, "Stop workstream")!.click();
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
