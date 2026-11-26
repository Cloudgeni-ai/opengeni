import { expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { CreateScheduledTaskRequest, type AccessGrant } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

// Every way a trigger is created (the API, Opengeni's own tools, app sync)
// goes through createValidatedScheduledTask, which asks the readiness check
// only after the agent is known to be the caller's to use. The refusal itself
// is covered against a real database (apps/api agent-setup-readiness-postgres).
const asked: (string | null | undefined)[] = [];
const askedAs: (string | null | undefined)[] = [];
const actual = await import("../src/domain/ready-made-setup-readiness");
mock.module("../src/domain/ready-made-setup-readiness", () => ({
  ...actual,
  requireAgentTriggerReady: async (
    _deps: unknown,
    checkedAs: { subjectId?: string | null },
    agentId: string | null,
  ) => {
    asked.push(agentId);
    askedAs.push(checkedAs.subjectId);
    throw new HTTPException(409, {
      message: "Connect GitHub to turn this on.",
      cause: { code: "agent_setup_incomplete", missing: [] },
    });
  },
}));
// A trigger that finished its one run and is being re-armed.
const actualEvents = await import("../src/domain/event-triggers/automation-events");
mock.module("../src/domain/event-triggers/automation-events", () => ({
  ...actualEvents,
  scheduledTaskFinishedOnce: async () => true,
}));
const { createValidatedScheduledTask, resumeScheduledTaskAsAdmin } =
  await import("../src/domain/scheduled-tasks");
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

test("the readiness check never answers before the agent is checked", async () => {
  const db = new Proxy({} as never, {
    get() {
      throw new Error("agent checks read the database first");
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
  ).rejects.toThrow("agent checks read the database first");
  // A private agent's id can't earn a readiness message.
  expect(asked).toEqual([]);
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

test("an admin turning someone's trigger back on is checked against the owner's connections", async () => {
  asked.length = 0;
  askedAs.length = 0;
  const existing = {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: grant.workspaceId,
    status: "paused",
    ownerSubjectId: "user:owner",
    agentConfig: { agentId },
    events: null,
  } as never;
  await expect(
    resumeScheduledTaskAsAdmin(
      {} as never,
      { ...grant, subjectId: "user:admin" },
      existing,
      testSettings(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  // Runs use the owner's access, so their connections count, not the admin's.
  expect(askedAs).toEqual(["user:owner"]);
});

test("re-arming a trigger that finished its one run is checked too", async () => {
  asked.length = 0;
  const finished = {
    id: "33333333-3333-4333-8333-333333333334",
    workspaceId: grant.workspaceId,
    status: "active",
    ownerSubjectId: "user:owner",
    agentConfig: { agentId },
    events: null,
  } as never;
  await expect(
    resumeScheduledTaskAsAdmin({} as never, grant, finished, testSettings()),
  ).rejects.toMatchObject({ status: 409 });
  expect(asked).toEqual([agentId]);
});
