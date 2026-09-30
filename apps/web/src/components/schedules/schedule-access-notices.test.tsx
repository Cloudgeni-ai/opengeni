import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ScheduledTaskAccessAttention, ScheduledTaskPolicyDrift } from "@/types";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { ScheduledTaskAccessNotices } = await import("./schedule-access-notices");

const drift: ScheduledTaskPolicyDrift = {
  missingConnectors: [{ id: "gmail", name: "Gmail" }],
  unavailableConnectors: [],
  missingOpenGeniTools: ["browser_read"],
  unavailableAccounts: [],
  attachableAccounts: [{ id: "slack", name: "Slack" }],
  canRefresh: true,
};

const attention: ScheduledTaskAccessAttention = {
  taskId: crypto.randomUUID(),
  taskName: "Post the daily summary",
  executionDigest: "a".repeat(64),
  runId: crypto.randomUUID(),
  firedAt: "2026-09-17T08:00:00.000Z",
  unavailableAccounts: [],
  failures: [
    {
      serverId: "slack",
      name: "Slack",
      providerDomain: "slack.com",
      reason: "personal_authority_unavailable",
      count: 2,
      firstOccurredAt: "2026-09-17T08:00:05.000Z",
    },
  ],
};

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("scheduled task access notices", () => {
  test("tells the owner what failed and what a one-click refresh changes", async () => {
    const onRefreshAccess = mock(() => undefined);
    const view = await render(
      <ScheduledTaskAccessNotices
        policyDrift={drift}
        attention={attention}
        ownsTask
        busy={false}
        onRefreshAccess={onRefreshAccess}
      />,
    );
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("The last run could not use a connector");
      expect(text).toContain(
        "Couldn't use Slack: your personal account is not available to this schedule.",
      );
      expect(text).toContain("Refreshing access below may fix it.");
      expect(text).toContain("New schedules in this workspace also get Gmail; this one does not.");
      expect(text).toContain("1 newer Opengeni tool is not available to it: browser read.");
      const button = [...view.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Refresh access",
      );
      expect(button).toBeTruthy();
      await act(async () => button!.click());
      expect(onRefreshAccess).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  test("offers no refresh to a viewer who cannot run it", async () => {
    const view = await render(
      <ScheduledTaskAccessNotices
        policyDrift={{ ...drift, canRefresh: false }}
        attention={null}
        ownsTask
        busy={false}
        onRefreshAccess={() => undefined}
      />,
    );
    try {
      expect(view.container.querySelector("button")).toBeNull();
      expect(view.container.textContent).toContain(
        "Refreshing needs a signed-in person who can manage schedules.",
      );
    } finally {
      await view.cleanup();
    }
  });

  test("a failure without drift points at the connection instead", async () => {
    const view = await render(
      <ScheduledTaskAccessNotices
        policyDrift={null}
        attention={attention}
        ownsTask
        busy={false}
        onRefreshAccess={() => undefined}
      />,
    );
    try {
      expect(view.container.textContent).toContain(
        "Check the connection in Capabilities, then run the schedule again.",
      );
      expect(view.container.querySelector("button")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a schedule that cannot start says so once and offers the refresh right there", async () => {
    const onRefreshAccess = mock(() => undefined);
    const view = await render(
      <ScheduledTaskAccessNotices
        policyDrift={{
          missingConnectors: [],
          unavailableConnectors: [],
          missingOpenGeniTools: [],
          unavailableAccounts: [{ id: "linear", name: "Linear" }],
          attachableAccounts: [],
          canRefresh: true,
        }}
        attention={{
          ...attention,
          runId: null,
          firedAt: null,
          failures: [],
          unavailableAccounts: [{ id: "linear", name: "Linear" }],
        }}
        ownsTask
        busy={false}
        onRefreshAccess={onRefreshAccess}
      />,
    );
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("New runs of this schedule cannot start");
      const sentence =
        "The account chosen for Linear can no longer be used, so new runs cannot start.";
      expect(text.split(sentence)).toHaveLength(2);
      expect(text).toContain("Refreshing access uses the accounts you can use now.");
      expect(text).not.toContain("This schedule's access is out of date");
      const button = [...view.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Refresh access",
      );
      await act(async () => button!.click());
      expect(onRefreshAccess).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  test("a blocked schedule the viewer cannot refresh points at the connection", async () => {
    const view = await render(
      <ScheduledTaskAccessNotices
        policyDrift={null}
        attention={{
          ...attention,
          runId: null,
          firedAt: null,
          failures: [],
          unavailableAccounts: [{ id: "linear", name: "Linear" }],
        }}
        ownsTask
        busy={false}
        onRefreshAccess={() => undefined}
      />,
    );
    try {
      expect(view.container.textContent).toContain(
        "Reconnect the account in Capabilities, or edit the schedule to choose another one.",
      );
      expect(view.container.querySelector("button")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("defaults the owner does not want can be kept off", async () => {
    const onDismissDrift = mock(() => undefined);
    const view = await render(
      <ScheduledTaskAccessNotices
        policyDrift={drift}
        attention={null}
        ownsTask
        busy={false}
        onRefreshAccess={() => undefined}
        onDismissDrift={onDismissDrift}
      />,
    );
    try {
      const button = [...view.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Keep without these",
      );
      expect(button).toBeTruthy();
      await act(async () => button!.click());
      expect(onDismissDrift).toHaveBeenCalledTimes(1);
    } finally {
      await view.cleanup();
    }
  });

  test("renders nothing when access is current and every run could use its connectors", async () => {
    const view = await render(
      <ScheduledTaskAccessNotices
        policyDrift={null}
        attention={null}
        ownsTask
        busy={false}
        onRefreshAccess={() => undefined}
      />,
    );
    try {
      expect(view.container.querySelector("[data-scheduled-task-access]")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});
