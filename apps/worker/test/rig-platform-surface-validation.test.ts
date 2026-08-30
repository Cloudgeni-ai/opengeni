import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type {
  BrowserObservation,
  BrowserTarget,
  ComputerActionReceipt,
  ComputerObservation,
  ComputerTarget,
} from "@opengeni/contracts";
import type { Database, LeaseSnapshot } from "@opengeni/db";
import { BrowserControlUnsupportedError, type EstablishedSandboxSession } from "@opengeni/runtime";
import {
  runRigPlatformSurfaceValidation,
  type RigPlatformSurfaceValidationDependencies,
  type RigPlatformSurfaceValidationInput,
} from "../src/activities/rig-platform-surface-validation";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_ID = "44444444-4444-4444-8444-444444444444";
const BROWSER_SESSION_ID = "55555555-5555-4555-8555-555555555555";
const COMPUTER_SESSION_ID = "66666666-6666-4666-8666-666666666666";
const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const CHECKED_AT = "2026-08-30T12:00:00.000Z";

type FailureMode =
  | "terminal"
  | "browser_unsupported"
  | "browser_empty_targets"
  | "browser_generation_mismatch"
  | "browser_observed_target_mismatch"
  | "browser_cleanup"
  | "computer_unsupported"
  | "computer_empty_targets"
  | "computer_empty_image"
  | "computer_invalid_image"
  | "computer_observed_target_mismatch"
  | "computer_observed_generation_mismatch"
  | "computer_frame_target_mismatch"
  | "computer_frame_generation_mismatch"
  | "computer_action_target_mismatch"
  | "computer_action_observation_mismatch"
  | "computer_settled_target_mismatch"
  | "computer_cleanup"
  | "controller_cleanup"
  | "lease_epoch_mismatch"
  | "provider_instance_mismatch";

function lease(overrides: Partial<LeaseSnapshot> = {}): LeaseSnapshot {
  return {
    id: LEASE_ID,
    sandboxGroupId: GROUP_ID,
    liveness: "warm",
    refcount: 1,
    turnHolders: 1,
    viewerHolders: 0,
    instanceId: "sandbox-exact",
    backend: "modal",
    os: "linux",
    image: "example.invalid/opengeni:test",
    rigVersionId: VERSION_ID,
    dataPlaneUrl: null,
    terminalDataPlaneUrl: null,
    controllerDataPlaneUrl: null,
    leaseEpoch: 8,
    workspaceGeneration: 3,
    archiveGeneration: null,
    archiveComplete: false,
    archiveCapture: null,
    reaperHold: null,
    resumeBackendId: null,
    resumeState: null,
    expiresAt: new Date("2026-08-30T12:20:00.000Z"),
    ...overrides,
  } as LeaseSnapshot;
}

function browserTarget(
  controllerGeneration: string,
  overrides: Partial<BrowserTarget> = {},
): BrowserTarget {
  return {
    id: "page-1",
    browserSessionId: BROWSER_SESSION_ID,
    controllerGeneration,
    targetGeneration: "target-1",
    documentGeneration: "document-1",
    kind: "page",
    title: "OpenGeni Rig Surface Validation",
    url: "data:text/html,<title>OpenGeni Rig Surface Validation</title>",
    selected: true,
    attached: true,
    createdAt: CHECKED_AT,
    ...overrides,
  };
}

function browserObservation(
  controllerGeneration: string,
  targetOverrides: Partial<BrowserTarget> = {},
): BrowserObservation {
  const target = browserTarget(controllerGeneration, targetOverrides);
  return {
    protocolVersion: 1,
    observationId: "browser-observation-1",
    browserSessionId: BROWSER_SESSION_ID,
    target,
    frameId: "browser-frame-1",
    semantic: null,
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt: CHECKED_AT,
  };
}

function computerTarget(
  controllerGeneration: string,
  overrides: Partial<ComputerTarget> = {},
): ComputerTarget {
  return {
    id: "screen-1",
    computerSessionId: COMPUTER_SESSION_ID,
    controllerGeneration,
    targetGeneration: "screen-generation-1",
    kind: "screen",
    applicationId: null,
    processId: null,
    title: "Desktop",
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    focused: true,
    ...overrides,
  };
}

