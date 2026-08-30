import { createHash, randomUUID } from "node:crypto";
import {
  COMPUTER_SCREENSHOT_MAX_BYTES,
  type BrowserObservation,
  type BrowserTarget,
  type ComputerActionReceipt,
  type ComputerObservation,
  type ComputerTarget,
} from "@opengeni/contracts";
import {
  RigPlatformSurfaceValidationReceipt,
  type RigPlatformSurfaceValidationReceipt as RigPlatformSurfaceValidationReceiptValue,
} from "@opengeni/contracts/rig-platform-surface-validation";
import { readLease, type Database, type LeaseSnapshot } from "@opengeni/db";
import {
  provisionBrowserControlClient,
  sandboxCommandExitCode,
  sandboxCommandOutput,
  tearDownBrowserControlServer,
  validateComputerControlFrameEvidence,
  type BrowserControlClient,
  type BrowserControlPlacementSession,
  type ComputerControlFrame,
  type EstablishedSandboxSession,
  type PlacementBrowserSession,
  type PlacementComputerSession,
  type TurnSandboxCommandArgs,
  type TurnSandboxCommandSession,
} from "@opengeni/runtime/sandbox";
import sharp from "sharp";

const TERMINAL_EXPECTED_BUN_VERSION = "1.4.0";
const SURFACE_TARGET_URL =
  "data:text/html,<title>OpenGeni Rig Surface Validation</title><main id=opengeni-rig-surface>ready</main>";

type CommandRunner = (
  session: TurnSandboxCommandSession,
  args: TurnSandboxCommandArgs,
) => Promise<unknown>;

type BrowserSessionClient = ReturnType<BrowserControlClient["sessionClient"]>;
type ComputerSessionClient = ReturnType<BrowserControlClient["computerSessionClient"]>;

type SurfaceController = Pick<
  BrowserControlClient,
  | "createSession"
  | "sessionClient"
  | "endSession"
  | "createComputerSession"
  | "computerSessionClient"
  | "endComputerSession"
>;

export type RigPlatformSurfaceValidationDependencies = {
  readLease: typeof readLease;
  provisionController: (
    session: BrowserControlPlacementSession,
    input: Parameters<typeof provisionBrowserControlClient>[1],
  ) => Promise<{ client: SurfaceController }>;
  tearDownController: (session: unknown) => Promise<void>;
  randomUUID: () => string;
  checkedAt: () => string;
  inspectImage: (data: Uint8Array) => Promise<{
    format: string | undefined;
    width: number | undefined;
    height: number | undefined;
  }>;
};

const defaultDependencies: RigPlatformSurfaceValidationDependencies = {
  readLease,
  provisionController: async (session, input) =>
    await provisionBrowserControlClient(session, input),
  tearDownController: async (session) => await tearDownBrowserControlServer(session),
  randomUUID,
  checkedAt: () => new Date().toISOString(),
  inspectImage: async (data) => {
    const metadata = await sharp(data, { failOn: "error" }).metadata();
    return { format: metadata.format, width: metadata.width, height: metadata.height };
  },
};

export type RigPlatformSurfaceValidationInput = {
  settings: {
    sandboxTerminalEnabled: boolean;
    sandboxDesktopEnabled: boolean;
    rigSetupTimeoutMs: number;
  };
  db: Database;
  workspaceId: string;
  sandboxGroupId: string;
  rigVersionId: string;
  established: EstablishedSandboxSession;
  commandRunner: CommandRunner;
  ownership: {
    leaseId: string;
    leaseEpoch: number;
    workspaceGeneration: number;
    instanceId: string;
  };
};

function validationError(message: string): Error {
  return new Error(`Rig platform surface validation failed: ${message}`);
}

function token(prefix: string, uuid: string): string {
  return `${prefix}.${uuid.replaceAll("-", "")}`;
}

