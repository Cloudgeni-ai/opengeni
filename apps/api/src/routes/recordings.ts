import {
  AppendRecordingLiveSegmentsRequest,
  CompleteRecordingChunksRequest,
  CreateRecordingLiveSessionRequest,
  CreateRecordingPersonRequest,
  CreateRecordingRequest,
  CreateRecordingTranscriptRequest,
  CreateRecordingUploadsRequest,
  RecordingCapturePurpose,
  FinalizeRecordingRequest,
  RecordingNoteKind,
  RememberRecordingPersonVoiceRequest,
  resolveWorkspaceVoiceInputEnabled,
  recordingMicrophoneIsOwner,
  resolveWorkspaceRecordingSettings,
  SaveRecordingNoteRequest,
  UpdateRecordingRequest,
  UpdateRecordingSegmentsRequest,
  UpdateRecordingSpeakersRequest,
  WorkspaceVoiceInputSettings,
  type Recording,
  type RecordingChunkUpload,
  type RecordingLiveSession,
  type RecordingTranscriptionModel,
  type RecordingTranscriptionOptions,
  type RecordingTranscriptionRequest,
  type WorkspaceRecordingSettings,
  REGION_RESTRICTED,
} from "@opengeni/contracts";
import {
  estimateRecordingTranscriptionCostMicros,
  findRecordingTranscriptionModel,
  RecordingTranscriptionError,
  requireAccessGrant,
  TranscriptionBillingRefusedError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  appendRecordingLiveSegments,
  checkWorkspaceAllowance,
  createRecording,
  createRecordingPerson,
  createRecordingTranscriptVersion,
  finalizeRecording,
  forgetRecordingPersonVoice,
  getRecording,
  getRecordingTrackPreparedObject,
  getRecordingTranscriptPage,
  getWorkspace,
  workspaceMemberDisplayName,
  listRecordingChunks,
  listRecordingLiveSegments,
  listRecordingNotes,
  listRecordingPeople,
  listRecordingsWithOwnElsewhere,
  ownRecordingHome,
  ownRecordingWorkspaces,
  recordingVisible,
  listRecordingTranscriptVersions,
  markRecordingChunksUploaded,
  markRecordingDeleting,
  recordAuditEvent,
  RecordingConflictError,
  rememberRecordingPersonVoice,
  RecordingForbiddenError,
  RecordingNotFoundError,
  reserveRecordingChunks,
  saveRecordingNote,
  setCurrentRecordingTranscriptVersion,
  startRecordingLiveTrack,
  updateRecording,
  updateRecordingSegments,
  updateRecordingSpeakers,
  type CreditDebitAttribution,
} from "@opengeni/db";
import { voiceInputCreditBillingActive } from "@opengeni/config";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { ApiHttpError } from "../http/api-error";
import { parseRequestJson } from "../http/request-body";
import { userContentSignedGetUrlOptions } from "../http/user-content";
import {
  createSpeechToTextDeployment,
  dictationProviders,
  meetingModelFor,
  meetingModelWithoutCreditsFor,
  speechToTextServesMeetings,
  type SpeechToTextDeployment,
} from "@opengeni/core/transcription-service";
import { creditDebitAttributionForGrant } from "../access-grant-rls";
import { meetingCalendarLookup, meetingCalendarTitle } from "../meeting-calendar-title";
import { errorMessage } from "@opengeni/contracts/values";

const UPLOAD_URL_SECONDS = 15 * 60;
const PLAYBACK_URL_SECONDS = 60 * 60;

/** The type the worker stored a prepared track with, read from its key's extension. */
function preparedTrackContentType(objectKey: string): string {
  return objectKey.endsWith(".m4a") ? "audio/mp4" : "audio/webm";
}

/**
 * A new recording's language: the request's, else the workspace's meeting
 * language. Null asks to detect it even when the workspace names one. It is
 * settled when recording starts, because the live transcript streams from
 * the first second, and kept with the recording.
 */
export function meetingLanguage(
  requested: string | null | undefined,
  settings: WorkspaceRecordingSettings,
): string | undefined {
  if (requested === null) return undefined;
  return requested ?? settings.language;
}

/** Options as stored: a null language (detect) is the same as none. */
function storedTranscription(
  requested: RecordingTranscriptionRequest,
): RecordingTranscriptionOptions {
  const { language, ...rest } = requested;
  return { ...rest, ...(language ? { language } : {}) };
}

/** A request takes at most this many keyterms, as the contract allows. */
const MAX_KEYTERMS = 100;

