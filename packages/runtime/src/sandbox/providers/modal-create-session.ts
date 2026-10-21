import {
  ModalImageSelector,
  ModalSandboxSession,
  buildModalCloudBucketMountConfig,
  isModalCloudBucketMountEntry,
  type ModalSandboxClient,
  type ModalSandboxClientOptions,
  type ModalSandboxSessionState,
} from "@openai/agents-extensions/sandbox/modal";
import {
  Manifest,
  isMount,
  normalizeSandboxClientCreateArgs,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
  type Entry,
} from "@openai/agents/sandbox";
import { UserError } from "@openai/agents-core";
import {
  assertHostPathGrantsRebound,
  materializeEnvironment,
  readOptionalString,
} from "@openai/agents-core/sandbox/internal";
import { Sandbox, type CloudBucketMount, type Image, type ModalClient } from "modal";
import { createModalProviderCreateBoundary, type ModalCreateIntent } from "./modal-create-boundary";
import { modalCommandStartCleanupIsSafe } from "./modal-command-start-errors";
import {
  cachedModalApp,
  cachedModalImage,
  sharedModalClient,
  withModalCreateBoundary,
} from "./modal-shared-client";

/** The shared process-wide client is never closed by one create. */
const SHARED_CLIENT_TRANSPORT: Pick<ModalClient, "close"> = { close() {} };

export type ModalCreateLifecycle = {
  beforeDispatch: (intent: ModalCreateIntent, providerContext: unknown) => Promise<void>;
  onCreated: (session: ModalSandboxSession, intent: ModalCreateIntent) => Promise<void>;
};

/** The pinned Agents adapter options plus Opengeni-owned physical-create
 * placement. `regions` is applied only by Opengeni's own create boundary; the
 * pinned adapter never sees or persists it, and resume keeps a box's placement. */
export type OpenGeniModalSandboxClientOptions = Partial<ModalSandboxClientOptions> & {
  regions?: string[];
};

/** Release local transport after a failed create, but never stop a box whose
 * original setup invocation may still be writing behind its durable fence. */
export async function releaseModalCreateFailure(
  session: Pick<ModalSandboxSession, "close"> | undefined,
  modal: Pick<ModalClient, "close">,
  error: unknown,
): Promise<never> {
  try {
    if (session && modalCommandStartCleanupIsSafe(error)) {
      try {
        await session.close();
      } catch (cleanupError) {
        // eslint-disable-next-line preserve-caught-error -- Both failures remain exact AggregateError causes.
        throw new AggregateError(
          [error, cleanupError],
          "Modal create failed and cleanup needs reconciliation",
          { cause: cleanupError },
        );
      }
    }
  } finally {
    modal.close();
  }
  throw error;
}

