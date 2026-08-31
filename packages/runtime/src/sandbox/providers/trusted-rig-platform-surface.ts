import { createHash } from "node:crypto";
import {
  BrowserControlTransportError,
  provisionBrowserControlClient,
  type BrowserControlPlacementSession,
  type TrustedRigPlatformSurface,
  type TrustedRigPlatformSurfaceBinding,
  type TrustedRigPlatformSurfaceOperation,
} from "../browser-control-client";

export type TrustedRigPlatformSidecar = BrowserControlPlacementSession & {
  readonly sidecarId: string;
  terminate(options: { timeoutMs: number; deadlineAtMs?: number }): Promise<void>;
};

export type TrustedRigPlatformSidecarFactory = (
  input: TrustedRigPlatformSurfaceOperation,
) => Promise<TrustedRigPlatformSidecar>;

function sameOperation(
  binding: TrustedRigPlatformSurfaceBinding,
  input: TrustedRigPlatformSurfaceOperation,
): boolean {
  return (
    input.backendId === binding.backendId &&
    input.instanceId === binding.instanceId &&
    input.providerImage === binding.providerImage &&
    input.providerImageId === binding.providerImageId &&
    input.leaseId === binding.leaseId &&
    input.leaseEpoch === binding.leaseEpoch &&
    input.workspaceGeneration === binding.workspaceGeneration &&
    input.sandboxGroupId === binding.sandboxGroupId &&
    input.rigVersionId === binding.rigVersionId
  );
}

function assertOperation(
  binding: TrustedRigPlatformSurfaceBinding,
  input: TrustedRigPlatformSurfaceOperation,
): void {
  if (!sameOperation(binding, input)) {
    throw new Error("trusted Rig platform surface operation changed its exact binding");
  }
  input.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    (input.deadlineAtMs !== undefined && input.deadlineAtMs <= Date.now())
  ) {
    throw new BrowserControlTransportError("trusted Rig platform surface deadline was reached");
  }
}

function operationDeadline(input: TrustedRigPlatformSurfaceOperation): number {
  return Math.min(
    Date.now() + input.timeoutMs,
    input.deadlineAtMs === undefined ? Number.POSITIVE_INFINITY : input.deadlineAtMs,
  );
}

function remainingMs(deadlineAtMs: number): number {
  const remaining = Math.floor(deadlineAtMs - Date.now());
  if (remaining <= 0) {
    throw new BrowserControlTransportError("trusted Rig platform surface deadline was reached");
  }
  return Math.max(1, Math.min(10 * 60_000, remaining));
}

async function terminateSidecar(
  sidecar: TrustedRigPlatformSidecar,
  input: TrustedRigPlatformSurfaceOperation,
): Promise<void> {
  const cleanupDeadlineAtMs = Date.now() + Math.max(1, Math.min(15_000, input.timeoutMs));
  await sidecar.terminate({
    timeoutMs: remainingMs(cleanupDeadlineAtMs),
    deadlineAtMs: cleanupDeadlineAtMs,
  });
}

async function settleCreation(
  create: Promise<TrustedRigPlatformSidecar>,
  input: TrustedRigPlatformSurfaceOperation,
): Promise<TrustedRigPlatformSidecar> {
  const deadlineAtMs = operationDeadline(input);
  const controller = new AbortController();
  const onAbort = (): void =>
    controller.abort(input.signal?.reason ?? new Error("operation aborted"));
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new BrowserControlTransportError("trusted Rig platform surface deadline was reached"),
      ),
    remainingMs(deadlineAtMs),
  );
  try {
    const winner = await Promise.race([
      create.then((sidecar) => ({ kind: "created" as const, sidecar })),
      new Promise<{ kind: "aborted"; reason: unknown }>((resolve) => {
        const settle = (): void => resolve({ kind: "aborted", reason: controller.signal.reason });
        controller.signal.addEventListener("abort", settle, { once: true });
      }),
    ]);
    if (winner.kind === "created") return winner.sidecar;

    // Provider sidecar creation is not universally cancellable. Do not return
    // while it can still materialize: await the exact request, terminate any
    // late sidecar, then surface the original deadline/cancellation reason.
    let late: TrustedRigPlatformSidecar | null = null;
    try {
      late = await create;
    } finally {
      if (late) await terminateSidecar(late, input).catch(() => undefined);
    }
    throw winner.reason;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function commandOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const value = result as { output?: unknown; stdout?: unknown; stderr?: unknown };
  return [value.output, value.stdout, value.stderr]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n");
}

