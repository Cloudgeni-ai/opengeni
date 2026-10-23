// Deterministic data for the Schedules list preview. Pause and resume change
// the in-memory schedules after a short delay; `?fail=1` makes every pause
// and resume fail, to show the rollback. Nothing here reaches a real API.
import type { ScheduledTask, ScheduledTaskRun } from "@opengeni/sdk";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
const viewer = "viewer-subject";
const params = new URLSearchParams(location.search);
const fail = params.get("fail") === "1";
const delayMs = Number(params.get("delay") ?? "400");
const HOUR = 3_600_000;
const now = Date.now();

function task(
  index: number,
  name: string,
  status: ScheduledTask["status"],
  schedule: ScheduledTask["schedule"],
): ScheduledTask {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    accountId: "acct",
    workspaceId,
    name,
    ownerSubjectId: viewer,
    visibility: "workspace",
    status,
    schedule,
    temporalScheduleId: id,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    action: { kind: "agent_turn" },
    agentConfig: { prompt: "Example", resources: [], metadata: {} },
    authorityRevision: 1,
    executionDigest: "0".repeat(64),
    targetSessionId: null,
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: new Date(now - 30 * 24 * HOUR).toISOString(),
    updatedAt: new Date(now - HOUR).toISOString(),
  } as unknown as ScheduledTask;
}

const daily = (hour: number, minute: number, timeZone = "Europe/Oslo") =>
  ({ type: "calendar", timeZone, hour, minute }) as const;

const tasks: ScheduledTask[] = [
  task(1, "Daily kitchen prevention brief", "paused", daily(7, 0)),
  task(2, "Market radar: daily prospect research", "active", daily(8, 0, "UTC")),
  task(3, "Weekday funding watch", "paused", {
    type: "calendar",
    timeZone: "Europe/Oslo",
    hour: 8,
    minute: 30,
    daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  }),
  task(4, "Oslo demand and surplus radar", "active", daily(6, 30)),
  task(5, "Daily demand-signal research", "paused", daily(5, 30)),
];

function run(taskId: string, hoursAgo: number, status: ScheduledTaskRun["status"]) {
  return {
    id: `run-${taskId}`,
    accountId: "acct",
    workspaceId,
    taskId,
    taskAuthorityRevision: 1,
    taskExecutionDigest: null,
    status,
    triggerType: "schedule",
    scheduledAt: null,
    firedAt: new Date(now - hoursAgo * HOUR).toISOString(),
    sessionId: null,
    triggerEventId: null,
    actionKind: "agent_turn",
    knowledgeSyncRunId: null,
    knowledgeSummary: null,
    completedAt: null,
    error: status === "failed" ? "Example failure" : null,
  } as unknown as ScheduledTaskRun;
}
const lastRuns: Record<string, ScheduledTaskRun> = Object.fromEntries(
  (
    [
      [0, 1, "succeeded"],
      [1, 22, "succeeded"],
      [2, 23, "succeeded"],
      [3, 1, "failed"],
      [4, 2, "succeeded"],
    ] as const
  ).map(([index, hours, status]) => [tasks[index]!.id, run(tasks[index]!.id, hours, status)]),
);

declare global {
  interface Window {
    scheduleToggleCalls: { action: "pause" | "resume"; id: string }[];
  }
}
window.scheduleToggleCalls = [];

const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
async function setStatus(id: string, status: ScheduledTask["status"]) {
  window.scheduleToggleCalls.push({ action: status === "paused" ? "pause" : "resume", id });
  await wait();
  if (fail) throw new Error("The server could not change this schedule.");
  const found = tasks.find((candidate) => candidate.id === id)!;
  found.status = status;
  return { ...found };
}

const context = {
  client: {
    listScheduledTasks: async () => tasks.map((item) => ({ ...item })),
    listScheduledTaskAccessAttention: async () => [],
    listScheduledTaskRuns: async (_workspace: string, id: string) =>
      lastRuns[id] ? [lastRuns[id]] : [],
    pauseScheduledTask: (_workspace: string, id: string) => setStatus(id, "paused"),
    resumeScheduledTask: (_workspace: string, id: string) => setStatus(id, "active"),
    triggerScheduledTask: async () => undefined,
    deleteScheduledTask: async () => undefined,
    getSession: async () => {
      throw new Error("not used");
    },
  },
  accessContext: {
    subjectId: viewer,
    workspaceGrants: [
      { workspaceId, permissions: ["scheduled_tasks:manage", "scheduled_tasks:run"] },
    ],
  },
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};

export function useAppContext() {
  return context;
}