function defined<T extends object>(
  value: T,
): {
  [K in keyof T]?: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function unsupported(feature: string): never {
  throw new SandboxUnsupportedFeatureError(`Modal create does not support ${feature}`, {
    provider: "modal",
    feature,
  });
}

function validateManifest(manifest: Manifest): void {
  if (manifest.users.length) unsupported("manifest.users");
  if (manifest.groups.length) unsupported("manifest.groups");
  if (manifest.extraPathGrants.length) unsupported("manifest.extraPathGrants");
  for (const { entry } of manifest.iterEntries()) {
    if (entry.permissions !== undefined) unsupported("entry.permissions");
    if (entry.group !== undefined) unsupported("entry.group");
    if (isMount(entry) && !isModalCloudBucketMountEntry(entry)) unsupported("entry.mountStrategy");
  }
}

function withoutMounts(manifest: Manifest): Manifest {
  const entries = (source: Record<string, Entry>): Record<string, Entry> =>
    Object.fromEntries(
      Object.entries(source)
        .filter(([, entry]) => !isMount(entry))
        .map(([path, entry]) => [
          path,
          entry.type === "dir" && entry.children
            ? { ...structuredClone(entry), children: entries(entry.children) }
            : structuredClone(entry),
        ]),
    );
  return new Manifest({
    version: manifest.version,
    root: manifest.root,
    entries: entries(manifest.entries),
    environment: Object.fromEntries(
      Object.entries(manifest.environment).map(([key, value]) => [key, value.init()]),
    ),
    users: structuredClone(manifest.users),
    groups: structuredClone(manifest.groups),
    extraPathGrants: structuredClone(manifest.extraPathGrants),
    remoteMountCommandAllowlist: [...manifest.remoteMountCommandAllowlist],
  });
}

/** Native Modal cloud-bucket mounts for a manifest, resolved on `modal`. */
export async function resolveModalCloudBucketMounts(
  modal: ModalClient,
  source: Manifest,
  defaultSecretName: string | undefined,
  /** Resume keeps the pinned adapter's behavior: ignore foreign mounts. */
  foreignMounts: "reject" | "skip" = "reject",
): Promise<Record<string, CloudBucketMount> | undefined> {
  const result: Record<string, CloudBucketMount> = {};
  for (const { entry, mountPath } of source.mountTargets()) {
    if (!isModalCloudBucketMountEntry(entry)) {
      if (foreignMounts === "skip") continue;
      unsupported("entry.mountStrategy");
    }
    const config = buildModalCloudBucketMountConfig(
      entry,
      defined({
        secretName: readOptionalString(entry.mountStrategy, "secretName") ?? defaultSecretName,
        secretEnvironmentName: readOptionalString(entry.mountStrategy, "secretEnvironmentName"),
      }),
    );
    const secret = config.secretName
      ? await modal.secrets.fromName(
          config.secretName,
          defined({
            environment: config.secretEnvironmentName,
          }),
        )
      : config.credentials
        ? await modal.secrets.fromObject(config.credentials)
        : undefined;
    result[mountPath] = modal.cloudBucketMounts.create(
      config.bucketName,
      defined({
        bucketEndpointUrl: config.bucketEndpointUrl,
        keyPrefix: config.keyPrefix,
        readOnly: config.readOnly,
        secret,
      }),
    );
  }
  return Object.keys(result).length ? result : undefined;
}

/** Own physical creation while retaining the pinned SDK's public session API.
 * Its ordinary create() applies the manifest before exposing the instance ID,
 * which is too late for a durable worker lease. No global SDK monkey-patching.
 */
export async function createModalSessionWithLifecycle(
  defaults: OpenGeniModalSandboxClientOptions,
  args: Parameters<ModalSandboxClient["create"]>[0],
  lifecycle: ModalCreateLifecycle,
  installPolicy: (session: ModalSandboxSession) => ModalSandboxSession,
): Promise<ModalSandboxSession> {
  const create = normalizeSandboxClientCreateArgs(args);
  if (create.snapshot !== undefined) unsupported("snapshot");
  const overrides = create.options as OpenGeniModalSandboxClientOptions | undefined;
  const options = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== null && value !== undefined) Object.assign(options, { [key]: value });
  }
  options.env = { ...defaults.env, ...overrides?.env };
  if (options.sandbox) unsupported("existing sandbox selector in physical create");
  if (!options.appName?.trim()) throw new Error("Modal create requires a non-empty appName");
  if (
    options.nativeCloudBucketSecretName !== undefined &&
    !options.nativeCloudBucketSecretName.trim()
  ) {
    throw new Error("Modal nativeCloudBucketSecretName must be non-empty");
  }
  const workspacePersistence = options.workspacePersistence ?? "tar";
  if (!["tar", "snapshot_filesystem", "snapshot_directory"].includes(workspacePersistence))
    unsupported("workspacePersistence");
  for (const key of [
    "sandboxCreateTimeoutS",
    "snapshotFilesystemTimeoutMs",
    "snapshotFilesystemRestoreTimeoutMs",
    "timeoutMs",
    "idleTimeoutMs",
    "cpu",
    "memoryMiB",
  ] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0))
      throw new Error(`Modal ${key} must be positive`);
  }
  if (
    options.regions !== undefined &&
    (!Array.isArray(options.regions) ||
      options.regions.length === 0 ||
      options.regions.some((region) => typeof region !== "string" || !region.trim()))
  ) {
    throw new Error("Modal regions must be a non-empty list of region names");
  }
  const manifest = create.manifest;
  validateManifest(manifest);
  // Validate mount configuration before any provider resource is requested.
  for (const { entry } of manifest.mountTargets()) {
    buildModalCloudBucketMountConfig(
      entry,
      defined({
        secretName:
          readOptionalString(entry.mountStrategy, "secretName") ??
          options.nativeCloudBucketSecretName,
        secretEnvironmentName: readOptionalString(entry.mountStrategy, "secretEnvironmentName"),
      }),
    );
  }
  let session: ModalSandboxSession | undefined;
  let timedOut = false;
  let cloudBucketMounts: Record<string, CloudBucketMount> | undefined;
  let state: Omit<ModalSandboxSessionState, "sandboxId">;
  let app: Awaited<ReturnType<ModalClient["apps"]["fromName"]>>;
  const modal = sharedModalClient(
    defined({
      tokenId: options.tokenId,
      tokenSecret: options.tokenSecret,
      environment: options.environment,
      endpoint: options.endpoint,
      imageBuilderVersion: options.imageBuilderVersion,
    }),
  );
  // Each attempted physical create keeps its own one-shot durable boundary;
  // only this operation's SandboxCreate (inside withModalCreateBoundary) sees it.
  const createBoundary = createModalProviderCreateBoundary({
    operationId: crypto.randomUUID(),
    beforeDispatch: async (intent) => {
      if (timedOut) throw new Error("Modal create expired before provider dispatch");
      await lifecycle.beforeDispatch(intent, { modal });
    },
    onReceipt: async (receipt) => {
      const constructorArgs = {
        modal,
        app,
        sandbox: new Sandbox(modal, receipt.instanceId),
        ownsSandbox: true,
        state: { ...state, sandboxId: receipt.instanceId, imageId: receipt.imageId },
        cloudBucketMounts,
        cloudBucketMountsProvider: async () =>
          await resolveMounts(session?.state.manifest ?? manifest),
        concurrencyLimits: create.concurrencyLimits,
        archiveLimits: create.archiveLimits,
      };
      // Agents Extensions 0.14.3's structural Modal types predate Modal 0.9's
      // snapshot options. Runtime policy adapts that pinned interface.
      session = installPolicy(
        new ModalSandboxSession(
          constructorArgs as unknown as ConstructorParameters<typeof ModalSandboxSession>[0],
        ),
      );
      await lifecycle.onCreated(session, receipt);
    },
  });
  const resolveMounts = async (source: Manifest) =>
    await resolveModalCloudBucketMounts(modal, source, options.nativeCloudBucketSecretName);
  try {
    app = await cachedModalApp(
      modal,
      options.appName,
      defined({
        createIfMissing: true,
        environment: options.environment,
      }),
    );
    const environment = await materializeEnvironment(manifest, options.env);
    const selector =
      options.image ?? ModalImageSelector.fromTag(options.imageTag ?? "debian:bookworm-slim");
    let image: Image;
    if (selector.kind === "image") image = selector.value as Image;
    else if (typeof selector.value !== "string" || !selector.value.trim())
      throw new Error("Modal image identity must be non-empty");
    else if (selector.kind === "id" || selector.kind === "tag")
      image = await cachedModalImage(modal, app, { kind: selector.kind, value: selector.value });
    else throw new Error("Unsupported Modal image selector");
    if (typeof image?.build !== "function")
      throw new Error("Modal image selector requires a native Image");
    cloudBucketMounts = await resolveMounts(manifest);
    state = {
      manifest,
      ownsSandbox: true,
      appName: options.appName,
      imageTag:
        selector.kind === "tag"
          ? (selector.value as string)
          : (options.imageTag ?? "debian:bookworm-slim"),
      sandboxCreateTimeoutS: options.sandboxCreateTimeoutS,
      workspacePersistence,
      snapshotFilesystemTimeoutMs: options.snapshotFilesystemTimeoutMs,
      snapshotFilesystemRestoreTimeoutMs: options.snapshotFilesystemRestoreTimeoutMs,
      environment,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs,
      cpu: options.cpu,
      memoryMiB: options.memoryMiB,
      gpu: options.gpu,
      configuredExposedPorts: options.exposedPorts,
      modalEnvironment: options.environment,
      endpoint: options.endpoint,
      imageBuilderVersion: options.imageBuilderVersion,
      nativeCloudBucketSecretName: options.nativeCloudBucketSecretName,
      useSleepCmd: options.useSleepCmd ?? true,
    };
    // The boundary scope stays active until the provider call settles, so a
    // late receipt after the local timeout is still persisted.
    const physicalCreate = withModalCreateBoundary(createBoundary, () =>
      modal.sandboxes.create(
        app,
        image,
        defined({
          workdir: manifest.root,
          env: environment,
          command: state.useSleepCmd ? ["sleep", "infinity"] : undefined,
          timeoutMs: options.timeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
          cpu: options.cpu,
          memoryMiB: options.memoryMiB,
          gpu: options.gpu,
          encryptedPorts: options.exposedPorts,
          cloudBucketMounts,
          regions: options.regions ? [...options.regions] : undefined,
        }),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await (options.sandboxCreateTimeoutS === undefined
        ? physicalCreate
        : Promise.race([
            physicalCreate,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(
                  new Error("Modal sandbox creation timed out; provider receipt remains fenced"),
                );
              }, options.sandboxCreateTimeoutS! * 1000);
            }),
          ]));
    } finally {
      if (timer) clearTimeout(timer);
      // A late callback still persists its ID. Cleanup cannot license another
      // create until the durable lease has that identity and terminal proof.
      if (timedOut)
        void physicalCreate
          .then(
            async () => {
              await session?.close();
            },
            async () => {
              await session?.close();
            },
          )
          .catch(() => {
            modal.logger.warn(
              "Late Modal create cleanup failed; durable lease requires reconciliation",
            );
          });
    }
    if (!session) throw new Error("Modal create bypassed the required physical receipt boundary");
    await session.applyManifest(withoutMounts(manifest));
    return session;
  } catch (error) {
    // The transport is the shared process-wide client and is never released
    // here; a failed box is still stopped when cleanup is provably safe.
    if (!timedOut) {
      return await releaseModalCreateFailure(session, SHARED_CLIENT_TRANSPORT, error);
    }
    throw error;
  }
}

