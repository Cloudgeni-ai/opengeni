import { expect, test } from "bun:test";
import { acquireSharedTestDatabase, testSettings } from "@opengeni/testing";
import { initialSandboxMachine } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  findSandboxMachine,
  type SandboxMachineInventoryItem,
} from "@opengeni/db";
import { withRlsContext } from "../../../packages/db/src/database";
import { insertSandboxMachineInTransaction } from "../../../packages/db/src/sandbox-v2-machines";
import { createSandboxV2MachineStore } from "@opengeni/core";
import { MachineController, type MachineBackend } from "@opengeni/runtime/sandbox";
import { createSandboxV2ControlActivities } from "../src/activities/sandbox-v2";
import type { ControlActivityServices } from "../src/activities/types";
import type { SandboxV2ControlProviders } from "../src/sandbox-v2-control";

test("control worker preserves retained ownership across flags, lost replies and concurrent sweeps", async () => {
  const fixture = await acquireSharedTestDatabase("sandbox-v2-worker-control");
  if (!fixture) throw Error("Machine control requires disposable PostgreSQL");
  const client = createDb(fixture.appUrl);
  try {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Synthetic control",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Synthetic control",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const scope = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sandboxGroupId: crypto.randomUUID(),
    };
    const id = crypto.randomUUID();
    await withRlsContext(client.db, scope, (tx) =>
      insertSandboxMachineInTransaction(
        tx,
        scope.accountId,
        initialSandboxMachine(scope, "docker", id),
      ),
    );
    const target: SandboxMachineInventoryItem = { ...scope, machineId: id, provider: "docker" };
    let dispatches = 0;
    let created = false;
    let physicalCalls = 0;
    const backend: MachineBackend = {
      provider: "docker",
      dispatch: async () => {
        dispatches++;
        created = true;
        return { outcome: "unknown" };
      },
      reconcile: async (machine, transition) =>
        created
          ? {
              outcome: "settled",
              transitionId: transition.id,
              state: "running",
              disk: { syntheticDisk: id },
              instance: { id: `instance-${id}`, bootId: "synthetic-boot", diskLineage: machine.id },
            }
          : { outcome: "unknown" },
    };
    const store = createSandboxV2MachineStore(client.db, scope.accountId);
    await new MachineController(store, backend, 1000).acquire(scope, {
      id: "synthetic-owner",
      owner: "synthetic-session",
      kind: "file",
      authority: "synthetic-read",
    });
    function worker(providers?: SandboxV2ControlProviders) {
      return createSandboxV2ControlActivities(
        async () =>
          ({
            db: client.db,
            settings: testSettings({ sandboxV2Enabled: false }),
            ...(providers ? { sandboxV2ControlProviders: providers } : {}),
          }) as ControlActivityServices,
      );
    }
    expect((await worker().listSandboxV2Machines()).items).toContainEqual(target);
    expect((await worker().reconcileSandboxV2Machine(target)).status).toBe("deferred");
    expect(dispatches).toBe(0);
    const providers: SandboxV2ControlProviders = new Map([
      [
        "docker",
        {
          backend,
          transport: {
            exec: async () => {
              physicalCalls++;
              throw Error("No synthetic command");
            },
          },
        },
      ],
    ]);
    const control = worker(providers);
    expect(
      (await control.reconcileSandboxV2Machine({ ...target, provider: "another-provider" })).status,
    ).toBe("deferred");
    expect(
      (await control.reconcileSandboxV2Machine({ ...target, accountId: crypto.randomUUID() }))
        .status,
    ).toBe("deferred");
    expect(dispatches).toBe(0);
    await Promise.all(
      Array.from({ length: 8 }, () => worker(providers).reconcileSandboxV2Machine(target)),
    );
    expect(dispatches).toBe(1);
    expect((await findSandboxMachine(client.db, scope))!.state).toBe("running");
    expect((await findSandboxMachine(client.db, scope))!.demands).toHaveLength(1);
    expect(physicalCalls).toBe(0);
    expect((await control.reconcileSandboxV2Machine(target)).status).toBe("reconciled");
    expect(dispatches).toBe(1);
  } finally {
    await client.close();
    await fixture.release();
  }
}, 180_000);
