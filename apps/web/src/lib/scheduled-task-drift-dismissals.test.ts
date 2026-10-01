import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { carryScheduledTaskDriftDismissal, dismissScheduledTaskDrift, scheduledTaskDriftDismissal } =
  await import("./scheduled-task-drift-dismissals");

const head = "a".repeat(64);
const task = { id: "task-1", executionDigest: head };

beforeEach(() => {
  window.localStorage.clear();
});

test("keeps the dismissed defaults for the task head the owner saw, per workspace", () => {
  expect(scheduledTaskDriftDismissal("one", task)).toBeNull();
  expect(
    dismissScheduledTaskDrift("one", task, {
      missingConnectors: [{ id: "gmail", name: "Gmail" }],
      missingOpenGeniTools: ["browser_read"],
    }),
  ).toBe(true);
  // A later default is added to the same choice, never replacing it.
  dismissScheduledTaskDrift("one", task, {
    missingConnectors: [{ id: "notion", name: "Notion" }],
    missingOpenGeniTools: [],
  });
  expect(scheduledTaskDriftDismissal("one", task)).toEqual({
    executionDigest: head,
    connectors: ["gmail", "notion"],
    openGeniTools: ["browser_read"],
  });
  expect(scheduledTaskDriftDismissal("two", task)).toBeNull();
  // An edit moved the task to a new head: a fresh look.
  expect(
    scheduledTaskDriftDismissal("one", { ...task, executionDigest: "b".repeat(64) }),
  ).toBeNull();
});

test("a refresh that kept the defaults off carries the choice to the new head", () => {
  dismissScheduledTaskDrift("one", task, {
    missingConnectors: [{ id: "gmail", name: "Gmail" }],
    missingOpenGeniTools: [],
  });
  const dismissal = scheduledTaskDriftDismissal("one", task);
  const next = "c".repeat(64);
  carryScheduledTaskDriftDismissal("one", task.id, dismissal, next);
  expect(scheduledTaskDriftDismissal("one", { ...task, executionDigest: next })).toEqual({
    executionDigest: next,
    connectors: ["gmail"],
    openGeniTools: [],
  });
  expect(scheduledTaskDriftDismissal("one", task)).toBeNull();
});

test("unreadable storage shows the drift instead of failing", () => {
  window.localStorage.setItem("opengeni.schedules.access-drift-dismissed", "not json");
  expect(scheduledTaskDriftDismissal("one", task)).toBeNull();
  window.localStorage.setItem(
    "opengeni.schedules.access-drift-dismissed",
    JSON.stringify({ one: { "task-1": { executionDigest: 7 } } }),
  );
  expect(scheduledTaskDriftDismissal("one", task)).toBeNull();
});
