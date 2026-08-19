import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComputerActionCommand,
  ComputerObservation,
  ComputerSessionCapabilities,
  ComputerTarget,
} from "@opengeni/contracts";
import {
  ComputerSupervisor,
  type ComputerEnvironmentAllocator,
  type ComputerFrameSubscription,
  type ComputerImageFrame,
  type ComputerSupervisorDriver,
} from "../src";

const computerSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";

describe("ComputerSupervisor", () => {
  test("hosts workspace sessions and replays durable terminal receipts without redispatch", async () => {
    const rootDirectory = await mkdtemp("/tmp/og-computer-supervisor-");
    const drivers: FixtureComputerDriver[] = [];
    const open = async () =>
      await ComputerSupervisor.open({
        rootDirectory,
        environmentAllocator: fixtureEnvironmentAllocator(),
        createDriver: async (context) => {
          const driver = new FixtureComputerDriver(
            context.computerSessionId,
            context.controllerGeneration,
          );
          drivers.push(driver);
          return driver;
        },
      });
    let supervisor = await open();
    try {
      const created = await supervisor.createSession(options());
      expect(created).toMatchObject({
        computerSessionId,
        platform: "linux",
        adapter: "fixture.atspi.v1",
        seatId: "seat-1",
        displayId: ":101",
      });
      expect(supervisor.listSessions()).toHaveLength(1);
      expect(drivers[0]?.listTargetCalls).toBe(1);
      const environment = supervisor.launchEnvironment(options());
      expect(environment).toMatchObject({ PATH: process.env.PATH ?? "/usr/bin" });
      environment.DISPLAY = ":mutated";
      expect(supervisor.launchEnvironment(options()).DISPLAY).toBeUndefined();
      expect(() =>
        supervisor.launchEnvironment({
          computerSessionId,
          controllerGeneration: "controller-stale",
        }),
      ).toThrow();
      expect(await supervisor.action(command())).toMatchObject({ state: "completed" });
      expect(drivers[0]?.dispatches).toBe(1);
      await expect(
        supervisor.createSession({ ...options(), controllerGeneration: "controller-2" }),
      ).rejects.toMatchObject({ code: "controller_stale" });
    } finally {
      await supervisor.close();
    }

    supervisor = await open();
    try {
      await supervisor.createSession(options());
      expect(await supervisor.action(command())).toMatchObject({ state: "completed" });
      expect(drivers[1]?.dispatches).toBe(0);
      await supervisor.endSession(
        { computerSessionId, controllerGeneration },
        { removeState: true },
      );
      await expect(
        access(join(rootDirectory, "computer-sessions", computerSessionId)),
      ).rejects.toBeDefined();
    } finally {
      await supervisor.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  test("displaces other shared-seat helpers when a new ComputerSession is created", async () => {
    const rootDirectory = await mkdtemp("/tmp/og-computer-displace-");
    const drivers: FixtureComputerDriver[] = [];
    const supervisor = await ComputerSupervisor.open({
      rootDirectory,
      displaceExistingSessions: true,
      environmentAllocator: fixtureEnvironmentAllocator(),
      createDriver: async (context) => {
        const driver = new FixtureComputerDriver(
          context.computerSessionId,
          context.controllerGeneration,
        );
        drivers.push(driver);
        return driver;
      },
    });
    try {
      await supervisor.createSession(options());
      await supervisor.createSession({
        ...options(),
        computerSessionId: "33333333-3333-4333-8333-333333333333",
        controllerGeneration: "controller-2",
      });
      expect(supervisor.listSessions()).toEqual([
        expect.objectContaining({
          computerSessionId: "33333333-3333-4333-8333-333333333333",
        }),
      ]);
      expect(drivers[0]?.closed).toBe(true);
      expect(drivers[1]?.closed).toBe(false);
    } finally {
      await supervisor.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  test("serializes concurrent shared-seat creates so only one helper survives", async () => {
    const rootDirectory = await mkdtemp("/tmp/og-computer-displace-race-");
    const drivers: FixtureComputerDriver[] = [];
    const supervisor = await ComputerSupervisor.open({
      rootDirectory,
      displaceExistingSessions: true,
      environmentAllocator: fixtureEnvironmentAllocator(),
      createDriver: async (context) => {
        const driver = new FixtureComputerDriver(
          context.computerSessionId,
          context.controllerGeneration,
        );
        drivers.push(driver);
        return driver;
      },
    });
    try {
      await Promise.all([
        supervisor.createSession(options()),
        supervisor.createSession({
          ...options(),
          computerSessionId: "33333333-3333-4333-8333-333333333333",
          controllerGeneration: "controller-2",
        }),
      ]);
      expect(supervisor.listSessions()).toHaveLength(1);
      expect(drivers.filter((driver) => !driver.closed)).toHaveLength(1);
      expect(drivers.filter((driver) => driver.closed)).toHaveLength(1);
    } finally {
      await supervisor.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  test("keeps isolated-seat ComputerSessions side by side", async () => {
    const rootDirectory = await mkdtemp("/tmp/og-computer-isolated-");
    const drivers: FixtureComputerDriver[] = [];
    const supervisor = await ComputerSupervisor.open({
      rootDirectory,
      environmentAllocator: fixtureEnvironmentAllocator(),
      createDriver: async (context) => {
        const driver = new FixtureComputerDriver(
          context.computerSessionId,
          context.controllerGeneration,
        );
        drivers.push(driver);
        return driver;
      },
    });
    try {
      await supervisor.createSession(options());
      await supervisor.createSession({
        ...options(),
        computerSessionId: "33333333-3333-4333-8333-333333333333",
        controllerGeneration: "controller-2",
      });
      expect(supervisor.listSessions()).toHaveLength(2);
      expect(drivers.every((driver) => !driver.closed)).toBe(true);
    } finally {
      await supervisor.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  test("enforces placement capacity across independent ComputerSessions", async () => {
    const rootDirectory = await mkdtemp("/tmp/og-computer-capacity-");
    const supervisor = await ComputerSupervisor.open({
      rootDirectory,
      maxSessions: 1,
      environmentAllocator: fixtureEnvironmentAllocator(),
      createDriver: async (context) =>
        new FixtureComputerDriver(context.computerSessionId, context.controllerGeneration),
    });
    try {
      await supervisor.createSession(options());
      await expect(
        supervisor.createSession({
          ...options(),
          computerSessionId: "33333333-3333-4333-8333-333333333333",
        }),
      ).rejects.toMatchObject({ code: "resource_unavailable", retryable: true });
    } finally {
      await supervisor.close();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});

class FixtureComputerDriver implements ComputerSupervisorDriver {
  readonly platform = "linux" as const;
  readonly adapterId = "fixture.atspi.v1";
  readonly capabilities: ComputerSessionCapabilities = {
    semanticObservation: true,
    appDiscovery: true,
    appLaunch: true,
    windowCapture: true,
    screenCapture: true,
    semanticActions: true,
    pointerInput: true,
    keyboardInput: true,
    clipboard: true,
    backgroundActions: true,
    parallelApps: true,
  };
  dispatches = 0;
  listTargetCalls = 0;
  closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly generation: string,
  ) {}

  async listTargets(): Promise<ComputerTarget[]> {
    this.listTargetCalls += 1;
    return [this.targetValue()];
  }

  async target(targetId: string): Promise<ComputerTarget | null> {
    return targetId === "window-1" ? this.targetValue() : null;
  }

  async observe(): Promise<ComputerObservation> {
    return this.observation("observation-1");
  }

  async dispatch(): Promise<ComputerObservation> {
    this.dispatches += 1;
    return this.observation("observation-2");
  }

  async capture(): Promise<ComputerImageFrame> {
    throw new Error("unused");
  }

  async clipboard() {
    return {
      computerSessionId: this.sessionId,
      controllerGeneration: this.generation,
      text: "fixture clipboard",
      truncated: false,
      observedAt: "2026-08-11T12:00:00.000Z",
    };
  }

  async subscribeFrames(): Promise<ComputerFrameSubscription> {
    throw new Error("unused");
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private targetValue(): ComputerTarget {
    return {
      id: "window-1",
      computerSessionId: this.sessionId,
      controllerGeneration: this.generation,
      targetGeneration: "target-generation-1",
      kind: "window",
      applicationId: "fixture.desktop",
      processId: 42,
      title: "Fixture",
      bounds: { x: 0, y: 0, width: 400, height: 300 },
      focused: true,
    };
  }

  private observation(observationId: string): ComputerObservation {
    return {
      protocolVersion: 1,
      observationId,
      computerSessionId: this.sessionId,
      target: this.targetValue(),
      frameId: "frame-1",
      semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
      screenshot: null,
      focusedRef: null,
      changedRegions: [],
      observedAt: "2026-08-10T12:00:00.000Z",
    };
  }
}

function options() {
  return {
    computerSessionId,
    controllerGeneration,
  };
}

function fixtureEnvironmentAllocator(): ComputerEnvironmentAllocator {
  return {
    async allocate() {
      return {
        seatId: "seat-1",
        displayId: ":101",
        rfbPort: null,
        environment: { PATH: process.env.PATH ?? "/usr/bin" },
        async close() {},
      };
    },
  };
}

function command(): ComputerActionCommand {
  return {
    protocolVersion: 1,
    operationId: "22222222-2222-4222-8222-222222222222",
    computerSessionId,
    controllerGeneration,
    targetId: "window-1",
    expectedTargetGeneration: "target-generation-1",
    expectedObservationId: "observation-1",
    expectedFrameId: null,
    actor: { kind: "agent", subjectId: "agent:fixture" },
    action: {
      type: "semantic",
      locator: { kind: "ref", ref: "e1" },
      action: "invoke",
    },
  };
}
