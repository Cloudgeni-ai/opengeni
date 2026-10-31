import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionSetupStrip, runsOnSetupIcon, visibilitySetupIcon } =
  await import("./new-session-setup-strip");
const { RunsOnMenuBody, VisibilityMenuBody, runsOnSummary, visibilitySummary } =
  await import("./new-session-settings-menu");
const { emptySessionDraft } = await import("../../lib/session-create");

afterAll(() => GlobalRegistrator.unregister());
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

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const machine = (name: string) =>
  ({ sandboxId: `sandbox-${name}`, name, state: "online", os: "linux", arch: "x86_64" }) as never;
const rig = (id: string, name: string) => ({ id, name, scope: "workspace" }) as never;

function runsOnChoices() {
  return {
    draft: emptySessionDraft(),
    machines: [machine("build-01")],
    rigs: [rig("rig-node", "Node 22"), rig("rig-py", "Python 3.13")],
    workspaceDefaultRigId: "rig-node",
    selfhostedPrimary: false,
    fleetLoadFailed: false,
    selectedChannelId: null,
    selectionHistory: { projects: [] },
  } as Parameters<typeof runsOnSummary>[0];
}

function chip(name: string) {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label^="${name}:"]`);
  if (!found) throw new Error(`No ${name} chip`);
  return found;
}

async function open(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
    await settle(10);
  });
}

function menuRow(name: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes(name),
  );
  if (!found) throw new Error(`No row named ${name}`);
  return found;
}

function setup(props: {
  project?: boolean;
  onVisibility?: (value: "private" | "workspace") => void;
  onRig?: (rigId: string) => void;
  disabled?: boolean;
}) {
  const choices = runsOnChoices();
  return (
    <SessionSetupStrip
      disabled={props.disabled === true}
      project={
        props.project === false
          ? null
          : {
              channels: [],
              selectedChannelId: null,
              onChange: () => {},
              onCreate: () => {},
            }
      }
      runsOn={{
        label: "Runs on",
        summary: runsOnSummary(choices),
        icon: runsOnSetupIcon(choices),
        disabled: props.disabled === true,
        renderMenu: () => (
          <RunsOnMenuBody
            {...choices}
            disabled={props.disabled === true}
            onChange={(draft) => props.onRig?.(draft.rigId)}
            onComputeChange={() => {}}
            onRetryMachines={() => {}}
          />
        ),
      }}
      visibility={{
        label: "Visibility",
        summary: visibilitySummary("workspace"),
        icon: visibilitySetupIcon("workspace"),
        disabled: props.disabled === true,
        renderMenu: (close) => (
          <VisibilityMenuBody
            value="workspace"
            disabled={props.disabled === true}
            onChange={(value) => {
              props.onVisibility?.(value);
              close();
            }}
          />
        ),
      }}
    />
  );
}

test("the strip shows project, Runs on and Visibility as chips, in that order", async () => {
  await act(async () => root.render(setup({})));
  const group = container.querySelector('[role="group"][aria-label="New chat setup"]')!;
  const names = [...group.querySelectorAll("button")].map((button) =>
    button.getAttribute("aria-label"),
  );
  expect(names).toEqual(["Project: Default", "Runs on: Node 22", "Visibility: Workspace"]);
  // The value is the visible text; the setting's name is the tooltip and accessible name.
  expect(chip("Runs on").textContent).toBe("Node 22");
  expect(chip("Runs on").title).toBe("Runs on");
  expect(chip("Visibility").textContent).toBe("Workspace");
});

test("without a project chip the strip still offers where it runs and who can see it", async () => {
  await act(async () => root.render(setup({ project: false })));
  expect(container.querySelector('[aria-label^="Project:"]')).toBeNull();
  expect(chip("Runs on")).toBeTruthy();
  expect(chip("Visibility")).toBeTruthy();
});

test("Visibility opens its choices from the chip and closes after a choice", async () => {
  const onVisibility = mock((_value: "private" | "workspace") => {});
  await act(async () => root.render(setup({ onVisibility })));
  await open(chip("Visibility"));
  expect(chip("Visibility").getAttribute("aria-expanded")).toBe("true");
  expect(document.body.textContent).toContain("Who can see this chat");
  // Focus starts on the current value, so arrow keys work at once.
  expect(document.activeElement).toBe(menuRow("Workspace"));
  await act(async () => {
    menuRow("Only me").click();
    await settle(10);
  });
  expect(onVisibility).toHaveBeenCalledWith("private");
  expect(chip("Visibility").getAttribute("aria-expanded")).toBe("false");
});

test("Runs on opens its environments from the chip and stays open to refine", async () => {
  const onRig = mock((_rigId: string) => {});
  await act(async () => root.render(setup({ onRig })));
  await open(chip("Runs on"));
  expect(document.body.textContent).toContain("Sandbox environment");
  await act(async () => {
    menuRow("Python 3.13").click();
    await settle(10);
  });
  expect(onRig).toHaveBeenCalledWith("rig-py");
  // A machine choice reveals its folder choice, so the menu stays open.
  expect(chip("Runs on").getAttribute("aria-expanded")).toBe("true");
});

test("busy setup disables every chip", async () => {
  await act(async () => root.render(setup({ disabled: true })));
  for (const button of container.querySelectorAll("button")) {
    expect(button.disabled).toBe(true);
  }
});