function computerObservation(
  controllerGeneration: string,
  targetOverrides: Partial<ComputerTarget> = {},
): ComputerObservation {
  return {
    protocolVersion: 1,
    observationId: "computer-observation-1",
    computerSessionId: COMPUTER_SESSION_ID,
    target: computerTarget(controllerGeneration, targetOverrides),
    frameId: "computer-frame-1",
    semantic: null,
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    observedAt: CHECKED_AT,
  };
}

function completedComputerAction(
  controllerGeneration: string,
  overrides: Partial<ComputerActionReceipt> = {},
): ComputerActionReceipt {
  return {
    protocolVersion: 1,
    operationId: OPERATION_ID,
    computerSessionId: COMPUTER_SESSION_ID,
    controllerGeneration,
    targetId: "screen-1",
    state: "completed",
    dispatchedAt: CHECKED_AT,
    settledAt: CHECKED_AT,
    observation: null,
    error: null,
    ...overrides,
  };
}

function harness(mode?: FailureMode, disabled: { terminal?: boolean; desktop?: boolean } = {}) {
  const events: string[] = [];
  const readBindings: LeaseSnapshot[] = [];
  let uuidIndex = 0;
  const uuids = [
    "88888888-8888-4888-8888-888888888888",
    BROWSER_SESSION_ID,
    "99999999-9999-4999-8999-999999999999",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    COMPUTER_SESSION_ID,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    OPERATION_ID,
  ];
  let generation = "";
  let computerObservationCount = 0;
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const imageSha = createHash("sha256").update(image).digest("hex");

  const controller = {
    createSession: async (request: {
      browserSessionId: string;
      controllerGeneration: string;
      headed: boolean;
      tokenGeneration: number;
    }) => {
      events.push("browser:create");
      expect(request.browserSessionId).toBe(BROWSER_SESSION_ID);
      expect(request.headed).toBe(true);
      expect(request.tokenGeneration).toBe(8);
      generation = request.controllerGeneration;
      if (mode === "browser_unsupported") throw new BrowserControlUnsupportedError("unsupported");
      const returnedGeneration =
        mode === "browser_generation_mismatch" ? "other-generation" : generation;
      return {
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: returnedGeneration,
        observation: browserObservation(returnedGeneration),
      };
    },
    sessionClient: () => ({
      listTargets: async () => {
        events.push("browser:list");
        return mode === "browser_empty_targets" ? [] : [browserTarget(generation)];
      },
      openTarget: async () => {
        events.push("browser:open");
        return browserObservation(generation);
      },
      observe: async () => {
        events.push("browser:observe");
        return browserObservation(
          generation,
          mode === "browser_observed_target_mismatch" ? { id: "page-other" } : {},
        );
      },
    }),
    endSession: async () => {
      events.push("browser:end");
      if (mode === "browser_cleanup") throw new Error("browser cleanup failed");
    },
    createComputerSession: async (request: {
      computerSessionId: string;
      controllerGeneration: string;
      tokenGeneration: number;
    }) => {
      events.push("computer:create");
      expect(request.computerSessionId).toBe(COMPUTER_SESSION_ID);
      expect(request.controllerGeneration).toBe(generation);
      expect(request.tokenGeneration).toBe(8);
      if (mode === "computer_unsupported") {
        throw new BrowserControlUnsupportedError("computer unsupported");
      }
      return {
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: generation,
        platform: "linux" as const,
        adapter: "x11",
        seatId: "seat-1",
        displayId: ":99",
        capabilities: {
          semanticObservation: true,
          screenshots: true,
          liveFrames: true,
          humanInput: true,
          clipboard: true,
          applications: true,
          windows: true,
          screens: true,
        },
        targets: [computerTarget(generation)],
      };
    },
    computerSessionClient: () => ({
      listTargets: async () => {
        events.push("computer:list");
        return mode === "computer_empty_targets" ? [] : [computerTarget(generation)];
      },
      observe: async () => {
        events.push("computer:observe");
        computerObservationCount += 1;
        if (mode === "computer_observed_target_mismatch" && computerObservationCount === 1) {
          return computerObservation(generation, { id: "screen-other" });
        }
        if (mode === "computer_observed_generation_mismatch" && computerObservationCount === 1) {
          return computerObservation(generation, { targetGeneration: "screen-generation-other" });
        }
        if (mode === "computer_settled_target_mismatch" && computerObservationCount === 2) {
          return computerObservation(generation, { id: "screen-other" });
        }
        return computerObservation(generation);
      },
      capture: async () => {
        events.push("computer:capture");
        const data = mode === "computer_empty_image" ? new Uint8Array() : image;
        const metadata = {
          frameId: "computer-frame-1",
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: generation,
          targetId: mode === "computer_frame_target_mismatch" ? "screen-other" : "screen-1",
          targetGeneration:
            mode === "computer_frame_generation_mismatch"
              ? "screen-generation-other"
              : "screen-generation-1",
          sequence: 1,
          mediaType: "image/png",
          width: 1,
          height: 1,
          capturedAt: CHECKED_AT,
          sha256: mode === "computer_invalid_image" ? "0".repeat(64) : imageSha,
        };
        return {
          data,
          mediaType: "image/png" as const,
          metadataHeader: Buffer.from(JSON.stringify(metadata)).toString("base64url"),
        };
      },
      action: async () => {
        events.push("computer:action");
        if (mode === "computer_action_target_mismatch") {
          return completedComputerAction(generation, { targetId: "screen-other" });
        }
        if (mode === "computer_action_observation_mismatch") {
          return completedComputerAction(generation, {
            observation: computerObservation(generation, { id: "screen-other" }),
          });
        }
        return completedComputerAction(generation);
      },
    }),
    endComputerSession: async () => {
      events.push("computer:end");
      if (mode === "computer_cleanup") throw new Error("computer cleanup failed");
    },
  };

  const dependencies = {
    readLease: async () => {
      const current = lease({
        ...(mode === "lease_epoch_mismatch" ? { leaseEpoch: 9 } : {}),
        ...(mode === "provider_instance_mismatch" ? { instanceId: "sandbox-other" } : {}),
      });
      readBindings.push(current);
      return current;
    },
    provisionController: async (session: unknown) => {
      events.push("controller:provision");
      expect(session).toBe(established.session);
      return { client: controller };
    },
    tearDownController: async (session: unknown) => {
      events.push("controller:down");
      expect(session).toBe(established.session);
      if (mode === "controller_cleanup") throw new Error("controller cleanup failed");
    },
    randomUUID: () => uuids[uuidIndex++]!,
    checkedAt: () => CHECKED_AT,
    inspectImage: async () =>
      mode === "computer_invalid_image"
        ? { format: "jpeg", width: 1, height: 1 }
        : { format: "png", width: 1, height: 1 },
  } as unknown as RigPlatformSurfaceValidationDependencies;

  const established: EstablishedSandboxSession = {
    client: {},
    session: { exec: async () => ({ exitCode: 0 }) },
    sessionState: {},
    instanceId: "sandbox-exact",
    backendId: "modal",
  };
  const input: RigPlatformSurfaceValidationInput = {
    settings: {
      sandboxTerminalEnabled: disabled.terminal !== true,
      sandboxDesktopEnabled: disabled.desktop !== true,
      rigSetupTimeoutMs: 30_000,
    },
    db: {} as Database,
    workspaceId: WORKSPACE_ID,
    sandboxGroupId: GROUP_ID,
    rigVersionId: VERSION_ID,
    established,
    commandRunner: async (session, command) => {
      events.push("terminal:command");
      expect(session).toBe(established.session);
      expect(command).toMatchObject({ workdir: "/workspace", runAs: "root", tty: true });
      if (mode === "terminal") return { exitCode: 1, output: "terminal failed" };
      return {
        exitCode: 0,
        output: "cwd=/workspace\nuid=0\nbun=1.4.0\ninteractive=yes\n",
      };
    },
    ownership: {
      leaseId: LEASE_ID,
      sandboxGroupId: GROUP_ID,
      leaseEpoch: 8,
      workspaceGeneration: 3,
      instanceId: "sandbox-exact",
    },
  };
  return { dependencies, input, events, readBindings };
}

