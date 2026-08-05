import { createHash } from "node:crypto";
import {
  CreateTranscriptionRecordingRequest,
  FinalizeTranscriptionRecordingRequest,
  resolveWorkspaceVoiceInputEnabled,
  TRANSCRIPTION_RECORDING_PROVIDER_SEGMENT_SECONDS,
  TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS,
  type TranscriptionRecordingErrorCode,
  type TranscriptionRecordingResponse,
  type UploadTranscriptionRecordingChunkResponse,
} from "@opengeni/contracts";
import {
  isAcceptedMimeType,
  normalizeMimeType,
  requireAccessGrant,
  TRANSCRIPTION_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
  TranscriptionServiceError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  claimNextTranscriptionRecordingSegment,
  claimTranscriptionRecordingAssembly,
  completeTranscriptionRecordingAssembly,
  completeTranscriptionRecordingChunk,
  completeTranscriptionRecordingSegment,
  completeTranscriptionRecordingSegmentPreparation,
  createTranscriptionRecording,
  discardTranscriptionRecording,
  failTranscriptionRecordingAssembly,
  failTranscriptionRecordingSegment,
  getTranscriptionRecording,
  listTranscriptionRecordings,
  listTranscriptionRecordingChunks,
  markTranscriptionRecordingObjectCleaned,
  markTranscriptionRecordingObjectsCleaned,
  reserveTranscriptionRecordingChunk,
  reserveTranscriptionRecordingSegment,
  startTranscriptionRecordingSegmentProviderCall,
  transcriptionRecordingObjectKeys,
  TranscriptionRecordingConflictError,
  TranscriptionRecordingNotFoundError,
  TranscriptionRecordingStateError,
} from "@opengeni/db";
import { getWorkspace } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { TranscriptionSegmenterError } from "../transcription/segmenter";

const CHUNK_SHA256_HEADER = "x-opengeni-chunk-sha256";
const CHUNK_START_HEADER = "x-opengeni-chunk-start-milliseconds";
const CHUNK_DURATION_HEADER = "x-opengeni-chunk-duration-milliseconds";
const PROCESSING_LEASE_MILLISECONDS = 15 * 60 * 1_000;

type RecordingAuthority = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
};

class RecordingProcessingError extends Error {
  readonly name = "RecordingProcessingError";

