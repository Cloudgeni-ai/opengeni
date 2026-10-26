import { Context } from "@temporalio/activity";
import {
  environmentsEncryptionKeyBytes,
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import { BROWSER_STATE_ARTIFACT_CONTENT_TYPE } from "@opengeni/contracts";
import { retainCompletedBrowserDownloads, type RetainedDownloadSource } from "@opengeni/core";
import {
  browserDeadlineCheckpoint,
  clearSuspendedBrowserSessionController,
  commitBrowserSessionSuspension,
  dispatchBrowserSessionOperation,
  failBrowserSessionSuspension,
  getBrowserSessionControlRecord,
  listBrowserDeadlineCheckpoints,
  readLease,
  releaseLeaseHolder,
  withRlsContext,
  type BrowserDeadlineCheckpointTarget,
} from "@opengeni/db";
import {
  deriveBrowserControllerAdminToken,
  deriveBrowserSessionControllerTokens,
} from "@opengeni/interaction/browser-controller-authority";
import {
  browserStateArtifactAad,
  browserStateManifestDigest,
  browserStateObjectKey,
  deriveBrowserStateDataKey,
  wrapBrowserStateDataKey,
} from "@opengeni/interaction/browser-state-authority";
import {
  BrowserControlClient,
  BrowserControlRequestError,
  createSandboxClientForBackend,
  deserializeSandboxSessionStateEnvelope,
  resumeExactSandboxSession,
  type BrowserControlPlacementSession,
} from "@opengeni/runtime";
import type { ControlActivityServices } from "./types";
import { errorMessage } from "@opengeni/contracts/values";

const UPLOAD_CLEANUP_GRACE_MS = 24 * 60 * 60_000;

function heartbeat(): void {
  try {
    Context.current().heartbeat();
  } catch {
    // Direct embedded calls have no Temporal context. In-flight controller
    // operations still settle under their exact durable database claim.
  }
}

async function withActivityHeartbeat<T>(run: () => Promise<T>): Promise<T> {
  heartbeat();
  const timer = setInterval(heartbeat, 5_000);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

type CheckpointController = Pick<BrowserControlClient, "captureState" | "endSession"> & {
  /** The browser's own downloads, kept as workspace files before capture. */
  downloads?: (tokens: { controlToken: string; viewToken: string }) => RetainedDownloadSource;
};
type CheckpointPlacement = {
  target: BrowserDeadlineCheckpointTarget;
  lease: NonNullable<Awaited<ReturnType<typeof readLease>>>;
  settings: Settings;
  controllerRoot: string;
};

async function resumeCheckpointController({
  target,
  lease,
  settings,
  controllerRoot,
}: CheckpointPlacement): Promise<CheckpointController> {
  // This edge cannot create a box or route through a user's current machine.
  const provider = createSandboxClientForBackend("modal", settings) as Parameters<
    typeof deserializeSandboxSessionStateEnvelope
  >[0];
  const envelope = lease.resumeState as { sessionState?: unknown };
  const state = await deserializeSandboxSessionStateEnvelope(
    provider,
    envelope.sessionState ?? lease.resumeState,
    target.instanceId,
  );
  const resumed = await resumeExactSandboxSession(provider, "modal", state, target.instanceId);
  const client = new BrowserControlClient(resumed.session as BrowserControlPlacementSession, {
    adminToken: deriveBrowserControllerAdminToken({
      rootSecret: controllerRoot,
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      placement: { kind: "sandbox_group", sandboxGroupId: target.sandboxGroupId },
      placementInstanceId: target.instanceId,
    }),
  });
  return {
    captureState: client.captureState.bind(client),
    endSession: client.endSession.bind(client),
    downloads: (tokens) =>
      client.sessionClient({
        reference: {
          browserSessionId: target.browserSessionId,
          controllerGeneration: target.controllerGeneration,
        },
        ...tokens,
      }),
  };
}

/** Suspension removes the browser's working directory, and with it every
 * download: keep completed ones as workspace files first. Best effort; a
 * failure is logged and never blocks the save. */
async function retainDownloadsBeforeCapture(
  services: Pick<ControlActivityServices, "db" | "settings"> & {
    objectStorage: NonNullable<ControlActivityServices["objectStorage"]>;
  },
  target: BrowserDeadlineCheckpointTarget,
  controllerRoot: string,
  client: CheckpointController,
): Promise<void> {
  if (!client.downloads) return;
  try {
    const record = await getBrowserSessionControlRecord(services.db, target);
    if (
      !record.session.capabilities.downloads ||
      record.session.controller?.controllerGeneration !== target.controllerGeneration
    ) {
      return;
    }
    const result = await retainCompletedBrowserDownloads(services, {
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      subjectId: null,
      browserSessionId: target.browserSessionId,
      sourceSessionId: record.sourceSessionId,
      source: client.downloads(
        deriveBrowserSessionControllerTokens({
          rootSecret: controllerRoot,
          accountId: target.accountId,
          workspaceId: target.workspaceId,
          placement: { kind: "sandbox_group", sandboxGroupId: target.sandboxGroupId },
          placementInstanceId: target.instanceId,
          browserSessionId: target.browserSessionId,
          controllerGeneration: target.controllerGeneration,
          tokenGeneration: record.tokenGeneration,
        }),
      ),
      uploadAudience: "sandbox",
    });
    for (const failure of result.failed) {
      console.warn("browser.download_retention_failed", {
        workspaceId: target.workspaceId,
        browserSessionId: target.browserSessionId,
        ...failure,
      });
    }
  } catch (error) {
    console.warn("browser.download_retention_failed", {
      workspaceId: target.workspaceId,
      browserSessionId: target.browserSessionId,
      downloadId: null,
      error: errorMessage(error),
    });
  }
}

/** Whether this worker can save browser profiles: ownership, object storage,
 * the controller delegation secret and the environments encryption key. */
export function browserCheckpointPrerequisites(
  settings: Settings,
  objectStorage: ControlActivityServices["objectStorage"],
): boolean {
  if (
    !settings.sandboxOwnershipEnabled ||
    !objectStorage ||
    !resolveFirstPartyDelegationSecret(settings)
  )
    return false;
  const root = environmentsEncryptionKeyBytes(settings);
  if (!root) return false;
  root.fill(0);
  return true;
}

export function createBrowserDeadlineCheckpointActivities(
  services: () => Promise<ControlActivityServices>,
  connectController: (
    placement: CheckpointPlacement,
  ) => Promise<CheckpointController> = resumeCheckpointController,
) {
  return {
    async listDueBrowserCheckpoints() {
      return await withActivityHeartbeat(async () => {
        const { db, settings, objectStorage } = await services();
        if (!browserCheckpointPrerequisites(settings, objectStorage)) return [];
        return await listBrowserDeadlineCheckpoints(db);
      });
    },
    async checkpointBrowserBeforeDeadline(target: BrowserDeadlineCheckpointTarget) {
      return await withActivityHeartbeat(async () => {
        const { db, settings, objectStorage } = await services();
        const rootKey = environmentsEncryptionKeyBytes(settings);
        const controllerRoot = resolveFirstPartyDelegationSecret(settings);
        if (!rootKey || !objectStorage || !controllerRoot) {
          rootKey?.fill(0);
          throw new Error("browser deadline checkpoint storage or encryption is unavailable");
        }
        let dataKey: Buffer | null = null;
        let aad: Buffer | null = null;
        let timer: ReturnType<typeof setInterval> | null = null;
        try {
          // Only the reaper's locked idle decision prepares an idle save; this
          // activity continues it. A deadline save prepares here.
          const claim = await browserDeadlineCheckpoint(db, target, {
            prepare: target.reason !== "idle",
            touch: true,
          });
          if (!claim) return { status: "skipped" as const };
          let pulseRunning = false;
          let authorityLost = false;
          const pulse = async () => {
            if (pulseRunning) return;
            pulseRunning = true;
            try {
              if (!(await browserDeadlineCheckpoint(db, target, { touch: true })))
                authorityLost = true;
            } finally {
              pulseRunning = false;
            }
          };
          timer = setInterval(() => {
            void pulse().catch(() => undefined);
          }, 5_000);
          const lease = await readLease(db, target.workspaceId, target.sandboxGroupId);
          if (
            !lease ||
            lease.instanceId !== target.instanceId ||
            lease.leaseEpoch !== target.leaseEpoch ||
            !lease.resumeState
          ) {
            throw new Error("browser deadline checkpoint placement changed");
          }
          const placement = {
            kind: "sandbox_group" as const,
            sandboxGroupId: target.sandboxGroupId,
          };
          const client = await connectController({ target, lease, settings, controllerRoot });
          if (authorityLost || !(await browserDeadlineCheckpoint(db, target, { touch: true }))) {
            throw new Error("browser deadline checkpoint authority changed");
          }
          if (claim.state !== "completed") {
            await retainDownloadsBeforeCapture(
              { db, settings, objectStorage },
              target,
              controllerRoot,
              client,
            );
            const scope = { ...target, operationId: claim.operationId };
            const objectKey = browserStateObjectKey(target.workspaceId, claim.operationId);
            dataKey = deriveBrowserStateDataKey(rootKey, { ...scope, objectKey });
            aad = browserStateArtifactAad({ ...scope, objectKey });
            await dispatchBrowserSessionOperation(db, {
              ...scope,
              deadlineTarget: target,
              stateUpload: {
                objectKey,
                cleanupAfter: new Date(Date.now() + UPLOAD_CLEANUP_GRACE_MS),
              },
            });
            const signed = await objectStorage.createPutUrl({
              key: objectKey,
              contentType: BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
              audience: "sandbox",
            });
            const receipt = await client
              .captureState({
                ...scope,
                objectKey,
                afterCapture: "stop",
                dataKey,
                aad,
                upload: {
                  url: signed.url,
                  requiredHeaders: signed.requiredHeaders,
                  expiresAt: signed.expiresAt.toISOString(),
                },
              })
              .catch(async (error: unknown) => {
                if (
                  error instanceof BrowserControlRequestError &&
                  (error.error.code === "outcome_unknown" || !error.error.retryable)
                ) {
                  await failBrowserSessionSuspension(db, { ...scope, error: error.error });
                }
                throw error;
              });
            if (authorityLost) throw new Error("browser deadline checkpoint authority changed");
            const portable = receipt.manifest.profileCrypto !== "platform_bound";
            await commitBrowserSessionSuspension(db, {
              ...scope,
              deadlineTarget: target,
              artifact: {
                kind: "chromium_profile",
                format: receipt.format,
                objectKey,
                artifactDigest: receipt.artifactDigest,
                contentDigest: receipt.contentDigest,
                manifestDigest: browserStateManifestDigest(receipt.manifest),
                sizeBytes: receipt.sizeBytes,
                encryptedDataKey: wrapBrowserStateDataKey(rootKey, dataKey, {
                  ...scope,
                  objectKey,
                  artifactDigest: receipt.artifactDigest,
                  contentDigest: receipt.contentDigest,
                }),
                materialization: {
                  portability: portable ? "portable" : "placement_bound",
                  reason: portable
                    ? null
                    : "Profile encryption depends on the source operating-system credential store.",
                  platform: receipt.manifest.platform,
                  architecture: receipt.manifest.architecture,
                  engine: receipt.manifest.engine,
                  engineVersion: receipt.manifest.engineVersion,
                  driverId: receipt.manifest.driverId,
                  driverSchemaVersion: receipt.manifest.driverSchemaVersion,
                  profileCrypto: receipt.manifest.profileCrypto,
                  providerId: null,
                  placement: portable ? null : placement,
                },
              },
            });
          }
          // Only remove the local profile after the encrypted artifact and its
          // authority committed. A crash resumes this cleanup, never capture.
          await client.endSession(target, { removeState: true }).catch((error: unknown) => {
            if (!(error instanceof BrowserControlRequestError && error.status === 404)) throw error;
          });
          await withRlsContext(
            db,
            target,
            async (tx) => {
              if ((await browserDeadlineCheckpoint(tx, target))?.state !== "completed") {
                throw new Error("browser deadline checkpoint cleanup authority changed");
              }
              await clearSuspendedBrowserSessionController(tx, {
                ...target,
                expectedControllerGeneration: target.controllerGeneration,
              });
              // One transaction prevents a human resume from acquiring a new
              // same-browser holder between clearing and releasing the old one.
              await releaseLeaseHolder(tx, {
                ...target,
                kind: "interaction",
                holderId: `browser-session:${target.browserSessionId}`,
                // The idle window already elapsed before this save began, so
                // a box the saved browser was last to hold drains now.
                idleGraceMs: target.reason === "idle" ? 0 : settings.sandboxIdleGraceMs,
                preserveHoldersChangedAt: target.reason === "idle",
              });
            },
            undefined,
            "none",
          );
          return { status: "suspended" as const };
        } finally {
          if (timer) clearInterval(timer);
          dataKey?.fill(0);
          aad?.fill(0);
          rootKey.fill(0);
        }
      });
    },
  };
}
