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
  SandboxUnsupportedFeatureError,
  type Entry,
} from "@openai/agents/sandbox";
import { materializeEnvironment, readOptionalString } from "@openai/agents-core/sandbox/internal";
import { ModalClient, Sandbox, type CloudBucketMount } from "modal";
import {
  createModalProviderCreateBoundary,
  type ModalCreateIntent,
  type ModalCreateImagePreparation,
} from "./modal-create-boundary";
import { prepareCanonicalModalCreateImage } from "./modal-registry-image";
import { modalCommandStartCleanupIsSafe } from "./modal-command-start-errors";
import {
  modalNativeBrokerInitialCommand,
  parseModalNativeBrokerCreatePlan,
  type ModalNativeBrokerCreatePlan,
} from "./modal-native-broker-create";

export type ModalCreateLifecycle = {
  beforeDispatch: (intent: ModalCreateIntent, providerContext: unknown) => Promise<void>;
  onCreated: (session: ModalSandboxSession, intent: ModalCreateIntent) => Promise<void>;
  /** Internal opt-in only, not a create option. Both extra gates are required:
   * persist qualified broker creation after ordinary lease admission, then
   * verify/retain authenticated initial bootstrap before lease publication.
   * SDK command setup is deferred until ordinary warm mutation admission. */
  nativeBroker?: {
    plan: ModalNativeBrokerCreatePlan;
    beforeDispatch: (intent: ModalCreateIntent, providerContext: unknown) => Promise<void>;
    verifyCreated: (session: ModalSandboxSession, intent: ModalCreateIntent) => Promise<void>;
  };
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

/** Own physical creation while retaining the pinned SDK's public session API.
 * Its ordinary create() applies the manifest before exposing the instance ID,
 * which is too late for a durable worker lease. No global SDK monkey-patching.
 */
export async function createModalSessionWithLifecycle(
  defaults: Partial<ModalSandboxClientOptions>,
  args: Parameters<ModalSandboxClient["create"]>[0],
  lifecycle: ModalCreateLifecycle,
  installPolicy: (session: ModalSandboxSession) => ModalSandboxSession,
): Promise<ModalSandboxSession> {
  const nativeBroker = lifecycle.nativeBroker
    ? {
        plan: parseModalNativeBrokerCreatePlan(lifecycle.nativeBroker.plan),
        beforeDispatch: lifecycle.nativeBroker.beforeDispatch,
        verifyCreated: lifecycle.nativeBroker.verifyCreated,
      }
    : undefined;
  if (
    nativeBroker &&
    (typeof nativeBroker.beforeDispatch !== "function" ||
      typeof nativeBroker.verifyCreated !== "function")
  )
    throw new Error("Modal native broker creation requires durable admission and bootstrap gates");
  const create = normalizeSandboxClientCreateArgs(args);
  if (create.snapshot !== undefined) unsupported("snapshot");
  const overrides = create.options as Partial<ModalSandboxClientOptions> | undefined;
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
  const manifest = create.manifest;
  validateManifest(manifest);
  if (nativeBroker && (manifest.root !== "/workspace" || Object.keys(manifest.entries).length))
    unsupported("native broker initial manifest entries or noncanonical root");
  if (nativeBroker && manifest.mountTargets().length) unsupported("native broker initial mounts");
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
  let imagePreparation: ModalCreateImagePreparation | undefined;
  const modal = new ModalClient(
    defined({
      tokenId: options.tokenId,
      tokenSecret: options.tokenSecret,
      environment: options.environment,
      endpoint: options.endpoint,
      grpcMiddleware: [
        createModalProviderCreateBoundary({
          operationId: crypto.randomUUID(),
          imagePreparation: () => imagePreparation,
          ...(nativeBroker ? { nativeBroker: nativeBroker.plan } : {}),
          beforeDispatch: async (intent) => {
            if (timedOut) throw new Error("Modal create expired before provider dispatch");
            await lifecycle.beforeDispatch(intent, { modal });
            if (nativeBroker) {
              if (timedOut) throw new Error("Modal broker create expired before durable admission");
              await nativeBroker.beforeDispatch(intent, { modal });
            }
            if (timedOut) throw new Error("Modal create expired during durable admission");
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
            // The pinned SDK closes processes/the box, but not its Modal
            // transport. This adapter owns a dedicated client per create.
            const closeSession = session.close.bind(session);
            session.close = async () => {
              await closeSession();
              modal.close();
            };
            await lifecycle.onCreated(session, receipt);
            if (nativeBroker) {
              if (timedOut) throw new Error("Modal broker receipt arrived after create timeout");
              await nativeBroker.verifyCreated(session, receipt);
              if (timedOut) throw new Error("Modal broker bootstrap exceeded create containment");
            }
          },
        }),
      ],
    }),
  );
  const resolveMounts = async (source: Manifest) => {
    const result: Record<string, CloudBucketMount> = {};
    for (const { entry, mountPath } of source.mountTargets()) {
      if (!isModalCloudBucketMountEntry(entry)) unsupported("entry.mountStrategy");
      const config = buildModalCloudBucketMountConfig(
        entry,
        defined({
          secretName:
            readOptionalString(entry.mountStrategy, "secretName") ??
            options.nativeCloudBucketSecretName,
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
  };
  try {
    app = await modal.apps.fromName(
      options.appName,
      defined({
        createIfMissing: true,
        environment: options.environment,
      }),
    );
    const environment = await materializeEnvironment(manifest, options.env);
    const selector =
      options.image ?? ModalImageSelector.fromTag(options.imageTag ?? "debian:bookworm-slim");
    const prepared = await prepareCanonicalModalCreateImage(modal, app, selector);
    const image = prepared.image;
    imagePreparation = prepared.preparation;
    if (
      nativeBroker &&
      (prepared.preparation.kind === "unqualified-image" ||
        prepared.preparation.imageId !== nativeBroker.plan.imageId)
    )
      throw new Error("Modal native broker creation selected an unqualified physical image");
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
      useSleepCmd: nativeBroker ? false : (options.useSleepCmd ?? true),
    };
    const physicalCreate = modal.sandboxes.create(
      app,
      image,
      defined({
        workdir: nativeBroker ? "/" : manifest.root,
        env: environment,
        command: nativeBroker
          ? modalNativeBrokerInitialCommand(nativeBroker.plan)
          : state.useSleepCmd
            ? ["sleep", "infinity"]
            : undefined,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        cpu: options.cpu,
        memoryMiB: options.memoryMiB,
        gpu: options.gpu,
        encryptedPorts: options.exposedPorts,
        cloudBucketMounts,
      }),
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
          })
          .finally(() => modal.close());
    }
    if (!session) throw new Error("Modal create bypassed the required physical receipt boundary");
    // The qualified stock image contains /workspace. Applying even an empty
    // SDK manifest runs mkdir through TaskExec while the lease is warming,
    // before ordinary mutation admission exists. Broker bootstrap establishes
    // readiness; the provided-session manifest is applied through routing only
    // after the lease is warm. No entries or mounts may be skipped here.
    if (!nativeBroker) await session.applyManifest(withoutMounts(manifest));
    return session;
  } catch (error) {
    // Timed-out work still owns its transport until its late receipt settles.
    // Every synchronous failure releases the transport even if stopping the
    // provider fails; durable reconciliation uses a separate authenticated client.
    if (!timedOut) {
      return await releaseModalCreateFailure(session, modal, error);
    }
    throw error;
  }
}
