// A route move this attempt cannot serve (another workspace root, or a home it
// cannot reach) must give every call a certain outcome and end the attempt at
// a clean point: between batches, before the model chooses its next calls.

import { describe, expect, test } from "bun:test";
import {
  ActiveBackendUnresolvableError,
  RoutingSandboxSession,
  RoutingWorkspaceRootChangedError,
  createTurnToolCancellationController,
  type ActivePointer,
  type RoutableBackendSession,
} from "../src/sandbox";
import { ROUTE_MOVED_CALL_NOT_STARTED } from "../src/sandbox/turn-tool-cancellation";

function routedPair() {
  let pointer: ActivePointer = { activeSandboxId: null, activeEpoch: 0 };
  const calls: string[] = [];
  const backend = (name: string, root: string): RoutableBackendSession => ({
    state: { manifest: { root } },
    exec: async (args: unknown) => {
      calls.push(`${name}:${(args as { cmd: string }).cmd}`);
      return { stdout: name, exitCode: 0 };
    },
  });
  const home = backend("home", "/workspace");
  const sameRoot = backend("same-root", "/workspace");
  const otherRoot = backend("other-root", "/srv/project");
  let resolves = 0;
  const proxy = new RoutingSandboxSession({
    defaultResolved: { session: home, sandboxId: null, kind: "modal" },
    readPointer: async () => ({ ...pointer }),
    resolveActiveBackend: async (route) => {
      resolves += 1;
      if (route.activeSandboxId === null) return { session: home, sandboxId: null, kind: "modal" };
      if (route.activeSandboxId === "no-home")
        throw new ActiveBackendUnresolvableError("home_unavailable_this_turn", "no home");
      return {
        session: route.activeSandboxId === "same" ? sameRoot : otherRoot,
        sandboxId: route.activeSandboxId,
        kind: "selfhosted",
      };
    },
  });
  return {
    proxy,
    calls,
    resolves: () => resolves,
    swap: (target: string | null) => {
      pointer = { activeSandboxId: target, activeEpoch: pointer.activeEpoch + 1 };
    },
  };
}

function functionTool(name: string, invoke: () => Promise<unknown>) {
  return {
    type: "function" as const,
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    strict: false,
    invoke: async () => await invoke(),
  };
}

describe("route move between batches", () => {
  test("a move to another workspace root is refused at the boundary, before any call", async () => {
    const routed = routedPair();
    await routed.proxy.exec({ cmd: "before" });
    routed.swap("other");
    await expect(routed.proxy.assertActiveRouteContinuable()).rejects.toBeInstanceOf(
      RoutingWorkspaceRootChangedError,
    );
    expect(routed.calls).toEqual(["home:before"]);
  });

  test("a move this attempt can serve is adopted once, as its next call would", async () => {
    const routed = routedPair();
    await routed.proxy.exec({ cmd: "before" });
    routed.swap("same");
    await routed.proxy.assertActiveRouteContinuable();
    const resolvesAfterBoundary = routed.resolves();
    await routed.proxy.exec({ cmd: "after" });
    expect(routed.resolves()).toBe(resolvesAfterBoundary);
    expect(routed.calls).toEqual(["home:before", "same-root:after"]);
  });
});

describe("route move inside a batch", () => {
  test("a call refused before reaching any route reports that it did not start", async () => {
    const routed = routedPair();
    const controller = createTurnToolCancellationController();
    const [exec] = controller.wrapTools([
      functionTool("exec_command", () => routed.proxy.exec({ cmd: "after-move" })),
    ]);
    routed.swap("other");
    await expect(exec!.invoke({}, "{}")).resolves.toBe(ROUTE_MOVED_CALL_NOT_STARTED);
    routed.swap("no-home");
    await expect(exec!.invoke({}, "{}")).resolves.toBe(ROUTE_MOVED_CALL_NOT_STARTED);
    expect(routed.calls).toEqual([]);
  });

  test("a call that already reached a route still fails instead of claiming nothing ran", async () => {
    const routed = routedPair();
    const controller = createTurnToolCancellationController();
    const [twoStep] = controller.wrapTools([
      functionTool("two_step", async () => {
        await routed.proxy.exec({ cmd: "first" });
        routed.swap("other");
        return await routed.proxy.exec({ cmd: "second" });
      }),
    ]);
    await expect(twoStep!.invoke({}, "{}")).rejects.toBeInstanceOf(
      RoutingWorkspaceRootChangedError,
    );
    expect(routed.calls).toEqual(["home:first"]);
  });

  test("parallel calls each get their own certain outcome", async () => {
    const routed = routedPair();
    const controller = createTurnToolCancellationController();
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const [ranBeforeMove, refusedAfterMove] = controller.wrapTools([
      functionTool("exec_command", async () => {
        const result = await routed.proxy.exec({ cmd: "early" });
        await slowReleased;
        return result;
      }),
      functionTool("exec_command", async () => {
        await slowReleased;
        return await routed.proxy.exec({ cmd: "late" });
      }),
    ]);
    const early = ranBeforeMove!.invoke({}, "{}");
    const late = refusedAfterMove!.invoke({}, "{}");
    await Bun.sleep(0);
    routed.swap("other");
    releaseSlow();
    await expect(early).resolves.toMatchObject({ stdout: "home" });
    await expect(late).resolves.toBe(ROUTE_MOVED_CALL_NOT_STARTED);
    expect(routed.calls).toEqual(["home:early"]);
  });
});