function controllerGeneration(input: RigPlatformSurfaceValidationInput): string {
  const digest = createHash("sha256")
    .update(
      [
        input.ownership.leaseId,
        String(input.ownership.leaseEpoch),
        String(input.ownership.workspaceGeneration),
        input.established.instanceId,
        input.rigVersionId,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 24);
  return `rigv-${input.ownership.leaseEpoch}-${input.ownership.workspaceGeneration}-${digest}`;
}

function assertLeaseBinding(
  lease: LeaseSnapshot | null,
  input: RigPlatformSurfaceValidationInput,
): asserts lease is LeaseSnapshot {
  if (!lease) throw validationError("the verifier lease disappeared");
  const expected = input.ownership;
  if (
    lease.id !== expected.leaseId ||
    lease.sandboxGroupId !== input.sandboxGroupId ||
    lease.leaseEpoch !== expected.leaseEpoch ||
    lease.workspaceGeneration !== expected.workspaceGeneration ||
    lease.instanceId !== expected.instanceId ||
    lease.instanceId !== input.established.instanceId ||
    lease.backend !== input.established.backendId ||
    lease.rigVersionId !== input.rigVersionId ||
    lease.liveness !== "warm"
  ) {
    throw validationError("the verifier sandbox/provider/lease binding changed");
  }
}

async function assertExactBinding(
  input: RigPlatformSurfaceValidationInput,
  dependencies: RigPlatformSurfaceValidationDependencies,
): Promise<void> {
  assertLeaseBinding(
    await dependencies.readLease(input.db, input.workspaceId, input.sandboxGroupId),
    input,
  );
}

function assertBrowserTargetBinding(target: BrowserTarget, session: PlacementBrowserSession): void {
  if (
    target.browserSessionId !== session.browserSessionId ||
    target.controllerGeneration !== session.controllerGeneration
  ) {
    throw validationError("browser target returned another session/controller binding");
  }
}

function assertBrowserObservationBinding(
  observation: BrowserObservation,
  session: PlacementBrowserSession,
): void {
  if (observation.browserSessionId !== session.browserSessionId) {
    throw validationError("browser observation returned another session binding");
  }
  assertBrowserTargetBinding(observation.target, session);
}

function assertDeterministicBrowserTarget(target: BrowserTarget): void {
  if (
    !target.url.startsWith("data:text/html,") ||
    target.title !== "OpenGeni Rig Surface Validation"
  ) {
    throw validationError("browser did not observe the deterministic validation target");
  }
}

function assertComputerTargetBinding(
  target: ComputerTarget,
  session: PlacementComputerSession,
): void {
  if (
    target.computerSessionId !== session.computerSessionId ||
    target.controllerGeneration !== session.controllerGeneration
  ) {
    throw validationError("computer target returned another session/controller binding");
  }
}

function assertComputerObservationBinding(
  observation: ComputerObservation,
  session: PlacementComputerSession,
): void {
  if (observation.computerSessionId !== session.computerSessionId) {
    throw validationError("computer observation returned another session binding");
  }
  assertComputerTargetBinding(observation.target, session);
}

type ComputerPassedReceipt = Extract<
  RigPlatformSurfaceValidationReceiptValue["computer"],
  { status: "passed" }
>;
type ComputerImageEvidence = Omit<ComputerPassedReceipt, "actionOperationId">;

async function validateComputerFrame(
  frame: ComputerControlFrame,
  session: PlacementComputerSession,
  target: ComputerTarget,
  observation: ComputerObservation,
  dependencies: RigPlatformSurfaceValidationDependencies,
): Promise<ComputerImageEvidence> {
  if (frame.data.byteLength < 1 || frame.data.byteLength > COMPUTER_SCREENSHOT_MAX_BYTES) {
    throw validationError("computer image is empty or exceeds its byte limit");
  }
  const validated = validateComputerControlFrameEvidence(frame, {
    computerSessionId: session.computerSessionId,
    controllerGeneration: session.controllerGeneration,
    targetId: target.id,
  });
  const metadata = validated.metadata;
  if (
    metadata.targetGeneration !== target.targetGeneration ||
    metadata.frameId !== observation.frameId
  ) {
    throw validationError("computer image returned another target generation or frame");
  }
  const inspected = await dependencies.inspectImage(validated.data);
  const expectedFormat = validated.mediaType === "image/png" ? "png" : "jpeg";
  if (
    inspected.format !== expectedFormat ||
    inspected.width !== metadata.width ||
    inspected.height !== metadata.height
  ) {
    throw validationError("computer image bytes do not match their native metadata");
  }
  return {
    status: "passed",
    computerSessionId: session.computerSessionId,
    controllerGeneration: session.controllerGeneration,
    targetId: target.id,
    targetGeneration: target.targetGeneration,
    frameId: metadata.frameId,
    image: {
      mediaType: validated.mediaType,
      sizeBytes: validated.data.byteLength,
      width: metadata.width,
      height: metadata.height,
      sha256: metadata.sha256,
    },
  };
}

function cleanupFailure(primary: unknown, cleanup: unknown): Error {
  const cleanupError = cleanup instanceof Error ? cleanup : new Error(String(cleanup));
  if (primary === undefined) return cleanupError;
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  return new AggregateError(
    [primaryError, cleanupError],
    "Rig platform surface validation and cleanup both failed",
  );
}

async function endBrowserSession(
  input: RigPlatformSurfaceValidationInput,
  dependencies: RigPlatformSurfaceValidationDependencies,
  controller: SurfaceController,
  session: PlacementBrowserSession,
  primary: unknown,
): Promise<void> {
  try {
    await assertExactBinding(input, dependencies);
    await controller.endSession(session, { removeState: true });
    await assertExactBinding(input, dependencies);
  } catch (error) {
    throw cleanupFailure(primary, error);
  }
}

async function endComputerSession(
  input: RigPlatformSurfaceValidationInput,
  dependencies: RigPlatformSurfaceValidationDependencies,
  controller: SurfaceController,
  session: PlacementComputerSession,
  primary: unknown,
): Promise<void> {
  try {
    await assertExactBinding(input, dependencies);
    await controller.endComputerSession(session, { removeState: true });
    await assertExactBinding(input, dependencies);
  } catch (error) {
    throw cleanupFailure(primary, error);
  }
}

async function validateTerminal(
  input: RigPlatformSurfaceValidationInput,
  dependencies: RigPlatformSurfaceValidationDependencies,
): Promise<RigPlatformSurfaceValidationReceiptValue["terminal"]> {
  if (!input.settings.sandboxTerminalEnabled) return { status: "disabled" };
  await assertExactBinding(input, dependencies);
  const result = await input.commandRunner(input.established.session as TurnSandboxCommandSession, {
    cmd: [
      "set -eu",
      'test "$(id -u)" = 0',
      'test "$(pwd -P)" = /workspace',
      "test -t 0",
      `test "$(bun --version)" = ${TERMINAL_EXPECTED_BUN_VERSION}`,
      `bun -e 'if (Bun.version !== "${TERMINAL_EXPECTED_BUN_VERSION}") process.exit(1)'`,
      `printf 'cwd=%s\\nuid=%s\\nbun=%s\\ninteractive=yes\\n' "$(pwd -P)" "$(id -u)" "$(bun --version)"`,
    ].join("\n"),
    workdir: "/workspace",
    runAs: "root",
    tty: true,
    yieldTimeMs: input.settings.rigSetupTimeoutMs,
    maxOutputTokens: 4_000,
  });
  await assertExactBinding(input, dependencies);
  const output = sandboxCommandOutput(result);
  if (
    sandboxCommandExitCode(result) !== 0 ||
    !output.includes("cwd=/workspace") ||
    !output.includes("uid=0") ||
    !output.includes(`bun=${TERMINAL_EXPECTED_BUN_VERSION}`) ||
    !output.includes("interactive=yes")
  ) {
    throw validationError("the real interactive root terminal command path did not pass");
  }
  return {
    status: "passed",
    cwd: "/workspace",
    uid: 0,
    bunVersion: TERMINAL_EXPECTED_BUN_VERSION,
    interactive: true,
  };
}

async function validateBrowser(
  input: RigPlatformSurfaceValidationInput,
  dependencies: RigPlatformSurfaceValidationDependencies,
  controller: SurfaceController,
  generation: string,
): Promise<RigPlatformSurfaceValidationReceiptValue["browser"]> {
  const browserSessionId = dependencies.randomUUID();
  const controlToken = token("control", dependencies.randomUUID());
  const viewToken = token("view", dependencies.randomUUID());
  let session: PlacementBrowserSession | undefined;
  let primary: unknown;
  try {
    await assertExactBinding(input, dependencies);
    session = await controller.createSession({
      browserSessionId,
      controllerGeneration: generation,
      tokenGeneration: input.ownership.leaseEpoch,
      controlToken,
      viewToken,
      headed: true,
      initialUrl: SURFACE_TARGET_URL,
    });
    if (
      session.browserSessionId !== browserSessionId ||
      session.controllerGeneration !== generation
    ) {
      throw validationError("browser creation returned another session/controller binding");
    }
    assertBrowserObservationBinding(session.observation, session);
    assertDeterministicBrowserTarget(session.observation.target);
    const client: BrowserSessionClient = controller.sessionClient({
      reference: session,
      controlToken,
      viewToken,
    });
    await assertExactBinding(input, dependencies);
    const initialTargets = await client.listTargets();
    await assertExactBinding(input, dependencies);
    if (initialTargets.length < 1) throw validationError("browser returned no real targets");
    initialTargets.forEach((target) => assertBrowserTargetBinding(target, session!));
    const opened = await client.openTarget(`${SURFACE_TARGET_URL}%23opened`);
    await assertExactBinding(input, dependencies);
    assertBrowserObservationBinding(opened, session);
    assertDeterministicBrowserTarget(opened.target);
    const targets = await client.listTargets();
    await assertExactBinding(input, dependencies);
    if (!targets.some((target) => target.id === opened.target.id)) {
      throw validationError("browser did not list the target it opened");
    }
    targets.forEach((target) => assertBrowserTargetBinding(target, session!));
    const observed = await client.observe(opened.target.id);
    await assertExactBinding(input, dependencies);
    assertBrowserObservationBinding(observed, session);
    assertDeterministicBrowserTarget(observed.target);
    return {
      status: "passed",
      browserSessionId,
      controllerGeneration: generation,
      targetId: observed.target.id,
      observedTargetGeneration: observed.target.targetGeneration,
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (session) await endBrowserSession(input, dependencies, controller, session, primary);
  }
}

function assertCompletedAction(
  receipt: ComputerActionReceipt,
  session: PlacementComputerSession,
  target: ComputerTarget,
  operationId: string,
): void {
  if (
    receipt.operationId !== operationId ||
    receipt.computerSessionId !== session.computerSessionId ||
    receipt.controllerGeneration !== session.controllerGeneration ||
    receipt.targetId !== target.id ||
    receipt.state !== "completed"
  ) {
    throw validationError("computer benign action did not complete on the exact binding");
  }
}

async function validateComputer(
  input: RigPlatformSurfaceValidationInput,
  dependencies: RigPlatformSurfaceValidationDependencies,
  controller: SurfaceController,
  generation: string,
): Promise<RigPlatformSurfaceValidationReceiptValue["computer"]> {
  if (!input.settings.sandboxDesktopEnabled) return { status: "disabled" };
  const computerSessionId = dependencies.randomUUID();
  const controlToken = token("control", dependencies.randomUUID());
  const viewToken = token("view", dependencies.randomUUID());
  let session: PlacementComputerSession | undefined;
  let primary: unknown;
  try {
    await assertExactBinding(input, dependencies);
    session = await controller.createComputerSession({
      computerSessionId,
      controllerGeneration: generation,
      tokenGeneration: input.ownership.leaseEpoch,
      controlToken,
      viewToken,
    });
    if (
      session.computerSessionId !== computerSessionId ||
      session.controllerGeneration !== generation
    ) {
      throw validationError("computer creation returned another session/controller binding");
    }
    session.targets.forEach((target) => assertComputerTargetBinding(target, session!));
    const client: ComputerSessionClient = controller.computerSessionClient({
      reference: session,
      controlToken,
      viewToken,
    });
    const targets = await client.listTargets();
    await assertExactBinding(input, dependencies);
    targets.forEach((target) => assertComputerTargetBinding(target, session!));
    const target = targets.find((candidate) => candidate.kind === "screen");
    if (!target) throw validationError("computer returned no real screen target");
    const observation = await client.observe(target.id);
    await assertExactBinding(input, dependencies);
    assertComputerObservationBinding(observation, session);
    if (
      !observation.frameId ||
      !target.bounds ||
      target.bounds.width < 1 ||
      target.bounds.height < 1
    ) {
      throw validationError("computer screen observation lacks a usable native frame/bounds");
    }
    const frame = await client.capture(target.id, {
      format: "png",
      maxWidth: 1280,
      maxHeight: 800,
    });
    await assertExactBinding(input, dependencies);
    const evidence = await validateComputerFrame(frame, session, target, observation, dependencies);
    const operationId = dependencies.randomUUID();
    const receipt = await client.action({
      protocolVersion: 1,
      operationId,
      computerSessionId,
      controllerGeneration: generation,
      targetId: target.id,
      expectedTargetGeneration: target.targetGeneration,
      expectedObservationId: observation.observationId,
      expectedFrameId: observation.frameId,
      actor: { kind: "system", subjectId: "rig-platform-surface-validation" },
      action: {
        type: "pointer",
        frameId: observation.frameId,
        action: "move",
        x: Math.floor(
          target.bounds.x + Math.min(target.bounds.width - 1, Math.max(0, target.bounds.width / 2)),
        ),
        y: Math.floor(
          target.bounds.y +
            Math.min(target.bounds.height - 1, Math.max(0, target.bounds.height / 2)),
        ),
      },
    });
    await assertExactBinding(input, dependencies);
    assertCompletedAction(receipt, session, target, operationId);
    return { ...evidence, actionOperationId: operationId };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (session) await endComputerSession(input, dependencies, controller, session, primary);
  }
}

export async function runRigPlatformSurfaceValidation(
  input: RigPlatformSurfaceValidationInput,
  dependencies: RigPlatformSurfaceValidationDependencies = defaultDependencies,
): Promise<RigPlatformSurfaceValidationReceiptValue> {
  await assertExactBinding(input, dependencies);
  const terminal = await validateTerminal(input, dependencies);
  const generation = controllerGeneration(input);
  const adminToken = token("admin", dependencies.randomUUID());
  let controller: SurfaceController | undefined;
  let controllerProvisionAttempted = false;
  let primary: unknown;
  let primaryCaught = false;
  let receipt: RigPlatformSurfaceValidationReceiptValue | undefined;
  try {
    await assertExactBinding(input, dependencies);
    controllerProvisionAttempted = true;
    controller = (
      await dependencies.provisionController(
        input.established.session as BrowserControlPlacementSession,
        {
          adminToken,
          allowedOrigins: [],
          timeoutMs: input.settings.rigSetupTimeoutMs,
        },
      )
    ).client;
    await assertExactBinding(input, dependencies);
    const browser = await validateBrowser(input, dependencies, controller, generation);
    const computer = await validateComputer(input, dependencies, controller, generation);
    await assertExactBinding(input, dependencies);
    receipt = RigPlatformSurfaceValidationReceipt.parse({
      version: 1,
      checkedAt: dependencies.checkedAt(),
      binding: {
        leaseId: input.ownership.leaseId,
        sandboxGroupId: input.sandboxGroupId,
        leaseEpoch: input.ownership.leaseEpoch,
        workspaceGeneration: input.ownership.workspaceGeneration,
        instanceId: input.established.instanceId,
        backendId: input.established.backendId,
        rigVersionId: input.rigVersionId,
      },
      terminal,
      browser,
      computer,
    });
  } catch (error) {
    primary = error;
    primaryCaught = true;
  }
  let cleanup: unknown;
  let cleanupCaught = false;
  if (controllerProvisionAttempted) {
    try {
      await assertExactBinding(input, dependencies);
      await dependencies.tearDownController(input.established.session);
      await assertExactBinding(input, dependencies);
    } catch (error) {
      cleanup = error;
      cleanupCaught = true;
    }
  }
  if (primaryCaught) {
    if (cleanupCaught) throw cleanupFailure(primary, cleanup);
    throw primary;
  }
  if (cleanupCaught) throw cleanupFailure(undefined, cleanup);
  if (!receipt) throw validationError("the validation receipt was not produced");
  return receipt;
}
