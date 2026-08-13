import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import type { MediaGenerationResult } from "@opengeni/contracts";
import { type CanonicalVideoGenerationRequest, videoGenerationRequestDigest } from "@opengeni/core";
import {
  addSessionSystemUpdateWithSourceMutation,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getVideoGenerationOperation,
  markVideoGenerationProviderStarted,
  markVideoGenerationReferenceCleaned,
  markVideoGenerationRetaining,
  markVideoGenerationSubmissionIntent,
  markVideoGenerationSubmissionUncertain,
  materializeXaiCredentialForRun,
  refreshXaiSubscriptionCredentialSerialized,
  rotateVideoGenerationCredential,
  markVideoGenerationTerminalUpdate,
  markVideoGenerationTerminalUpdateInTransaction,
  mediaGenerationResultForStoredOperation,
  rescheduleVideoGenerationOperation,
  settleVideoGenerationFailure,
  settleVideoGenerationReady,
  type XaiCredentialForRun,
  type VideoGenerationOperationWithReferences,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import type { ObjectStorage } from "@opengeni/storage";
import {
  buildGatewayVideoStartBody,
  GatewayVideoApiError,
  getGatewayVideoGenerationStatus,
  startGatewayVideoGenerationWithBody,
  type GatewayVideoReferenceGrant,
} from "./gateway-video-generation";
import {
  downloadGeneratedVideoToVerifiedTemp,
  retainVerifiedGeneratedVideo,
} from "./video-output-retention";
import {
  decryptVideoGenerationCredential,
  encryptVideoGenerationXaiCredential,
  type VideoGenerationProviderCredential,
} from "./video-generation-credential";
import {
  refreshXaiToken,
  XaiSubscriptionError,
  xaiAccessTokenExpiry,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";
import {
  buildXaiVideoStartBody,
  getXaiVideoGenerationStatus,
  startXaiVideoGeneration,
} from "./xai-video-generation";
import type {
  TurnActivityServices,
  VideoGenerationReconcileResult,
  VideoGenerationTerminalStatus,
} from "./types";

const RECONCILE_ERROR_MAX = 1_000;

export function createVideoGenerationActivities(services: () => Promise<TurnActivityServices>) {
  return {
    reconcileVideoGenerationOperation: async (input: {
      accountId: string;
      workspaceId: string;
      operationId: string;
    }): Promise<VideoGenerationReconcileResult> => {
      const service = await services();
      if (!service.objectStorage) {
        throw new Error("Video generation reconciliation requires object storage");
      }
      return await reconcileVideoGenerationOperation(service, input);
    },
  };
}

export async function reconcileVideoGenerationOperation(
  service: TurnActivityServices,
  input: { accountId: string; workspaceId: string; operationId: string },
): Promise<VideoGenerationReconcileResult> {
  const storage = requireStorage(service.objectStorage);
  let operation = await requireOperation(service, input);
  if (isTerminal(operation.status)) {
    await deliverTerminalResult(service, operation);
    return { action: "terminal", status: operation.status };
  }
  const key = environmentsEncryptionKeyBytes(service.settings);
  if (!key) throw new Error("Video generation recovery encryption key is unavailable");
  if (!operation.credentialEncrypted) {
    throw new Error("Video provider credential lease was erased too early");
  }
  const providerCredential = decryptVideoGenerationCredential(key, operation.credentialEncrypted);
  const usesSuperGrok = operation.fundingSource === "supergrok_subscription";
  if (usesSuperGrok !== (providerCredential.kind === "xai-subscription")) {
    throw new Error("Video provider credential does not match its funding source");
  }
  const apiKey = providerCredential.kind === "api-key" ? providerCredential.apiKey : null;
  const xaiAuth =
    providerCredential.kind === "xai-subscription"
      ? await durableXaiVideoAuth(service, operation, key, providerCredential)
      : null;
  let preparedSubmissionThisRun = false;

  if (operation.status === "accepted") {
    const canonical = decryptCanonicalRequest(operation, key);
    const grants: GatewayVideoReferenceGrant[] = [];
    const expirations: Date[] = [];
    for (const reference of operation.references) {
      if (!reference.stagingObjectKey) {
        throw new Error("Video generation reference staging object is missing");
      }
      const signed = await storage.createGetUrl({
        key: reference.stagingObjectKey,
        expiresInSeconds: service.settings.videoGenerationReferenceUrlTtlSeconds,
      });
      grants.push({
        role: parseReferenceRole(reference.role),
        url: signed.url,
        mediaType: reference.contentType,
      });
      expirations.push(signed.expiresAt);
    }
    const providerRequestExpiresAt = expirations.length
      ? new Date(Math.min(...expirations.map((value) => value.getTime())))
      : operation.recoveryDeadlineAt;
    const body = usesSuperGrok
      ? buildXaiVideoStartBody(canonical, grants)
      : buildGatewayVideoStartBody(canonical, grants);
    operation = retainReferences(
      operation,
      await markVideoGenerationSubmissionIntent(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        encryptedProviderRequest: encryptEnvironmentValue(key, JSON.stringify(body)),
        providerRequestExpiresAt,
        nextReconcileAt: new Date(),
      }),
    );
    preparedSubmissionThisRun = true;
  }

  if (operation.status === "submission_uncertain") {
    if (usesSuperGrok && !preparedSubmissionThisRun) {
      operation = retainReferences(
        operation,
        await settleVideoGenerationFailure(service.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          operationId: operation.id,
          requestDigest: operation.requestDigest,
          status: "outcome_unknown",
          publicReason:
            "The video provider did not confirm whether generation started. It was not replayed because xAI provides no start idempotency key.",
        }),
      );
      await deliverTerminalResult(service, operation);
      return { action: "terminal", status: terminalStatus(operation.status) };
    }
    const deadline = Math.min(
      operation.recoveryDeadlineAt.getTime(),
      operation.providerRequestExpiresAt?.getTime() ?? 0,
    );
    if (Date.now() >= deadline) {
      operation = retainReferences(
        operation,
        await settleVideoGenerationFailure(service.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          operationId: operation.id,
          requestDigest: operation.requestDigest,
          status: "outcome_unknown",
          publicReason:
            "The video provider did not confirm whether generation started. It was not retried with a new request.",
        }),
      );
      await deliverTerminalResult(service, operation);
      return { action: "terminal", status: terminalStatus(operation.status) };
    }
    const body = decryptProviderBody(operation, key);
    try {
      const started = usesSuperGrok
        ? await startXaiVideoGeneration({
            body,
            sessionId: operation.sessionId,
            auth: requireXaiAuth(xaiAuth),
          })
        : await startGatewayVideoGenerationWithBody({
            apiKey: requireApiKey(apiKey),
            modelId: operation.modelId,
            body,
            idempotencyKey: operation.providerIdempotencyKey,
          });
      operation = retainReferences(
        operation,
        await markVideoGenerationProviderStarted(service.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          operationId: operation.id,
          requestDigest: operation.requestDigest,
          providerJobId: started.providerJobId,
          nextReconcileAt: nextPoll(service),
        }),
      );
      return waitResult(service);
    } catch (error) {
      if (isPermanentProviderFailure(error)) {
        operation = retainReferences(
          operation,
          await settleVideoGenerationFailure(service.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            operationId: operation.id,
            requestDigest: operation.requestDigest,
            status: "provider_failed",
            publicReason: "The video provider rejected the generation request.",
            privateError: privateError(error),
          }),
        );
        await deliverTerminalResult(service, operation);
        return { action: "terminal", status: terminalStatus(operation.status) };
      }
      await markVideoGenerationSubmissionUncertain(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        nextReconcileAt: nextPoll(service),
        error: privateError(error),
      });
      return waitResult(service);
    }
  }

  if (operation.status !== "provider_started" && operation.status !== "retaining") {
    throw new Error(`Video operation cannot be reconciled from ${operation.status}`);
  }
  if (!operation.providerJobId) throw new Error("Video provider job identity is missing");
  let status;
  try {
    status = usesSuperGrok
      ? await getXaiVideoGenerationStatus({
          providerJobId: operation.providerJobId,
          sessionId: operation.sessionId,
          auth: requireXaiAuth(xaiAuth),
        })
      : await getGatewayVideoGenerationStatus({
          apiKey: requireApiKey(apiKey),
          modelId: operation.modelId,
          providerJobId: operation.providerJobId,
        });
  } catch (error) {
    if (Date.now() < operation.recoveryDeadlineAt.getTime() && !isPermanentProviderFailure(error)) {
      await rescheduleVideoGenerationOperation(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        nextReconcileAt: nextPoll(service),
        error: privateError(error),
      });
      return waitResult(service);
    }
    const failureStatus = operation.status === "retaining" ? "retention_failed" : "outcome_unknown";
    operation = retainReferences(
      operation,
      await settleVideoGenerationFailure(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        status: failureStatus,
        publicReason:
          failureStatus === "retention_failed"
            ? "The generated video could not be retained."
            : "The video provider stopped reporting the accepted generation.",
        privateError: privateError(error),
      }),
    );
    await deliverTerminalResult(service, operation);
    return { action: "terminal", status: terminalStatus(operation.status) };
  }
  if (status.status === "pending") {
    await rescheduleVideoGenerationOperation(service.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: operation.id,
      requestDigest: operation.requestDigest,
      nextReconcileAt: nextPoll(service),
    });
    return waitResult(service);
  }
  if (status.status === "error") {
    const failureStatus = operation.status === "retaining" ? "retention_failed" : "provider_failed";
    operation = retainReferences(
      operation,
      await settleVideoGenerationFailure(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        status: failureStatus,
        publicReason: status.publicReason,
      }),
    );
    await deliverTerminalResult(service, operation);
    return { action: "terminal", status: terminalStatus(operation.status) };
  }

  if (operation.status === "provider_started") {
    operation = retainReferences(
      operation,
      await markVideoGenerationRetaining(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
      }),
    );
  }
  try {
    const canonical = decryptCanonicalRequest(operation, key);
    const downloaded = await downloadGeneratedVideoToVerifiedTemp({
      url: status.outputUrl,
      mediaType: status.mediaType,
      settings: service.settings,
      expectedDurationSeconds: canonical.durationSeconds,
    });
    try {
      const retained = await retainVerifiedGeneratedVideo({
        storage,
        temp: downloaded.temp,
        facts: downloaded.facts,
      });
      const settled = await settleVideoGenerationReady(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        fileId: operation.expectedFileId,
        bucket: retained.bucket,
        objectKey: retained.objectKey,
        sizeBytes: retained.sizeBytes,
        sha256: retained.sha256,
        facts: retained.facts,
      });
      operation = { ...settled.operation, references: operation.references };
    } finally {
      await downloaded.temp.cleanup();
    }
  } catch (error) {
    if (Date.now() < operation.recoveryDeadlineAt.getTime()) {
      await rescheduleVideoGenerationOperation(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        nextReconcileAt: nextPoll(service),
        error: privateError(error),
      });
      return waitResult(service);
    }
    operation = retainReferences(
      operation,
      await settleVideoGenerationFailure(service.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        status: "retention_failed",
        publicReason: "The generated video could not be retained.",
        privateError: privateError(error),
      }),
    );
  }
  await deliverTerminalResult(service, operation);
  return { action: "terminal", status: terminalStatus(operation.status) };
}

