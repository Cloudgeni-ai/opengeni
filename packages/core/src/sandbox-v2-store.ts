import { compareAndSetSandboxMachine, findSandboxMachine, type Database } from "@opengeni/db";
import { MachineConflictError, type MachineStore } from "@opengeni/runtime/sandbox";

/** Account identity comes from boot/session authority, never from a guest command
 * or provider ID. SQL retains the workspace/group and version CAS under FORCE RLS. */
export function createSandboxV2MachineStore(db: Database, accountId: string): MachineStore {
  return {
    load: async (scope) => {
      const machine = await findSandboxMachine(db, {
        accountId,
        workspaceId: scope.workspaceId,
        sandboxGroupId: scope.sandboxGroupId,
      });
      if (!machine) throw new MachineConflictError("No admitted machine in this sandbox group");
      return machine;
    },
    compareAndSet: (previous, next) => compareAndSetSandboxMachine(db, accountId, previous, next),
  };
}
