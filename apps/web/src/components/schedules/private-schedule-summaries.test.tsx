import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PrivateScheduledTaskSummary } from "@/types";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const workspaceId = "workspace-example";
const summary: PrivateScheduledTaskSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerSubjectId: "member-a",
  ownerName: "Ada Lovelace",
  status: "active",
  schedule: { type: "interval", everySeconds: 3_600 },
  lastRunAt: null,
  last30Days: { runs: 12, creditUsd: 0, estimatedProviderUsd: 1.5 },
  createdAt: "2026-10-01T10:00:00.000Z",
};
const pausePrivateScheduledTask = mock(async (_workspace: string, id: string) => ({
  ...summary,
  id,
  status: "paused" as const,
}));
const onDemand: PrivateScheduledTaskSummary = {
  ...summary,
  id: "00000000-0000-4000-8000-000000000002",
  ownerName: null,
  schedule: { type: "manual" },
};
const client = {
  listPrivateScheduledTaskSummaries: async () => ({ schedules: [summary, onDemand] }),
  pausePrivateScheduledTask,
};
mock.module("@/context", () => ({ useAppContext: () => ({ client }) }));
const { PrivateScheduleSummaries } = await import("./private-schedule-summaries");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("an admin sees whose private schedule it is, its cadence and cost, and can pause it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PrivateScheduleSummaries
        workspaceId={workspaceId}
        now={new Date("2026-10-11T12:00:00.000Z")}
      />,
    );
    await flush();
  });
  const text = container.textContent ?? "";
  expect(text).toContain("Other people's private schedules");
  expect(text).toContain("Ada Lovelace's schedule");
  expect(text).toContain("Every hour");
  expect(text).toContain("A member's schedule");
  expect(text).toContain("Only when its owner runs it");
  expect(text).toContain("$1.50");
  expect(text).toContain("Never run");
  expect(text).not.toContain("Only when you run it");

  const pause = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Pause Ada Lovelace\'s schedule"]',
  )!;
  await act(async () => {
    pause.click();
    await flush();
  });
  expect(pausePrivateScheduledTask).toHaveBeenCalledWith(workspaceId, summary.id);
  expect(container.textContent).toContain("Paused");
  expect(container.querySelector('button[aria-label="Pause Ada Lovelace\'s schedule"]')).toBeNull();
  await act(async () => root.unmount());
});
