import { describe, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, UpdateScheduledTaskRequest } from "@opengeni/contracts";
import { contractToolInput } from "../src/mcp/contract-input";
import {
  resolveScheduledTaskCreateInput,
  scheduledTaskCreateToolInput,
  scheduledTaskCreateToolValidation,
} from "../src/mcp/scheduled-task-input";

const sessionId = "00000000-0000-4000-8000-000000000001";
const otherSessionId = "00000000-0000-4000-8000-000000000002";
const message = {
  name: "Morning review",
  schedule: { type: "interval", everySeconds: 3600 },
  prompt: "Review new activity.",
} as const;

describe("conversational scheduling input", () => {
  test("published MCP schema admits the minimal call without injecting separate-agent defaults", () => {
    const schema = contractToolInput(
      scheduledTaskCreateToolInput(),
      scheduledTaskCreateToolValidation(sessionId),
    );
    expect(schema.parse(message)).toEqual(message);
    expect(resolveScheduledTaskCreateInput(schema.parse(message), sessionId)).toMatchObject({
      targetSessionId: sessionId,
      runMode: "existing_session",
      overlapPolicy: "buffer_one",
      agentConfig: { prompt: message.prompt, tools: [], resources: [], metadata: {} },
    });
  });

  test("REST accepts an existing-chat message with no duplicated execution settings", () => {
    const result = CreateScheduledTaskRequest.parse({ ...message, targetSessionId: sessionId });
    expect(result.runMode).toBe("existing_session");
    expect(result.agentConfig.model).toBeUndefined();
    expect(result.agentConfig.machineTarget).toBeUndefined();
    expect(result.variableSetId).toBeUndefined();
  });

  test("an explicit destination overrides only the destination, never the calling authority", () => {
    expect(
      resolveScheduledTaskCreateInput({ ...message, targetSessionId: otherSessionId }, sessionId)
        .targetSessionId,
    ).toBe(otherSessionId);
    expect(() => resolveScheduledTaskCreateInput(message, null)).toThrow("Choose an existing chat");
  });

  test("separate agents require an explicit mode and creation configuration", () => {
    const { prompt, ...base } = message;
    for (const runMode of ["reusable_session", "new_session_per_run"] as const) {
      expect(
        resolveScheduledTaskCreateInput({ ...base, runMode, agentConfig: { prompt } }, sessionId),
      ).toMatchObject({ runMode });
      expect(() => resolveScheduledTaskCreateInput({ ...message, runMode }, sessionId)).toThrow();
    }
    expect(
      resolveScheduledTaskCreateInput({ ...base, agentConfig: { prompt } }, sessionId)
        .targetSessionId,
    ).toBe(sessionId);
  });

  test("invalid and ambiguous messages fail as validation results, including escape expansion", () => {
    for (const value of [
      { ...message, agentConfig: { prompt: "Other instructions" } },
      { ...message, sandboxBackend: "selfhosted" },
      { ...message, prompt: "\n".repeat(40_000) },
      { ...message, prompt: "" },
    ])
      expect(
        CreateScheduledTaskRequest.safeParse({ ...value, targetSessionId: sessionId }).success,
      ).toBe(false);
    expect(
      UpdateScheduledTaskRequest.safeParse({ prompt: "A", agentConfigPatch: { prompt: "B" } })
        .success,
    ).toBe(false);
    expect(UpdateScheduledTaskRequest.parse({ prompt: "Updated message" })).toEqual({
      prompt: "Updated message",
    });
  });
});
