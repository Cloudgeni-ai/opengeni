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

  test("a session switch aborts the old list and renders zero frames of its fleet", async () => {
    let oldSignal: AbortSignal | undefined;
    let oldCalls = 0;
    const machinesClient: MachinesClientLike = {
      listMachines: async (_workspaceId, options) => {
        if (options?.sessionId === "sess-1") {
          oldCalls += 1;
          if (oldCalls === 1) return response;
          oldSignal = options.signal;
          return await new Promise<MachinesResponse>(() => {});
        }
        return await new Promise<MachinesResponse>(() => {});
      },
    };
    const observations: Array<{ sessionId: string; activeSandboxId: string | null }> = [];
    const hook = await renderHook(
      (props: { sessionId: string }) => {
        const result = useMachines({
          client,
          workspaceId: WORKSPACE_ID,
          machinesClient,
          sessionId: props.sessionId,
          pollIntervalMs: 20,
        });
        observations.push({
          sessionId: props.sessionId,
          activeSandboxId: result.activeSandboxId,
        });
        return result;
      },
      { sessionId: "sess-1" },
    );
    await flush(50);
    expect(hook.result.current.activeSandboxId).toBe("modal-box");
    expect(oldSignal?.aborted).toBe(false);
    observations.length = 0;

    await hook.rerender({ sessionId: "sess-2" });

    expect(oldSignal?.aborted).toBe(true);
    expect(
      observations.some(
        (observation) =>
          observation.sessionId === "sess-2" && observation.activeSandboxId === "modal-box",
      ),
    ).toBe(false);
    expect(hook.result.current.activeSandboxId).toBeNull();
    await hook.unmount();
  });

  test("a late attach settlement from the old session cannot clear the new session spinner", async () => {
    let resolveOld: () => void = () => {};
    let resolveNew: () => void = () => {};
    const oldSwap = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    const newSwap = new Promise<void>((resolve) => {
      resolveNew = resolve;
    });
    const machinesClient: MachinesClientLike = {
      listMachines: async () => response,
      swapActiveSandbox: async (_workspaceId, sessionId) =>
        await (sessionId === "sess-1" ? oldSwap : newSwap),
    };
    const hook = await renderHook(
      (props: { sessionId: string }) =>
        useMachines({
          client,
          workspaceId: WORKSPACE_ID,
          machinesClient,
          sessionId: props.sessionId,
        }),
      { sessionId: "sess-1" },
    );
    await flush();
    let oldAttach!: Promise<boolean>;
    await actRun(() => {
      oldAttach = hook.result.current.attach("old-box");
    });
    await flush();
    expect(hook.result.current.attachingSandboxId).toBe("old-box");

    await hook.rerender({ sessionId: "sess-2" });
    let newAttach!: Promise<boolean>;
    await actRun(() => {
      newAttach = hook.result.current.attach("new-box");
    });
    await flush();
    expect(hook.result.current.attachingSandboxId).toBe("new-box");

    await actRun(async () => {
      resolveOld();
      await oldAttach;
    });
    await flush();
    expect(hook.result.current.attaching).toBe(true);
    expect(hook.result.current.attachingSandboxId).toBe("new-box");
    expect(hook.result.current.mutationError).toBeNull();

    await actRun(async () => {
      resolveNew();
      await newAttach;
    });
    await flush();
    expect(hook.result.current.attaching).toBe(false);
    expect(hook.result.current.attachingSandboxId).toBeNull();
    await hook.unmount();
  });
});