function commandExitCode(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const value = (result as { exitCode?: unknown }).exitCode;
  return typeof value === "number" ? value : null;
}

function terminalProbeCommand(): string {
  return [
    "set -eu",
    'test "$PWD" = /workspace',
    'test "$(id -u)" = 0',
    'test "$(bun --version)" = 1.4.0',
    "test -t 1",
    "printf '%s\\n' OPENGENI_TRUSTED_TERMINAL_OK",
  ].join("\n");
}

function desktopStartupCommand(binding: TrustedRigPlatformSurfaceBinding): string {
  const suffix = createHash("sha256")
    .update(`${binding.leaseId}\0${binding.leaseEpoch}\0${binding.workspaceGeneration}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return [
    "set -eu",
    `export HOME=/tmp/opengeni-rig-surface-home-${suffix}`,
    'install -d -m 0700 "$HOME"',
    "STREAM_PORT=6080 DESKTOP_W=1280 DESKTOP_H=800 opengeni-desktop-up",
  ].join("\n");
}

export function createTrustedRigPlatformSurface(input: {
  binding: TrustedRigPlatformSurfaceBinding;
  desktopEnabled: boolean;
  createSidecar: TrustedRigPlatformSidecarFactory;
}): TrustedRigPlatformSurface {
  const binding = Object.freeze({ ...input.binding });
  let sidecar: TrustedRigPlatformSidecar | null = null;
  let creating: Promise<TrustedRigPlatformSidecar> | null = null;

  const ensureSidecar = async (
    operation: TrustedRigPlatformSurfaceOperation,
  ): Promise<TrustedRigPlatformSidecar> => {
    assertOperation(binding, operation);
    if (sidecar) return sidecar;
    if (!creating) creating = input.createSidecar(operation);
    try {
      sidecar = await settleCreation(creating, operation);
      return sidecar;
    } finally {
      creating = null;
    }
  };

  const discardSidecar = async (operation: TrustedRigPlatformSurfaceOperation): Promise<void> => {
    const current = sidecar;
    sidecar = null;
    if (current) await terminateSidecar(current, operation);
  };

  return Object.freeze({
    binding,
    async runTerminalProbe(operation) {
      assertOperation(binding, operation);
      const current = await ensureSidecar(operation);
      try {
        const result = await current.exec!({
          cmd: terminalProbeCommand(),
          workdir: "/workspace",
          tty: true,
          yieldTimeMs: operation.timeoutMs,
          timeoutMs: operation.timeoutMs,
          ...(operation.deadlineAtMs === undefined ? {} : { deadlineAtMs: operation.deadlineAtMs }),
          ...(operation.signal ? { signal: operation.signal } : {}),
          maxOutputTokens: 2_000,
        });
        if (
          commandExitCode(result) !== 0 ||
          !commandOutput(result).includes("OPENGENI_TRUSTED_TERMINAL_OK")
        ) {
          throw new Error("trusted Rig platform terminal probe failed");
        }
        return { cwd: "/workspace", uid: 0, bunVersion: "1.4.0", interactive: true };
      } catch (error) {
        await discardSidecar(operation).catch(() => undefined);
        throw error;
      }
    },
    async provisionController(operation) {
      assertOperation(binding, operation);
      const current = await ensureSidecar(operation);
      try {
        if (input.desktopEnabled) {
          const result = await current.exec!({
            cmd: desktopStartupCommand(binding),
            workdir: "/workspace",
            yieldTimeMs: operation.timeoutMs,
            timeoutMs: operation.timeoutMs,
            ...(operation.deadlineAtMs === undefined
              ? {}
              : { deadlineAtMs: operation.deadlineAtMs }),
            ...(operation.signal ? { signal: operation.signal } : {}),
            maxOutputTokens: 4_000,
          });
          if (commandExitCode(result) !== 0) {
            throw new Error(`trusted Rig desktop startup failed: ${commandOutput(result)}`);
          }
        }
        const provisioned = await provisionBrowserControlClient(current, {
          adminToken: operation.adminToken,
          allowedOrigins: operation.allowedOrigins,
          timeoutMs: operation.timeoutMs,
          ...(operation.deadlineAtMs === undefined ? {} : { deadlineAtMs: operation.deadlineAtMs }),
          ...(operation.signal ? { signal: operation.signal } : {}),
        });
        return { client: provisioned.client };
      } catch (error) {
        await discardSidecar(operation).catch(() => undefined);
        throw error;
      }
    },
    async tearDownController(operation) {
      assertOperation(binding, operation);
      await discardSidecar(operation);
    },
  });
}
