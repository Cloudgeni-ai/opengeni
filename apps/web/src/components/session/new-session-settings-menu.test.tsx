import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  RunsOnMenuBody,
  RunsOnNotice,
  VisibilityMenuBody,
  checkedRigValue,
  hasRunsOnChoices,
  runsOnAttention,
  runsOnSummary,
} = await import("./new-session-settings-menu");
const { DropdownMenu, DropdownMenuContent } = await import("@/components/ui/dropdown-menu");
const { emptySessionDraft } = await import("@/lib/session-create");

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

/** Render a drill-in where it lives: inside the open "+" dropdown. */
async function renderInMenu(body: ReactNode) {
  await act(async () =>
    root.render(
      <DropdownMenu open>
        <DropdownMenuContent>{body}</DropdownMenuContent>
      </DropdownMenu>,
    ),
  );
}

function menuRadios() {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
}

function row(name: string) {
  const found = menuRadios().find((radio) => radio.textContent?.includes(name));
  if (!found) throw new Error(`No row named ${name}`);
  return found;
}

async function press(key: string) {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    // Radix moves roving focus on a timeout.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const machine = (name: string, state = "online") =>
  ({ sandboxId: `sandbox-${name}`, name, state, os: "linux", arch: "x86_64" }) as never;
const rig = (id: string, name: string) => ({ id, name, scope: "workspace" }) as never;

function choices(overrides: Record<string, unknown> = {}) {
  return {
    draft: emptySessionDraft(),
    machines: [machine("build-01"), machine("old", "offline")],
    rigs: [rig("rig-node", "Node 22")],
    workspaceDefaultRigId: "rig-node",
    selfhostedPrimary: false,
    fleetLoadFailed: false,
    selectedChannelId: null,
    selectionHistory: { projects: [] },
    ...overrides,
  } as Parameters<typeof runsOnSummary>[0];
}

test("Runs on shows only when there is something to choose", () => {
  expect(hasRunsOnChoices(choices())).toBe(true);
  expect(hasRunsOnChoices(choices({ machines: [], rigs: [] }))).toBe(false);
  expect(hasRunsOnChoices(choices({ machines: [], rigs: [], selfhostedPrimary: true }))).toBe(true);
});

test("the row value names the environment or the machine", () => {
  expect(runsOnSummary(choices())).toBe("Node 22");
  expect(runsOnSummary(choices({ workspaceDefaultRigId: null }))).toBe("Managed sandbox");
  const onMachine = {
    ...emptySessionDraft(),
    compute: { kind: "machine", sandboxId: "sandbox-build-01", folder: { kind: "root" } },
  };
  expect(runsOnSummary(choices({ draft: onMachine }))).toBe("build-01");
});

test("picking a machine goes through the explicit compute path; offline ones can't be picked", async () => {
  const onComputeChange = mock();
  await act(async () =>
    root.render(
      <RunsOnMenuBody
        {...choices()}
        presentation="dialog"
        disabled={false}
        onChange={() => {}}
        onComputeChange={onComputeChange}
        onRetryMachines={() => {}}
      />,
    ),
  );
  const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const build = radios.find((radio) => radio.textContent?.includes("build-01"))!;
  const old = radios.find((radio) => radio.textContent?.includes("old"))!;
  expect(old.disabled).toBe(true);
  await act(async () => build.click());
  expect(onComputeChange).toHaveBeenCalledTimes(1);
  expect(onComputeChange.mock.calls[0]![0].compute).toEqual({
    kind: "machine",
    sandboxId: "sandbox-build-01",
    folder: { kind: "root" },
  });
});

test("in the + menu, Runs on rows are menu radios that the keyboard reaches", async () => {
  const onComputeChange = mock();
  const onChange = mock();
  await renderInMenu(
    <RunsOnMenuBody
      {...choices()}
      disabled={false}
      onChange={onChange}
      onComputeChange={onComputeChange}
      onRetryMachines={() => {}}
    />,
  );
  expect(document.querySelectorAll('[role="radio"]')).toHaveLength(0);
  // Focus lands on the checked row, so arrow keys work at once.
  expect(row("Managed sandbox").getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(row("Managed sandbox"));
  expect(row("old").hasAttribute("data-disabled")).toBe(true);

  await press("ArrowDown");
  expect(document.activeElement).toBe(row("build-01"));
  // The offline machine is skipped on the way to the environment rows.
  await press("ArrowDown");
  expect(document.activeElement).toBe(row("Workspace default"));

  await press("ArrowUp");
  await press("Enter");
  expect(onComputeChange).toHaveBeenCalledTimes(1);
  expect(onComputeChange.mock.calls[0]![0].compute).toEqual({
    kind: "machine",
    sandboxId: "sandbox-build-01",
    folder: { kind: "root" },
  });
  // Choosing keeps the menu open for the folder or environment below.
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
});

test("a draft naming the workspace default environment checks Workspace default", async () => {
  const draft = { ...emptySessionDraft(), rigId: "rig-node" };
  expect(checkedRigValue(draft, "rig-node")).toBe("");
  expect(checkedRigValue(draft, "rig-other")).toBe("rig-node");
  expect(checkedRigValue(emptySessionDraft(), "rig-node")).toBe("");

  await renderInMenu(
    <RunsOnMenuBody
      {...choices({ draft, rigs: [rig("rig-node", "Node 22"), rig("rig-py", "Python")] })}
      disabled={false}
      onChange={() => {}}
      onComputeChange={() => {}}
      onRetryMachines={() => {}}
    />,
  );
  const checked = menuRadios().filter((radio) => radio.getAttribute("aria-checked") === "true");
  expect(checked.map((radio) => radio.textContent)).toEqual([
    expect.stringContaining("Managed sandbox"),
    expect.stringContaining("Workspace default: Node 22"),
  ]);
});

test("a failed machine load offers a retry the keyboard reaches", async () => {
  const onRetryMachines = mock();
  await renderInMenu(
    <RunsOnMenuBody
      {...choices({ machines: [], fleetLoadFailed: true })}
      disabled={false}
      onChange={() => {}}
      onComputeChange={() => {}}
      onRetryMachines={onRetryMachines}
    />,
  );
  const retry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Try again",
  )!;
  expect(retry).toBeDefined();
  await act(async () => retry.focus());
  await press("Enter");
  expect(onRetryMachines).toHaveBeenCalledTimes(1);
});

test("in the + menu, Visibility rows are menu radios with the value focused", async () => {
  const onChange = mock();
  await renderInMenu(<VisibilityMenuBody value="private" disabled={false} onChange={onChange} />);
  expect(document.querySelectorAll('[role="radio"]')).toHaveLength(0);
  expect(row("Only me").getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(row("Only me"));
  await press("ArrowUp");
  expect(document.activeElement).toBe(row("Workspace"));
  await press("Enter");
  expect(onChange).toHaveBeenCalledWith("workspace");
});

test("Send waiting on Runs on is explained under the composer", async () => {
  const onMachine = (sandboxId: string | null) => ({
    ...emptySessionDraft(),
    compute: { kind: "machine" as const, sandboxId, folder: { kind: "root" as const } },
  });
  const base = { machines: [], fleetLoadFailed: false, fleetLoading: false };
  expect(runsOnAttention({ ...base, draft: emptySessionDraft() })).toBeNull();
  expect(runsOnAttention({ ...base, draft: onMachine(null) })).toBe("connect-machine");
  expect(runsOnAttention({ ...base, draft: onMachine(null), fleetLoading: true })).toBeNull();
  expect(
    runsOnAttention({ ...base, draft: onMachine(null), machines: [machine("build-01")] }),
  ).toBe("pick-machine");
  expect(
    runsOnAttention({
      ...base,
      draft: onMachine("sandbox-build-01"),
      machines: [machine("build-01")],
    }),
  ).toBeNull();
  expect(runsOnAttention({ ...base, draft: emptySessionDraft(), fleetLoadFailed: true })).toBe(
    "fleet-load-failed",
  );

  const onRetryMachines = mock();
  await act(async () =>
    root.render(
      <RunsOnNotice
        attention="fleet-load-failed"
        machines={[]}
        onRetryMachines={onRetryMachines}
      />,
    ),
  );
  expect(container.textContent).toContain("Couldn't load your connected machines.");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(onRetryMachines).toHaveBeenCalledTimes(1);

  await act(async () =>
    root.render(
      <RunsOnNotice
        attention="pick-machine"
        machines={[machine("build-01")]}
        onRetryMachines={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("Pick a machine under + > Runs on to send.");

  await act(async () =>
    root.render(
      <RunsOnNotice
        attention="pick-machine"
        machines={[machine("old", "offline")]}
        onRetryMachines={() => {}}
      />,
    ),
  );
  expect(container.textContent).toContain("offline");
  expect(container.textContent).toContain("+ > Runs on");

  await act(async () =>
    root.render(
      <RunsOnNotice
        attention="connect-machine"
        machines={[]}
        onRetryMachines={() => {}}
        connectAction={<a href="/machines">Connect a machine</a>}
      />,
    ),
  );
  expect(container.textContent).toContain("Connect one to send.");
  expect(container.querySelector("a")?.textContent).toBe("Connect a machine");
});