async function deliverTerminalResult(
  service: TurnActivityServices,
  operation: VideoGenerationOperationWithReferences,
): Promise<void> {
  if (
    operation.terminalUpdateState === "delivered" ||
    operation.terminalUpdateState === "suppressed"
  ) {
    await cleanupTerminalReferences(service, operation);
    return;
  }
  if (!operation.sessionId) {
    await markVideoGenerationTerminalUpdate(service.db, {
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      operationId: operation.id,
      state: "suppressed",
    });
    await cleanupTerminalReferences(service, operation);
    return;
  }
  const payload = await terminalPayload(service, operation);
  const result = await addSessionSystemUpdateWithSourceMutation(
    service.db,
    {
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      sessionId: operation.sessionId,
      kind: "media_generation_result",
      classification: payload.status === "ready" ? "success" : "failure",
      sourceId: operation.id,
      dedupeKey: `video-generation-terminal:${operation.id}`,
      summary:
        payload.status === "ready"
          ? "The requested video is ready and available in the workspace."
          : payload.boundedPublicReason,
      payload,
      lineage: { operationId: operation.id },
    },
    async (tx, _wakeEventId, updateId) => {
      const marked = await markVideoGenerationTerminalUpdateInTransaction(tx, {
        workspaceId: operation.workspaceId,
        operationId: operation.id,
        state: updateId ? "leased" : "suppressed",
        ...(updateId ? { updateId } : {}),
      });
      if (!marked && operation.terminalUpdateState !== "leased") {
        throw new Error("Video terminal result lost its disposition fence");
      }
    },
  );
  if (result.reason === "session_cancelled") {
    await cleanupTerminalReferences(service, operation);
    return;
  }
  if (result.added && result.events.length > 0) {
    await publishDurableSessionEvents(
      service.bus,
      operation.workspaceId,
      operation.sessionId,
      result.events,
    );
  }
  if (result.shouldWake && service.wakeSessionWorkflow) {
    if (result.workflowWakeRevision === null) {
      throw new Error("Video terminal result wake has no revision");
    }
    await service.wakeSessionWorkflow({
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      sessionId: operation.sessionId,
      workflowId: result.temporalWorkflowId ?? `session-${operation.sessionId}`,
      wakeRevision: result.workflowWakeRevision,
    });
  }
  await cleanupTerminalReferences(service, operation);
}

