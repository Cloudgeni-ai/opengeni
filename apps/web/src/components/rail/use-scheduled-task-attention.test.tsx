import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ScheduledTaskAccessAttention } from "@/types";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function attention(runId: string): ScheduledTaskAccessAttention {
  return {
    taskId: "task-1",
    taskName: "Post the daily summary",
    executionDigest: "a".repeat(64),
    runId,
    firedAt: "2026-09-17T08:00:00.000Z",
    unavailableAccounts: [],
    failures: [
      {
        serverId: "slack",
        name: "Slack",
        providerDomain: "slack.com",
        reason: "personal_authority_unavailable",
        count: 1,
        firstOccurredAt: "2026-09-17T08:00:05.000Z",
      },
    ],
  };
}

const list = mock(
  async (_workspace: string): Promise<ScheduledTaskAccessAttention[]> => [attention("run-1")],
);
let permissions = ["scheduled_tasks:run"];
const client = { listScheduledTaskAccessAttention: list };
mock.module("@/context", () => ({
  useAppContext: () => ({
    client,
    accessContext: {
      workspaceGrants: [{ workspaceId: "one", permissions }],
    },
  }),
}));
const {
  markScheduledTaskAttentionSeen,
  notifyScheduledTaskAttentionUpdated,
  useScheduledTaskAttentionIndicator,
} = await import("./use-scheduled-task-attention");

function Probe({ workspace }: { workspace: string }) {
  return <span>{useScheduledTaskAttentionIndicator(workspace) ? "attention" : "none"}</span>;
}

beforeEach(() => {
  window.localStorage.clear();
  list.mockClear();
  permissions = ["scheduled_tasks:run"];
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test("shows the dot for an unseen failed run, clears once seen, and returns for a new failure", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspace="one" />));
    expect(container.textContent).toBe("attention");
    expect(list).toHaveBeenLastCalledWith("one");

    // The owner opened Schedules and saw the notice.
    await act(async () => markScheduledTaskAttentionSeen("one", [attention("run-1")]));
    expect(container.textContent).toBe("none");

    // A later run of the same schedule failed again: a new notice.
    list.mockResolvedValueOnce([attention("run-2")]);
    await act(async () => notifyScheduledTaskAttentionUpdated());
    expect(container.textContent).toBe("attention");

    // A transient failure keeps the known state; a clean run clears it.
    list.mockRejectedValueOnce(new Error("offline"));
    await act(async () => notifyScheduledTaskAttentionUpdated());
    expect(container.textContent).toBe("attention");
    list.mockResolvedValueOnce([]);
    await act(async () => notifyScheduledTaskAttentionUpdated());
    expect(container.textContent).toBe("none");
  } finally {
    await act(async () => root.unmount());
  }
});

/** New runs cannot start: there is no run, only the task head and its connectors. */
function blocked(executionDigest: string): ScheduledTaskAccessAttention {
  return {
    taskId: "task-2",
    taskName: "Weekly Linear digest",
    executionDigest,
    runId: null,
    firedAt: null,
    failures: [],
    unavailableAccounts: [{ id: "linear", name: "Linear" }],
  };
}

test("notifies about a schedule that cannot start, and again when it breaks after a fix", async () => {
  list.mockResolvedValue([blocked("b".repeat(64))]);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspace="one" />));
    expect(container.textContent).toBe("attention");

    await act(async () => markScheduledTaskAttentionSeen("one", [blocked("b".repeat(64))]));
    expect(container.textContent).toBe("none");

    // Still blocked on the next poll: the owner already saw it.
    await act(async () => notifyScheduledTaskAttentionUpdated());
    expect(container.textContent).toBe("none");

    // Refreshed (a new task head), then the account broke again: a new notice.
    list.mockResolvedValue([blocked("c".repeat(64))]);
    await act(async () => notifyScheduledTaskAttentionUpdated());
    expect(container.textContent).toBe("attention");
  } finally {
    await act(async () => root.unmount());
    list.mockImplementation(async () => [attention("run-1")]);
  }
});

test("asks nothing of a viewer who cannot see schedules", async () => {
  permissions = ["workspace:read"];
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspace="one" />));
    expect(container.textContent).toBe("none");
    expect(list).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

test("an unexpected answer keeps the navigation rendering and shows no dot", async () => {
  list.mockResolvedValueOnce(undefined as unknown as ScheduledTaskAccessAttention[]);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe workspace="one" />));
    expect(container.textContent).toBe("none");
  } finally {
    await act(async () => root.unmount());
  }
});
