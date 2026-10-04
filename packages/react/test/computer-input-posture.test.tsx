import { expect, test } from "bun:test";
import type { ComputerSessionInputPosture } from "@opengeni/sdk/interaction";
import { useLayoutEffect } from "react";
import { useComputerInputPosture } from "../src/hooks/use-computer-input-posture";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();
const computerSessionId = "44444444-4444-4444-8444-444444444444";

test("a replacement client revokes app input in layout before its posture request settles", async () => {
  const controllerGeneration = "controller-1";
  const oldClient = fakeClient({
    getComputerInputPosture: async () => ({
      computerSessionId,
      controllerGeneration,
      inputAllowed: true,
    }),
  });
  let resolveNew!: (value: ComputerSessionInputPosture) => void;
  const newClient = fakeClient({
    getComputerInputPosture: async () =>
      await new Promise<ComputerSessionInputPosture>((resolve) => {
        resolveNew = resolve;
      }),
  });
  const layoutPostures: { inputAllowed: boolean | null; pending: boolean; error: Error | null }[] =
    [];
  const options = (client: typeof oldClient) => ({
    client,
    workspaceId: WORKSPACE_ID,
    computerSessionId,
    controllerGeneration,
    enabled: true,
  });
  const rendered = await renderHook((props: ReturnType<typeof options>) => {
    const posture = useComputerInputPosture(props);
    useLayoutEffect(() => {
      layoutPostures.push({
        inputAllowed: posture.inputAllowed,
        pending: posture.pending,
        error: posture.error,
      });
    });
    return posture;
  }, options(oldClient));
  try {
    await flush();
    expect(rendered.result.current.inputAllowed).toBe(true);
    await rendered.rerenderThroughLayout(options(newClient));
    expect(layoutPostures.at(-1)).toEqual({ inputAllowed: null, pending: true, error: null });
    await flush();
    await actRun(() =>
      resolveNew({ computerSessionId, controllerGeneration, inputAllowed: false }),
    );
    expect(rendered.result.current.inputAllowed).toBe(false);
    expect(rendered.result.current.pending).toBe(false);
  } finally {
    await rendered.unmount();
  }
});

for (const transition of ["client", "workspace", "computer", "controller", "enabled"] as const) {
  test(`a ${transition} round trip requires fresh app posture before paint`, async () => {
    type Pending = {
      computerSessionId: string;
      controllerGeneration: string;
      signal: AbortSignal;
      resolve: (value: ComputerSessionInputPosture) => void;
    };
    const pending: Pending[] = [];
    let currentGeneration = "controller-1";
    const getComputerInputPosture = async (
      _workspace: string,
      resource: string,
      requestOptions?: { signal?: AbortSignal },
    ) =>
      await new Promise<ComputerSessionInputPosture>((resolve) => {
        pending.push({
          computerSessionId: resource,
          controllerGeneration: currentGeneration,
          signal: requestOptions!.signal!,
          resolve,
        });
      });
    const client = fakeClient({ getComputerInputPosture });
    const replacement = fakeClient({ getComputerInputPosture });
    const original = {
      client,
      workspaceId: WORKSPACE_ID,
      computerSessionId,
      controllerGeneration: currentGeneration,
      enabled: true,
    };
    const changed = {
      ...original,
      ...(transition === "client" ? { client: replacement } : {}),
      ...(transition === "workspace"
        ? { workspaceId: "55555555-5555-4555-8555-555555555555" }
        : {}),
      ...(transition === "computer"
        ? { computerSessionId: "66666666-6666-4666-8666-666666666666" }
        : {}),
      ...(transition === "controller" ? { controllerGeneration: "controller-2" } : {}),
      ...(transition === "enabled" ? { enabled: false } : {}),
    };
    const layoutPostures: (boolean | null)[] = [];
    const rendered = await renderHook((props: typeof original) => {
      const posture = useComputerInputPosture(props);
      useLayoutEffect(() => {
        layoutPostures.push(posture.inputAllowed);
      });
      return posture;
    }, original);
    const settle = (request: Pending, inputAllowed: boolean) =>
      request.resolve({
        computerSessionId: request.computerSessionId,
        controllerGeneration: request.controllerGeneration,
        inputAllowed,
      });
    try {
      await actRun(() => settle(pending[0]!, true));
      expect(rendered.result.current.inputAllowed).toBe(true);
      await actRun(() => rendered.result.current.refresh());
      const oldRequest = pending.at(-1)!;
      currentGeneration = changed.controllerGeneration;
      await rendered.rerenderThroughLayout(changed);
      expect(layoutPostures.at(-1)).toBeNull();
      await flush();
      expect(oldRequest.signal.aborted).toBe(true);
      const intermediateRequest = transition === "enabled" ? null : pending.at(-1)!;
      currentGeneration = original.controllerGeneration;
      await rendered.rerenderThroughLayout(original);
      expect(layoutPostures.at(-1)).toBeNull();
      expect(rendered.result.current.pending).toBe(true);
      await flush();
      const freshRequest = pending.at(-1)!;
      expect(freshRequest).not.toBe(oldRequest);
      if (intermediateRequest) expect(intermediateRequest.signal.aborted).toBe(true);
      await actRun(() => {
        settle(oldRequest, true);
        if (intermediateRequest) settle(intermediateRequest, true);
      });
      expect(rendered.result.current.inputAllowed).toBeNull();
      expect(rendered.result.current.pending).toBe(true);
      await actRun(() => settle(freshRequest, false));
      expect(rendered.result.current.inputAllowed).toBe(false);
      expect(rendered.result.current.pending).toBe(false);
    } finally {
      await rendered.unmount();
    }
  });
}

