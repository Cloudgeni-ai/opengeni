import { ModalImageSelector, ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import { effectiveModalIdleTimeoutSeconds } from "@opengeni/config";
import type { Settings } from "@opengeni/config";
import type { BackgroundJobSpec } from "@opengeni/contracts";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

const MODAL_ORPHAN_SWEEP_LIMIT = 50;
// A provider box is invisible to the lease until Modal create + manifest
// materialization returns and the creation callback records its instance id.
// Production baseline (2026-07-15, all 8 turn workers): 155/155 completed creates
// finished under 10s (154 under 2.5s). Two minutes is a 12x observed-max buffer,
// while avoiding the former 30-minute retention of boxes abandoned by a rolling
// worker restart. The live-instance guard below remains authoritative: once a box
// is recorded by any lease, age and missing/stale tags can never terminate it.
const MODAL_UNATTRIBUTED_ORPHAN_GRACE_MS = 2 * 60_000;

export type ModalSandboxAttribution = {
  leaseId: string;
  workspaceId: string;
  sandboxGroupId: string;
};

export type LiveModalSandboxLeaseAttribution = ModalSandboxAttribution & {
  instanceId: string | null;
  liveness?: string;
};

export type ModalOrphanSweepTermination = {
  sandboxId: string;
  reason: "stale_attribution" | "unattributed";
  tags: Record<string, string>;
};

export type ModalOrphanSweepResult = {
  examined: number;
  terminated: ModalOrphanSweepTermination[];
  skipped: number;
};

export function modalSandboxAttributionEnvironment(
  input: ModalSandboxAttribution,
): Record<string, string> {
  return {
    OPENGENI_SANDBOX_LEASE_ID: input.leaseId,
    OPENGENI_SANDBOX_GROUP_ID: input.sandboxGroupId,
    OPENGENI_WORKSPACE_ID: input.workspaceId,
  };
}

export function modalSandboxAttributionTags(
  input: ModalSandboxAttribution,
): Record<string, string> {
  return {
    opengeni: "true",
    opengeni_lease_id: input.leaseId,
    opengeni_workspace_id: input.workspaceId,
    opengeni_sandbox_group_id: input.sandboxGroupId,
  };
}

export const modalProvider: ProviderRegistration = {
  backend: "modal",
  descriptor: CAPABILITY_DESCRIPTORS.modal,
  validateCredentials(settings) {
    // both-or-neither (preserves existing validation at config validateSettings).
    if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret)) {
      throw new SandboxConfigError(
        "modal",
        "OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted",
      );
    }
    if (!settings.modalAppName) {
      throw new SandboxConfigError("modal", "OPENGENI_MODAL_APP_NAME is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof ModalSandboxClient>[0]> = {
      appName: settings.modalAppName,
      timeoutMs: settings.modalTimeoutSeconds * 1000,
      sandboxCreateTimeoutS: Math.ceil(settings.sandboxWarmingTimeoutMs / 1000),
      exposedPorts,
      env: environment,
      // A registry image's own CMD is not a sandbox keepalive contract (for
      // example, python:3.12-slim can exit immediately). Keep the provider's
      // control process alive so exec/resume remains available; Modal's hard
      // timeout and explicit OpenGeni teardown still own the box lifetime.
      useSleepCmd: true,
    };
    // gap-fill (module 03 §4.1): these SDK options were previously unmapped.
    // ALWAYS pin idleTimeoutMs (sandbox-file-persistence): an UNSET idle timeout
    // lets the SDK send idleTimeoutSecs=undefined, so Modal applies its short
    // server-default idle-reap and kills an idle (between-turns) box LONG before
    // OpenGeni's reaper can resume+snapshot it. effectiveModalIdleTimeoutSeconds
    // defaults this to the hard lifetime so the box survives its full warm window
    // and the reaper — not Modal's idle-reap — governs teardown (and snapshots
    // /workspace first).
    options.idleTimeoutMs = effectiveModalIdleTimeoutSeconds(settings) * 1000;
    if (settings.modalWorkspacePersistence) {
      options.workspacePersistence = settings.modalWorkspacePersistence;
    }
    const imageSelector = resolveModalImageSelector(settings);
    if (imageSelector) {
      options.image = imageSelector;
    }
    if (settings.modalTokenId) {
      options.tokenId = settings.modalTokenId;
    }
    if (settings.modalTokenSecret) {
      options.tokenSecret = settings.modalTokenSecret;
    }
    if (settings.modalEnvironment) {
      options.environment = settings.modalEnvironment;
    }
    return new ModalSandboxClient(options);
  },
};

