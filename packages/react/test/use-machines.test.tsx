/* ----------------------------------------------------------------------------
   M9 useMachines hook: loads the workspace fleet from the structural
   MachinesClientLike surface (M10's endpoint), exposes the active pointer, and
   attaches/swaps the session's active sandbox + refetches. Dual-consumer safe —
   it reads only the structural client, so an adapter works in any frontend.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { actRun, registerDom, renderHook, flush } from "./render-hook";
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

  test("attach swaps via the default swapActiveSandbox path (session-scoped) + refetches", async () => {
    const swappedTo: Array<{ sessionId: string; target: string }> = [];
    let current = response;
    const machinesClient: MachinesClientLike = {
      listMachines: async () => current,
      swapActiveSandbox: async (_ws, sessionId, request) => {
        swappedTo.push({ sessionId, target: request.target });
        current = { ...response, activeSandboxId: request.target, activeEpoch: 4 };
        return { swapped: true, activeSandboxId: request.target, activeEpoch: 4 };
      },
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient, sessionId: "sess-1" }),
      undefined,
    );
    await flush();
    expect(hook.result.current.canAttach).toBe(true);
    const ok = await actRun(() => hook.result.current.attach("sh-1"));
    await flush();
    expect(ok).toBe(true);
    expect(swappedTo).toEqual([{ sessionId: "sess-1", target: "sh-1" }]);
    expect(hook.result.current.activeSandboxId).toBe("sh-1");
    await hook.unmount();
  });

  test("a host-supplied attachMachine adapter wins over swapActiveSandbox", async () => {
    const attachedTo: Array<{ sessionId: string; sandboxId: string }> = [];
    let current = response;
    const machinesClient: MachinesClientLike = {
      listMachines: async () => current,
      attachMachine: async (_ws, sessionId, sandboxId) => {
        attachedTo.push({ sessionId, sandboxId });
        current = { ...response, activeSandboxId: sandboxId, activeEpoch: 5 };
        return { activeSandboxId: sandboxId, activeEpoch: 5 };
      },
      swapActiveSandbox: async () => {
        throw new Error("should not be called when an adapter is supplied");
      },
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient, sessionId: "sess-2" }),
      undefined,
    );
    await flush();
    const ok = await actRun(() => hook.result.current.attach("sh-1"));
    await flush();
    expect(ok).toBe(true);
    expect(attachedTo).toEqual([{ sessionId: "sess-2", sandboxId: "sh-1" }]);
    await hook.unmount();
  });

  test("canAttach is false without a sessionId (the swap is session-scoped)", async () => {
    const machinesClient: MachinesClientLike = {
      listMachines: async () => response,
      swapActiveSandbox: async () => ({ swapped: true, activeSandboxId: "sh-1", activeEpoch: 4 }),
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient }),
      undefined,
    );
    await flush();
    expect(hook.result.current.canAttach).toBe(false);
    const ok = await actRun(() => hook.result.current.attach("sh-1"));
    expect(ok).toBe(false);
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

  test("revoke permanently unenrolls through the SDK surface and refreshes", async () => {
    const revoked: string[] = [];
    let current = response;
    const machinesClient: MachinesClientLike = {
      listMachines: async () => current,
      revokeEnrollment: async (_workspaceId, enrollmentId) => {
        revoked.push(enrollmentId);
        current = {
          ...response,
          machines: response.machines.filter((item) => item.enrollmentId !== enrollmentId),
        };
        return { revoked: false }; // lost-response retry: already terminal is success
      },
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient }),
      undefined,
    );
    await flush();
    expect(hook.result.current.canRevoke).toBe(true);
    const ok = await actRun(() => hook.result.current.revoke("enr-sh-1"));
    await flush();
    expect(ok).toBe(true);
    expect(revoked).toEqual(["enr-sh-1"]);
    expect(hook.result.current.machines.some((item) => item.enrollmentId === "enr-sh-1")).toBe(
      false,
    );
    await hook.unmount();
  });

  test("a revoke failure resets its spinner without reporting attach progress", async () => {
    const machinesClient: MachinesClientLike = {
      listMachines: async () => response,
      revokeEnrollment: async () => {
        throw new Error("revoke unavailable");
      },
    };
    const hook = await renderHook(
      () => useMachines({ client, workspaceId: WORKSPACE_ID, machinesClient }),
      undefined,
    );
    await flush();

    const ok = await actRun(() => hook.result.current.revoke("enr-sh-1"));
    await flush();

    expect(ok).toBe(false);
    expect(hook.result.current.revokingEnrollmentId).toBeNull();
    expect(hook.result.current.attaching).toBe(false);
    expect(hook.result.current.attachingSandboxId).toBeNull();
    expect(hook.result.current.mutationError?.message).toBe("revoke unavailable");
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