/** The pinned adapter's provider-error shape: a SandboxProviderError naming the
 * operation, with the provider failure as its exact cause. */
async function withModalProviderError<T>(
  operation: string,
  context: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UserError) throw error;
    const cause = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new SandboxProviderError(
        `ModalSandboxClient failed to ${operation}${cause ? `: ${cause}` : ""}`,
        { provider: "modal", operation, ...context, cause },
      ),
      { cause: error },
    );
  }
}

/**
 * Reattach to a live box on the shared process-wide client. Same lookups,
 * errors and session as the pinned adapter's resume, which instead built a new
 * client per call and so paid a fresh TLS channel, AuthTokenGet and
 * EnvironmentGetOrCreate (about 0.5 s) on every warm turn.
 */
export async function resumeModalSessionOnSharedClient(
  defaults: OpenGeniModalSandboxClientOptions,
  state: ModalSandboxSessionState,
): Promise<ModalSandboxSession> {
  assertHostPathGrantsRebound(state);
  if (!state.sandboxId) {
    throw new UserError("Modal sandbox resume requires a persisted sandboxId.");
  }
  const sandboxId = state.sandboxId;
  const modal = sharedModalClient(
    defined({
      tokenId: defaults.tokenId,
      tokenSecret: defaults.tokenSecret,
      environment: state.modalEnvironment ?? defaults.environment,
      endpoint: state.endpoint ?? defaults.endpoint,
      imageBuilderVersion: state.imageBuilderVersion ?? defaults.imageBuilderVersion,
    }),
  );
  const sandbox = await withModalProviderError(
    "resume sandbox",
    { sandboxId },
    async () => await modal.sandboxes.fromId(sandboxId),
  );
  const ownsSandbox = state.ownsSandbox !== false;
  const app =
    ownsSandbox || state.workspacePersistence === "snapshot_filesystem"
      ? await withModalProviderError(
          "look up app",
          { appName: state.appName },
          async () =>
            await cachedModalApp(
              modal,
              state.appName,
              defined({ createIfMissing: ownsSandbox, environment: state.modalEnvironment }),
            ),
        )
      : {};
  const exitCode = await withModalProviderError(
    "poll sandbox",
    { sandboxId },
    async () => await sandbox.poll(),
  );
  if (exitCode !== null) {
    throw new UserError(`Modal sandbox ${state.sandboxId} is no longer running.`);
  }
  const constructorArgs = {
    state,
    modal,
    app,
    sandbox,
    ownsSandbox,
    cloudBucketMountsProvider: async () =>
      await resolveModalCloudBucketMounts(
        modal,
        state.manifest,
        state.nativeCloudBucketSecretName ?? defaults.nativeCloudBucketSecretName,
        "skip",
      ),
    archiveLimits: defaults.archiveLimits,
  };
  return new ModalSandboxSession(
    constructorArgs as unknown as ConstructorParameters<typeof ModalSandboxSession>[0],
  );
}
