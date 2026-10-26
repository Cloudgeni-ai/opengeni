import { expect, mock, test } from "bun:test";

let permissions: string[] = [];
let grantShape: Record<string, unknown> = {};
let credential: unknown;
let machineEnabled: boolean | undefined;
let rigsEnabled: boolean | undefined;
const action = mock(async () => null);
const refresh = mock(async () => {});
const attach = mock(async () => true);
let fleetMachines: Array<Record<string, unknown>> = [{ sandboxId: "machine" }];
const machine = fleetMachines[0]!;
mock.module("../app-context", () => ({
  useAppContext: () => ({
    accessContext: {
      workspaceGrants: [{ workspaceId: "workspace", permissions, ...grantShape }],
      ...(credential ? { credential } : {}),
    },
  }),
}));
mock.module("../../session-context", () => ({
  useOpenGeni: () => ({ workspaceId: "workspace" }),
}));
mock.module("../../hooks/use-rigs", () => ({
  useRigs: (options: { enabled?: boolean | undefined }) => {
    rigsEnabled = options.enabled;
    return { rigs: [{ id: "rig" }], loading: false, error: null, refresh };
  },
}));
mock.module("../../machines", () => ({
  useMachines: (options: { enabled?: boolean | undefined }) => {
    machineEnabled = options.enabled;
    return {
      machines: fleetMachines,
      activeSandboxId: "machine",
      loading: false,
      error: null,
      refresh,
      canRemove: true,
      canUpdateAgent: true,
      canUpdateOperationPolicy: true,
      canAttach: true,
      remove: action,
      updateAgent: action,
      updateOperationPolicy: action,
      attach,
      fetchSeries: action,
      mutationError: null,
    };
  },
}));
const { useWorkspaceMachines } = await import("./use-workspace-machines");
const { useWorkspaceRigs } = await import("./use-workspace-rigs");

test("denied resource reads and manual retries remain request-free, including after revocation", async () => {
  permissions = ["workspace:admin"];
  expect(useWorkspaceMachines().machines.map((item) => item.sandboxId)).toEqual([
    machine.sandboxId,
  ]);
  expect(useWorkspaceRigs().rigs).toHaveLength(1);
  permissions = [];
  const machines = useWorkspaceMachines();
  const rigs = useWorkspaceRigs();
  expect(useWorkspaceMachines().fetchSeries).toBe(machines.fetchSeries);
  expect(useWorkspaceMachines().machines).toBe(machines.machines);
  expect(useWorkspaceMachines().refresh).toBe(machines.refresh);
  expect(useWorkspaceRigs().rigs).toBe(rigs.rigs);
  expect(useWorkspaceRigs().refresh).toBe(rigs.refresh);
  expect(machineEnabled).toBe(false);
  expect(rigsEnabled).toBe(false);
  expect(machines.machines).toEqual([]);
  expect(rigs.rigs).toEqual([]);
  await machines.refresh();
  await rigs.refresh();
  expect(refresh).not.toHaveBeenCalled();
  expect(await machines.attach("machine")).toBe(false);
  expect(attach).not.toHaveBeenCalled();
});

test("machine readers cannot manage machines; controls recover with exact grants", async () => {
  permissions = ["enrollments:read"];
  let machines = useWorkspaceMachines();
  expect(machineEnabled).toBe(true);
  expect(machines.machines.map((item) => item.sandboxId)).toEqual([machine.sandboxId]);
  expect(machines.canManage).toBe(false);
  expect(machines.canRemove).toBe(false);
  expect(machines.canUpdateAgent).toBe(false);
  expect(machines.canUpdateOperationPolicy).toBe(false);
  expect(machines.canAttach).toBe(false);
  await machines.remove("machine");
  await machines.updateAgent("machine");
  await machines.updateOperationPolicy("machine", {} as never);
  expect(action).not.toHaveBeenCalled();
  permissions = ["enrollments:read", "enrollments:manage", "sessions:control", "rigs:use"];
  machines = useWorkspaceMachines();
  expect(machines.canManage).toBe(true);
  expect(machines.canRemove).toBe(true);
  expect(machines.canAttach).toBe(true);
  await machines.remove("machine");
  await useWorkspaceRigs().refresh();
  expect(action).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(rigsEnabled).toBe(true);
  useWorkspaceRigs({ enabled: false });
  expect(rigsEnabled).toBe(false);
});

test("a signed-in Member connects and changes only their own Only me machines", async () => {
  action.mockClear();
  const own = { sandboxId: "own", enrollmentId: "own", scope: "user" };
  const shared = { sandboxId: "shared", enrollmentId: "shared", scope: "workspace" };
  fleetMachines = [own, shared];
  permissions = ["enrollments:read", "sessions:read"];
  grantShape = { principalKind: "human_session" };
  let machines = useWorkspaceMachines();
  expect(machines.canManage).toBe(false);
  expect(machines.canConnect).toBe(true);
  expect(machines.canManageMachine(own as never)).toBe(true);
  expect(machines.canManageMachine(shared as never)).toBe(false);
  await machines.updateOperationPolicy("shared", {} as never);
  await machines.remove("shared");
  expect(action).not.toHaveBeenCalled();
  await machines.updateOperationPolicy("own", {} as never);
  await machines.remove("own");
  expect(action).toHaveBeenCalledTimes(2);

  for (const shape of [
    { grant: { principalKind: "human_session", metadata: { delegated: true } } },
    { grant: { principalKind: "human_session", serviceInitiator: { kind: "service" } } },
    { grant: { principalKind: "api_key" } },
    { grant: { principalKind: "human_session" }, credential: { kind: "api_key" } },
  ]) {
    grantShape = shape.grant;
    credential = shape.credential;
    machines = useWorkspaceMachines();
    expect(machines.canConnect).toBe(false);
    expect(machines.canManageMachine(own as never)).toBe(false);
    await machines.remove("own");
  }
  expect(action).toHaveBeenCalledTimes(2);
  grantShape = {};
  credential = undefined;
  fleetMachines = [machine];
});
