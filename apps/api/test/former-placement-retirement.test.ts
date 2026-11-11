import { describe, expect, test } from "bun:test";
import type { LostConnectedInteractionController } from "@opengeni/db";
import { BrowserControlRequestError } from "@opengeni/runtime/sandbox";
import {
  retireFormerPlacementControllersWith,
  type FormerPlacementRetirementPorts,
} from "../src/former-placement-retirement";

const machine = "00000000-0000-4000-8000-0000000000aa";

function controller(
  resource: LostConnectedInteractionController["resource"],
  index: number,
  placementInstanceId = machine,
): LostConnectedInteractionController {
  return {
    resource,
    resourceId: `00000000-0000-4000-8000-00000000000${index}`,
    connectedSandboxId: machine,
    controllerGeneration: `generation-${index}`,
    placementInstanceId,
  };
}

function harness(options: {
  controllers: LostConnectedInteractionController[];
  reachable?: boolean;
  endErrors?: Record<string, Error>;
}) {
  const calls: string[] = [];
  const released: string[] = [];
  const failures: Array<string | null> = [];
  const provisioned: string[] = [];
  const session = { synthetic: true } as never;
  const ports: FormerPlacementRetirementPorts = {
    listControllers: async () => options.controllers,
    withMachine: async (fn) => {
      if (options.reachable === false) return { reached: false };
      return { reached: true, value: await fn(session) };
    },
    provisionClient: async (_session, placementInstanceId) => {
      provisioned.push(placementInstanceId);
      return {
        endSession: async (reference, endOptions) => {
          calls.push(
            `browser ${reference.browserSessionId} ${reference.controllerGeneration} removeState=${endOptions.removeState} discard=${endOptions.discardWorkingRuntime === true}`,
          );
          const error = options.endErrors?.[reference.browserSessionId];
          if (error) throw error;
        },
        endComputerSession: async (reference, endOptions) => {
          calls.push(
            `computer ${reference.computerSessionId} ${reference.controllerGeneration} removeState=${endOptions.removeState}`,
          );
          const error = options.endErrors?.[reference.computerSessionId];
          if (error) throw error;
        },
      };
    },
    release: async (entry) => {
      released.push(entry.resourceId);
      return true;
    },
    onFailure: (entry) => {
      failures.push(entry?.resourceId ?? null);
    },
  };
  return { ports, calls, released, failures, provisioned };
}

describe("retiring controllers a source task's move left on its former machine", () => {
  test("ends each exact generation while keeping its state, then releases the binding", async () => {
    const browser = controller("browser_session", 1);
    const computer = controller("computer_session", 2);
    const run = harness({ controllers: [browser, computer] });
    const result = await retireFormerPlacementControllersWith(run.ports);
    expect(run.calls).toEqual([
      `browser ${browser.resourceId} generation-1 removeState=false discard=true`,
      `computer ${computer.resourceId} generation-2 removeState=false`,
    ]);
    expect(run.released).toEqual([browser.resourceId, computer.resourceId]);
    // Browser and Desktop share one controller scope generation.
    expect(run.provisioned).toEqual([machine]);
    expect(result).toEqual({
      retired: [browser.resourceId, computer.resourceId],
      remaining: [],
      unreachable: false,
    });
  });

  test("treats a controller that no longer holds the generation as already ended", async () => {
    const browser = controller("browser_session", 1);
    const run = harness({
      controllers: [browser],
      endErrors: {
        [browser.resourceId]: new BrowserControlRequestError(404, {
          code: "not_found",
          message: "browser session not found",
          retryable: false,
        }),
      },
    });
    const result = await retireFormerPlacementControllersWith(run.ports);
    expect(run.released).toEqual([browser.resourceId]);
    expect(result.remaining).toEqual([]);
  });

  test("keeps the binding of a controller that refused or failed, and continues with the rest", async () => {
    const refused = controller("browser_session", 1);
    const ended = controller("browser_session", 2);
    const run = harness({
      controllers: [refused, ended],
      endErrors: {
        [refused.resourceId]: new BrowserControlRequestError(409, {
          code: "resource_unavailable",
          message: "preserved",
          retryable: false,
        }),
      },
    });
    const result = await retireFormerPlacementControllersWith(run.ports);
    expect(run.released).toEqual([ended.resourceId]);
    expect(run.failures).toEqual([refused.resourceId]);
    expect(result).toEqual({
      retired: [ended.resourceId],
      remaining: [refused.resourceId],
      unreachable: false,
    });
  });

  test("attempts nothing and releases nothing when the former machine is unreachable", async () => {
    const browser = controller("browser_session", 1);
    const run = harness({ controllers: [browser], reachable: false });
    const result = await retireFormerPlacementControllersWith(run.ports);
    expect(run.calls).toEqual([]);
    expect(run.released).toEqual([]);
    expect(result).toEqual({ retired: [], remaining: [browser.resourceId], unreachable: true });
  });

  test("does not reach the machine when nothing remains bound", async () => {
    let reached = false;
    const run = harness({ controllers: [] });
    const result = await retireFormerPlacementControllersWith({
      ...run.ports,
      withMachine: async (fn) => {
        reached = true;
        return await run.ports.withMachine(fn);
      },
    });
    expect(reached).toBe(false);
    expect(result).toEqual({ retired: [], remaining: [], unreachable: false });
  });
});