type ModalModule = typeof import("modal");
type ModalClientLike = InstanceType<ModalModule["ModalClient"]>;

// --- Private-registry image resolution (OPENGENI_MODAL_IMAGE_REGISTRY_SECRET) ------
//
// The Agents-extension Modal backend resolves `modalImageRef` via
// `Image.fromRegistry(tag)` with NO secret, so it can only pull PUBLIC images. To run
// a PRIVATE image we resolve the named Modal Secret and pre-build the authenticated
// `fromRegistry(tag, secret)` image ONCE per process, then hand the provider `build`
// a `ModalImageSelector.fromImage(...)`. `build` is synchronous and modal is imported
// lazily (never loaded for non-modal backends), so resolution can't happen inside
// `build`; the worker awaits `ensureModalRegistryImage` at boot for global refs and
// at turn time for pack-scoped refs, then `build` reads the settled result. Modal
// images are lazy, workspace-scoped definitions, so an image built by this module's
// client is usable by the ModalSandboxClient's own client.

/** Loader seam so unit tests can inject a fake modal module. */
export type ModalModuleLoader = () => Promise<Pick<ModalModule, "ModalClient">>;

const defaultModalLoader: ModalModuleLoader = () => import("modal");

/** Settled, synchronously-readable resolved images, keyed per config. */
const resolvedRegistryImages = new Map<string, unknown>();
/** In-flight resolutions, for cross-call de-duplication. */
const inFlightRegistryImages = new Map<string, Promise<void>>();

function registryImageCacheKey(settings: Settings): string {
  return [
    settings.modalImageRef ?? "",
    settings.modalImageRegistrySecret ?? "",
    settings.modalEnvironment ?? "",
  ].join("|");
}

/**
 * Resolve + cache the private-registry Modal image. No-op unless BOTH
 * `modalImageRef` and `modalImageRegistrySecret` are set. Memoized per
 * (imageRef, secret, environment) so it runs once per worker process. Awaited at
 * worker boot for the deployment-global image and at turn time for pack-scoped
 * images BEFORE the first sandbox using that ref is created; `build` then reads the
 * resolved image and otherwise falls back to the public `fromTag` path.
 */
export async function ensureModalRegistryImage(
  settings: Settings,
  loadModal: ModalModuleLoader = defaultModalLoader,
): Promise<void> {
  if (!settings.modalImageRegistrySecret || !settings.modalImageRef) {
    return;
  }
  const key = registryImageCacheKey(settings);
  if (resolvedRegistryImages.has(key)) {
    return;
  }
  let pending = inFlightRegistryImages.get(key);
  if (!pending) {
    pending = (async () => {
      const modal = await loadModal();
      const client = new modal.ModalClient(modalClientOptions(settings));
      // Resolve the Secret via the AUTHENTICATED client (client.secrets.fromName),
      // NOT the static `modal.Secret.fromName`, which resolves against
      // `getDefaultClient()` — i.e. the standard MODAL_TOKEN_ID/MODAL_TOKEN_SECRET env
      // or ~/.modal.toml — and so would throw "Profile is missing token_id" in any host
      // that supplies the token only through OpenGeni settings (OPENGENI_MODAL_TOKEN_ID).
      const secret = await client.secrets.fromName(
        settings.modalImageRegistrySecret!,
        settings.modalEnvironment ? { environment: settings.modalEnvironment } : undefined,
      );
      // fromRegistry is synchronous and returns a lazy image definition (built
      // server-side at sandbox create); the resolved secretId travels with it.
      const image = client.images.fromRegistry(settings.modalImageRef!, secret);
      resolvedRegistryImages.set(key, image);
    })().finally(() => {
      inFlightRegistryImages.delete(key);
    });
    inFlightRegistryImages.set(key, pending);
  }
  await pending;
}

