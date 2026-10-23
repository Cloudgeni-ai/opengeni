import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ScheduledTask } from "@opengeni/react/app/types";
import type { ReactNode } from "react";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const workspaceId = "workspace-example";
const viewer = "viewer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function schedule(id: string, name: string, status: ScheduledTask["status"]): ScheduledTask {
  return {
    id,
    workspaceId,
    name,
    ownerSubjectId: viewer,
    visibility: "workspace",
    status,
    schedule: { type: "calendar", timeZone: "UTC", hour: 8, minute: 0 },
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    action: { kind: "agent_turn" },
    agentConfig: { prompt: "Example", resources: [], metadata: {} },
    executionDigest: "0".repeat(64),
    targetSessionId: null,
    reusableSessionId: null,
    metadata: {},
  } as unknown as ScheduledTask;
}

let server: ScheduledTask[] = [];
let pending: ReturnType<typeof deferred<ScheduledTask>> | null = null;
const pauseScheduledTask = mock(async (_workspace: string, id: string) => {
  pending = deferred<ScheduledTask>();
  const result = await pending.promise;
  server = server.map((task) => (task.id === id ? { ...task, status: "paused" } : task));
  return result;
});
const resumeScheduledTask = mock(async (_workspace: string, id: string) => {
  pending = deferred<ScheduledTask>();
  const result = await pending.promise;
  server = server.map((task) => (task.id === id ? { ...task, status: "active" } : task));
  return result;
});
const listScheduledTasks = mock(async () => server.map((task) => ({ ...task })));
const client = {
  listScheduledTasks,
  listScheduledTaskAccessAttention: async () => [],
  listScheduledTaskRuns: async () => [],
  pauseScheduledTask,
  resumeScheduledTask,
  getSession: async () => {
    throw new Error("not used");
  },
};
const context = {
  client,
  accessContext: {
    subjectId: viewer,
    workspaceGrants: [{ workspaceId, permissions: ["scheduled_tasks:manage"] }],
  },
};
const toastError = mock((_title: string, _options?: unknown) => undefined);
const toastSuccess = mock((_title: string, _options?: unknown) => undefined);
mock.module("sonner", () => ({
  toast: Object.assign(() => undefined, { error: toastError, success: toastSuccess }),
}));
mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#chat">{children}</a>,
  useNavigate: () => () => undefined,
}));
mock.module("@opengeni/react/app/app-context", () => ({ useAppContext: () => context }));
mock.module("./create-with-opengeni", () => ({
  CreateWithOpenGeniButton: () => null,
  useCanCreateScheduleWithAgent: () => false,
  useCreateWithOpenGeni: () => ({ open: () => undefined, dialog: null }),
}));
const { SchedulesListPage, holdOrder } = await import("./schedules-list-page");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.replaceChildren();
  pauseScheduledTask.mockClear();
  resumeScheduledTask.mockClear();
  listScheduledTasks.mockClear();
  toastError.mockClear();
  toastSuccess.mockClear();
  pending = null;
  server = [
    schedule("a", "Morning brief", "active"),
    schedule("b", "Weekly dependency PR", "active"),
    schedule("c", "Cost check", "paused"),
  ];
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function renderList() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SchedulesListPage workspaceId={workspaceId} />);
  });
  await flush();
  return container;
}

function switchFor(container: HTMLElement, name: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`);
  if (!found) throw new Error(`No switch for ${name}`);
  return found;
}

function rowText(control: HTMLElement): string {
  return control.closest("li")?.textContent ?? "";
}

function rowTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].map(
    (control) => control.getAttribute("aria-label") ?? "",
  );
}

test("each row has one switch for its schedule and no separate Resume button", async () => {
  const container = await renderList();
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(3);
  expect(switchFor(container, "Morning brief").getAttribute("aria-checked")).toBe("true");
  expect(switchFor(container, "Cost check").getAttribute("aria-checked")).toBe("false");
  expect(
    [...container.querySelectorAll("button")].some((button) =>
      /resume/i.test(`${button.textContent} ${button.getAttribute("aria-label") ?? ""}`),
    ),
  ).toBe(false);
});

test("one click pauses: the switch and Next run change before the server answers", async () => {
  const container = await renderList();
  const control = switchFor(container, "Morning brief");
  expect(rowText(control)).not.toContain("Paused");

  await act(async () => control.click());
  expect(pauseScheduledTask).toHaveBeenCalledTimes(1);
  expect(pauseScheduledTask.mock.calls[0]?.[1]).toBe("a");
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.getAttribute("aria-busy")).toBe("true");
  expect(rowText(control)).toContain("Paused");

  // A second click while saving sends nothing.
  await act(async () => control.click());
  expect(pauseScheduledTask).toHaveBeenCalledTimes(1);

  await act(async () => pending!.resolve({ ...server[0]!, status: "paused" }));
  await flush();
  const settled = switchFor(container, "Morning brief");
  expect(settled.getAttribute("aria-checked")).toBe("false");
  expect(settled.hasAttribute("aria-busy")).toBe(false);
  expect(rowText(settled)).toContain("Paused");
  expect(toastSuccess).not.toHaveBeenCalled();
  expect(toastError).not.toHaveBeenCalled();
});

test("a failed resume puts the switch back and says what failed", async () => {
  const container = await renderList();
  const control = switchFor(container, "Cost check");

  await act(async () => control.click());
  expect(resumeScheduledTask).toHaveBeenCalledTimes(1);
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(rowText(control)).not.toContain("Paused");

  await act(async () => pending!.reject(new Error("Example failure")));
  await flush();
  const settled = switchFor(container, "Cost check");
  expect(settled.getAttribute("aria-checked")).toBe("false");
  expect(rowText(settled)).toContain("Paused");
  expect(toastError).toHaveBeenCalledTimes(1);
  expect(toastError.mock.calls[0]?.[0]).toBe("Couldn't resume the schedule");
});

test("rows keep their place after a switch, even once the list reloads", async () => {
  const container = await renderList();
  const before = rowTitles(container);
  expect(before.at(-1)).toBe("Cost check");

  // Resuming would sort Cost check among the active ones; it stays put.
  await act(async () => switchFor(container, "Cost check").click());
  await act(async () => pending!.resolve({ ...server[2]!, status: "active" }));
  await flush();
  expect(listScheduledTasks.mock.calls.length).toBeGreaterThan(1);
  expect(switchFor(container, "Cost check").getAttribute("aria-checked")).toBe("true");
  expect(rowTitles(container)).toEqual(before);
});

test("holdOrder keeps the held order only for the same schedules", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => schedule(id, id, "active"));
  expect(holdOrder([a!, b!, c!], ["c", "a", "b"]).map((task) => task.id)).toEqual(["c", "a", "b"]);
  expect(holdOrder([a!, b!], ["c", "a"]).map((task) => task.id)).toEqual(["a", "b"]);
  expect(holdOrder([a!, b!, c!], ["a", "b"]).map((task) => task.id)).toEqual(["a", "b", "c"]);
  expect(holdOrder([a!, b!], null).map((task) => task.id)).toEqual(["a", "b"]);
});
