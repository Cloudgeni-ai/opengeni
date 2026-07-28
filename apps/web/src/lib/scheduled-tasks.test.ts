import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@/types";
import {
  agentConfigFromFormState,
  formStateFromScheduledTask,
  newScheduledTaskFormState,
} from "./scheduled-tasks";

const connectionId = "11111111-1111-4111-8111-111111111111";

function scheduledTask(): ScheduledTask {
  const now = new Date(0).toISOString();
  return {
    id: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "44444444-4444-4444-8444-444444444444",
    name: "Explicit Slack routing",
    status: "active",
    schedule: { type: "interval", everySeconds: 3_600 },
    temporalScheduleId: "scheduled-task-test",
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Use the selected OpenGeni Slack bot",
      resources: [],
      tools: [{ kind: "mcp", id: "opengeni" }],
      metadata: {},
      slackBotConnectionId: connectionId,
    },
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("scheduled task Slack bot selection", () => {
  test("round-trips an explicit connection and omits routing when cleared", () => {
    const task = scheduledTask();
    const form = formStateFromScheduledTask(task);
    expect(form.slackBotConnectionId).toBe(connectionId);
    expect(agentConfigFromFormState(form, task).slackBotConnectionId).toBe(connectionId);

    const cleared = { ...form, slackBotConnectionId: "" };
    expect(agentConfigFromFormState(cleared, task)).not.toHaveProperty("slackBotConnectionId");

    const fresh = newScheduledTaskFormState(true);
    expect(fresh.slackBotConnectionId).toBe("");
    expect(agentConfigFromFormState(fresh)).not.toHaveProperty("slackBotConnectionId");
  });
});