  constructor(
    message: string,
    readonly code: TranscriptionRecordingErrorCode,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function registerResumableTranscriptionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/transcription-recordings", async (c) => {
    try {
      const authority = await requireRecordingAuthority(c, deps, false);
      return c.json({
        recordings: await listTranscriptionRecordings(deps.db, {
          workspaceId: authority.workspaceId,
          subjectId: authority.subjectId,
        }),
      });
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/transcription-recordings", async (c) => {
    try {
      const authority = await requireRecordingAuthority(c, deps, true);
      if (!(await resumableAvailable(deps, authority.workspaceId))) {
        return c.json({ code: "unavailable" }, 503);
      }
      const parsed = CreateTranscriptionRecordingRequest.safeParse(await jsonBody(c));
      if (!parsed.success) return c.json({ code: "invalid_request" }, 400);
      const mimeType = normalizeMimeType(parsed.data.mimeType);
      if (!isAcceptedMimeType(mimeType, deps.transcription!.limits().acceptedMimeTypes)) {
        return c.json({ code: "not_supported" }, 415);
      }
      const recording = await createTranscriptionRecording(deps.db, {
        ...authority,
        recordingId: parsed.data.recordingId,
        mimeType,
        expiresAt: new Date(Date.now() + deps.settings.voiceInputResumableRetentionSeconds * 1_000),
      });
      return c.json(recording, 201);
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/transcription-recordings/:recordingId", async (c) => {
    try {
      const authority = await requireRecordingAuthority(c, deps, false);
      const response = await getTranscriptionRecording(deps.db, {
        ...authority,
        recordingId: uuidParam(c, "recordingId"),
      });
      return c.json(withRecoveryRetryHint(await cleanupTerminalObjects(deps, authority, response)));
    } catch (error) {
      return routeError(c, error);
    }
  });

  app.put(
    "/v1/workspaces/:workspaceId/transcription-recordings/:recordingId/chunks/:chunkNumber",
    async (c) => {
      try {
        const authority = await requireRecordingAuthority(c, deps, true);
        if (!deps.objectStorage || !deps.settings.voiceInputResumableEnabled) {
          return c.json({ code: "unavailable" }, 503);
        }
        const chunkNumber = nonnegativeInteger(c.req.param("chunkNumber"));
        const startMilliseconds = headerInteger(c, CHUNK_START_HEADER, true);
        const durationMilliseconds = headerInteger(c, CHUNK_DURATION_HEADER, true);
        const declaredSha256 = c.req.header(CHUNK_SHA256_HEADER)?.trim().toLowerCase() ?? "";
        if (!/^[0-9a-f]{64}$/.test(declaredSha256)) {
          return c.json({ code: "invalid_request" }, 400);
        }
        const body = await readBoundedBody(
          c.req.raw,
          deps.settings.voiceInputResumableMaxChunkSizeBytes,
        );
        const sha256 = sha256Hex(body);
        if (sha256 !== declaredSha256) {
          return c.json({ code: "conflict" }, 409);
        }
        const existing = await getTranscriptionRecording(deps.db, {
          ...authority,
          recordingId: uuidParam(c, "recordingId"),
        });
        if (
          normalizeMimeType(c.req.header("content-type") ?? "") !==
          normalizeMimeType(existing.recording.mimeType)
        ) {
          return c.json({ code: "not_supported" }, 415);
        }
        const reservation = await reserveTranscriptionRecordingChunk(deps.db, {
          ...authority,
          recordingId: existing.recording.id,
          chunkNumber,
          byteLength: body.byteLength,
          sha256,
          startMilliseconds,
          durationMilliseconds,
          maxTotalBytes: deps.settings.voiceInputResumableMaxSizeBytes,
          maxDurationMilliseconds: deps.settings.voiceInputResumableMaxDurationSeconds * 1_000,
        });
        if (!reservation.deduplicated) {
          try {
            // A concurrent same-hash retry may still observe the row while it is
            // uploading and repeat this PUT. The object key is hash-derived and
            // the storage contract permits identical verified writes; the DB
            // completion fence prevents duplicate chunk accounting.
            await deps.objectStorage.putObject({
              key: reservation.chunk.objectKey,
              contentType: existing.recording.mimeType,
              body,
              sha256,
            });
          } catch {
            throw new RecordingProcessingError("Chunk upload failed", "network", true);
          }
        }
        const completed = await completeTranscriptionRecordingChunk(deps.db, {
          workspaceId: authority.workspaceId,
          subjectId: authority.subjectId,
          recordingId: existing.recording.id,
          chunkNumber,
        });
        const response: UploadTranscriptionRecordingChunkResponse = {
          recording: completed.recording.recording,
          chunk: {
            chunkNumber: completed.chunk.chunkNumber,
            byteLength: completed.chunk.byteLength,
            sha256: completed.chunk.sha256,
            startMilliseconds: completed.chunk.startMilliseconds,
            durationMilliseconds: completed.chunk.durationMilliseconds,
            deduplicated: reservation.deduplicated || completed.deduplicated,
          },
        };
        return c.json(response);
      } catch (error) {
        return routeError(c, error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/transcription-recordings/:recordingId/finalize",
    async (c) => {
      const owner = correlationId(c);
      let authority: RecordingAuthority | null = null;
      let generation = 0;
      try {
        authority = await requireRecordingAuthority(c, deps, true);
        if (!(await resumableAvailable(deps, authority.workspaceId))) {
          return c.json({ code: "unavailable" }, 503);
        }
        const parsed = FinalizeTranscriptionRecordingRequest.safeParse(await jsonBody(c));
        if (!parsed.success) return c.json({ code: "invalid_request" }, 400);
        const recordingId = uuidParam(c, "recordingId");
        const claim = await claimTranscriptionRecordingAssembly(deps.db, {
          workspaceId: authority.workspaceId,
          subjectId: authority.subjectId,
          recordingId,
          owner,
          ...parsed.data,
          staleBefore: new Date(Date.now() - PROCESSING_LEASE_MILLISECONDS),
        });
        generation = claim.generation;
        if (!claim.claimed) {
          const response = withRecoveryRetryHint(claim.recording);
          return c.json(response, claim.recording.recording.state === "segmenting" ? 202 : 200);
        }
        for (const key of claim.staleObjectKeys) {
          try {
            await deps.objectStorage!.deleteObject(key);
            await markTranscriptionRecordingObjectCleaned(deps.db, {
              workspaceId: authority.workspaceId,
              subjectId: authority.subjectId,
              recordingId,
              objectKey: key,
            });
          } catch {
            // The durable object ledger keeps the key eligible for the global reaper.
          }
        }
        const chunks = await listTranscriptionRecordingChunks(deps.db, {
          workspaceId: authority.workspaceId,
          subjectId: authority.subjectId,
          recordingId,
        });
        const providerMaxSegmentSeconds = deps.transcription!.limits().maxDurationSeconds;
        const minimumBoundedSegmentSeconds = Math.ceil(
          claim.recording.recording.totalDurationMilliseconds / 1_000 / 1_000,
        );
        if (providerMaxSegmentSeconds < minimumBoundedSegmentSeconds) {
          throw new RecordingProcessingError(
            "Recording cannot fit the bounded provider segment projection",
            "too_large",
            false,
          );
        }
        const providerSegmentSeconds = Math.min(
          TRANSCRIPTION_RECORDING_PROVIDER_SEGMENT_SECONDS,
          providerMaxSegmentSeconds,
        );
        for await (const segment of deps.transcriptionSegmenter!.segment({
          sourceMimeType: claim.recording.recording.mimeType,
          totalDurationMilliseconds: claim.recording.recording.totalDurationMilliseconds,
          providerSegmentSeconds,
          chunks: verifiedChunkBytes(deps, chunks, c.req.raw.signal),
          signal: c.req.raw.signal,
        })) {
          const sha256 = sha256Hex(segment.bytes);
          const reservation = await reserveTranscriptionRecordingSegment(deps.db, {
            ...authority,
            recordingId,
            owner,
            generation,
            segmentNumber: segment.segmentNumber,
            byteLength: segment.bytes.byteLength,
            sha256,
            startMilliseconds: segment.startMilliseconds,
            durationMilliseconds: segment.durationMilliseconds,
          });
          try {
            await deps.objectStorage!.putObject({
              key: reservation.objectKey,
              contentType: segment.mimeType,
              body: segment.bytes,
              sha256,
            });
          } catch {
            throw new RecordingProcessingError("Segment upload failed", "network", true);
          }
          await completeTranscriptionRecordingSegmentPreparation(deps.db, {
            workspaceId: authority.workspaceId,
            subjectId: authority.subjectId,
            recordingId,
            owner,
            generation,
            segmentNumber: segment.segmentNumber,
          });
        }
        return c.json(
          await completeTranscriptionRecordingAssembly(deps.db, {
            workspaceId: authority.workspaceId,
            subjectId: authority.subjectId,
            recordingId,
            owner,
            generation,
          }),
        );
      } catch (error) {
        if (authority && generation > 0) {
          const failure = processingFailure(error);
          const persisted = await failTranscriptionRecordingAssembly(deps.db, {
            workspaceId: authority.workspaceId,
            subjectId: authority.subjectId,
            recordingId: uuidParam(c, "recordingId"),
            owner,
            generation,
            errorCode: failure.code,
            retryable: failure.retryable,
          }).catch(() => null);
          if (persisted) return c.json(persisted);
        }
        return routeError(c, error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/transcription-recordings/:recordingId/process-next",
    async (c) => {
      let authority: RecordingAuthority | null = null;
      let attemptId: string | null = null;
      let segmentNumber: number | null = null;
      try {
        authority = await requireRecordingAuthority(c, deps, true);
        const service = deps.transcription;
        if (
          !deps.objectStorage ||
          !service ||
          !(await service.available({ workspaceId: authority.workspaceId }))
        ) {
          return c.json({ code: "unavailable" }, 503);
        }
        const selectedProvider = service.selectProvider
          ? await service.selectProvider({ workspaceId: authority.workspaceId })
          : "host";
        if (!selectedProvider) return c.json({ code: "unavailable" }, 503);
        attemptId = correlationId(c);
        const claim = await claimNextTranscriptionRecordingSegment(deps.db, {
          workspaceId: authority.workspaceId,
          subjectId: authority.subjectId,
          recordingId: uuidParam(c, "recordingId"),
          attemptId,
          providerId: selectedProvider,
          staleBefore: new Date(Date.now() - PROCESSING_LEASE_MILLISECONDS),
          providerDeadlineAt: new Date(Date.now() + PROCESSING_LEASE_MILLISECONDS),
        });
        if (!claim.claimed || !claim.segment) {
          const cleaned = await cleanupTerminalObjects(deps, authority, claim.recording);
          return c.json(
            withRecoveryRetryHint(cleaned),
            cleaned.recording.state === "transcribing" ? 202 : 200,
          );
        }
        segmentNumber = claim.segment.segmentNumber;
        const stored = await deps.objectStorage?.getObjectBytes(claim.segment.objectKey);
        if (!stored) {
          throw new RecordingProcessingError("Provider segment is missing", "invalid_audio", false);
        }
        if (
          stored.bytes.byteLength !== claim.segment.byteLength ||
          sha256Hex(stored.bytes) !== claim.segment.sha256
        ) {
          throw new RecordingProcessingError(
            "Provider segment failed integrity verification",
            "invalid_audio",
            false,
          );
        }
        const providerStartedAt = new Date();
        const providerDeadlineAt = new Date(
          providerStartedAt.getTime() + TRANSCRIPTION_PROVIDER_REQUEST_TIMEOUT_MILLISECONDS,
        );
        await startTranscriptionRecordingSegmentProviderCall(deps.db, {
          workspaceId: authority.workspaceId,
          subjectId: authority.subjectId,
          recordingId: uuidParam(c, "recordingId"),
          segmentNumber,
          attemptId,
          providerStartedAt,
          providerDeadlineAt,
        });
        const result = await service.transcribe({
          workspaceId: authority.workspaceId,
          accountId: authority.accountId,
          audio: stored.bytes,
          mimeType: "audio/wav",
          durationSeconds: claim.segment.durationMilliseconds / 1_000,
          requestId: attemptId,
          providerDeadlineAt,
          ...(claim.segment.providerId && claim.segment.providerId !== "host"
            ? { providerId: claim.segment.providerId }
            : {}),
        });
        const completed = await completeTranscriptionRecordingSegment(deps.db, {
          workspaceId: authority.workspaceId,
          subjectId: authority.subjectId,
          recordingId: uuidParam(c, "recordingId"),
          segmentNumber,
          attemptId,
          text: result.text,
          languages: result.languages,
          providerId: claim.segment.providerId ?? result.providerId,
        });
        return c.json(await cleanupTerminalObjects(deps, authority, completed));
      } catch (error) {
        if (authority && attemptId && segmentNumber !== null) {
          const failure = processingFailure(error);
          const persisted = await failTranscriptionRecordingSegment(deps.db, {
            workspaceId: authority.workspaceId,
            subjectId: authority.subjectId,
            recordingId: uuidParam(c, "recordingId"),
            segmentNumber,
            attemptId,
            errorCode: failure.code,
            retryable: failure.retryable,
          }).catch(() => null);
          if (persisted) return c.json(persisted);
        }
        return routeError(c, error);
      }
    },
  );

  app.delete("/v1/workspaces/:workspaceId/transcription-recordings/:recordingId", async (c) => {
    try {
      const authority = await requireRecordingAuthority(c, deps, false);
      const discarded = await discardTranscriptionRecording(deps.db, {
        workspaceId: authority.workspaceId,
        subjectId: authority.subjectId,
        recordingId: uuidParam(c, "recordingId"),
      });
      return c.json(await cleanupTerminalObjects(deps, authority, discarded));
    } catch (error) {
      return routeError(c, error);
    }
  });
}

function withRecoveryRetryHint(
  response: TranscriptionRecordingResponse,
): TranscriptionRecordingResponse {
  if (response.recording.state === "segmenting" || response.recording.state === "transcribing") {
    return {
      ...response,
      retryAfterMilliseconds: TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS,
    };
  }
  return response;
}

async function requireRecordingAuthority(
  c: Context,
  deps: ApiRouteDeps,
  requirePolicy: boolean,
): Promise<RecordingAuthority> {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    throw new TranscriptionRecordingNotFoundError("Workspace not found");
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
  if (requirePolicy) {
    const workspace = await getWorkspace(deps.db, workspaceId);
    if (!workspace) throw new TranscriptionRecordingNotFoundError("Workspace not found");
    if (resolveWorkspaceVoiceInputEnabled(workspace.settings) === false) {
      throw new RecordingProcessingError("Voice input is disabled", "policy_blocked", false);
    }
  }
  return {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
  };
}

async function resumableAvailable(deps: ApiRouteDeps, workspaceId: string): Promise<boolean> {
  return Boolean(
    deps.settings.voiceInputResumableEnabled &&
    deps.objectStorage &&
    deps.transcription &&
    deps.transcriptionSegmenter &&
    (await deps.transcription.available({ workspaceId })) &&
    (await deps.transcriptionSegmenter.available()),
  );
}

async function cleanupTerminalObjects(
  deps: ApiRouteDeps,
  authority: RecordingAuthority,
  response: TranscriptionRecordingResponse,
): Promise<TranscriptionRecordingResponse> {
  if (
    !deps.objectStorage ||
    response.recording.objectsCleaned ||
    (response.recording.state !== "complete" &&
      response.recording.state !== "discarded" &&
      !(response.recording.state === "failed" && !response.recording.retryable))
  ) {
    return response;
  }
  try {
    const keys = await transcriptionRecordingObjectKeys(deps.db, {
      workspaceId: authority.workspaceId,
      subjectId: authority.subjectId,
      recordingId: response.recording.id,
    });
    let current = response;
    for (const key of keys) {
      await deps.objectStorage.deleteObject(key);
      current = await markTranscriptionRecordingObjectCleaned(deps.db, {
        workspaceId: authority.workspaceId,
        subjectId: authority.subjectId,
        recordingId: response.recording.id,
        objectKey: key,
      });
    }
    if (current.recording.objectsCleaned) return current;
    return await markTranscriptionRecordingObjectsCleaned(deps.db, {
      workspaceId: authority.workspaceId,
      subjectId: authority.subjectId,
      recordingId: response.recording.id,
    });
  } catch {
    return response;
  }
}

async function* verifiedChunkBytes(
  deps: ApiRouteDeps,
  chunks: Awaited<ReturnType<typeof listTranscriptionRecordingChunks>>,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    if (signal.aborted) {
      throw new RecordingProcessingError("Audio assembly was cancelled", "cancelled", true);
    }
    let stored: Awaited<ReturnType<NonNullable<ApiRouteDeps["objectStorage"]>["getObjectBytes"]>>;
    try {
      stored = await deps.objectStorage!.getObjectBytes(chunk.objectKey);
    } catch {
      throw new RecordingProcessingError("Chunk download failed", "network", true);
    }
    if (!stored) {
      throw new RecordingProcessingError("Chunk is missing", "invalid_audio", false);
    }
    if (stored.bytes.byteLength !== chunk.byteLength || sha256Hex(stored.bytes) !== chunk.sha256) {
      throw new RecordingProcessingError(
        "Chunk integrity verification failed",
        "invalid_audio",
        false,
      );
    }
    yield stored.bytes;
  }
}

function processingFailure(error: unknown): {
  code: TranscriptionRecordingErrorCode;
  retryable: boolean;
} {
  if (error instanceof RecordingProcessingError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof TranscriptionSegmenterError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof TranscriptionServiceError) {
    return {
      code: error.code,
      retryable:
        error.retryable ||
        error.code === "cancelled" ||
        error.code === "network" ||
        error.code === "timeout" ||
        error.code === "unavailable" ||
        error.code === "provider",
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "cancelled", retryable: true };
  }
  return { code: "unknown", retryable: true };
}

function routeError(c: Context, error: unknown): Response | Promise<Response> {
  if (error instanceof TranscriptionRecordingNotFoundError) {
    return c.json({ code: "not_found" }, 404);
  }
  if (error instanceof TranscriptionRecordingConflictError) {
    return c.json({ code: "conflict" }, 409);
  }
  if (error instanceof TranscriptionRecordingStateError) {
    return c.json({ code: "invalid_state" }, 409);
  }
  if (error instanceof RecordingProcessingError) {
    const status =
      error.code === "policy_blocked"
        ? 403
        : error.code === "not_supported"
          ? 415
          : error.code === "too_large"
            ? 413
            : error.code === "invalid_audio"
              ? 400
              : error.code === "unavailable"
                ? 503
                : 502;
    return c.json({ code: error.code }, status as never);
  }
  return c.json({ code: "unknown" }, 500);
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function correlationId(c: Context): string {
  const value = c.req.header("x-opengeni-correlation-id")?.trim();
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? valueAsUuid(value) : crypto.randomUUID();
}

function valueAsUuid(value: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function nonnegativeInteger(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RecordingProcessingError("Invalid integer", "invalid_audio", false);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RecordingProcessingError("Invalid integer", "invalid_audio", false);
  }
  return parsed;
}

function uuidParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new TranscriptionRecordingNotFoundError("Recording not found");
  }
  return value;
}

function headerInteger(c: Context, name: string, allowZero: boolean): number {
  const raw = c.req.header(name) ?? "";
  const value = nonnegativeInteger(raw);
  if (!allowZero && value === 0) {
    throw new RecordingProcessingError("Invalid integer", "invalid_audio", false);
  }
  return value;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RecordingProcessingError("Chunk is too large", "too_large", false);
  }
  if (!request.body) {
    throw new RecordingProcessingError("Chunk is required", "invalid_audio", false);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (request.signal.aborted) {
        throw new RecordingProcessingError("Chunk upload was cancelled", "cancelled", true);
      }
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RecordingProcessingError("Chunk is too large", "too_large", false);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new RecordingProcessingError("Chunk is required", "invalid_audio", false);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
