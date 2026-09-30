import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RunsOnMenuBody, hasRunsOnChoices, runsOnSummary } =
  await import("./new-session-settings-menu");
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
});

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
