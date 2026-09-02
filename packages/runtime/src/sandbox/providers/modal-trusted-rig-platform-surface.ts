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
  type TrustedRigPlatformSidecarPurpose,
} from "./trusted-rig-platform-surface";
import {
  assertTrustedRigPlatformRuntimeMatches,
  captureTrustedRigPlatformRuntimeManifest,
  type TrustedRigPlatformRuntimeManifest,
  type TrustedRigPlatformRuntimePathMetadata,
} from "./trusted-rig-platform-runtime-integrity";
import type {
  ProviderTrustedRigPlatformRuntimeInspectionInput,
  ProviderTrustedRigPlatformSurfaceInput,
} from "./types";

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
    readBytes(path: string): Promise<Uint8Array>;
    stat(path: string): Promise<ModalFileInfo>;
    listFiles(path: string): AsyncIterable<ModalFileInfo>;
    writeBytes(data: Uint8Array | ArrayBuffer | Buffer, path: string): Promise<void>;
  };
  terminate(): Promise<void>;
  terminate(options: { wait: true; timeoutMs?: number; signal?: AbortSignal }): Promise<number>;
};

type ModalImage = { imageId?: string };
type ModalDeadlineOptions = { timeoutMs?: number; signal?: AbortSignal };
type ModalFileInfo = {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink";
  readonly size: number;
  readonly mode: number;
  readonly symlinkTarget: string | null;
};
type ModalFilesystem = {
  readBytes(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<ModalFileInfo>;
  listFiles(path: string): AsyncIterable<ModalFileInfo>;
};

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
    filesystem?: ModalFilesystem;
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

async function modalFilesystemOperation<T>(input: {
  operation: () => Promise<T>;
  signal?: AbortSignal;
  deadlineAtMs: number;
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
      () => finish(new Error("Modal trusted Rig runtime inspection deadline was reached")),
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
    void operation.catch(() => undefined);
    throw winner.reason;
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort();
  }
}

function modalPathMetadata(info: ModalFileInfo): TrustedRigPlatformRuntimePathMetadata {
  return {
    path: info.path,
    type: info.type,
    sizeBytes: info.size,
    mode: info.mode,
    symlinkTarget: info.symlinkTarget,
  };
}

async function captureModalTrustedRigPlatformRuntime(input: {
  settings: ProviderTrustedRigPlatformRuntimeInspectionInput["settings"];
  filesystem: ModalFilesystem;
  deadlineAtMs: number;
  signal?: AbortSignal;
}): Promise<TrustedRigPlatformRuntimeManifest> {
  const run = async <T>(operation: () => Promise<T>): Promise<T> =>
    await modalFilesystemOperation({
      operation,
      deadlineAtMs: input.deadlineAtMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  return await captureTrustedRigPlatformRuntimeManifest({
    settings: input.settings,
    ...(input.signal ? { signal: input.signal } : {}),
    inspectPath: async (path) => {
      try {
        return modalPathMetadata(await run(async () => await input.filesystem.stat(path)));
      } catch (error) {
        if (isNotFound(error)) {
          return { path, type: "missing", sizeBytes: 0, mode: 0, symlinkTarget: null };
        }
        throw error;
      }
    },
    readBytes: async (path) => await run(async () => await input.filesystem.readBytes(path)),
    listDirectory: async (path) => {
      const entries: string[] = [];
      await run(async () => {
        for await (const info of input.filesystem.listFiles(path)) {
          const prefix = `${path}/`;
          if (!info.path.startsWith(prefix) || info.path.slice(prefix.length).includes("/")) {
            throw new Error(`Modal returned a non-child loader inventory path for ${path}`);
          }
          entries.push(info.path.slice(prefix.length));
        }
      });
      return entries;
    },
  });
}

function modalSidecarName(
  input: ProviderTrustedRigPlatformSurfaceInput,
  purpose: TrustedRigPlatformSidecarPurpose,
): string {
  const digest = createHash("sha256")
    .update(
      [
        input.instanceId,
        input.leaseId,
        String(input.leaseEpoch),
        String(input.workspaceGeneration),
        input.rigVersionId,
        purpose,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 28);
  return `opengeni-rig-${purpose}-${digest}`;
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
  purpose: TrustedRigPlatformSidecarPurpose,
): Promise<TrustedRigPlatformSidecar> {
  const session = input.session as ModalRigSession;
  const sandboxId = session.state?.sandboxId;
  const imageId = session.state?.imageId;
  const images = session.modal?.images;
  const candidateFilesystem = session.sandbox?.filesystem;
  const sidecars = session.sandbox?.experimentalSidecars;
  if (
    sandboxId !== input.instanceId ||
    !imageId ||
    (input.expectedProviderImageId !== undefined && input.expectedProviderImageId !== imageId) ||
    typeof images?.fromId !== "function" ||
    typeof candidateFilesystem?.readBytes !== "function" ||
    typeof candidateFilesystem?.stat !== "function" ||
    typeof candidateFilesystem?.listFiles !== "function" ||
    !sidecars ||
    typeof sidecars.create !== "function" ||
    typeof sidecars.get !== "function" ||
    typeof session.resolveExposedPort !== "function"
  ) {
    throw new Error("Modal trusted Rig validation requires an exact sidecar-capable session");
  }
  const runtimeAuthorityImageId = input.runtimeAuthorityImageId ?? imageId;
  if (!runtimeAuthorityImageId) {
    throw new Error("Modal trusted Rig validation requires a runtime authority image");
  }
  const assertCandidateRuntimeIntegrity = async (options: {
    timeoutMs: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
  }): Promise<void> => {
    if (session.state?.sandboxId !== input.instanceId || session.state?.imageId !== imageId) {
      throw new Error("Modal trusted Rig candidate changed its immutable image binding");
    }
    const deadlineAtMs = Math.min(
      Date.now() + options.timeoutMs,
      options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    const actual = await captureModalTrustedRigPlatformRuntime({
      settings: input.settings,
      filesystem: candidateFilesystem,
      deadlineAtMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertTrustedRigPlatformRuntimeMatches(input.runtimeManifest, actual);
  };
  const name = modalSidecarName(input, purpose);
  const deadlineAtMs = operationDeadlineAt(operation);
  try {
    await assertCandidateRuntimeIntegrity({
      timeoutMs: remainingMs(deadlineAtMs),
      deadlineAtMs,
      ...(operation.signal ? { signal: operation.signal } : {}),
    });
    const image = await images.fromId(
      runtimeAuthorityImageId,
      deadlineOptions(deadlineAtMs, operation.signal),
    );
    if (image.imageId && image.imageId !== runtimeAuthorityImageId) {
      throw new Error("Modal trusted Rig validation resolved another immutable image");
    }
    const create = async (): Promise<ModalSidecar> =>
      await sidecars.create(name, image, {
        command: ["/bin/sh", "-c", "exec /usr/bin/sleep infinity"],
        workdir: "/workspace",
        ...deadlineOptions(deadlineAtMs, operation.signal),
      });
    let container: ModalSidecar;
    try {
      container = await create();
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await cleanupModalSidecarByName(sidecars, name, operation);
      container = await create();
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
    try {
      const actualRuntimeManifest = await captureModalTrustedRigPlatformRuntime({
        settings: input.settings,
        filesystem: container.filesystem,
        deadlineAtMs,
        ...(operation.signal ? { signal: operation.signal } : {}),
      });
      assertTrustedRigPlatformRuntimeMatches(input.runtimeManifest, actualRuntimeManifest);
    } catch (error) {
      await terminate({ deadlineAtMs }).catch(() => undefined);
      throw error;
    }
    const assertRuntimeIntegrity: TrustedRigPlatformSidecar["assertRuntimeIntegrity"] = async (
      options,
    ) => {
      if (terminated) throw new Error("Modal trusted Rig sidecar is terminated");
      await assertCandidateRuntimeIntegrity(options);
      const integrityDeadlineAtMs = Math.min(
        Date.now() + options.timeoutMs,
        options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      );
      const authority = await captureModalTrustedRigPlatformRuntime({
        settings: input.settings,
        filesystem: container.filesystem,
        deadlineAtMs: integrityDeadlineAtMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      assertTrustedRigPlatformRuntimeMatches(input.runtimeManifest, authority);
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
          const process = await container.exec(["/bin/sh", "-c", args.cmd], {
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
      assertRuntimeIntegrity,
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

export async function inspectModalTrustedRigPlatformRuntime(
  input: ProviderTrustedRigPlatformRuntimeInspectionInput,
) {
  const session = input.session as ModalRigSession;
  const providerImageId = session.state?.imageId;
  const filesystem = session.sandbox?.filesystem;
  if (
    session.state?.sandboxId !== input.instanceId ||
    !providerImageId ||
    (input.expectedProviderImageId !== undefined &&
      input.expectedProviderImageId !== providerImageId) ||
    typeof filesystem?.readBytes !== "function" ||
    typeof filesystem?.stat !== "function" ||
    typeof filesystem?.listFiles !== "function"
  ) {
    throw new Error(
      "Modal trusted Rig runtime inspection requires the exact live provider filesystem",
    );
  }
  const deadlineAtMs = Math.min(
    Date.now() + input.timeoutMs,
    input.deadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
  return await captureModalTrustedRigPlatformRuntime({
    settings: input.settings,
    filesystem,
    deadlineAtMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
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
  const runtimeAuthorityImageId = input.runtimeAuthorityImageId ?? providerImageId;
  if (!runtimeAuthorityImageId) {
    throw new Error("Modal trusted Rig validation requires a runtime authority image id");
  }
  return createTrustedRigPlatformSurface({
    binding: {
      authority: "deployment_control_plane",
      backendId: "modal",
      instanceId: input.instanceId,
      providerImage: input.providerImage,
      providerImageId,
      runtimeAuthorityImageId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      workspaceGeneration: input.workspaceGeneration,
      sandboxGroupId: input.sandboxGroupId,
      rigVersionId: input.rigVersionId,
      runtimeManifestDigest: input.runtimeManifest.digest,
    },
    desktopEnabled: input.settings.sandboxDesktopEnabled,
    createSidecar: async (operation, purpose) =>
      await createModalSidecar(input, operation, purpose),
  });
}
