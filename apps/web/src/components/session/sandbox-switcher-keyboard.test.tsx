import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MachineView } from "@opengeni/react/machines";
import type { Root } from "react-dom/client";
import type { SessionRunsOn } from "./sandbox-switcher";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
mock.module("@/lib/use-workspace-rigs", () => ({ useWorkspaceRigs: () => ({ rigs: [] }) }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionRunsOnMenuBody } = await import("./sandbox-switcher");
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } =
  await import("@/components/ui/dropdown-menu");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
afterAll(() => GlobalRegistrator.unregister());

const machines = [
  {
    sandboxId: "home",
    name: "Modal",
    kind: "modal",
    isSessionGroup: true,
    state: "online",
    active: true,
  },
  {
    sandboxId: "offline",
    name: "Offline machine",
    kind: "selfhosted",
    state: "offline",
    active: false,
  },
  { sandboxId: "build", name: "Build machine", kind: "selfhosted", state: "online", active: false },
  {
    sandboxId: "headless",
    name: "Headless machine",
    kind: "selfhosted",
    state: "display_unavailable",
    active: false,
  },
] as MachineView[];

function runsOn(overrides: Partial<SessionRunsOn["fleet"]> = {}): SessionRunsOn {
  return {
    machines,
    activeMachine: machines[0]!,
    activeName: "Cloud sandbox",
    hasChoices: true,
    sandboxBackend: "modal",
    fleet: {
      canAttach: true,
      attaching: false,
      attachingSandboxId: null,
      attach: mock(async () => {}),
      ...overrides,
    } as SessionRunsOn["fleet"],
  };
}

async function press(key: string) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderMenu(value: SessionRunsOn) {
  await act(async () =>
    root.render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>More composer actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SessionRunsOnMenuBody runsOn={value} workspaceId="workspace" rigId={null} />
        </DropdownMenuContent>
      </DropdownMenu>,
    ),
  );
}

function row(name: string) {
  const result = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (item) => item.textContent?.includes(name),
  );
  if (!result) throw new Error(`No menu radio named ${name}`);
  return result;
}

test("existing chat machine choices participate in menu focus, skip offline, and stay open on selection", async () => {
  const value = runsOn();
  await renderMenu(value);
  expect(document.querySelectorAll('[role="radio"]')).toHaveLength(0);
  expect(document.activeElement).toBe(row("Cloud sandbox"));
  await press("Enter");
  expect(value.fleet.attach).not.toHaveBeenCalled();
  expect(row("Offline machine").hasAttribute("data-disabled")).toBe(true);
  await press("ArrowDown");
  expect(document.activeElement).toBe(row("Build machine"));
  await press("Enter");
  expect(value.fleet.attach).toHaveBeenCalledTimes(1);
  expect(value.fleet.attach).toHaveBeenCalledWith("build");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await press("ArrowDown");
  expect(document.activeElement).toBe(row("Headless machine"));
  await press(" ");
  expect(value.fleet.attach).toHaveBeenLastCalledWith("headless");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
});

test("pending swaps and missing attach permission keep every machine disabled", async () => {
  for (const overrides of [
    { attaching: true, attachingSandboxId: "build" },
    { canAttach: false },
  ]) {
    const value = runsOn(overrides);
    await renderMenu(value);
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(rows).toHaveLength(4);
    expect(rows.every((item) => item.hasAttribute("data-disabled"))).toBe(true);
    await act(async () => row("Build machine").click());
    expect(value.fleet.attach).not.toHaveBeenCalled();
  }
});

test("a session without an active box focuses the first available machine", async () => {
  const value = runsOn();
  value.activeMachine = null;
  value.activeName = "No sandbox";
  value.sandboxBackend = "none";
  value.machines = machines.slice(1);
  await renderMenu(value);
  expect(row("No sandbox").getAttribute("aria-checked")).toBe("true");
  expect(row("No sandbox").hasAttribute("data-disabled")).toBe(true);
  expect(document.activeElement).toBe(row("Build machine"));
});

test("dialog presentation retains plain Tab-reachable machine choices", async () => {
  const value = runsOn();
  await act(async () =>
    root.render(
      <SessionRunsOnMenuBody
        presentation="dialog"
        runsOn={value}
        workspaceId="workspace"
        rigId={null}
      />,
    ),
  );
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0);
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(rows).toHaveLength(4);
  expect(rows[2]!.tabIndex).toBe(0);
  expect(rows[1]!.disabled).toBe(true);
  await act(async () => rows[2]!.click());
  expect(value.fleet.attach).toHaveBeenCalledTimes(1);
  expect(value.fleet.attach).toHaveBeenCalledWith("build");
});
