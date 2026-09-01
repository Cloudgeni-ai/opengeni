import { createHash } from "node:crypto";
import type { ExposedPortEndpoint } from "@openai/agents/sandbox";
import type {
  BrowserControlPlacementSession,
  TrustedRigPlatformSurface,
  TrustedRigPlatformSurfaceOperation,
} from "../browser-control-client";
import {
  createTrustedRigPlatformSurface,
  type TrustedRigPlatformSidecar,
} from "./trusted-rig-platform-surface";
import type { ProviderTrustedRigPlatformSurfaceInput } from "./types";

type ModalProcess = {
  stdout: ReadableStream<string>;
  stderr: ReadableStream<string>;
  wait(): Promise<number>;
};

type ModalSidecar = {
  readonly containerId: string;
  readonly containerName: string;
  exec(
    command: string[],
    options?: {
      mode?: "text";
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore";
      workdir?: string;
      timeoutMs?: number;
      pty?: boolean;
    },
  ): Promise<ModalProcess>;
  filesystem: {
    writeBytes(data: Uint8Array | ArrayBuffer | Buffer, path: string): Promise<void>;
  };
  terminate(): Promise<void>;
  terminate(options: { wait: true; timeoutMs?: number; signal?: AbortSignal }): Promise<number>;
};

type ModalImage = { imageId?: string };
type ModalDeadlineOptions = { timeoutMs?: number; signal?: AbortSignal };

type ModalRigSession = BrowserControlPlacementSession & {
  modal?: {
    images?: {
      fromId?: (
        imageId: string,
        options?: ModalDeadlineOptions,
      ) => ModalImage | Promise<ModalImage>;
    };
  };
  sandbox?: {
    experimentalSidecars?: {
      create(
        name: string,
        image: ModalImage,
        options?: { command?: string[]; workdir?: string } & ModalDeadlineOptions,
      ): Promise<ModalSidecar>;
      get(
        name: string,
        options?: { includeTerminated?: boolean } & ModalDeadlineOptions,
      ): Promise<ModalSidecar>;
    };
  };
  state?: { sandboxId?: string; imageId?: string };
};

function remainingMs(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new Error("Modal trusted sidecar deadline was reached");
  return Math.max(1, Math.min(10 * 60_000, remaining));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Modal trusted sidecar operation aborted");
}

