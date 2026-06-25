/* ----------------------------------------------------------------------------
   M9 useMachines hook: loads the workspace fleet from the structural
   MachinesClientLike surface (M10's endpoint), exposes the active pointer, and
   attaches/swaps the session's active sandbox + refetches. Dual-consumer safe —
   it reads only the structural client, so an adapter works in any frontend.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { useMachines, type MachinesClientLike } from "../src/hooks/use-machines";
import type { MachinesResponse, MachineView } from "../src/types/machines";

registerDom();

const client = fakeClient({});

function machine(overrides: Partial<MachineView> & Pick<MachineView, "sandboxId">): MachineView {
  return {
    enrollmentId: "enr-" + overrides.sandboxId,
    name: "m",
    kind: "selfhosted",
    state: "online",
    active: false,
    isSessionGroup: false,
    os: "linux",
    arch: "x86_64",
    hasDisplay: true,
    allowScreenControl: true,
    sharedSessionCount: 1,
    lastSeenAt: null,
    metrics: null,
    ...overrides,
  };
}

const response: MachinesResponse = {
  activeSandboxId: "modal-box",
  activeEpoch: 3,
  machines: [
    machine({ sandboxId: "modal-box", kind: "modal", isSessionGroup: true, active: true }),
    machine({ sandboxId: "sh-1" }),
  ],
};

describe("useMachines", () => {
  test("loads the fleet + active pointer from the structural client", async () => {
    const machinesClient: MachinesClientLike = {
      listMachines: async () => response,
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient }),
      undefined,
    );
    await flush();
    expect(hook.result.current.machines.length).toBe(2);
    expect(hook.result.current.activeSandboxId).toBe("modal-box");
    expect(hook.result.current.activeEpoch).toBe(3);
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
  });

  test("attach swaps the active sandbox + refetches", async () => {
    const attachedTo: string[] = [];
    let current = response;
    const machinesClient: MachinesClientLike = {
      listMachines: async () => current,
      attachMachine: async (_ws, sandboxId) => {
        attachedTo.push(sandboxId);
        current = { ...response, activeSandboxId: sandboxId, activeEpoch: 4 };
        return { activeSandboxId: sandboxId, activeEpoch: 4 };
      },
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient }),
      undefined,
    );
    await flush();
    const ok = await hook.result.current.attach("sh-1");
    await flush();
    expect(ok).toBe(true);
    expect(attachedTo).toEqual(["sh-1"]);
    expect(hook.result.current.activeSandboxId).toBe("sh-1");
    await hook.unmount();
  });

  test("fetchSeries returns the downsampled samples", async () => {
    const machinesClient: MachinesClientLike = {
      listMachines: async () => response,
      machineMetricsSeries: async () => [
        {
          cpuPct: 12,
          load1: 0.3,
          load5: 0.2,
          load15: 0.1,
          memUsedBytes: 1,
          memTotalBytes: 2,
          diskUsedBytes: 1,
          diskTotalBytes: 2,
          gpuUtilPct: null,
          gpuMemBytes: null,
          runQueue: 0,
          sampledAt: "2026-06-26T09:00:00.000Z",
        },
      ],
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient }),
      undefined,
    );
    await flush();
    const samples = await hook.result.current.fetchSeries("enr-sh-1", "1h");
    expect(samples.length).toBe(1);
    expect(samples[0]?.cpuPct).toBe(12);
    await hook.unmount();
  });

  test("a load error is surfaced", async () => {
    const machinesClient: MachinesClientLike = {
      listMachines: async () => {
        throw new Error("nats down");
      },
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient }),
      undefined,
    );
    await flush();
    expect(hook.result.current.error?.message).toBe("nats down");
    expect(hook.result.current.machines.length).toBe(0);
    await hook.unmount();
  });
});