test("reenabling the same source never paints its previously granted posture", async () => {
  let calls = 0;
  let resolveFresh!: (value: ComputerSessionInputPosture) => void;
  const client = fakeClient({
    getComputerInputPosture: async () => {
      if (++calls === 1)
        return { computerSessionId, controllerGeneration: "controller-1", inputAllowed: true };
      return await new Promise<ComputerSessionInputPosture>((resolve) => {
        resolveFresh = resolve;
      });
    },
  });
  const options = (enabled: boolean) => ({
    client,
    workspaceId: WORKSPACE_ID,
    computerSessionId,
    controllerGeneration: "controller-1",
    enabled,
  });
  const layoutPostures: (boolean | null)[] = [];
  const rendered = await renderHook((props: ReturnType<typeof options>) => {
    const posture = useComputerInputPosture(props);
    useLayoutEffect(() => {
      layoutPostures.push(posture.inputAllowed);
    });
    return posture;
  }, options(true));
  try {
    await flush();
    expect(rendered.result.current.inputAllowed).toBe(true);
    await rendered.rerender(options(false));
    expect(rendered.result.current.inputAllowed).toBeNull();
    expect(rendered.result.current.pending).toBe(false);
    await rendered.rerenderThroughLayout(options(true));
    expect(layoutPostures.at(-1)).toBeNull();
    expect(rendered.result.current.pending).toBe(true);
    await flush();
    await actRun(() =>
      resolveFresh({
        computerSessionId,
        controllerGeneration: "controller-1",
        inputAllowed: false,
      }),
    );
    expect(rendered.result.current.inputAllowed).toBe(false);
  } finally {
    await rendered.unmount();
  }
});

test("a controller change revokes app input before passive effects and ignores delayed old authority", async () => {
  const pending = new Map<string, (value: ComputerSessionInputPosture) => void>();
  const signals: AbortSignal[] = [];
  let generation = "controller-1";
  const client = fakeClient({
    getComputerInputPosture: async (_workspace, _resource, options) => {
      signals.push(options!.signal!);
      return await new Promise<ComputerSessionInputPosture>((resolve) =>
        pending.set(generation, resolve),
      );
    },
  });
  const options = (controllerGeneration: string) => ({
    client,
    workspaceId: WORKSPACE_ID,
    computerSessionId,
    controllerGeneration,
    enabled: true,
  });
  const rendered = await renderHook(useComputerInputPosture, options(generation));
  try {
    expect(rendered.result.current.inputAllowed).toBeNull();
    await actRun(() =>
      pending.get(generation)!({
        computerSessionId,
        controllerGeneration: generation,
        inputAllowed: true,
      }),
    );
    expect(rendered.result.current.inputAllowed).toBe(true);
    generation = "controller-2";
    await rendered.rerenderThroughLayout(options(generation));
    expect(rendered.result.current.inputAllowed).toBeNull();
    expect(rendered.result.current.pending).toBe(true);
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    generation = "controller-3";
    await rendered.rerender(options(generation));
    expect(signals[1]!.aborted).toBe(true);
    await actRun(() =>
      pending.get("controller-2")!({
        computerSessionId,
        controllerGeneration: "controller-2",
        inputAllowed: true,
      }),
    );
    expect(rendered.result.current.inputAllowed).toBeNull();
    await actRun(() =>
      pending.get(generation)!({
        computerSessionId,
        controllerGeneration: generation,
        inputAllowed: false,
      }),
    );
    expect(rendered.result.current.inputAllowed).toBe(false);
  } finally {
    await rendered.unmount();
  }
});

test("Refresh invalidates a true app posture while a failed fresh request settles", async () => {
  let calls = 0;
  let rejectFresh!: (cause: Error) => void;
  const client = fakeClient({
    getComputerInputPosture: async () => {
      calls++;
      if (calls === 1)
        return { computerSessionId, controllerGeneration: "controller-1", inputAllowed: true };
      return await new Promise<ComputerSessionInputPosture>((_resolve, reject) => {
        rejectFresh = reject;
      });
    },
  });
  const rendered = await renderHook(useComputerInputPosture, {
    client,
    workspaceId: WORKSPACE_ID,
    computerSessionId,
    controllerGeneration: "controller-1",
    enabled: true,
  });
  try {
    await flush();
    expect(rendered.result.current.inputAllowed).toBe(true);
    await actRun(() => rendered.result.current.refresh());
    expect(rendered.result.current.inputAllowed).toBeNull();
    expect(rendered.result.current.pending).toBe(true);
    await actRun(() => rejectFresh(new Error("Fixture source authorization unavailable")));
    expect(rendered.result.current.inputAllowed).toBeNull();
    expect(rendered.result.current.pending).toBe(false);
    expect(rendered.result.current.error?.message).toContain("unavailable");
  } finally {
    await rendered.unmount();
  }
});