async function modalOperation<T>(input: {
  operation: () => Promise<T>;
  signal?: AbortSignal;
  deadlineAtMs: number;
  terminate: () => Promise<void>;
}): Promise<T> {
  input.signal?.throwIfAborted();
  const operation = input.operation();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let removeAbort = (): void => undefined;
  const aborted = new Promise<{ reason: unknown }>((resolve) => {
    const finish = (reason: unknown): void => resolve({ reason });
    let timeoutMs: number;
    try {
      timeoutMs = remainingMs(input.deadlineAtMs);
    } catch (error) {
      finish(error);
      return;
    }
    timer = setTimeout(
      () => finish(new Error("Modal trusted sidecar deadline was reached")),
      timeoutMs,
    );
    if (input.signal?.aborted) {
      finish(abortReason(input.signal));
    } else if (input.signal) {
      const onAbort = (): void => finish(abortReason(input.signal!));
      input.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => input.signal?.removeEventListener("abort", onAbort);
    }
  });
  try {
    const winner = await Promise.race([
      operation.then((value) => ({ kind: "completed" as const, value })),
      aborted.then(({ reason }) => ({ kind: "aborted" as const, reason })),
    ]);
    if (winner.kind === "completed") return winner.value;
    await input.terminate().catch(() => undefined);
    void operation.catch(() => undefined);
    throw winner.reason;
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}

function modalSidecarName(input: ProviderTrustedRigPlatformSurfaceInput): string {
  const digest = createHash("sha256")
    .update(
      [
        input.instanceId,
        input.leaseId,
        String(input.leaseEpoch),
        String(input.workspaceGeneration),
        input.rigVersionId,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 28);
  return `opengeni-rig-surface-${digest}`;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && error.name === "AlreadyExistsError";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}

function operationDeadlineAt(operation: TrustedRigPlatformSurfaceOperation): number {
  return Math.min(
    Date.now() + operation.timeoutMs,
    operation.deadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
}

function deadlineOptions(deadlineAtMs: number, signal?: AbortSignal): ModalDeadlineOptions {
  return {
    timeoutMs: remainingMs(deadlineAtMs),
    ...(signal ? { signal } : {}),
  };
}

async function cleanupModalSidecarByName(
  sidecars: NonNullable<NonNullable<ModalRigSession["sandbox"]>["experimentalSidecars"]>,
  name: string,
  operation: TrustedRigPlatformSurfaceOperation,
): Promise<void> {
  const deadlineAtMs = Date.now() + Math.max(1, Math.min(15_000, operation.timeoutMs));
  try {
    const existing = await sidecars.get(name, {
      includeTerminated: false,
      ...deadlineOptions(deadlineAtMs),
    });
    await existing.terminate({ wait: true, ...deadlineOptions(deadlineAtMs) });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function createModalSidecar(
  input: ProviderTrustedRigPlatformSurfaceInput,
  operation: TrustedRigPlatformSurfaceOperation,
): Promise<TrustedRigPlatformSidecar> {
  const session = input.session as ModalRigSession;
  const sandboxId = session.state?.sandboxId;
  const imageId = session.state?.imageId;
  const images = session.modal?.images;
  const sidecars = session.sandbox?.experimentalSidecars;
  if (
    sandboxId !== input.instanceId ||
    !imageId ||
    (input.expectedProviderImageId !== undefined && input.expectedProviderImageId !== imageId) ||
    typeof images?.fromId !== "function" ||
    !sidecars ||
    typeof sidecars.create !== "function" ||
    typeof sidecars.get !== "function" ||
    typeof session.resolveExposedPort !== "function"
  ) {
    throw new Error("Modal trusted Rig validation requires an exact sidecar-capable session");
  }
  const name = modalSidecarName(input);
  const deadlineAtMs = operationDeadlineAt(operation);
  try {
    const image = await images.fromId(imageId, deadlineOptions(deadlineAtMs, operation.signal));
    if (image.imageId && image.imageId !== imageId) {
      throw new Error("Modal trusted Rig validation resolved another immutable image");
    }
    let container: ModalSidecar;
    try {
      container = await sidecars.create(name, image, {
        command: ["/bin/sh", "-lc", "exec sleep infinity"],
        workdir: "/workspace",
        ...deadlineOptions(deadlineAtMs, operation.signal),
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      container = await sidecars.get(name, {
        includeTerminated: false,
        ...deadlineOptions(deadlineAtMs, operation.signal),
      });
    }
    if (container.containerName !== name || !container.containerId) {
      await container
        .terminate({ wait: true, ...deadlineOptions(deadlineAtMs) })
        .catch(() => undefined);
      throw new Error("Modal trusted Rig sidecar returned another container identity");
    }

    let terminated = false;
    let terminatePromise: Promise<void> | null = null;
    const terminate = async (options?: {
      timeoutMs?: number;
      deadlineAtMs?: number;
    }): Promise<void> => {
      if (!terminatePromise) {
        terminated = true;
        const terminateDeadlineAtMs = Math.min(
          Date.now() + (options?.timeoutMs ?? 15_000),
          options?.deadlineAtMs ?? Number.POSITIVE_INFINITY,
        );
        terminatePromise = container
          .terminate({ wait: true, ...deadlineOptions(terminateDeadlineAtMs) })
          .then(() => undefined)
          .catch((error) => {
            if (isNotFound(error)) return;
            throw error;
          });
      }
      await terminatePromise;
    };
    const execute = async (
      args: Parameters<NonNullable<BrowserControlPlacementSession["exec"]>>[0],
    ) => {
      if (terminated) throw new Error("Modal trusted Rig sidecar is terminated");
      const deadline = Math.min(
        args.deadlineAtMs ?? Number.POSITIVE_INFINITY,
        Date.now() + (args.timeoutMs ?? args.yieldTimeMs ?? operation.timeoutMs),
      );
      return await modalOperation({
        ...(args.signal ? { signal: args.signal } : {}),
        deadlineAtMs: deadline,
        terminate,
        operation: async () => {
          const process = await container.exec(["/bin/sh", "-lc", args.cmd], {
            mode: "text",
            stdout: "pipe",
            stderr: "pipe",
            workdir: args.workdir ?? "/workspace",
            timeoutMs: remainingMs(deadline),
            pty: args.tty ?? false,
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.wait(),
          ]);
          return { output: `${stdout}${stderr}`, stdout, stderr, exitCode };
        },
      });
    };
    const writePlacementPrivate: NonNullable<
      BrowserControlPlacementSession["writePlacementPrivate"]
    > = async (args) => {
      if (terminated) throw new Error("Modal trusted Rig sidecar is terminated");
      const deadline = Math.min(
        args.deadlineAtMs ?? Number.POSITIVE_INFINITY,
        Date.now() + (args.timeoutMs ?? operation.timeoutMs),
      );
      const bytes = typeof args.content === "string" ? Buffer.from(args.content) : args.content;
      await modalOperation({
        ...(args.signal ? { signal: args.signal } : {}),
        deadlineAtMs: deadline,
        terminate,
        operation: async () => await container.filesystem.writeBytes(bytes, args.path),
      });
      return bytes.byteLength;
    };

    return {
      sidecarId: container.containerId,
      exec: execute,
      writePlacementPrivate,
      writeFile: writePlacementPrivate,
      resolveExposedPort: async (port, options) =>
        (await session.resolveExposedPort!(port, options as never)) as ExposedPortEndpoint,
      finalizeOpStreamOps: async () => undefined,
      terminate,
    };
  } catch (error) {
    await cleanupModalSidecarByName(sidecars, name, operation).catch(() => undefined);
    throw error;
  }
}

export async function createModalTrustedRigPlatformSurface(
  input: ProviderTrustedRigPlatformSurfaceInput,
): Promise<TrustedRigPlatformSurface> {
  const session = input.session as ModalRigSession;
  const providerImageId = session.state?.imageId;
  if (
    !providerImageId ||
    (input.expectedProviderImageId !== undefined &&
      input.expectedProviderImageId !== providerImageId)
  ) {
    throw new Error("Modal trusted Rig validation requires an immutable provider image id");
  }
  return createTrustedRigPlatformSurface({
    binding: {
      authority: "deployment_control_plane",
      backendId: "modal",
      instanceId: input.instanceId,
      providerImage: input.providerImage,
      providerImageId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      workspaceGeneration: input.workspaceGeneration,
      sandboxGroupId: input.sandboxGroupId,
      rigVersionId: input.rigVersionId,
    },
    desktopEnabled: input.settings.sandboxDesktopEnabled,
    createSidecar: async (operation) => await createModalSidecar(input, operation),
  });
}