async function cleanupTerminalReferences(
  service: TurnActivityServices,
  operation: VideoGenerationOperationWithReferences,
): Promise<void> {
  const storage = requireStorage(service.objectStorage);
  for (const reference of operation.references) {
    if (!reference.stagingObjectKey || reference.cleanedAt) continue;
    // `outcome_unknown` is only terminal after the frozen provider grant and
    // recovery deadline have elapsed. Other terminal outcomes have observed a
    // provider terminal state, so their immutable staging inputs are no longer
    // needed. Delete first, then CAS the row; a crash repeats an idempotent delete.
    if (
      operation.status === "outcome_unknown" &&
      Date.now() <
        Math.max(
          operation.recoveryDeadlineAt.getTime(),
          reference.grantExpiresAt?.getTime() ?? 0,
          reference.cleanupAfter?.getTime() ?? 0,
        )
    ) {
      continue;
    }
    const stagingObjectKey = reference.stagingObjectKey;
    await storage.deleteObject(stagingObjectKey);
    const marked = await markVideoGenerationReferenceCleaned(service.db, {
      accountId: operation.accountId,
      workspaceId: operation.workspaceId,
      operationId: operation.id,
      ordinal: reference.ordinal,
      stagingObjectKey,
    });
    if (!marked) throw new Error("Video reference cleanup lost its durable identity");
  }
}