describe("mandatory Rig platform surface validation", () => {
  test("passes all enabled native surfaces on the exact verifier provider and epoch", async () => {
    const state = harness();
    const receipt = await runRigPlatformSurfaceValidation(state.input, state.dependencies);
    expect(receipt.binding).toEqual({
      leaseId: LEASE_ID,
      sandboxGroupId: GROUP_ID,
      leaseEpoch: 8,
      workspaceGeneration: 3,
      instanceId: "sandbox-exact",
      backendId: "modal",
      rigVersionId: VERSION_ID,
    });
    expect(receipt.terminal.status).toBe("passed");
    expect(receipt.browser.status).toBe("passed");
    expect(receipt.computer.status).toBe("passed");
    expect(state.events).toEqual([
      "terminal:command",
      "controller:provision",
      "browser:create",
      "browser:list",
      "browser:open",
      "browser:list",
      "browser:observe",
      "browser:end",
      "computer:create",
      "computer:list",
      "computer:observe",
      "computer:capture",
      "computer:action",
      "computer:observe",
      "computer:end",
      "controller:down",
    ]);
    expect(state.readBindings.length).toBeGreaterThan(10);
    expect(state.readBindings.every((binding) => binding.instanceId === "sandbox-exact")).toBe(
      true,
    );
  });

  test("skips only surfaces explicitly disabled by deployment policy", async () => {
    const state = harness(undefined, { terminal: true, desktop: true });
    const receipt = await runRigPlatformSurfaceValidation(state.input, state.dependencies);
    expect(receipt.terminal).toEqual({ status: "disabled" });
    expect(receipt.computer).toEqual({ status: "disabled" });
    expect(receipt.browser.status).toBe("passed");
    expect(state.events).not.toContain("terminal:command");
    expect(state.events).not.toContain("computer:create");
  });

  for (const [mode, message] of [
    ["terminal", "interactive root terminal"],
    ["browser_unsupported", "unsupported"],
    ["browser_empty_targets", "no real targets"],
    ["browser_generation_mismatch", "another session/controller binding"],
    ["browser_observed_target_mismatch", "another requested target binding"],
    ["browser_cleanup", "browser cleanup failed"],
    ["computer_unsupported", "computer unsupported"],
    ["computer_empty_targets", "no real screen target"],
    ["computer_empty_image", "image is empty"],
    ["computer_invalid_image", "does not match its request"],
    ["computer_observed_target_mismatch", "another requested target binding"],
    ["computer_observed_generation_mismatch", "another requested target binding"],
    ["computer_frame_target_mismatch", "does not match its request"],
    ["computer_frame_generation_mismatch", "another target generation"],
    ["computer_action_target_mismatch", "exact binding"],
    ["computer_action_observation_mismatch", "another requested target binding"],
    ["computer_settled_target_mismatch", "another requested target binding"],
    ["computer_cleanup", "computer cleanup failed"],
    ["controller_cleanup", "controller cleanup failed"],
    ["lease_epoch_mismatch", "binding changed"],
    ["provider_instance_mismatch", "binding changed"],
  ] as const) {
    test(`fails closed for ${mode}`, async () => {
      const state = harness(mode);
      await expect(
        runRigPlatformSurfaceValidation(state.input, state.dependencies),
      ).rejects.toThrow(message);
    });
  }

  test("still ends browser and controller when computer creation is unsupported", async () => {
    const state = harness("computer_unsupported");
    await expect(runRigPlatformSurfaceValidation(state.input, state.dependencies)).rejects.toThrow(
      "computer unsupported",
    );
    expect(state.events).toContain("browser:end");
    expect(state.events).toContain("controller:down");
  });
});
