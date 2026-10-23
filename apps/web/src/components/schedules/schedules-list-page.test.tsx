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
/** One open save per schedule; the test settles it. */
const saves = new Map<string, ReturnType<typeof deferred<void>>>();
/** While set, list reads take their snapshot at once and answer when it resolves. */
let listGate: ReturnType<typeof deferred<void>> | null = null;
async function save(id: string, status: ScheduledTask["status"]) {
  const gate = deferred<void>();
  saves.set(id, gate);
  await gate.promise;
  server = server.map((task) => (task.id === id ? { ...task, status } : task));
  return { ...server.find((task) => task.id === id)! };
}
const pauseScheduledTask = mock((_workspace: string, id: string) => save(id, "paused"));
const resumeScheduledTask = mock((_workspace: string, id: string) => save(id, "active"));
const listScheduledTasks = mock(async () => {
  const snapshot = server.map((task) => ({ ...task }));
  if (listGate) await listGate.promise;
  return snapshot;
});
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
const { ScheduleMenuItems, canSwitchSchedule } = await import("./schedule-parts");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
  await import("@opengeni/react/ui/dropdown-menu");

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
  saves.clear();
  listGate = null;
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

  await act(async () => saves.get("a")!.resolve());
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

  await act(async () => saves.get("c")!.reject(new Error("Example failure")));
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
  await act(async () => saves.get("c")!.resolve());
  await flush();
  expect(listScheduledTasks.mock.calls.length).toBeGreaterThan(1);
  expect(switchFor(container, "Cost check").getAttribute("aria-checked")).toBe("true");
  expect(rowTitles(container)).toEqual(before);
});

test("the list sorts again once the pointer leaves it", async () => {
  const container = await renderList();
  await act(async () => switchFor(container, "Cost check").click());
  await act(async () => saves.get("c")!.resolve());
  await flush();
  expect(rowTitles(container).at(-1)).toBe("Cost check");

  const row = switchFor(container, "Cost check").closest("li")!;
  // While the row's menu is open the order holds.
  const trigger = row.querySelector<HTMLButtonElement>(
    '[aria-label="More actions for Cost check"]',
  )!;
  trigger.setAttribute("aria-expanded", "true");
  await act(async () => {
    row.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
  });
  await flush();
  expect(rowTitles(container).at(-1)).toBe("Cost check");
  trigger.setAttribute("aria-expanded", "false");

  await act(async () => {
    row.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
  });
  await flush();
  // Cost check runs again, so it now sorts by name among the active ones.
  expect(rowTitles(container)).toEqual(["Cost check", "Morning brief", "Weekly dependency PR"]);
});

test("holdOrder keeps the held order only for the same schedules", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => schedule(id, id, "active"));
  expect(holdOrder([a!, b!, c!], ["c", "a", "b"]).map((task) => task.id)).toEqual(["c", "a", "b"]);
  expect(holdOrder([a!, b!], ["c", "a"]).map((task) => task.id)).toEqual(["a", "b"]);
  expect(holdOrder([a!, b!, c!], ["a", "b"]).map((task) => task.id)).toEqual(["a", "b", "c"]);
  expect(holdOrder([a!, b!], null).map((task) => task.id)).toEqual(["a", "b"]);
});

test("a refresh that overlaps a save never paints an older state over it", async () => {
  const container = await renderList();
  await act(async () => switchFor(container, "Morning brief").click());
  await act(async () => switchFor(container, "Weekly dependency PR").click());

  // A's save lands; its refresh reads the server while B is still on, and
  // answers slowly.
  const slow = deferred<void>();
  listGate = slow;
  await act(async () => saves.get("a")!.resolve());
  await flush();
  listGate = null;
  // B's save lands and its own refresh answers at once.
  await act(async () => saves.get("b")!.resolve());
  await flush();
  expect(switchFor(container, "Weekly dependency PR").getAttribute("aria-checked")).toBe("false");

  // A's stale answer arrives last; B stays off.
  await act(async () => slow.resolve());
  await flush();
  expect(switchFor(container, "Weekly dependency PR").getAttribute("aria-checked")).toBe("false");
  expect(switchFor(container, "Morning brief").getAttribute("aria-checked")).toBe("false");
});