/**
 * The words a meeting transcript listens for: the recording's own first,
 * then the workspace's, each once whatever its case, cut at what one
 * request takes.
 */
export function meetingKeyterms(
  own: readonly string[] | undefined,
  workspace: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...(own ?? []), ...(workspace ?? [])]) {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MAX_KEYTERMS) break;
  }
  return terms;
}

/** The billing code a credit refusal carries (insufficient_credits, allowance_exhausted, ...). */
function refusalCode(refused: ApiHttpError): string {
  const code = refused.details?.code;
  return typeof code === "string" && code ? code : refused.code;
}

/**
 * Recordings: captured conversations made of audio tracks. Clients record
 * locally, upload chunks straight to storage with presigned URLs, then
 * finalize; the worker prepares the audio and makes transcript versions.
 */
export function registerRecordingRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: { deployment?: SpeechToTextDeployment } = {},
): void {
  const { db, observability } = deps;
  /** Telemetry failures never reach the request. */
  const count = (name: string, help: string, labels: Record<string, string>, amount = 1) => {
    try {
      observability?.incrementCounter({ name, help, labels, amount });
    } catch {
      // Product execution never inherits an observability failure.
    }
  };
  const deployment =
    options.deployment ??
    deps.speechToText ??
    createSpeechToTextDeployment({ settings: deps.settings, db });
  const registry = deployment.registry;
  const base = "/v1/workspaces/:workspaceId/recordings";

  /**
   * Who is asking, in which workspace. On a meeting's own routes that is the
   * workspace storing it: the person's own Only me meeting from another
   * workspace of the same organization opens in place in every workspace of it
   * they belong to, so it is read and changed where it is stored, as them, and
   * only with the access this request has there (the same permission, for the
   * same person). Without it the meeting is not found.
   */
  async function actorFor(c: Context, permission: "sessions:read" | "sessions:create") {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    const actor = {
      workspaceId,
      subjectId: grant.subjectId,
      accountId: grant.accountId,
      /** Who a deployment-funded transcript this request asks for is billed to. */
      creditAttribution: creditDebitAttributionForGrant(grant),
      /** The workspace that stores the meeting, when it is another than this one. */
      sourceWorkspace: null as { id: string; name: string } | null,
    };
    const recordingId = c.req.param("recordingId");
    if (
      !recordingId ||
      !z.string().uuid().safeParse(recordingId).success ||
      (await recordingVisible(db, { ...actor, recordingId }))
    ) {
      return actor;
    }
    const home = await ownRecordingHome(db, {
      subjectId: actor.subjectId,
      recordingId,
      workspaces: await ownRecordingWorkspaces(db, actor),
    });
    const there = home ? await sameGrantIn(c, home.id, permission, actor) : null;
    if (!home || !there) return actor;
    return {
      ...actor,
      workspaceId: home.id,
      accountId: there.accountId,
      creditAttribution: creditDebitAttributionForGrant(there),
      sourceWorkspace: { id: home.id, name: home.name },
    };
  }

  /**
   * This request's grant in another workspace of the organization, for the
   * same person, with the permission; null without one (a key or delegation
   * scoped to this workspace, a narrower role there, or no access).
   */
  async function sameGrantIn(
    c: Context,
    workspaceId: string,
    permission: "sessions:read" | "sessions:create",
    actor: { subjectId: string; accountId: string },
  ) {
    const grant = await requireAccessGrant(c, deps, workspaceId, permission).catch(() => null);
    return grant && grant.subjectId === actor.subjectId && grant.accountId === actor.accountId
      ? grant
      : null;
  }

  /** The person's other workspaces of the organization this request may list meetings in. */
  async function ownListableElsewhere(
    c: Context,
    actor: { workspaceId: string; subjectId: string; accountId: string },
  ): Promise<{ id: string; name: string }[]> {
    const candidates = await ownRecordingWorkspaces(db, actor);
    const allowed: { id: string; name: string }[] = [];
    for (let start = 0; start < candidates.length; start += 8) {
      const batch = candidates.slice(start, start + 8);
      const grants = await Promise.all(
        batch.map((workspace) => sameGrantIn(c, workspace.id, "sessions:read", actor)),
      );
      batch.forEach((workspace, index) => {
        if (grants[index]) allowed.push({ id: workspace.id, name: workspace.name });
      });
    }
    return allowed;
  }

  /** A meeting as the workspace the request came through shows it. */
  function shownHere<T extends Recording>(
    recording: T,
    actor: { sourceWorkspace: { id: string; name: string } | null },
  ): T {
    return actor.sourceWorkspace
      ? { ...recording, sourceWorkspace: actor.sourceWorkspace }
      : recording;
  }

  /**
   * Transcripts and live previews count toward the workspace's usage
   * allowance at the provider's list price (0976), so new transcription work
   * is refused once the workspace's or the person's allowance is used up.
   * Work already started finishes.
   */
  async function admitRecordingUsage(actor: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
  }): Promise<void> {
    const exhausted = await checkWorkspaceAllowance(db, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      subjectId: actor.subjectId,
      fundedWithoutCredits: true,
    });
    if (!exhausted) return;
    throw new ApiHttpError(402, {
      code: exhausted.code,
      message: exhausted.message,
      retryable: false,
      outcomeUnknown: false,
      details: {
        scope: exhausted.scope,
        resetsAt: exhausted.resetsAt,
        ...(exhausted.subjectId ? { subjectId: exhausted.subjectId } : {}),
      },
    });
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

  /**
   * The deployment's pinned model, else the request's, else the workspace's
   * default, else the first model this workspace can use (meetingModelFor).
   * A pinned deployment refuses any other model a request names.
   */
  async function transcriptionChoice(
    actor: { workspaceId: string; accountId: string; subjectId: string },
    requested: RecordingTranscriptionRequest,
  ): Promise<{
    providerId: string;
    model: string;
    options: RecordingTranscriptionOptions;
    /** Nobody chose the model: not the request, the workspace or a pinned deployment. */
    automatic: boolean;
  }> {
    const workspace = await getWorkspace(db, actor.workspaceId);
    const settings = resolveWorkspaceRecordingSettings(workspace?.settings);
    // A request that names its provider takes no default, not even its model.
    const defaults = requested.providerId
      ? null
      : await meetingModelFor(deployment, settings.transcription, {
          accountId: actor.accountId,
          workspaceId: actor.workspaceId,
          subjectId: actor.subjectId,
        });
    const providerId = requested.providerId ?? defaults!.providerId;
    const model = requested.model ?? defaults?.model;
    const pinnedAway =
      deployment.pinned !== null &&
      (providerId !== deployment.pinned.providerId ||
        (model !== undefined && model !== deployment.pinned.model));
    const found =
      model && !pinnedAway ? findRecordingTranscriptionModel(registry, providerId, model) : null;
    // A meeting transcript places every word in time; a model that returns
    // only text serves meetings only where the deployment aligns its words.
    if (!found || !speechToTextServesMeetings(deployment, found.spec)) {
      throw new ApiHttpError(400, {
        code: "validation_failed",
        message: "This transcription model is not offered here.",
        retryable: false,
        details: { code: "unknown_model", providerId, model: model ?? null },
      });
    }
    const {
      providerId: _provider,
      model: _model,
      keyterms: ownKeyterms,
      ...rest
    } = storedTranscription(requested);
    const diarizer = rest.diarizer ?? settings.diarizer;
    const keyterms = meetingKeyterms(ownKeyterms, settings.keyterms);
    return {
      providerId,
      model: found.spec.model,
      options: {
        ...rest,
        ...(diarizer ? { diarizer } : {}),
        ...(keyterms.length > 0 ? { keyterms } : {}),
      },
      automatic: !requested.providerId && !settings.transcription && deployment.pinned === null,
    };
  }

  /**
   * A dictation is transcribed by the workspace's voice input: its preferred
   * provider, else the first ready one, as text without speakers, in the
   * language the dictation was started in (detected when none), listening for
   * the person's vocabulary when the model takes one. The version records the
   * provider and the model it runs; the worker may still fall over to another
   * provider that refused before hearing it.
   */
  async function dictationChoice(
    actor: {
      workspaceId: string;
      accountId: string;
      subjectId: string;
    },
    recording: Recording,
  ): Promise<{ providerId: string; model: string; options: RecordingTranscriptionOptions }> {
    const voiceInput = await dictationPolicy(actor.workspaceId);
    const service = deps.transcription!;
    const providerId = service.selectProvider
      ? await service.selectProvider({
          workspaceId: actor.workspaceId,
          accountId: actor.accountId,
          subjectId: actor.subjectId,
          preferredProvider: voiceInput?.preferredProvider,
          fallbackEnabled: voiceInput?.fallbackEnabled,
        })
      : "host";
    if (!providerId) throw dictationUnavailable();
    const model =
      dictationProviders(deployment).find((provider) => provider.id === providerId)?.model.model ??
      "voice-input";
    const language = recording.transcription?.language;
    const keyterms = recording.transcription?.keyterms;
    return {
      providerId,
      model,
      options: {
        ...(language ? { language } : {}),
        ...(keyterms && keyterms.length > 0 ? { keyterms } : {}),
      },
    };
  }

  /** The workspace's voice input settings, refusing when voice input can't run. */
  async function dictationPolicy(workspaceId: string) {
    const workspace = await getWorkspace(db, workspaceId);
    if (resolveWorkspaceVoiceInputEnabled(workspace?.settings) === false) {
      throw new ApiHttpError(403, {
        code: "forbidden",
        message: "Voice input is turned off for this workspace.",
        retryable: false,
        details: { code: "policy_blocked" },
      });
    }
    if (!deps.transcription || !(await deps.transcription.available({ workspaceId }))) {
      throw dictationUnavailable();
    }
    return WorkspaceVoiceInputSettings.safeParse(workspace?.settings.voiceInput).data;
  }

  function dictationUnavailable(): ApiHttpError {
    return new ApiHttpError(503, {
      code: "upstream_unavailable",
      message: "Voice input isn't available on this deployment right now.",
      retryable: true,
      details: { code: "unavailable" },
    });
  }

  /**
   * The transcription a recording's next version uses, with who it is
   * billed to. A model the deployment pays for is admitted against the
   * payer's credits first, where credit billing is on, so a payer without
   * credits is refused before any audio is sent. When nobody chose that
   * model, a usable one the deployment doesn't pay for (a connected
   * subscription or the workspace's own key) runs instead. Otherwise a
   * meeting's refusal is returned, not thrown, so finalizing still ends
   * capture and stores a failed transcript that says why.
   */
  async function versionChoice(
    actor: {
      workspaceId: string;
      accountId: string;
      subjectId: string;
      creditAttribution: CreditDebitAttribution;
    },
    recording: Recording,
    requested: RecordingTranscriptionRequest,
  ): Promise<{
    providerId: string;
    model: string;
    options: RecordingTranscriptionOptions;
    creditAttribution: CreditDebitAttribution;
    /** The credit refusal a meeting's transcript can't start without fixing. */
    refused: ApiHttpError | null;
  }> {
    const { automatic, ...choice } =
      recording.purpose === "dictation"
        ? { ...(await dictationChoice(actor, recording)), automatic: false }
        : await transcriptionChoice(actor, requested);
    // EU-only: refused before the version exists, so no audio is ever sent.
    await deployment.assertRegion(
      choice.providerId,
      actor,
      recording.purpose === "dictation" ? "voice_input" : "meeting_transcription",
    );
    const provider = registry.get(choice.providerId);
    const spec = provider?.models.find((candidate) => candidate.model === choice.model);
    const refused =
      provider?.funding === "deployment" &&
      voiceInputCreditBillingActive(deps.settings) &&
      (recording.purpose === "dictation" || spec?.creditPricing)
        ? await creditRefusal(() =>
            deps.transcription?.admit?.({
              providerId: choice.providerId,
              accountId: actor.accountId,
              workspaceId: actor.workspaceId,
              attribution: actor.creditAttribution,
            }),
          )
        : null;
    if (refused && automatic) {
      const free = await meetingModelWithoutCreditsFor(deployment, {
        accountId: actor.accountId,
        workspaceId: actor.workspaceId,
        subjectId: actor.subjectId,
      });
      const found = free
        ? findRecordingTranscriptionModel(registry, free.providerId, free.model)
        : null;
      // Work that spends no credits still counts against a usage allowance
      // that prices it at list price; a used-up one is the refusal instead.
      const overAllowance =
        free && found
          ? await admitRecordingUsage(actor).then(
              () => null,
              (error: unknown) => {
                if (error instanceof ApiHttpError) return error;
                throw error;
              },
            )
          : null;
      if (overAllowance) {
        return { ...choice, creditAttribution: actor.creditAttribution, refused: overAllowance };
      }
      if (free && found) {
        return {
          ...choice,
          providerId: free.providerId,
          model: found.spec.model,
          creditAttribution: actor.creditAttribution,
          refused: null,
        };
      }
    }
    // A dictation is the composer's: it shows the refusal where the person typed.
    if (refused && recording.purpose === "dictation") throw refused;
    return { ...choice, creditAttribution: actor.creditAttribution, refused };
  }

  /** A credit refusal as the same 402 or 429 a session admission gives; null when admitted. */
  async function creditRefusal(
    admit: () => Promise<void> | undefined,
  ): Promise<ApiHttpError | null> {
    try {
      await admit();
      return null;
    } catch (error) {
      if (!(error instanceof TranscriptionBillingRefusedError)) throw error;
      return new ApiHttpError(error.status, {
        code:
          error.code === "allowance_exhausted"
            ? "allowance_exhausted"
            : error.code === "insufficient_credits"
              ? "payment_required"
              : "limit_exceeded",
        message: error.message,
        retryable: false,
        outcomeUnknown: false,
        details: { ...error.details, code: error.code },
      });
    }
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

  /** The live model a request names, else the provider's first, else the deployment's. */
  function liveModelChoice(requested: {
    providerId?: string | undefined;
    model?: string | undefined;
  }) {
    const fallback = deployment.liveDefault;
    const providerId = requested.providerId ?? fallback?.providerId;
    const model =
      requested.model ??
      (requested.providerId
        ? registry.get(requested.providerId)?.models.find((spec) => spec.capabilities.live)?.model
        : fallback?.model);
    // A pinned deployment sends audio only to its one provider, or to the
    // live model its operator named.
    const allowed =
      !deployment.pinned ||
      deployment.pinned.providerId === providerId ||
      (fallback !== null && fallback.providerId === providerId && fallback.model === model);
    const found =
      providerId && model && allowed
        ? findRecordingTranscriptionModel(registry, providerId, model, "live")
        : null;
    if (!found) {
      throw new ApiHttpError(400, {
        code: "validation_failed",
        message: "This live transcription model is not offered here.",
        retryable: false,
        details: { code: "unknown_model", providerId: providerId ?? null, model: model ?? null },
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
    // Dictations are private, so listing them shows the caller's own.
    const purpose = RecordingCapturePurpose.safeParse(c.req.query("purpose") ?? "meeting");
    if (!purpose.success) throw invalid("purpose must be meeting or dictation");
    const instant = (name: string): Date | undefined => {
      const value = c.req.query(name);
      if (!value) return undefined;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) throw invalid(`${name} must be a date and time`);
      return parsed;
    };
    // With the person's own Only me meetings from their other workspaces of
    // this organization, each saying where it is stored.
    const page = await listRecordingsWithOwnElsewhere(db, {
      elsewhere:
        (purpose.data ?? "meeting") === "meeting" && !externalRef
          ? await ownListableElsewhere(c, actor)
          : [],
      workspaceId: actor.workspaceId,
      subjectId: actor.subjectId,
      query: query || undefined,
      person: person || undefined,
      startedFrom: instant("startedFrom"),
      startedTo: instant("startedTo"),
      externalRef: externalRef || undefined,
      purpose: purpose.data,
      before,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({
      recordings: page.recordings.map((recording) => {
        const name = page.sourceWorkspaces.get(recording.workspaceId);
        return name === undefined
          ? recording
          : { ...recording, sourceWorkspace: { id: recording.workspaceId, name } };
      }),
      nextBefore: page.nextBefore,
    });
  });

  app.post(base, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const body = await parseRequestJson(c, CreateRecordingRequest);
    if (body.purpose === "dictation") {
      // Dictation is typing by voice: the workspace's voice input decides
      // whether and how it is heard, and only its owner ever sees it.
      await dictationPolicy(actor.workspaceId);
      if (body.tracks.length !== 1 || body.tracks[0]!.source !== "microphone") {
        throw invalid("A dictation has exactly one microphone track");
      }
      // The workspace's voice input picks the model; the dictation names only
      // the language it is spoken in (or none to detect it) and the words to
      // listen for.
      const { language, keyterms, ...other } = body.transcription ?? {};
      if (Object.keys(other).length > 0) {
        throw invalid(
          "A dictation uses the workspace's voice input model; only its language and keyterms can be set",
        );
      }
      const result = await guard(() =>
        createRecording(db, {
          ...actor,
          purpose: "dictation",
          recordingId: body.recordingId,
          title: body.title ?? "Dictation",
          visibility: "private",
          startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
          externalRef: body.externalRef,
          metadata: body.metadata,
          tracks: body.tracks,
          ...(language || keyterms?.length
            ? {
                transcription: {
                  ...(language ? { language } : {}),
                  ...(keyterms?.length ? { keyterms } : {}),
                },
              }
            : {}),
        }),
      );
      if (result.recording.purpose !== "dictation") {
        throw new ApiHttpError(409, {
          code: "conflict",
          message: "This recording id is already a meeting.",
          retryable: false,
          details: { code: "purpose_mismatch" },
        });
      }
      return c.json(result.recording, result.created ? 201 : 200);
    }
    await admitRecordingUsage(actor);
    const workspace = await getWorkspace(db, actor.workspaceId);
    const settings = resolveWorkspaceRecordingSettings(workspace?.settings);
    if (body.transcription) await transcriptionChoice(actor, body.transcription);
    const language = meetingLanguage(body.transcription?.language, settings);
    const transcription =
      body.transcription || language
        ? {
            ...storedTranscription(body.transcription ?? {}),
            ...(language ? { language } : {}),
          }
        : undefined;
    // Computer or tab audio makes the microphone the owner, named in the live
    // preview and the transcript. The name Opengeni has for them comes first;
    // an embedding app's own users may have none, so theirs is next.
    const startedAt = body.startedAt ? new Date(body.startedAt) : new Date();
    // Both lookups run at once; neither failing stops the recording.
    const [memberName, calendarTitle] = await Promise.all([
      recordingMicrophoneIsOwner(body.tracks)
        ? workspaceMemberDisplayName(db, actor).catch((error: unknown) => {
            // The recording starts regardless; the microphone stays unnamed until then.
            observability?.warn("couldn't read the recording owner's name", {
              workspaceId: actor.workspaceId,
              error: errorMessage(error),
            });
            return null;
          })
        : null,
      // Without a name from the person, the owner's calendar event at the
      // time names it. Capture is already running, so this never delays it.
      body.title === undefined || body.titleSource === "app"
        ? meetingCalendarTitle(
            meetingCalendarLookup({
              db,
              settings: deps.settings,
              workspaceId: actor.workspaceId,
              subjectId: actor.subjectId,
              ...(deps.meetingCalendarFetch ? { fetch: deps.meetingCalendarFetch } : {}),
              onProblem: (problem) =>
                observability?.warn("couldn't read the recording owner's calendar", {
                  workspaceId: actor.workspaceId,
                  providerDomain: problem.providerDomain,
                  reason: problem.reason,
                }),
            }),
            { subjectId: actor.subjectId, at: startedAt },
          )
        : null,
    ]);
    const ownerName = recordingMicrophoneIsOwner(body.tracks)
      ? (memberName ?? body.ownerName ?? null)
      : null;
    const result = await guard(() =>
      createRecording(db, {
        ...actor,
        recordingId: body.recordingId,
        ...(calendarTitle
          ? { title: calendarTitle, titleSource: "calendar" as const }
          : { title: body.title, titleSource: body.titleSource }),
        visibility: body.visibility ?? settings.defaultVisibility ?? "private",
        startedAt,
        externalRef: body.externalRef,
        metadata: body.metadata,
        tracks: body.tracks,
        transcription,
        ownerName,
      }),
    );
    if (result.recording.purpose !== "meeting") {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "This recording id is already a dictation.",
        retryable: false,
        details: { code: "purpose_mismatch" },
      });
    }
    return c.json(result.recording, result.created ? 201 : 200);
  });

  app.get(`${base}/:recordingId`, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    return c.json(
      shownHere(
        await guard(() => getRecording(db, { ...actor, recordingId: recordingIdParam(c) })),
        actor,
      ),
    );
  });

  app.patch(`${base}/:recordingId`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const body = await parseRequestJson(c, UpdateRecordingRequest);
    // Sharing shares with the workspace that stores the meeting, so it is
    // done there, where everyone it is shared with sees it.
    if (actor.sourceWorkspace && body.visibility !== undefined && body.visibility !== "private") {
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "Share this meeting from the workspace it was recorded in.",
        retryable: false,
      });
    }
    return c.json(
      shownHere(await guard(() => updateRecording(db, { ...actor, recordingId, ...body })), actor),
    );
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
    let newlyStoredBytes = 0;
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
      if (size === row.byteLength) {
        present.push(chunkNumber);
        newlyStoredBytes += row.byteLength;
      } else missing.push(chunkNumber);
    }
    const updated = await guard(() =>
      markRecordingChunksUploaded(db, {
        ...actor,
        recordingId,
        trackNumber: body.trackNumber,
        chunkNumbers: present,
      }),
    );
    if (newlyStoredBytes > 0) {
      count(
        "opengeni_recording_stored_bytes_total",
        "Bytes of recording audio written to object storage, by kind.",
        { kind: "chunks" },
        newlyStoredBytes,
      );
    }
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
    // Capture always ends here. A transcript the payer can't pay for is stored
    // failed with the refusal's code, so the meeting says what to fix and can
    // be transcribed again once it is fixed, instead of staying unfinished.
    const { refused, ...transcription } = await versionChoice(
      actor,
      current,
      current.transcription,
    );
    const result = await guard(() =>
      finalizeRecording(db, {
        ...actor,
        recordingId,
        endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
        tracks: body.tracks,
        transcription,
        versionId: crypto.randomUUID(),
        transcriptRefusedCode: refused ? refusalCode(refused) : undefined,
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
    if (recording.purpose === "dictation" && body.transcription) {
      throw invalid("A dictation uses the workspace's voice input model");
    }
    // Dictations are paid for with credits, which their ledger debit counts.
    if (recording.purpose !== "dictation") await admitRecordingUsage(actor);
    const { refused, ...transcription } = await versionChoice(
      actor,
      recording,
      body.transcription ?? recording.transcription,
    );
    if (refused) throw refused;
    const version = await guard(() =>
      createRecordingTranscriptVersion(db, {
        ...actor,
        recordingId,
        versionId: crypto.randomUUID(),
        transcription,
      }),
    );
    await startTranscript(actor.accountId, recording, version.id);
    // Asking again is the clearest sign a transcript wasn't good enough.
    count("opengeni_recording_transcript_reruns_total", "Transcripts asked for again.", {
      purpose: recording.purpose,
      provider: version.providerId,
      model: version.model,
    });
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

  /** The meeting's notepad and written-up notes. */
  app.get(`${base}/:recordingId/notes`, async (c) => {
    const actor = await actorFor(c, "sessions:read");
    const recordingId = recordingIdParam(c);
    return c.json({
      notes: await guard(() => listRecordingNotes(db, { ...actor, recordingId })),
    });
  });

  app.put(`${base}/:recordingId/notes/:kind`, async (c) => {
    const actor = await actorFor(c, "sessions:create");
    const recordingId = recordingIdParam(c);
    const kind = RecordingNoteKind.safeParse(c.req.param("kind"));
    if (!kind.success) throw notFound("Notes not found");
    const body = await parseRequestJson(c, SaveRecordingNoteRequest);
    return c.json(
      await guard(() =>
        saveRecordingNote(db, {
          ...actor,
          recordingId,
          kind: kind.data,
          body: body.body,
          expectedRevision: body.expectedRevision,
        }),
      ),
    );
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
    const workspace = await getWorkspace(db, actor.workspaceId);
    const recordingSettings = resolveWorkspaceRecordingSettings(workspace?.settings);
    const defaults = await meetingModelFor(deployment, recordingSettings.transcription, {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      subjectId: actor.subjectId,
    });
    const pinned = deployment.pinned;
    const liveDefault = deployment.liveDefault;
    const offered = pinned
      ? [
          registry.get(pinned.providerId)!,
          ...(liveDefault && liveDefault.providerId !== pinned.providerId
            ? [registry.get(liveDefault.providerId)!]
            : []),
        ]
      : [...registry.values()];
    const scope = {
      accountId: actor.accountId,
      workspaceId: actor.workspaceId,
      subjectId: actor.subjectId,
    };
    // Per provider: whether it serves this workspace, and whether EU-only
    // inference lets it, for meetings and for the live transcript (whose
    // client connects to the provider itself). A failed EU-only read fails
    // the request; it never becomes a wrong label.
    const perProvider = new Map(
      await Promise.all(
        offered.map(async (provider) => {
          const hasLive = provider.models.some((spec) => spec.capabilities.live);
          const [available, liveAvailable, region, liveRegion] = await Promise.all([
            deployment.available(provider.id, scope),
            hasLive
              ? deployment.available(provider.id, scope, "live_transcription")
              : Promise.resolve(false),
            deployment.regionAllowed(provider.id, actor),
            hasLive
              ? deployment.regionAllowed(provider.id, actor, "live_transcription")
              : Promise.resolve(true),
          ]);
          return [provider.id, { available, liveAvailable, region, liveRegion }] as const;
        }),
      ),
    );
    // The models a meeting can use: each places every word in time, or the
    // deployment does it for them. Live models stream the live transcript;
    // a pinned deployment offers its own provider's and the one its operator
    // named, as the live session route does.
    const models: RecordingTranscriptionModel[] = offered.flatMap((provider) =>
      provider.models.flatMap((spec) => {
        const meeting =
          spec.capabilities.batch &&
          (!pinned || (provider.id === pinned.providerId && spec.model === pinned.model)) &&
          speechToTextServesMeetings(deployment, spec);
        const live =
          spec.capabilities.live &&
          (!pinned ||
            provider.id === pinned.providerId ||
            (liveDefault?.providerId === provider.id && liveDefault.model === spec.model));
        if (!meeting && !live) return [];
        const state = perProvider.get(provider.id);
        // Each entry offers what the region allows; with nothing left it
        // stays listed, switched off, so clients show "Not supported in EU".
        const meetingRegion = meeting && state?.region !== false;
        const liveRegion = live && state?.liveRegion !== false;
        const restricted = !meetingRegion && !liveRegion;
        // The same test the worker charges by.
        const chargedInCredits = Boolean(
          provider.funding === "deployment" &&
          voiceInputCreditBillingActive(deps.settings) &&
          spec.creditPricing,
        );
        return [
          {
            providerId: provider.id,
            providerName: provider.name,
            model: spec.model,
            name: spec.name,
            available: restricted
              ? false
              : ((meetingRegion ? state?.available : state?.liveAvailable) ?? false),
            ...(restricted ? { unavailableReason: REGION_RESTRICTED } : {}),
            funding: provider.funding,
            capabilities: restricted
              ? { ...spec.capabilities, batch: meeting, live }
              : { ...spec.capabilities, batch: meetingRegion, live: liveRegion },
            // A price only where this workspace pays it: its own key, or credits
            // charged for a deployment's model. Otherwise the hour costs it nothing.
            usdPerHour:
              provider.funding === "workspace_key" || chargedInCredits ? spec.usdPerHour : null,
            chargedInCredits,
          },
        ];
      }),
    );
    const voiceInput = WorkspaceVoiceInputSettings.safeParse(workspace?.settings.voiceInput).data;
    const liveModels = models.filter((model) =>
      offered.some(
        (provider) =>
          provider.id === model.providerId &&
          provider.models.some((spec) => spec.model === model.model && spec.capabilities.live),
      ),
    );
    const liveRegionRestricted =
      liveModels.length > 0 &&
      liveModels.every((model) => perProvider.get(model.providerId)?.liveRegion === false);
    const preferred = voiceInput?.preferredProvider
      ? dictationProviders(deployment).find(
          (provider) =>
            provider.id ===
            (voiceInput.preferredProvider === "azure-mai"
              ? "azure-speech"
              : voiceInput.preferredProvider),
        )
      : undefined;
    const dictationDefault = deployment.pinned
      ? deployment.pinned
      : preferred
        ? { providerId: preferred.id, model: preferred.model.model }
        : null;
    return c.json({
      models,
      default: defaults,
      dictationDefault,
      pinned: !!deployment.pinned,
      language: recordingSettings.language ?? null,
      // Recorders don't start it where EU-only inference refuses every live route.
      liveTranscript: recordingSettings.liveTranscript === true && !liveRegionRestricted,
    });
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
    // EU-only: the client takes the minted secret straight to the provider,
    // past the server's transport guard, so the secret itself is refused.
    await deployment.assertRegion(provider.id, actor, "live_transcription");
    await admitRecordingUsage(actor);
    const resolved = await deployment.credentials(provider.id, actor);
    const liveLabels = { provider: provider.id, model: spec.model, funding: provider.funding };
    const liveHelp = "Live transcript sessions asked for, by outcome.";
    // Deployment accounts hold their own credential; only a key provider needs the workspace's.
    if (resolved === "missing") {
      count("opengeni_recording_live_sessions_total", liveHelp, {
        ...liveLabels,
        outcome: "no_credentials",
      });
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
        resolved.credentials,
      );
    } catch (error) {
      count("opengeni_recording_live_sessions_total", liveHelp, {
        ...liveLabels,
        outcome: error instanceof RecordingTranscriptionError ? `provider_${error.code}` : "error",
      });
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
    count("opengeni_recording_live_sessions_total", liveHelp, {
      ...liveLabels,
      outcome: "started",
    });
    const session: RecordingLiveSession = {
      providerId: provider.id,
      model: spec.model,
      protocol: grant.protocol,
      url: grant.url,
      ...(grant.token ? { token: grant.token } : {}),
      ...(grant.webrtcUrl ? { webrtcUrl: grant.webrtcUrl } : {}),
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
    const streamedSeconds = (body.streamedMilliseconds - (live?.streamedMilliseconds ?? 0)) / 1_000;
    if (live && streamedSeconds > 0) {
      const provider = registry.get(live.providerId);
      const labels = {
        provider: live.providerId,
        model: live.model,
        funding: provider?.funding ?? "none",
      };
      count(
        "opengeni_recording_live_audio_seconds_total",
        "Seconds of audio streamed to live transcript models.",
        labels,
        streamedSeconds,
      );
      const costMicros = spec
        ? estimateRecordingTranscriptionCostMicros(spec, streamedSeconds * 1_000)
        : null;
      if (costMicros !== null) {
        count(
          "opengeni_recording_live_cost_usd_total",
          "Live transcript provider spend at list price, in US dollars.",
          labels,
          costMicros / 1_000_000,
        );
      }
    }
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
