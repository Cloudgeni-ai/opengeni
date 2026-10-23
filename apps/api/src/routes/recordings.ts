import {
  CompleteRecordingChunksRequest,
  CreateRecordingPersonRequest,
  CreateRecordingRequest,
  CreateRecordingTranscriptRequest,
  CreateRecordingUploadsRequest,
  FinalizeRecordingRequest,
  resolveWorkspaceRecordingSettings,
  UpdateRecordingRequest,
  UpdateRecordingSegmentsRequest,
  UpdateRecordingSpeakersRequest,
  type Recording,
  type RecordingChunkUpload,
  type RecordingTranscriptionModel,
  type RecordingTranscriptionOptions,
} from "@opengeni/contracts";
import {
  createRecordingTranscriptionProviderRegistry,
  DEFAULT_RECORDING_TRANSCRIPTION,
  findRecordingTranscriptionModel,
  requireAccessGrant,
  type ApiRouteDeps,
  type RecordingTranscriptionProviderRegistry,
} from "@opengeni/core";
import {
  createRecording,
  createRecordingPerson,
  createRecordingTranscriptVersion,
  finalizeRecording,
  getRecording,
  getRecordingTrackPreparedObject,
  getRecordingTranscriptPage,
  getWorkspace,
  listRecordingChunks,
  listRecordingPeople,
  listRecordings,
  listRecordingTranscriptVersions,
  markRecordingChunksUploaded,
  markRecordingDeleting,
  recordAuditEvent,
  RecordingConflictError,
  RecordingForbiddenError,
  RecordingNotFoundError,
  reserveRecordingChunks,
  setCurrentRecordingTranscriptVersion,
  updateRecording,
  updateRecordingSegments,
  updateRecordingSpeakers,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import { elevenLabsKeyAvailable } from "../realtime-websocket";

const UPLOAD_URL_SECONDS = 15 * 60;
const PLAYBACK_URL_SECONDS = 60 * 60;

/**
 * Recordings: captured conversations made of audio tracks. Clients record
 * locally, upload chunks straight to storage with presigned URLs, then
 * finalize; the worker prepares the audio and makes transcript versions.
 */
export function registerRecordingRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: { registry?: RecordingTranscriptionProviderRegistry } = {},
): void {
  const { db } = deps;
  const registry = options.registry ?? createRecordingTranscriptionProviderRegistry();
  const base = "/v1/workspaces/:workspaceId/recordings";

  async function actorFor(c: Context, permission: "sessions:read" | "sessions:create") {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    return { workspaceId, subjectId: grant.subjectId, accountId: grant.accountId };
  }

  function recordingIdParam(c: Context): string {
    const recordingId = c.req.param("recordingId") ?? "";
    if (!z.string().uuid().safeParse(recordingId).success) throw notFound();
    return recordingId;
  }

  function versionIdQuery(c: Context, name = "version"): string | undefined {
    const value = c.req.query(name);
    if (value === undefined) return undefined;
    if (!z.string().uuid().safeParse(value).success) throw notFound("Transcript version not found");
    return value;
  }

  function storage() {
    if (!deps.objectStorage) {
      throw new ApiHttpError(503, {
        code: "upstream_unavailable",
        message: "Recording storage is not configured on this deployment.",
        retryable: false,
      });
    }
    return deps.objectStorage;
  }

  /** The request's model, else the workspace's default, else the deployment default. */
  async function transcriptionChoice(
    workspaceId: string,
    requested: RecordingTranscriptionOptions,
  ): Promise<{ providerId: string; model: string; options: RecordingTranscriptionOptions }> {
    const workspace = await getWorkspace(db, workspaceId);
    const defaults =
      resolveWorkspaceRecordingSettings(workspace?.settings).transcription ??
      DEFAULT_RECORDING_TRANSCRIPTION;
    const providerId = requested.providerId ?? defaults.providerId;
    const model = requested.model ?? (requested.providerId ? undefined : defaults.model);
    const found = model ? findRecordingTranscriptionModel(registry, providerId, model) : null;
    if (!found) {
      throw new ApiHttpError(400, {
        code: "validation_failed",
        message: "This transcription model is not offered here.",
        retryable: false,
        details: { code: "unknown_model", providerId, model: model ?? null },
      });
    }
    const { providerId: _provider, model: _model, ...rest } = requested;
    return { providerId, model: found.spec.model, options: rest };
  }

  async function startTranscript(
    accountId: string,
    recording: Recording,
    versionId: string,
  ): Promise<void> {
    await deps.workflowClient.startRecordingWorkflow?.({
      kind: "transcript",
      accountId,
      workspaceId: recording.workspaceId,
      recordingId: recording.id,
      versionId,
      ownerSubjectId: recording.ownerSubjectId,
    });
  }

  app.get(base, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    const beforeStartedAt = c.req.query("beforeStartedAt");
    const beforeId = c.req.query("beforeId");
    const limit = Number(c.req.query("limit") ?? 50);
    let before: { startedAt: Date; id: string } | undefined;
    if (beforeStartedAt || beforeId) {
      const startedAt = new Date(beforeStartedAt ?? "");
      if (Number.isNaN(startedAt.getTime()) || !z.string().uuid().safeParse(beforeId).success) {
        throw invalid("beforeStartedAt and beforeId must be given together");
      }
      before = { startedAt, id: beforeId! };
    }
    const query = c.req.query("query")?.slice(0, 200);
    const externalRef = c.req.query("externalRef")?.slice(0, 512);
    return c.json(
      await listRecordings(db, {
        workspaceId: actor.workspaceId,
        subjectId: actor.subjectId,
        query: query || undefined,
        externalRef: externalRef || undefined,
        before,
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    );
  });

  app.post(base, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const body = await parseRequestJson(c, CreateRecordingRequest);
    const workspace = await getWorkspace(db, actor.workspaceId);
    const settings = resolveWorkspaceRecordingSettings(workspace?.settings);
    if (body.transcription) await transcriptionChoice(actor.workspaceId, body.transcription);
    const result = await guard(() =>
      createRecording(db, {
        ...actor,
        recordingId: body.recordingId,
        title: body.title,
        visibility: body.visibility ?? settings.defaultVisibility ?? "private",
        startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
        externalRef: body.externalRef,
        metadata: body.metadata,
        tracks: body.tracks,
        transcription: body.transcription,
      }),
    );
    return c.json(result.recording, result.created ? 201 : 200);
  });

  app.get(`${base}/:recordingId`, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    return c.json(
      await guard(() => getRecording(db, { ...actor, recordingId: recordingIdParam(c) })),
    );
  });

  app.patch(`${base}/:recordingId`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, UpdateRecordingRequest);
    return c.json(await guard(() => updateRecording(db, { ...actor, recordingId, ...body })));
  });

  app.delete(`${base}/:recordingId`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const { ownerSubjectId } = await guard(() =>
      markRecordingDeleting(db, { ...actor, recordingId }),
    );
    await deps.workflowClient.startRecordingWorkflow?.({
      kind: "deletion",
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      recordingId,
      versionId: null,
      ownerSubjectId,
    });
    return c.body(null, 204);
  });

  app.post(`${base}/:recordingId/uploads`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, CreateRecordingUploadsRequest);
    const objects = storage();
    const recording = await guard(() => getRecording(db, { ...actor, recordingId }));
    const track = recording.tracks.find((item) => item.trackNumber === body.trackNumber);
    const rows = await guard(() =>
      reserveRecordingChunks(db, {
        ...actor,
        recordingId,
        trackNumber: body.trackNumber,
        chunks: body.chunks,
      }),
    );
    const uploads: RecordingChunkUpload[] = await Promise.all(
      rows.map(async (row) => {
        if (row.state === "uploaded") {
          return {
            chunkNumber: row.chunkNumber,
            uploaded: true,
            url: null,
            method: "PUT" as const,
            headers: {},
            expiresAt: null,
          };
        }
        const put = await objects.createPutUrl({
          key: row.objectKey,
          contentType: track?.mimeType.split(";")[0]!.trim() ?? "application/octet-stream",
          sha256: row.sha256,
          expiresInSeconds: UPLOAD_URL_SECONDS,
          audience: "public",
        });
        return {
          chunkNumber: row.chunkNumber,
          uploaded: false,
          url: put.url,
          method: "PUT" as const,
          headers: put.requiredHeaders,
          expiresAt: put.expiresAt.toISOString(),
        };
      }),
    );
    const issued = uploads.filter((upload) => upload.url !== null);
    if (issued.length > 0) {
      // Signed URLs are bearer capabilities: record the issuance (never the URL or key).
      await recordAuditEvent(db, {
        accountId: actor.accountId,
        workspaceId: actor.workspaceId,
        subjectId: actor.subjectId,
        action: "recording.signed_upload.issued",
        targetType: "recording",
        targetId: recordingId,
        metadata: {
          recordingId,
          trackNumber: body.trackNumber,
          chunkNumbers: issued.map((upload) => upload.chunkNumber),
          expiresAt: issued[0]!.expiresAt,
        },
      });
    }
    return c.json({ uploads });
  });

  app.post(`${base}/:recordingId/chunks/complete`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, CompleteRecordingChunksRequest);
    const objects = storage();
    const rows = await guard(() =>
      listRecordingChunks(db, {
        ...actor,
        recordingId,
        trackNumber: body.trackNumber,
        chunkNumbers: body.chunkNumbers,
      }),
    );
    const missing: number[] = [];
    const present: number[] = [];
    for (const chunkNumber of new Set(body.chunkNumbers)) {
      const row = rows.find((item) => item.chunkNumber === chunkNumber);
      if (!row) {
        missing.push(chunkNumber);
        continue;
      }
      if (row.state === "uploaded") {
        present.push(chunkNumber);
        continue;
      }
      const size = await storedSize(objects, row.objectKey);
      if (size === row.byteLength) present.push(chunkNumber);
      else missing.push(chunkNumber);
    }
    const updated = await guard(() =>
      markRecordingChunksUploaded(db, {
        ...actor,
        recordingId,
        trackNumber: body.trackNumber,
        chunkNumbers: present,
      }),
    );
    return c.json({
      uploaded: updated.filter((row) => row.state === "uploaded").map((row) => row.chunkNumber),
      missing: missing.sort((left, right) => left - right),
    });
  });

  app.post(`${base}/:recordingId/finalize`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, FinalizeRecordingRequest);
    const current = await guard(() => getRecording(db, { ...actor, recordingId }));
    const transcription = await transcriptionChoice(actor.workspaceId, current.transcription);
    const result = await guard(() =>
      finalizeRecording(db, {
        ...actor,
        recordingId,
        endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
        tracks: body.tracks,
        transcription,
        versionId: crypto.randomUUID(),
      }),
    );
    // Finalizing again restarts a lost start; a running workflow is left alone.
    if (result.version.state === "queued" || result.version.state === "processing") {
      await startTranscript(actor.accountId, result.recording, result.version.id);
    }
    return c.json({ recording: result.recording, transcript: result.version });
  });

  app.get(`${base}/:recordingId/transcripts`, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    const recordingId = recordingIdParam(c);
    return c.json({
      versions: await guard(() => listRecordingTranscriptVersions(db, { ...actor, recordingId })),
    });
  });

  app.post(`${base}/:recordingId/transcripts`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, CreateRecordingTranscriptRequest);
    const recording = await guard(() => getRecording(db, { ...actor, recordingId }));
    const transcription = await transcriptionChoice(
      actor.workspaceId,
      body.transcription ?? recording.transcription,
    );
    const version = await guard(() =>
      createRecordingTranscriptVersion(db, {
        ...actor,
        recordingId,
        versionId: crypto.randomUUID(),
        transcription,
      }),
    );
    await startTranscript(actor.accountId, recording, version.id);
    return c.json(version, 202);
  });

  app.get(`${base}/:recordingId/transcript`, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    const recordingId = recordingIdParam(c);
    const after = c.req.query("after");
    const limit = c.req.query("limit");
    const afterIndex = after === undefined ? undefined : Number(after);
    if (afterIndex !== undefined && !(Number.isInteger(afterIndex) && afterIndex >= 0)) {
      throw invalid("after must be a segment index");
    }
    return c.json(
      await guard(() =>
        getRecordingTranscriptPage(db, {
          ...actor,
          recordingId,
          versionId: versionIdQuery(c),
          after: afterIndex,
          limit: limit === undefined ? undefined : Number(limit) || undefined,
        }),
      ),
    );
  });

  app.post(`${base}/:recordingId/transcripts/:versionId/current`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const versionId = c.req.param("versionId") ?? "";
    if (!z.string().uuid().safeParse(versionId).success)
      throw notFound("Transcript version not found");
    return c.json(
      await guard(() =>
        setCurrentRecordingTranscriptVersion(db, { ...actor, recordingId, versionId }),
      ),
    );
  });

  app.patch(`${base}/:recordingId/speakers`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, UpdateRecordingSpeakersRequest);
    return c.json({
      speakers: await guard(() =>
        updateRecordingSpeakers(db, {
          ...actor,
          recordingId,
          versionId: versionIdQuery(c),
          assignments: body.assignments,
          segmentOverrides: body.segmentOverrides,
        }),
      ),
    });
  });

  app.patch(`${base}/:recordingId/segments`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, UpdateRecordingSegmentsRequest);
    return c.json({
      segments: await guard(() =>
        updateRecordingSegments(db, {
          ...actor,
          recordingId,
          versionId: versionIdQuery(c),
          edits: body.edits,
        }),
      ),
    });
  });

  /** A short-lived link to a track's prepared audio, for playback. */
  app.get(`${base}/:recordingId/tracks/:trackNumber/audio`, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    const recordingId = recordingIdParam(c);
    const trackNumber = Number(c.req.param("trackNumber"));
    if (!Number.isInteger(trackNumber) || trackNumber < 0 || trackNumber > 7)
      throw notFound("Track not found");
    const prepared = await guard(() =>
      getRecordingTrackPreparedObject(db, { ...actor, recordingId, trackNumber }),
    );
    if (!prepared) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "This track's audio is still being prepared.",
        retryable: true,
        details: { code: "audio_not_ready" },
      });
    }
    const link = await storage().createGetUrl({
      key: prepared.objectKey,
      expiresInSeconds: PLAYBACK_URL_SECONDS,
      audience: "public",
    });
    await recordAuditEvent(db, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      subjectId: actor.subjectId,
      action: "recording.signed_audio.issued",
      targetType: "recording",
      targetId: recordingId,
      metadata: { recordingId, trackNumber, expiresAt: link.expiresAt.toISOString() },
    });
    return c.json({
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      mimeType: prepared.objectKey.endsWith(".m4a") ? "audio/mp4" : "audio/webm",
      bytes: prepared.bytes,
    });
  });

  app.get("/v1/workspaces/:workspaceId/recording-people", async (c) => {
    const actor = await actorFor(c, "sessions:read");
    return c.json({
      people: await listRecordingPeople(db, {
        ...actor,
        query: c.req.query("query")?.slice(0, 200),
      }),
    });
  });

  app.post("/v1/workspaces/:workspaceId/recording-people", async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const body = await parseRequestJson(c, CreateRecordingPersonRequest);
    const { personId, ...person } = body;
    const result = await guard(() =>
      createRecordingPerson(db, { ...actor, personId: personId ?? crypto.randomUUID(), ...person }),
    );
    return c.json(result.person, result.created ? 201 : 200);
  });

  app.get("/v1/workspaces/:workspaceId/recording-models", async (c) => {
    const actor = await actorFor(c, "sessions:read");
    const elevenLabs = await elevenLabsKeyAvailable(db, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
    });
    const workspace = await getWorkspace(db, actor.workspaceId);
    const defaults =
      resolveWorkspaceRecordingSettings(workspace?.settings).transcription ??
      DEFAULT_RECORDING_TRANSCRIPTION;
    const models: RecordingTranscriptionModel[] = [...registry.values()].flatMap((provider) =>
      provider.models.map((spec) => ({
        providerId: provider.id,
        providerName: provider.name,
        model: spec.model,
        name: spec.name,
        available: provider.id === "elevenlabs" ? elevenLabs : false,
        capabilities: spec.capabilities,
        usdPerHour: spec.usdPerHour,
      })),
    );
    return c.json({ models, default: defaults });
  });
}

async function storedSize(
  objects: NonNullable<ApiRouteDeps["objectStorage"]>,
  key: string,
): Promise<number | null> {
  if (objects.headObject) {
    const head = await objects.headObject(key);
    return head?.ContentLength ?? null;
  }
  const stored = await objects.getObjectBytes(key);
  return stored ? stored.bytes.byteLength : null;
}

function notFound(message = "Recording not found"): ApiHttpError {
  return new ApiHttpError(404, { code: "not_found", message, retryable: false });
}

function invalid(message: string): ApiHttpError {
  return new ApiHttpError(400, { code: "validation_failed", message, retryable: false });
}

/** Map the data layer's errors to public API errors. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RecordingNotFoundError) throw notFound(error.message);
    if (error instanceof RecordingForbiddenError) {
      throw new ApiHttpError(403, { code: "forbidden", message: error.message, retryable: false });
    }
    if (error instanceof RecordingConflictError) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: error.message,
        retryable: false,
        details: { code: error.code },
      });
    }
    throw error;
  }
}
