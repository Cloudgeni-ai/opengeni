import { expect, mock, test } from "bun:test";

let permissions: string[] = [];
let machineEnabled: boolean | undefined;
let rigsEnabled: boolean | undefined;
const action = mock(async () => null);
const refresh = mock(async () => {});
const attach = mock(async () => true);
const machine = { sandboxId: "machine" };
mock.module("@/context", () => ({
  useAppContext: () => ({
    accessContext: { workspaceGrants: [{ workspaceId: "workspace", permissions }] },
  }),
}));
mock.module("@opengeni/react", () => ({
  useOpenGeni: () => ({ workspaceId: "workspace" }),
  useRigs: (options: { enabled?: boolean }) => {
    rigsEnabled = options.enabled;
    return { rigs: [{ id: "rig" }], loading: false, error: null, refresh };
  },
}));
mock.module("@opengeni/react/machines", () => ({
  useMachines: (options: { enabled?: boolean }) => {
    machineEnabled = options.enabled;
    return {
      machines: [machine],
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