/** The resolved private-registry image for these settings, or undefined if none. */
function cachedModalRegistryImage(settings: Settings): unknown | undefined {
  if (!settings.modalImageRegistrySecret || !settings.modalImageRef) {
    return undefined;
  }
  return resolvedRegistryImages.get(registryImageCacheKey(settings));
}

/**
 * Choose the image selector for a Modal sandbox client from settings. Returns:
 *  - `fromImage(resolved)` when a private-registry secret is configured AND the
 *    image has been resolved (ensureModalRegistryImage ran before create);
 *  - `fromTag(modalImageRef)` for the public path (no secret, or cold cache — the
 *    resume/attach paths never pull an image so the tag branch is harmless there);
 *  - `undefined` when no image ref is set (Modal uses its default image).
 * Exported for unit tests.
 */
export function resolveModalImageSelector(settings: Settings): ModalImageSelector | undefined {
  if (!settings.modalImageRef) {
    return undefined;
  }
  const registryImage = cachedModalRegistryImage(settings);
  return registryImage
    ? ModalImageSelector.fromImage(
        registryImage as Parameters<typeof ModalImageSelector.fromImage>[0],
      )
    : ModalImageSelector.fromTag(settings.modalImageRef);
}

/** Test-only: clear the resolved/in-flight image caches. */
export function __resetModalRegistryImageCacheForTest(): void {
  resolvedRegistryImages.clear();
  inFlightRegistryImages.clear();
}

function modalClientOptions(
  settings: Settings,
): ConstructorParameters<ModalModule["ModalClient"]>[0] {
  return {
    ...(settings.modalTokenId ? { tokenId: settings.modalTokenId } : {}),
    ...(settings.modalTokenSecret ? { tokenSecret: settings.modalTokenSecret } : {}),
    ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
    ...(settings.modalTimeoutSeconds ? { timeoutMs: settings.modalTimeoutSeconds * 1000 } : {}),
  };
}

async function createModalClient(settings: Settings): Promise<ModalClientLike> {
  const modal = await import("modal");
  return new modal.ModalClient(modalClientOptions(settings));
}

export async function tagModalSandbox(
  settings: Settings,
  sandboxId: string,
  attribution: ModalSandboxAttribution,
): Promise<boolean> {
  if (!sandboxId) {
    return false;
  }
  const modal = await createModalClient(settings);
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    await sandbox.setTags(modalSandboxAttributionTags(attribution));
    return true;
  } finally {
    modal.close();
  }
}

export async function terminateModalSandboxById(
  settings: Settings,
  sandboxId: string,
): Promise<boolean> {
  if (!sandboxId) {
    return true;
  }
  const modal = await createModalClient(settings);
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    await sandbox.terminate();
    return true;
  } finally {
    modal.close();
  }
}

export class BackgroundJobProviderLostError extends Error {
  constructor(instanceId: string, cause?: unknown) {
    super(`Modal background job provider instance disappeared: ${instanceId}`, { cause });
    this.name = "BackgroundJobProviderLostError";
  }
}

export type BackgroundJobProviderTerminal = {
  status: "completed" | "failed" | "cancelled" | "lost";
  exitCode?: number | null;
  error?: string | null;
  artifacts: Array<{
    path: string;
    bytes: Uint8Array;
  }>;
};

export type BackgroundJobObservationHooks = {
  onLog: (input: {
    stream: "stdout" | "stderr";
    providerOffset: number;
    text: string;
  }) => Promise<void>;
  shouldCancel: () => Promise<boolean>;
  heartbeat: () => void;
  sleep: (ms: number) => Promise<void>;
};

