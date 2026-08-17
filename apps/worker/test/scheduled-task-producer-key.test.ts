import { describe, expect, test } from "bun:test";
import { scheduledTaskRunProducerKey } from "../src/activities/scheduled-tasks";

describe("scheduled task legacy producer identity", () => {
  test("workflow retry, reset, and activity re-execution keep one logical producer", () => {
    const input = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      taskId: "00000000-0000-4000-8000-000000000002",
      triggerType: "scheduled" as const,
    };

    const first = scheduledTaskRunProducerKey(input, {
      namespace: "default",
      workflowExecution: { workflowId: "scheduled-fire/task/occurrence", runId: "run-a" },
      activityId: "1",
    });
    const replay = scheduledTaskRunProducerKey(input, {
      namespace: "default",
      workflowExecution: { workflowId: "scheduled-fire/task/occurrence", runId: "run-b" },
      activityId: "7",
    });

    expect(replay).toBe(first);
    expect(first).toContain("scheduled-fire/task/occurrence");
  });

  test("different logical fire workflows remain distinct", () => {
    const input = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      taskId: "00000000-0000-4000-8000-000000000002",
      triggerType: "scheduled" as const,
    };

    expect(
      scheduledTaskRunProducerKey(input, {
        namespace: "default",
        workflowExecution: { workflowId: "scheduled-fire/task/one", runId: "run-a" },
        activityId: "1",
      }),
    ).not.toBe(
      scheduledTaskRunProducerKey(input, {
        namespace: "default",
        workflowExecution: { workflowId: "scheduled-fire/task/two", runId: "run-a" },
        activityId: "1",
      }),
    );
  });
});
