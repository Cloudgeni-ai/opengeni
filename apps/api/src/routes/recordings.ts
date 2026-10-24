import {
  AppendRecordingLiveSegmentsRequest,
  CompleteRecordingChunksRequest,
  CreateRecordingLiveSessionRequest,
  CreateRecordingPersonRequest,
  CreateRecordingRequest,
  CreateRecordingTranscriptRequest,
  CreateRecordingUploadsRequest,
  FinalizeRecordingRequest,
  RememberRecordingPersonVoiceRequest,
  resolveWorkspaceRecordingSettings,
  UpdateRecordingRequest,
  UpdateRecordingSegmentsRequest,
  UpdateRecordingSpeakersRequest,
  type Recording,
  type RecordingChunkUpload,
  type RecordingLiveSession,
  type RecordingTranscriptionModel,
  type RecordingTranscriptionOptions,
} from "@opengeni/contracts";
import {
  createRecordingTranscriptionProviderRegistry,
  DEFAULT_RECORDING_LIVE_TRANSCRIPTION,
  DEFAULT_RECORDING_TRANSCRIPTION,
  estimateRecordingTranscriptionCostMicros,
  findRecordingTranscriptionModel,
  RecordingTranscriptionError,
  requireAccessGrant,
  type ApiRouteDeps,
  type RecordingTranscriptionProviderRegistry,
} from "@opengeni/core";
import {
  appendRecordingLiveSegments,
  createRecording,
  createRecordingPerson,
  createRecordingTranscriptVersion,
  finalizeRecording,
  forgetRecordingPersonVoice,
  getRecording,
  getRecordingTrackPreparedObject,
  getRecordingTranscriptPage,
  getWorkspace,
  listRecordingChunks,
  listRecordingLiveSegments,
  listRecordingPeople,
  listRecordings,
  listRecordingTranscriptVersions,
  markRecordingChunksUploaded,
  markRecordingDeleting,
  recordAuditEvent,
  RecordingConflictError,
  rememberRecordingPersonVoice,
  RecordingForbiddenError,
  RecordingNotFoundError,
  reserveRecordingChunks,
  setCurrentRecordingTranscriptVersion,
  startRecordingLiveTrack,
  updateRecording,
  updateRecordingSegments,
  updateRecordingSpeakers,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import { userContentSignedGetUrlOptions } from "../http/user-content";
import { elevenLabsKeyAvailable, loadElevenLabsApiKey } from "../realtime-websocket";

const UPLOAD_URL_SECONDS = 15 * 60;
const PLAYBACK_URL_SECONDS = 60 * 60;

/** The type the worker stored a prepared track with, read from its key's extension. */
function preparedTrackContentType(objectKey: string): string {
  return objectKey.endsWith(".m4a") ? "audio/mp4" : "audio/webm";
}

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
    const settings = resolveWorkspaceRecordingSettings(workspace?.settings);
    const defaults = settings.transcription ?? DEFAULT_RECORDING_TRANSCRIPTION;
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
    const diarizer = rest.diarizer ?? settings.diarizer;
    return {
      providerId,
      model: found.spec.model,
      options: { ...rest, ...(diarizer ? { diarizer } : {}) },
    };
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

  /** The provider key a workspace's recordings use, its own or its organization's. */
  async function providerApiKey(
    providerId: string,
    scope: { accountId: string; workspaceId: string },
  ): Promise<string | null> {
    if (providerId !== "elevenlabs") return null;
    return await loadElevenLabsApiKey(db, deps.settings, scope);
  }

  /** The live model a request names, else the provider's first, else the deployment's. */
  function liveModelChoice(requested: {
    providerId?: string | undefined;
    model?: string | undefined;
  }) {
    const providerId = requested.providerId ?? DEFAULT_RECORDING_LIVE_TRANSCRIPTION.providerId;
    const model =
      requested.model ??
      (requested.providerId
        ? registry.get(providerId)?.models.find((spec) => spec.capabilities.live)?.model
        : DEFAULT_RECORDING_LIVE_TRANSCRIPTION.model);
    const found = model
      ? findRecordingTranscriptionModel(registry, providerId, model, "live")
      : null;
    if (!found) {
      throw new ApiHttpError(400, {
        code: "validation_failed",
        message: "This live transcription model is not offered here.",
        retryable: false,
        details: { code: "unknown_model", providerId, model: model ?? null },
      });
    }
    return found;
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
    const person = c.req.query("person")?.slice(0, 200);
    const instant = (name: string): Date | undefined => {
      const value = c.req.query(name);
      if (!value) return undefined;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) throw invalid(`${name} must be a date and time`);
      return parsed;
    };
    return c.json(
      await listRecordings(db, {
        workspaceId: actor.workspaceId,
        subjectId: actor.subjectId,
        query: query || undefined,
        person: person || undefined,
        startedFrom: instant("startedFrom"),
        startedTo: instant("startedTo"),
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
          rejectSuggestions: body.rejectSuggestions,
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
      ...userContentSignedGetUrlOptions(preparedTrackContentType(prepared.objectKey)),
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

  function personIdParam(c: Context): string {
    const personId = c.req.param("personId") ?? "";
    if (!z.string().uuid().safeParse(personId).success) throw notFound("Person not found");
    return personId;
  }

  /** Agree to have a person's voice remembered (members for themselves). */
  app.put("/v1/workspaces/:workspaceId/recording-people/:personId/voice", async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const personId = personIdParam(c);
    const body = await parseRequestJson(c, RememberRecordingPersonVoiceRequest);
    const workspace = await getWorkspace(db, actor.workspaceId);
    if (resolveWorkspaceRecordingSettings(workspace?.settings).voiceprints !== true) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message:
          "This workspace does not recognize voices. An admin can turn it on in Meetings settings.",
        retryable: false,
        details: { code: "voice_recognition_off" },
      });
    }
    const person = await guard(() =>
      rememberRecordingPersonVoice(db, { ...actor, personId, consent: body.consent }),
    );
    await recordAuditEvent(db, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      subjectId: actor.subjectId,
      action: "recording.voice.remembered",
      targetType: "recording_person",
      targetId: personId,
      metadata: { personId, consent: body.consent },
    });
    return c.json(person);
  });

  /** Forget a person's voice and withdraw their agreement. */
  app.delete("/v1/workspaces/:workspaceId/recording-people/:personId/voice", async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const personId = personIdParam(c);
    const person = await guard(() => forgetRecordingPersonVoice(db, { ...actor, personId }));
    await recordAuditEvent(db, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      subjectId: actor.subjectId,
      action: "recording.voice.forgotten",
      targetType: "recording_person",
      targetId: personId,
      metadata: { personId },
    });
    return c.json(person);
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

  /**
   * A grant to stream one track of a recording being captured to a live
   * model. The client connects to the provider itself; the grant carries a
   * single-use credential, never the workspace's key.
   */
  app.post(`${base}/:recordingId/live-session`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, CreateRecordingLiveSessionRequest);
    const { provider, spec } = liveModelChoice(body);
    const apiKey = await providerApiKey(provider.id, actor);
    if (!apiKey) {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: `Add an ${provider.name} API key to this workspace's models to see a live transcript.`,
        retryable: false,
        details: { code: "credential_unavailable", providerId: provider.id },
      });
    }
    const { language } = await guard(() =>
      startRecordingLiveTrack(db, {
        ...actor,
        recordingId,
        trackNumber: body.trackNumber,
        providerId: provider.id,
        model: spec.model,
      }),
    );
    let grant;
    try {
      grant = await provider.createLiveSession!(
        { model: spec.model, language: language ?? undefined },
        { apiKey },
      );
    } catch (error) {
      if (!(error instanceof RecordingTranscriptionError)) throw error;
      const rejected = error.code === "unauthorized";
      throw new ApiHttpError(rejected ? 409 : 502, {
        code: rejected ? "conflict" : "upstream_unavailable",
        message: rejected
          ? `${provider.name} rejected this workspace's API key.`
          : error.code === "quota_exceeded"
            ? `${provider.name} has no credit left for a live transcript.`
            : `${provider.name} could not start a live transcript. Try again.`,
        retryable: error.retryable,
        details: { code: error.code, providerId: provider.id },
      });
    }
    const session: RecordingLiveSession = {
      providerId: provider.id,
      model: spec.model,
      protocol: grant.protocol,
      url: grant.url,
      audio: grant.audio,
      expiresAt: grant.expiresAt.toISOString(),
    };
    c.header("cache-control", "no-store");
    return c.json(session, 201);
  });

  /** Save finished live text for one track; only the person recording may. */
  app.post(`${base}/:recordingId/live-segments`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, AppendRecordingLiveSegmentsRequest);
    const recording = await guard(() => getRecording(db, { ...actor, recordingId }));
    const live = recording.tracks.find((track) => track.trackNumber === body.trackNumber)?.live;
    const spec = live
      ? findRecordingTranscriptionModel(registry, live.providerId, live.model, "live")?.spec
      : undefined;
    const result = await guard(() =>
      appendRecordingLiveSegments(db, {
        ...actor,
        recordingId,
        trackNumber: body.trackNumber,
        streamedMilliseconds: body.streamedMilliseconds,
        costUsdMicros: spec
          ? estimateRecordingTranscriptionCostMicros(spec, body.streamedMilliseconds)
          : null,
        segments: body.segments,
      }),
    );
    return c.json(result);
  });

  /** Live text saved after `after`, for anyone who can see the recording. */
  app.get(`${base}/:recordingId/live-segments`, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    const recordingId = recordingIdParam(c);
    const after = Number(c.req.query("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw invalid("after must be a sequence number");
    return c.json(
      await guard(() => listRecordingLiveSegments(db, { ...actor, recordingId, after })),
    );
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
