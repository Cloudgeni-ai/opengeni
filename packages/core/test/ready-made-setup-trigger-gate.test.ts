import { expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { CreateScheduledTaskRequest, type AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

// Every way a trigger is created (the API, Opengeni's own tools, app sync)
// goes through createValidatedScheduledTask, which asks the readiness check
// before anything else touches the database.
const asked: (string | null | undefined)[] = [];
const actual = await import("../src/domain/ready-made-setup-readiness");
mock.module("../src/domain/ready-made-setup-readiness", () => ({
  ...actual,
  requireAgentTriggerReady: async (_deps: unknown, _grant: unknown, agentId: string | null) => {
    asked.push(agentId);
    throw new HTTPException(409, {
      message: "Connect GitHub to turn this on.",
      cause: { code: "agent_setup_incomplete", missing: [] },
    });
  },
}));
const { createValidatedScheduledTask } = await import("../src/domain/scheduled-tasks");
const { agentTriggerTurnsOn } = actual;

const grant: AccessGrant = {
  accountId: "44444444-4444-4444-8444-444444444444",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  subjectId: "user:gate",
  permissions: ["scheduled_tasks:manage"],
  principalKind: "human_session",
};
const agentId = "22222222-2222-4222-8222-222222222222";

function request(status: "active" | "paused") {
  return CreateScheduledTaskRequest.parse({
    name: "Review PRs",
    status,
    schedule: { type: "manual" },
    runMode: "new_session_per_run",
    overlapPolicy: "buffer_one",
    action: { kind: "agent_turn" },
    agentConfig: { prompt: "Review", resources: [], tools: [], metadata: {}, agentId },
  });
}

test("creating an active trigger for an agent that isn't ready is refused with the reason", async () => {
  const db = new Proxy({} as never, {
    get() {
      throw new Error("Unexpected database effect before the readiness refusal");
    },
  });
  await expect(
    createValidatedScheduledTask({
      settings: testSettings(),
      db,
      objectStorage: null,
      grant,
      payload: request("active"),
    }),
  ).rejects.toMatchObject({ status: 409, message: "Connect GitHub to turn this on." });
  expect(asked).toEqual([agentId]);
});

test("a paused trigger isn't checked: it can be added and turned on later", async () => {
  asked.length = 0;
  await createValidatedScheduledTask({
    settings: testSettings(),
    db: new Proxy({} as never, {
      get() {
        throw new Error("stop after the gate");
      },
    }),
    objectStorage: null,
    grant,
    payload: request("paused"),
  }).catch(() => undefined);
  expect(asked).toEqual([]);
});

test("an edit is checked when it turns the trigger on or points an active one at another agent", () => {
  const base = { previousAgentId: "a", nextAgentId: "a" };
  expect(agentTriggerTurnsOn({ ...base, previousStatus: "paused", nextStatus: "active" })).toBe(
    true,
  );
  expect(agentTriggerTurnsOn({ ...base, previousStatus: "active", nextStatus: "active" })).toBe(
    false,
  );
  expect(
    agentTriggerTurnsOn({
      previousStatus: "active",
      nextStatus: "active",
      previousAgentId: "a",
      nextAgentId: "b",
    }),
  ).toBe(true);
  expect(agentTriggerTurnsOn({ ...base, previousStatus: "active", nextStatus: "paused" })).toBe(
    false,
  );
});