test("two rows can switch at once and each settles on its own", async () => {
  const container = await renderList();
  await act(async () => switchFor(container, "Morning brief").click());
  await act(async () => switchFor(container, "Cost check").click());
  expect(pauseScheduledTask).toHaveBeenCalledTimes(1);
  expect(resumeScheduledTask).toHaveBeenCalledTimes(1);

  await act(async () => saves.get("c")!.reject(new Error("Example failure")));
  await flush();
  expect(switchFor(container, "Cost check").getAttribute("aria-checked")).toBe("false");
  expect(switchFor(container, "Morning brief").getAttribute("aria-busy")).toBe("true");
  expect(switchFor(container, "Morning brief").getAttribute("aria-checked")).toBe("false");

  await act(async () => saves.get("a")!.resolve());
  await flush();
  expect(switchFor(container, "Morning brief").getAttribute("aria-checked")).toBe("false");
  expect(switchFor(container, "Morning brief").hasAttribute("aria-busy")).toBe(false);
});

const manager = {
  viewerSubjectId: viewer,
  canManage: true,
  canRun: true,
  canReadSessionIds: true,
  canTargetSessions: true,
};

function sync(id: string, status: ScheduledTask["status"], control: Record<string, unknown>) {
  return {
    ...schedule(id, `Sync ${id}`, status),
    action: { kind: "knowledge_source_sync" },
    agentConfig: { prompt: "", resources: [], metadata: {}, knowledgeSource: { id } },
    metadata: { knowledgeSourceSync: control },
  } as unknown as ScheduledTask;
}

test("the switch shows only where it pauses a schedule the viewer can change", () => {
  expect(canSwitchSchedule(schedule("a", "Mine", "active"), manager)).toBe(true);
  expect(canSwitchSchedule(schedule("a", "Mine", "paused"), manager)).toBe(true);
  // Someone else's, or without manage permission.
  expect(
    canSwitchSchedule({ ...schedule("a", "Theirs", "active"), ownerSubjectId: "other" }, manager),
  ).toBe(false);
  expect(canSwitchSchedule(schedule("a", "Mine", "active"), { ...manager, canManage: false })).toBe(
    false,
  );
  // A sync that would run once on, and ones stopped by their source or connection.
  expect(canSwitchSchedule(sync("s", "paused", { sourceEnabled: true }), manager)).toBe(true);
  expect(canSwitchSchedule(sync("s", "active", { sourceEnabled: false }), manager)).toBe(false);
  expect(canSwitchSchedule(sync("s", "paused", { sourceEnabled: false }), manager)).toBe(false);
  expect(canSwitchSchedule(sync("s", "active", { connectionPaused: true }), manager)).toBe(false);
  // A retired sync.
  const retired = {
    ...sync("r", "active", {}),
    agentConfig: {
      prompt: "",
      resources: [],
      metadata: {},
      knowledgeSource: { connection: { providerDomain: "api.atlassian.com" } },
    },
  } as unknown as ScheduledTask;
  expect(canSwitchSchedule(retired, manager)).toBe(false);
});

test("rows without a switch keep Pause in their menu; switched rows drop it", async () => {
  async function menuFor(task: ScheduledTask, pauseItem: boolean) {
    document.body.replaceChildren();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <ScheduleMenuItems
              task={task}
              access={manager}
              busy={false}
              pauseItem={pauseItem}
              onRunNow={() => undefined}
              onPause={() => undefined}
              onResume={() => undefined}
              onEdit={() => undefined}
              onDuplicate={() => undefined}
              onDelete={() => undefined}
            />
          </DropdownMenuContent>
        </DropdownMenu>,
      );
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    );
    await act(async () => root.unmount());
    return items;
  }
  const mine = schedule("a", "Mine", "active");
  expect(await menuFor(mine, !canSwitchSchedule(mine, manager))).toEqual([
    "Run now",
    "Edit",
    "Duplicate",
    "Delete",
  ]);
  const stopped = sync("s", "active", { sourceEnabled: false });
  expect(await menuFor(stopped, !canSwitchSchedule(stopped, manager))).toContain("Pause");
});

test("a list of others' schedules shows no switches", async () => {
  server = server.map((task) => ({ ...task, ownerSubjectId: "other" }));
  const container = await renderList();
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
});