export type BackgroundJobExecutionProvider = {
  start: (input: {
    workspaceId: string;
    jobId: string;
    spec: BackgroundJobSpec;
  }) => Promise<{ providerRef: string; providerInstanceId: string }>;
  observe: (input: {
    providerInstanceId: string;
    spec: BackgroundJobSpec;
    deadlineAt: Date | null;
    hooks: BackgroundJobObservationHooks;
  }) => Promise<BackgroundJobProviderTerminal>;
  terminate: (providerInstanceId: string) => Promise<void>;
};

function isModalNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
  return (
    candidate.name === "NotFoundError" ||
    candidate.code === "NOT_FOUND" ||
    candidate.code === 5 ||
    candidate.status === 404 ||
    (typeof candidate.message === "string" && /not[ -]?found/i.test(candidate.message))
  );
}

async function modalImageForBackgroundJob(
  modal: ModalClientLike,
  settings: Settings,
): Promise<unknown> {
  const cached = cachedModalRegistryImage(settings);
  if (cached) return cached;
  const imageRef = settings.modalImageRef ?? "debian:bookworm-slim";
  if (!settings.modalImageRegistrySecret) {
    return modal.images.fromRegistry(imageRef);
  }
  const secret = await modal.secrets.fromName(
    settings.modalImageRegistrySecret,
    settings.modalEnvironment ? { environment: settings.modalEnvironment } : undefined,
  );
  return modal.images.fromRegistry(imageRef, secret);
}

/**
 * Durable one-shot Modal execution. The job command is the Sandbox main
 * process, so sandboxId alone is sufficient to reattach after a worker loss.
 */
export function createModalBackgroundJobProvider(
  settings: Settings,
): BackgroundJobExecutionProvider {
  return {
    async start(input) {
      await ensureModalRegistryImage(settings);
      const modal = await createModalClient(settings);
      try {
        const app = await modal.apps.fromName(settings.modalAppName, {
          createIfMissing: true,
          ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
        });
        const image = await modalImageForBackgroundJob(modal, settings);
        const timeoutMs = (input.spec.timeoutSeconds ?? settings.modalTimeoutSeconds) * 1_000;
        const sandbox = await modal.sandboxes.create(
          app,
          image as Parameters<ModalClientLike["sandboxes"]["create"]>[1],
          {
            command: [input.spec.command, ...input.spec.args],
            ...(input.spec.cwd ? { workdir: input.spec.cwd } : {}),
            timeoutMs,
            idleTimeoutMs: timeoutMs,
            tags: {
              opengeni: "true",
              opengeni_background_job_id: input.jobId,
              opengeni_workspace_id: input.workspaceId,
            },
          },
        );
        return {
          providerRef: `modal:sandbox:${sandbox.sandboxId}`,
          providerInstanceId: sandbox.sandboxId,
        };
      } finally {
        modal.close();
      }
    },

    async observe(input) {
      const modal = await createModalClient(settings);
      let sandbox: Awaited<ReturnType<ModalClientLike["sandboxes"]["fromId"]>>;
      try {
        try {
          sandbox = await modal.sandboxes.fromId(input.providerInstanceId);
        } catch (error) {
          if (isModalNotFound(error)) {
            throw new BackgroundJobProviderLostError(input.providerInstanceId, error);
          }
          throw error;
        }

        let streamFailure: unknown = null;
        const drain = async (stream: "stdout" | "stderr") => {
          const reader = sandbox[stream].getReader();
          const encoder = new TextEncoder();
          let providerOffset = 0;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) return;
              const text = chunk.value;
              await input.hooks.onLog({ stream, providerOffset, text });
              providerOffset += encoder.encode(text).byteLength;
            }
          } finally {
            reader.releaseLock();
          }
        };
        const drains = [drain("stdout"), drain("stderr")].map((promise) =>
          promise.catch((error) => {
            streamFailure = error;
          }),
        );

        for (;;) {
          input.hooks.heartbeat();
          if (streamFailure) throw streamFailure;
          if (await input.hooks.shouldCancel()) {
            await sandbox.terminate().catch(() => undefined);
            await Promise.all(drains);
            return { status: "cancelled", artifacts: [] };
          }
          if (input.deadlineAt && input.deadlineAt.getTime() <= Date.now()) {
            await sandbox.terminate().catch(() => undefined);
            await Promise.all(drains);
            return {
              status: "failed",
              exitCode: null,
              error: "background job timed out",
              artifacts: [],
            };
          }
          let exitCode: number | null;
          try {
            exitCode = await sandbox.poll();
          } catch (error) {
            if (isModalNotFound(error)) {
              throw new BackgroundJobProviderLostError(input.providerInstanceId, error);
            }
            throw error;
          }
          if (exitCode !== null) {
            await Promise.all(drains);
            if (streamFailure) throw streamFailure;
            const artifacts: BackgroundJobProviderTerminal["artifacts"] = [];
            for (const path of input.spec.artifactPaths) {
              try {
                artifacts.push({ path, bytes: await sandbox.filesystem.readBytes(path) });
              } catch (error) {
                if (isModalNotFound(error)) break;
                throw error;
              }
            }
            return {
              status: exitCode === 0 ? "completed" : "failed",
              exitCode,
              ...(exitCode === 0 ? {} : { error: `background job exited with code ${exitCode}` }),
              artifacts,
            };
          }
          await input.hooks.sleep(1_000);
        }
      } finally {
        modal.close();
      }
    },

    async terminate(providerInstanceId) {
      await terminateModalSandboxById(settings, providerInstanceId);
    },
  };
}

