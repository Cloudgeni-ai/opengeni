import { expect, test } from "bun:test";
import { createOpenGeniText } from "@opengeni/react/messages";
import type { AccessContext, ScheduledTask, ScheduledTaskRun } from "@opengeni/sdk";
import {
  automationPermissions,
  automationStateWord,
  cachedAutomationList,
  forgetAutomation,
  lastRunWords,
  loadAutomationList,
  runIsLive,
  runRowWords,
} from "./automations";

const t = createOpenGeniText();
const now = new Date("2026-11-08T12:00:00Z");

const task = (id: string, patch: Partial<ScheduledTask> = {}) =>
  ({
    id,
    workspaceId: "work",
    name: id,
    ownerSubjectId: "me",
    status: "active",
    schedule: { type: "manual" },
    action: { kind: "agent_turn" },
    agentConfig: { prompt: "Say hello" },
    targetSessionId: null,
    ...patch,
  }) as ScheduledTask;

const run = (id: string, patch: Partial<ScheduledTaskRun> = {}) =>
  ({
    id,
    taskId: "a",
    status: "dispatched",
    triggerType: "scheduled",
    firedAt: "2026-11-08T10:00:00Z",
    sessionId: "chat",
    error: null,
    ...patch,
  }) as ScheduledTaskRun;

const context = (permissions: string[], subjectId = "me") =>
  ({
    subjectId,
    workspaceGrants: [{ workspaceId: "work", permissions }],
  }) as unknown as AccessContext;

test("the list shows each automation with its newest run, and an unreadable run as unknown", async () => {
  const asked: string[] = [];
  const list = await loadAutomationList(
    {
      listScheduledTasks: async () => [task("b", { name: "Beta" }), task("a", { name: "Alpha" })],
      listScheduledTaskRuns: async (_workspace, taskId, options) => {
        asked.push(`${taskId}:${options?.limit}`);
        if (taskId === "b") throw new Error("offline");
        return [run("r1")];
      },
      listEventSources: async () => {
        throw new Error("only event triggers need sources");
      },
    },
    "work",
    now,
  );
  expect(list.entries.map((entry) => entry.task.name)).toEqual(["Alpha", "Beta"]);
  expect(list.entries.map((entry) => entry.lastRun?.id ?? entry.lastRun)).toEqual([
    "r1",
    undefined,
  ]);
  expect(asked.toSorted()).toEqual(["a:1", "b:1"]);
  expect(list.sources).toEqual([]);
});

test("a row says what the automation last did", () => {
  expect(lastRunWords(t, null, now)).toBe("Hasn't run yet");
  expect(lastRunWords(t, undefined, now)).toBe("");
  expect(lastRunWords(t, run("r", { status: "failed" }), now)).toBe("Failed · 2 hours ago");
  expect(lastRunWords(t, run("r"), now)).toBe("Started · 2 hours ago");
  // An agent run ends once its chat has the message; only a queued one is still on its way.
  expect(runIsLive(run("r"))).toBe(false);
  expect(runIsLive(run("r", { status: "queued" }))).toBe(true);
});

test("a run row reads when, what started it and why it failed", () => {
  const words = runRowWords(
    t,
    run("r", { status: "failed", triggerType: "manual", error: "boom" }),
    now,
  );
  expect(words.subtitle.startsWith("Run now\n")).toBe(true);
  expect(words.status).toBe("Failed");
  expect(words.failed).toBe(true);
});

test("a word at the row's end for one that won't run", () => {
  expect(automationStateWord(task("a"))).toBeNull();
  expect(automationStateWord(task("a", { status: "paused" }))).toBe("Paused");
  expect(
    automationStateWord(
      task("a", {
        events: {
          triggers: [],
          maxRunsPerHour: 1,
          once: true,
          completedAt: "2026-11-01T00:00:00Z",
          throttledSince: null,
        },
      }),
    ),
  ).toBe("Finished");
});

test("only the owner changes or runs one, and creating needs chats too", () => {
  const manager = context(["scheduled_tasks:manage", "scheduled_tasks:run", "sessions:create"]);
  expect(automationPermissions(manager, "work", task("a"))).toEqual({
    canManage: true,
    canRun: true,
    canCreate: true,
  });
  expect(automationPermissions(manager, "work", task("a", { ownerSubjectId: "someone" }))).toEqual({
    canManage: false,
    canRun: false,
    canCreate: true,
  });
  // A workspace automation (no owner) belongs to everyone who manages automations.
  expect(
    automationPermissions(manager, "work", task("a", { ownerSubjectId: null })).canManage,
  ).toBe(true);
  expect(automationPermissions(context(["sessions:create"]), "work")).toEqual({
    canManage: false,
    canRun: false,
    canCreate: false,
  });
  expect(automationPermissions(context(["workspace:admin"]), "other").canManage).toBe(false);
  expect(automationPermissions(null, "work").canCreate).toBe(false);
});

test("a deleted automation leaves the kept list", () => {
  expect(cachedAutomationList("nowhere")).toBeUndefined();
  forgetAutomation("nowhere", "a");
  expect(cachedAutomationList("nowhere")).toBeUndefined();
});