async function terminalPayload(
  service: TurnActivityServices,
  operation: VideoGenerationOperationWithReferences,
): Promise<MediaGenerationResult> {
  return await mediaGenerationResultForStoredOperation(service.db, operation);
}

async function requireOperation(
  service: TurnActivityServices,
  input: { workspaceId: string; operationId: string },
): Promise<VideoGenerationOperationWithReferences> {
  const operation = await getVideoGenerationOperation(
    service.db,
    input.workspaceId,
    input.operationId,
  );
  if (!operation) throw new Error("Video generation operation was not found");
  return operation;
}

function decryptCanonicalRequest(
  operation: VideoGenerationOperationWithReferences,
  key: Uint8Array,
): CanonicalVideoGenerationRequest {
  if (!operation.requestEncrypted) throw new Error("Video generation request was erased too early");
  const parsed = JSON.parse(decryptEnvironmentValue(key, operation.requestEncrypted)) as unknown;
  const request = validateCanonicalRequest(parsed);
  if (videoGenerationRequestDigest(request) !== operation.requestDigest) {
    throw new Error("Video generation request digest is inconsistent");
  }
  return request;
}

function validateCanonicalRequest(value: unknown): CanonicalVideoGenerationRequest {
  const row = record(value);
  const references = Array.isArray(row?.references) ? row.references.map(record) : null;
  if (
    row?.schemaVersion !== 1 ||
    typeof row.modelId !== "string" ||
    typeof row.prompt !== "string" ||
    ![
      "text",
      "first_frame",
      "first_and_last_frames",
      "image_reference",
      "video_reference",
    ].includes(String(row.sourceMode)) ||
    !references ||
    !Number.isInteger(row.durationSeconds) ||
    !["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(String(row.aspectRatio)) ||
    !["480p", "720p"].includes(String(row.resolution)) ||
    typeof row.generateAudio !== "boolean" ||
    references.some(
      (reference) =>
        !reference ||
        !["first_frame", "last_frame", "image_reference", "video_reference"].includes(
          String(reference.role),
        ) ||
        typeof reference.contentSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(reference.contentSha256) ||
        typeof reference.contentType !== "string" ||
        !Number.isSafeInteger(reference.byteSize),
    )
  ) {
    throw new Error("Encrypted video generation request is malformed");
  }
  return value as CanonicalVideoGenerationRequest;
}

function decryptProviderBody(
  operation: VideoGenerationOperationWithReferences,
  key: Uint8Array,
): Record<string, unknown> {
  if (!operation.providerRequestEncrypted) throw new Error("Frozen provider request is missing");
  const body = record(JSON.parse(decryptEnvironmentValue(key, operation.providerRequestEncrypted)));
  if (!body || Buffer.byteLength(JSON.stringify(body)) > 256 * 1024) {
    throw new Error("Frozen provider request is malformed");
  }
  return body;
}

function parseReferenceRole(value: string): GatewayVideoReferenceGrant["role"] {
  if (
    value !== "first_frame" &&
    value !== "last_frame" &&
    value !== "image_reference" &&
    value !== "video_reference"
  ) {
    throw new Error("Video reference role is invalid");
  }
  return value;
}

function requireStorage(storage: ObjectStorage | null): ObjectStorage {
  if (!storage) throw new Error("Video generation requires object storage");
  return storage;
}

function nextPoll(service: TurnActivityServices): Date {
  return new Date(Date.now() + service.settings.videoGenerationPollIntervalMs);
}

function waitResult(service: TurnActivityServices): VideoGenerationReconcileResult {
  return {
    action: "waiting",
    delayMs: service.settings.videoGenerationPollIntervalMs,
  };
}

function requireApiKey(value: string | null): string {
  if (!value) throw new Error("Video provider API key is unavailable");
  return value;
}

function requireXaiAuth(
  value: Pick<XaiSubscriptionRequestContext, "getToken" | "refresh"> | null,
): Pick<XaiSubscriptionRequestContext, "getToken" | "refresh"> {
  if (!value) throw new Error("SuperGrok video authorization is unavailable");
  return value;
}

/**
 * A paid video job outlives the connected-account row. Keep its frozen OAuth
 * lease usable after disconnect, and durably replace rotated refresh tokens
 * before exposing them to another provider call. The shared account row is a
 * best-effort mirror only; it is never the operation's recovery authority.
 */
async function durableXaiVideoAuth(
  service: TurnActivityServices,
  operation: VideoGenerationOperationWithReferences,
  key: Uint8Array,
  credential: Extract<VideoGenerationProviderCredential, { kind: "xai-subscription" }>,
): Promise<Pick<XaiSubscriptionRequestContext, "getToken" | "refresh">> {
  let current = credential;
  const frozenEncrypted = operation.credentialEncrypted;
  if (!frozenEncrypted) throw new Error("SuperGrok video credential lease is unavailable");
  let currentEncrypted: string = frozenEncrypted;

  let connectedAccount: XaiCredentialForRun | null = null;
  try {
    connectedAccount = await materializeXaiCredentialForRun(service.db, {
      workspaceId: operation.workspaceId,
      subjectId: current.subjectId,
      credentialId: current.credentialId,
      authoritySnapshot: current.authoritySnapshot,
      encryptionKey: key,
    });
  } catch {
    // Disconnect/revocation must not cancel a previously accepted paid job.
  }

  return {
    getToken: async () => ({
      accessToken: current.accessToken,
      userId: current.userId,
    }),
    refresh: async () => {
      let next: typeof current | null = null;
      if (connectedAccount) {
        try {
          const result = await refreshXaiSubscriptionCredentialSerialized(service.db, {
            accountId: operation.accountId,
            workspaceId: operation.workspaceId,
            subjectId: current.subjectId,
            credentialId: current.credentialId,
            authoritySnapshot: current.authoritySnapshot,
            encryptionKey: key,
            observedAccessToken: current.accessToken,
            observedRefreshToken: current.refreshToken,
            refresh: async (shared) => {
              const refreshToken = shared.secret.refreshToken;
              if (!refreshToken) {
                throw new Error("The connected SuperGrok account cannot be refreshed");
              }
              const tokens = await refreshXaiToken(refreshToken);
              return {
                secret: {
                  version: 1,
                  accessToken: tokens.accessToken,
                  refreshToken: tokens.refreshToken,
                },
                expiresAt:
                  xaiAccessTokenExpiry(tokens.accessToken) ??
                  new Date(Date.now() + tokens.expiresInSeconds * 1_000),
              };
            },
          });
          connectedAccount = result.credential;
          if (
            connectedAccount.secret.accessToken &&
            connectedAccount.secret.refreshToken &&
            connectedAccount.providerAccountId
          ) {
            next = Object.freeze({
              ...current,
              accessToken: connectedAccount.secret.accessToken,
              refreshToken: connectedAccount.secret.refreshToken,
              userId: connectedAccount.providerAccountId,
            });
          }
        } catch {
          // Disconnect/revocation must not cancel a previously accepted paid job.
          connectedAccount = null;
        }
      }
      if (!next) {
        const tokens = await refreshXaiToken(current.refreshToken);
        next = Object.freeze({
          ...current,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
      }
      const nextEncrypted = encryptVideoGenerationXaiCredential(key, next);
      await rotateVideoGenerationCredential(service.db, {
        accountId: operation.accountId,
        workspaceId: operation.workspaceId,
        operationId: operation.id,
        requestDigest: operation.requestDigest,
        expectedCredentialEncrypted: currentEncrypted,
        credentialEncrypted: nextEncrypted,
      });
      current = next;
      currentEncrypted = nextEncrypted;
      return { accessToken: current.accessToken, userId: current.userId };
    },
  };
}

function isPermanentProviderFailure(error: unknown): boolean {
  if (error instanceof GatewayVideoApiError) return !error.retryable;
  if (!(error instanceof XaiSubscriptionError)) return false;
  if (error.kind === "relogin_required") return true;
  if (error.kind !== "provider_rejected") return false;
  return (
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function privateError(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/https?:\/\/\S+/gu, "[url omitted]")
    .slice(0, RECONCILE_ERROR_MAX);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTerminal(status: string): status is VideoGenerationTerminalStatus {
  return [
    "completed",
    "provider_failed",
    "cancelled_before_submit",
    "outcome_unknown",
    "retention_failed",
  ].includes(status);
}

function terminalStatus(status: string): VideoGenerationTerminalStatus {
  if (!isTerminal(status)) throw new Error(`Video generation status ${status} is not terminal`);
  return status;
}

function retainReferences(
  current: VideoGenerationOperationWithReferences,
  next: Omit<VideoGenerationOperationWithReferences, "references">,
): VideoGenerationOperationWithReferences {
  return { ...next, references: current.references };
}