type ModalSandboxInfo = {
  id: string;
  createdAt?: number;
  tags?: Array<{ tagName?: string; tagValue?: string }>;
};

type ModalCpListClient = ModalClientLike & {
  cpClient: {
    sandboxList(input: {
      appId?: string;
      beforeTimestamp?: number;
      environmentName?: string;
      includeFinished?: boolean;
      tags?: Array<{ tagName: string; tagValue: string }>;
    }): Promise<{ sandboxes?: ModalSandboxInfo[] }>;
  };
};

function tagsFromInfo(info: ModalSandboxInfo): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of info.tags ?? []) {
    if (typeof tag.tagName === "string" && typeof tag.tagValue === "string") {
      tags[tag.tagName] = tag.tagValue;
    }
  }
  return tags;
}

function sandboxCreatedAtMs(info: ModalSandboxInfo): number | null {
  if (
    typeof info.createdAt !== "number" ||
    !Number.isFinite(info.createdAt) ||
    info.createdAt <= 0
  ) {
    return null;
  }
  // Modal protobuf timestamps in this SDK are seconds as doubles.
  return info.createdAt < 10_000_000_000
    ? Math.floor(info.createdAt * 1000)
    : Math.floor(info.createdAt);
}

function attributionKey(
  input: Pick<ModalSandboxAttribution, "leaseId" | "workspaceId" | "sandboxGroupId">,
): string {
  return `${input.workspaceId}:${input.sandboxGroupId}:${input.leaseId}`;
}

export async function sweepModalOrphanSandboxes(
  settings: Settings,
  liveLeases: LiveModalSandboxLeaseAttribution[],
  options: {
    now?: Date;
    maxTerminations?: number;
    unattributedGraceMs?: number;
    client?: ModalClientLike;
  } = {},
): Promise<ModalOrphanSweepResult> {
  const nowMs = options.now?.getTime() ?? Date.now();
  const maxTerminations = options.maxTerminations ?? MODAL_ORPHAN_SWEEP_LIMIT;
  const unattributedGraceMs = options.unattributedGraceMs ?? MODAL_UNATTRIBUTED_ORPHAN_GRACE_MS;
  const liveByAttribution = new Map(liveLeases.map((lease) => [attributionKey(lease), lease]));
  // LIVE-INSTANCE GUARD: a box that any live lease's envelope points at is NEVER
  // an orphan, whatever its tags say. Tags are best-effort attribution (setTags
  // is a separate call after create and can fail or lag); the lease envelope is
  // the source of truth the turn path actually resumes by. Judging by tags alone
  // terminated a LIVE box mid-turn at exactly creation+30min (staging session
  // e644e8a8, 2026-07-06) — the box's unpushed work was unrecoverable because
  // nothing outside the reaper drain persists /workspace.
  const liveByInstanceId = new Map(
    liveLeases
      .filter((lease) => lease.instanceId)
      .map((lease) => [lease.instanceId as string, lease]),
  );
  const ownedClient = options.client ? null : await createModalClient(settings);
  const modal = (options.client ?? ownedClient)! as ModalCpListClient;
  try {
    const app = await modal.apps.fromName(settings.modalAppName, {
      createIfMissing: false,
      ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
    });
    const appId = app.appId;
    if (!appId) {
      return { examined: 0, terminated: [], skipped: 0 };
    }

    let examined = 0;
    let skipped = 0;
    const terminated: ModalOrphanSweepTermination[] = [];
    let beforeTimestamp: number | undefined;
    while (terminated.length < maxTerminations) {
      const response = await modal.cpClient.sandboxList({
        appId,
        ...(beforeTimestamp !== undefined ? { beforeTimestamp } : {}),
        includeFinished: false,
        ...(settings.modalEnvironment ? { environmentName: settings.modalEnvironment } : {}),
        tags: [],
      });
      const sandboxes = response.sandboxes ?? [];
      if (sandboxes.length === 0) {
        break;
      }
      for (const info of sandboxes) {
        examined += 1;
        const tags = tagsFromInfo(info);
        const leaseId = tags.opengeni_lease_id;
        const workspaceId = tags.opengeni_workspace_id;
        const sandboxGroupId = tags.opengeni_sandbox_group_id;
        // Background jobs are owned by their stable Temporal controller and a
        // Modal hard timeout, not by the interactive session-lease table.
        if (tags.opengeni_background_job_id) {
          skipped += 1;
          continue;
        }
        const liveByInstance = info.id ? liveByInstanceId.get(info.id) : undefined;
        if (liveByInstance) {
          // Live-instance guard (see above): a live lease resumes this exact box
          // by id — hard-skip it, and HEAL its attribution tags when they are
          // missing/stale so it stops looking sweep-eligible. Best-effort: a
          // failed re-tag must never fail the sweep (the guard, not the tags,
          // is what protects the box now).
          if (
            leaseId !== liveByInstance.leaseId ||
            workspaceId !== liveByInstance.workspaceId ||
            sandboxGroupId !== liveByInstance.sandboxGroupId
          ) {
            try {
              const sandbox = await modal.sandboxes.fromId(info.id);
              await sandbox.setTags(
                modalSandboxAttributionTags({
                  leaseId: liveByInstance.leaseId,
                  workspaceId: liveByInstance.workspaceId,
                  sandboxGroupId: liveByInstance.sandboxGroupId,
                }),
              );
            } catch {
              // Tag healing is opportunistic; the instance guard already
              // protects this box on every future sweep pass.
            }
          }
          skipped += 1;
          continue;
        }
        let reason: ModalOrphanSweepTermination["reason"] | null = null;
        if (leaseId && workspaceId && sandboxGroupId) {
          const live = liveByAttribution.get(
            attributionKey({ leaseId, workspaceId, sandboxGroupId }),
          );
          if (!live || (live.instanceId && live.instanceId !== info.id)) {
            reason = "stale_attribution";
          }
        } else {
          const createdAtMs = sandboxCreatedAtMs(info);
          if (createdAtMs !== null && nowMs - createdAtMs >= unattributedGraceMs) {
            reason = "unattributed";
          }
        }

        if (!reason) {
          skipped += 1;
          continue;
        }
        try {
          const sandbox = await modal.sandboxes.fromId(info.id);
          await sandbox.terminate();
          terminated.push({ sandboxId: info.id, reason, tags });
        } catch {
          skipped += 1;
        }
        if (terminated.length >= maxTerminations) {
          break;
        }
      }
      beforeTimestamp = sandboxes[sandboxes.length - 1]?.createdAt;
      if (beforeTimestamp === undefined) {
        break;
      }
    }
    return { examined, terminated, skipped };
  } finally {
    ownedClient?.close();
  }
}
