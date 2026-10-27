import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Recordings: captured conversations (meetings, interviews, site walks) with
 * one or more audio tracks, versioned transcripts and editable speakers.
 * Visibility matches chats: "private" is Only me, "workspace" is shared.
 */
export const RECORDING_MAX_TRACKS = 8;
export const RECORDING_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
export const RECORDING_MAX_DURATION_MILLISECONDS = 10 * 60 * 60 * 1_000;
export const RECORDING_UPLOAD_BATCH_MAX = 50;

/**
 * The audio containers a track can be captured in: WebM or Ogg Opus and MP4
 * AAC from browsers, and an ADTS AAC stream from phones, whose frames
 * concatenate across chunks the way WebM clusters do.
 */
export type RecordingAudioContainer = "webm" | "mp4" | "ogg" | "aac";

/** The container a track's MIME type names, or null when recordings cannot use it. */
export function recordingAudioContainer(mimeType: string): RecordingAudioContainer | null {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (base === "audio/webm" || base === "video/webm") return "webm";
  if (base === "audio/mp4" || base === "video/mp4" || base === "audio/x-m4a") return "mp4";
  if (base === "audio/ogg" || base === "application/ogg") return "ogg";
  if (base === "audio/aac" || base === "audio/aacp" || base === "audio/x-aac") return "aac";
  return null;
}

export const RecordingVisibility = /* @__PURE__ */ defineSchema(() =>
  z.enum(["private", "workspace"]),
);
export type RecordingVisibility = z.infer<typeof RecordingVisibility>;

export const RecordingState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["capturing", "processing", "ready", "failed"]),
);
export type RecordingState = z.infer<typeof RecordingState>;

/**
 * What a recorder can capture into a track. microphone: the person
 * recording; system: the computer's audio (the other side).
 */
export const RecordingCaptureSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["microphone", "system", "mixed", "upload"]),
);
export type RecordingCaptureSource = z.infer<typeof RecordingCaptureSource>;

/** Where a track came from: a recorder's capture, or a browser tab an agent recorded. */
export const RecordingTrackSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["microphone", "system", "mixed", "upload", "browser_tab"]),
);
export type RecordingTrackSource = z.infer<typeof RecordingTrackSource>;

export const RecordingTrackKind = /* @__PURE__ */ defineSchema(() => z.enum(["audio", "video"]));
export type RecordingTrackKind = z.infer<typeof RecordingTrackKind>;

/**
 * meeting: a recorded conversation, listed in Meetings. browser: an agent's
 * browser recording, a video of the tab with a log of what the agent did.
 * dictation: speech someone records to type it, such as into the chat box;
 * always private, never listed, and deleted a day after it is transcribed.
 */
export const RecordingPurpose = /* @__PURE__ */ defineSchema(() =>
  z.enum(["meeting", "browser", "dictation"]),
);
export type RecordingPurpose = z.infer<typeof RecordingPurpose>;

/** What a client may record: browser recordings are made by the server. */
export const RecordingCapturePurpose = /* @__PURE__ */ defineSchema(() =>
  z.enum(["meeting", "dictation"]),
);
export type RecordingCapturePurpose = z.infer<typeof RecordingCapturePurpose>;

/** How long a dictation is kept after it is transcribed, for the client to take its text. */
export const DICTATION_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;

export const RecordingTranscriptVersionState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["queued", "processing", "complete", "failed"]),
);
export type RecordingTranscriptVersionState = z.infer<typeof RecordingTranscriptVersionState>;

export const RecordingSpeakerSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(["confirmed", "suggested", "carried_over", "track"]),
);
export type RecordingSpeakerSource = z.infer<typeof RecordingSpeakerSource>;

/**
 * Who told the speakers apart in a version: the transcription provider, our
 * own diarizer, the tracks alone (microphone versus system audio), or nobody.
 */
export const RecordingDiarization = /* @__PURE__ */ defineSchema(() =>
  z.enum(["provider", "ours", "tracks", "none"]),
);
export type RecordingDiarization = z.infer<typeof RecordingDiarization>;

/**
 * Who tells speakers apart: `auto` uses the model's own diarization when it
 * has one and Opengeni's otherwise; `ours` always uses Opengeni's, for the
 * same speakers whatever the model.
 */
export const RecordingDiarizer = /* @__PURE__ */ defineSchema(() => z.enum(["auto", "ours"]));
export type RecordingDiarizer = z.infer<typeof RecordingDiarizer>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const externalRef = z.string().trim().min(1).max(512);
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue).max(100),
    z.record(z.string().max(128), jsonValue),
  ]),
);
/** Product-owned metadata; Opengeni stores and filters on it but never interprets it. */
const recordingMetadata = z
  .record(z.string().min(1).max(128), jsonValue)
  .refine((value) => JSON.stringify(value).length <= 16_384, "metadata is too large");

/** How to transcribe; every field is optional and falls back to workspace defaults. */
export const RecordingTranscriptionOptions = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      providerId: z.string().trim().min(1).max(128).optional(),
      model: z.string().trim().min(1).max(128).optional(),
      /** ISO 639-1 or 639-3 hint; omitted means detect. */
      language: z
        .string()
        .regex(/^[a-z]{2,3}$/u)
        .optional(),
      /** Upper bound on distinct speakers when the model diarizes. */
      maxSpeakers: z.number().int().min(1).max(32).optional(),
      /** Names and terms the model should recognize. */
      keyterms: z.array(z.string().trim().min(1).max(50)).max(100).optional(),
      /** Who tells speakers apart; defaults to the workspace's choice, else `auto`. */
      diarizer: RecordingDiarizer.optional(),
    })
    .strict(),
);
export type RecordingTranscriptionOptions = z.infer<typeof RecordingTranscriptionOptions>;

/**
 * How to transcribe, as asked for. A new recording that names no language
 * takes the workspace's meeting language; `null` detects it even then.
 */
export const RecordingTranscriptionRequest = /* @__PURE__ */ defineSchema(() =>
  RecordingTranscriptionOptions.extend({
    language: z
      .string()
      .regex(/^[a-z]{2,3}$/u)
      .nullable()
      .optional(),
  }).strict(),
);
export type RecordingTranscriptionRequest = z.infer<typeof RecordingTranscriptionRequest>;

/**
 * How long a workspace keeps meetings, in days after they were recorded.
 * Audio can go sooner than the transcript, never later.
 */
export const RecordingRetention = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      audioDays: z.number().int().min(0).max(36_500).optional(),
      transcriptDays: z.number().int().min(1).max(36_500).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.audioDays === undefined ||
        value.transcriptDays === undefined ||
        value.audioDays <= value.transcriptDays,
      "audioDays can't be longer than transcriptDays",
    ),
);
export type RecordingRetention = z.infer<typeof RecordingRetention>;

const DAY_MILLISECONDS = 86_400_000;

/**
 * When retention deletes a meeting's audio and the meeting itself, counted
 * from when it was recorded. Null where nothing is set. The sweep runs every
 * few minutes, so deletion follows shortly after.
 */
export function recordingRetentionDates(
  retention: RecordingRetention | undefined,
  recordedAt: Date,
): { audio: Date | null; meeting: Date | null } {
  const at = (days: number | undefined) =>
    days === undefined ? null : new Date(recordedAt.getTime() + days * DAY_MILLISECONDS);
  return { audio: at(retention?.audioDays), meeting: at(retention?.transcriptDays) };
}

/**
 * A workspace's recording defaults. New recordings are Only me unless the
 * workspace says otherwise; products may always set visibility explicitly.
 */
export const WorkspaceRecordingSettings = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      defaultVisibility: RecordingVisibility.optional(),
      /** Provider and model new transcripts use when a request names none. */
      transcription: z
        .object({
          providerId: z.string().trim().min(1).max(128),
          model: z.string().trim().min(1).max(128),
        })
        .strict()
        .optional(),
      /** Who tells speakers apart in new transcripts. */
      diarizer: RecordingDiarizer.optional(),
      /**
       * The language new meetings are in, as an ISO 639-1 or 639-3 code,
       * when a recording names none. Unset detects it. A live transcript
       * hears only a few seconds at a time, so detecting can drift between
       * languages there; naming one keeps it steady.
       */
      language: z
        .string()
        .regex(/^[a-z]{2,3}$/u)
        .optional(),
      /**
       * Recognize people by voice. Off by default. While on, Opengeni keeps
       * each diarized speaker's voice vector with the transcript and
       * suggests who a speaker is from the voices of people who agreed to be
       * remembered. Turning it off forgets every remembered voice.
       */
      voiceprints: z.boolean().optional(),
      /**
       * Show a live transcript while recording, by default. Off by default.
       * While on, the recorder also streams each track to a live speech
       * model as it is captured, which the provider bills for the audio
       * streamed. The live text is a preview: the final transcript replaces
       * it when the recording is done.
       */
      liveTranscript: z.boolean().optional(),
      /**
       * How long meetings are kept, in days after they were recorded. Unset
       * keeps them until someone deletes them. When `audioDays` passes, the
       * audio is deleted and the transcript stays (0 deletes it as soon as
       * the transcript is done); when `transcriptDays` passes, the whole
       * meeting is deleted.
       */
      retention: RecordingRetention.optional(),
    })
    .strict(),
);
export type WorkspaceRecordingSettings = z.infer<typeof WorkspaceRecordingSettings>;

/** Read a workspace's recording defaults leniently; a bad value means none. */
export function resolveWorkspaceRecordingSettings(settings: unknown): WorkspaceRecordingSettings {
  const value =
    settings !== null && typeof settings === "object"
      ? (settings as { recordings?: unknown }).recordings
      : undefined;
  return WorkspaceRecordingSettings.safeParse(value ?? {}).data ?? {};
}

export const CreateRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Client-generated id; creating the same id again returns the existing recording. */
      recordingId: z.string().uuid(),
      /**
       * meeting (the default) or dictation. A dictation is private and has one
       * microphone track; it is transcribed with the workspace's voice input
       * model, as text without speakers.
       */
      purpose: RecordingCapturePurpose.optional(),
      title: z.string().trim().min(1).max(300).optional(),
      visibility: RecordingVisibility.optional(),
      startedAt: z.string().datetime({ offset: true }).optional(),
      externalRef: externalRef.optional(),
      metadata: recordingMetadata.optional(),
      tracks: z
        .array(
          z
            .object({
              trackNumber: z
                .number()
                .int()
                .min(0)
                .max(RECORDING_MAX_TRACKS - 1),
              source: RecordingCaptureSource,
              mimeType: z
                .string()
                .trim()
                .min(1)
                .max(128)
                .refine(
                  (mimeType) => recordingAudioContainer(mimeType) !== null,
                  "mimeType must be audio/webm, audio/ogg, audio/mp4 or audio/aac",
                ),
            })
            .strict(),
        )
        .min(1)
        .max(RECORDING_MAX_TRACKS)
        .refine(
          (tracks) => new Set(tracks.map((track) => track.trackNumber)).size === tracks.length,
          "track numbers must be unique",
        ),
      transcription: RecordingTranscriptionRequest.optional(),
      /**
       * The person recording's name, as your app knows it. With computer or
       * tab audio beside the microphone, the microphone is theirs and is
       * named with this in the transcript, unless Opengeni already has a name
       * for them (their profile or membership label).
       */
      ownerName: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
);
export type CreateRecordingRequest = z.infer<typeof CreateRecordingRequest>;

export const RecordingChunkDescriptor = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      chunkNumber: z.number().int().min(0).max(100_000),
      byteLength: z.number().int().positive().max(RECORDING_MAX_CHUNK_BYTES),
      sha256: sha256Hex,
      startMilliseconds: z.number().int().min(0).max(RECORDING_MAX_DURATION_MILLISECONDS),
      durationMilliseconds: z.number().int().min(0).max(RECORDING_MAX_DURATION_MILLISECONDS),
    })
    .strict(),
);
export type RecordingChunkDescriptor = z.infer<typeof RecordingChunkDescriptor>;

/** Reserve chunks and get presigned URLs to PUT their bytes straight to storage. */
export const CreateRecordingUploadsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      trackNumber: z
        .number()
        .int()
        .min(0)
        .max(RECORDING_MAX_TRACKS - 1),
      chunks: z.array(RecordingChunkDescriptor).min(1).max(RECORDING_UPLOAD_BATCH_MAX),
    })
    .strict(),
);
export type CreateRecordingUploadsRequest = z.infer<typeof CreateRecordingUploadsRequest>;

export const RecordingChunkUpload = /* @__PURE__ */ defineSchema(() =>
  z.object({
    chunkNumber: z.number().int(),
    /** Already stored; skip the PUT. */
    uploaded: z.boolean(),
    /** Presigned URL to PUT the chunk's bytes to; null when already stored. */
    url: z.string().nullable(),
    method: z.literal("PUT"),
    /** Headers the PUT must carry exactly. */
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string().nullable(),
  }),
);
export type RecordingChunkUpload = z.infer<typeof RecordingChunkUpload>;

export const CreateRecordingUploadsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ uploads: z.array(RecordingChunkUpload) }),
);
export type CreateRecordingUploadsResponse = z.infer<typeof CreateRecordingUploadsResponse>;

/** Confirm chunks whose bytes were PUT; the server checks each object first. */
export const CompleteRecordingChunksRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      trackNumber: z
        .number()
        .int()
        .min(0)
        .max(RECORDING_MAX_TRACKS - 1),
      chunkNumbers: z
        .array(z.number().int().min(0).max(100_000))
        .min(1)
        .max(RECORDING_UPLOAD_BATCH_MAX),
    })
    .strict(),
);
export type CompleteRecordingChunksRequest = z.infer<typeof CompleteRecordingChunksRequest>;

export const CompleteRecordingChunksResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Chunks now confirmed as stored. */
    uploaded: z.array(z.number().int()),
    /** Chunks whose bytes are not (fully) in storage yet; upload them again. */
    missing: z.array(z.number().int()),
  }),
);
export type CompleteRecordingChunksResponse = z.infer<typeof CompleteRecordingChunksResponse>;

/** Capture is over: every listed chunk must be uploaded. Starts transcription. */
export const FinalizeRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      endedAt: z.string().datetime({ offset: true }).optional(),
      tracks: z
        .array(
          z
            .object({
              trackNumber: z
                .number()
                .int()
                .min(0)
                .max(RECORDING_MAX_TRACKS - 1),
              chunkCount: z.number().int().min(0).max(100_001),
            })
            .strict(),
        )
        .min(1)
        .max(RECORDING_MAX_TRACKS),
    })
    .strict(),
);
export type FinalizeRecordingRequest = z.infer<typeof FinalizeRecordingRequest>;

export const UpdateRecordingRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      title: z.string().trim().min(1).max(300).optional(),
      visibility: RecordingVisibility.optional(),
      externalRef: externalRef.nullable().optional(),
      metadata: recordingMetadata.optional(),
    })
    .strict(),
);
export type UpdateRecordingRequest = z.infer<typeof UpdateRecordingRequest>;

/** Start a new transcript version over the recording's audio. */
export const CreateRecordingTranscriptRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      transcription: RecordingTranscriptionRequest.optional(),
    })
    .strict(),
);
export type CreateRecordingTranscriptRequest = z.infer<typeof CreateRecordingTranscriptRequest>;

/**
 * Name speakers in one version. An assignment names a label (a person from
 * the directory, or a plain name); a segment override moves one segment to
 * another label. Assigning two labels to one person merges them.
 */
export const UpdateRecordingSpeakersRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      assignments: z
        .array(
          z
            .object({
              label: z.string().min(1).max(128),
              personId: z.string().uuid().nullable().optional(),
              name: z.string().trim().min(1).max(200).nullable().optional(),
            })
            .strict(),
        )
        .max(64)
        .optional(),
      segmentOverrides: z
        .array(
          z
            .object({
              segmentIndex: z.number().int().min(0),
              label: z.string().min(1).max(128),
            })
            .strict(),
        )
        .max(500)
        .optional(),
      /**
       * Turn down a voice suggestion: the label loses its suggested name, and
       * that person is not suggested for this voice in this recording again.
       */
      rejectSuggestions: z
        .array(z.object({ label: z.string().min(1).max(128) }).strict())
        .max(64)
        .optional(),
    })
    .strict(),
);
export type UpdateRecordingSpeakersRequest = z.infer<typeof UpdateRecordingSpeakersRequest>;

/**
 * Agree to have a person's voice remembered. `self` is a member agreeing
 * for themselves; `attested` is someone confirming that a person outside
 * the workspace agreed. Members can only agree for themselves.
 */
export const RecordingVoiceprintConsent = /* @__PURE__ */ defineSchema(() =>
  z.enum(["self", "attested"]),
);
export type RecordingVoiceprintConsent = z.infer<typeof RecordingVoiceprintConsent>;

export const RememberRecordingPersonVoiceRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({ consent: RecordingVoiceprintConsent }).strict(),
);
export type RememberRecordingPersonVoiceRequest = z.infer<
  typeof RememberRecordingPersonVoiceRequest
>;

/**
 * Correct the text of segments in one version. The version itself never
 * changes; edits are a layer on top. `text: null` reverts to the original.
 */
export const UpdateRecordingSegmentsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      edits: z
        .array(
          z
            .object({
              segmentIndex: z.number().int().min(0),
              text: z.string().max(65_536).nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
);
export type UpdateRecordingSegmentsRequest = z.infer<typeof UpdateRecordingSegmentsRequest>;

export const CreateRecordingPersonRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Client-generated id; creating the same id again returns the existing person. */
      personId: z.string().uuid().optional(),
      displayName: z.string().trim().min(1).max(200),
      email: z.string().trim().email().max(320).optional(),
      memberSubjectId: z.string().min(1).max(1024).optional(),
      externalRef: externalRef.optional(),
    })
    .strict(),
);
export type CreateRecordingPersonRequest = z.infer<typeof CreateRecordingPersonRequest>;

export const RecordingTrack = /* @__PURE__ */ defineSchema(() =>
  z.object({
    trackNumber: z.number().int(),
    kind: RecordingTrackKind,
    source: RecordingTrackSource,
    mimeType: z.string(),
    chunkCount: z.number().int(),
    totalBytes: z.number().int(),
    durationMilliseconds: z.number().int(),
    /** The worker has prepared one seekable file for this track. */
    playable: z.boolean(),
    /** A video track's picture, once its video is prepared; null otherwise. */
    video: z
      .object({
        width: z.number().int(),
        height: z.number().int(),
        frameCount: z.number().int(),
      })
      .nullable(),
    /** The live transcript streamed for this track, or null when none was. */
    live: z
      .object({
        providerId: z.string(),
        model: z.string(),
        /** Audio streamed to the live model so far. */
        streamedMilliseconds: z.number().int(),
        /** Estimated provider cost at list price, in US dollars. */
        costUsd: z.number().nullable(),
      })
      .nullable(),
  }),
);
export type RecordingTrack = z.infer<typeof RecordingTrack>;

export const RecordingTranscriptVersion = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string(),
    recordingId: z.string(),
    versionNumber: z.number().int(),
    providerId: z.string(),
    model: z.string(),
    options: RecordingTranscriptionOptions,
    state: RecordingTranscriptVersionState,
    isCurrent: z.boolean(),
    languages: z.array(z.string()),
    diarized: z.boolean(),
    diarization: RecordingDiarization.nullable(),
    audioMilliseconds: z.number().int(),
    segmentCount: z.number().int(),
    /** Estimated provider cost at list price, in US dollars. */
    costUsd: z.number().nullable(),
    requestedBySubjectId: z.string(),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  }),
);
export type RecordingTranscriptVersion = z.infer<typeof RecordingTranscriptVersion>;

export const Recording = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string(),
    workspaceId: z.string(),
    ownerSubjectId: z.string(),
    visibility: RecordingVisibility,
    title: z.string(),
    purpose: RecordingPurpose,
    state: RecordingState,
    /** Why a browser recording's video could not be made, when it failed. */
    errorCode: z.string().nullable(),
    startedAt: z.string(),
    captureEndedAt: z.string().nullable(),
    durationMilliseconds: z.number().int(),
    externalRef: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    /** When the workspace's retention deleted the audio; the transcript stays. */
    audioDeletedAt: z.string().nullable(),
    transcription: RecordingTranscriptionOptions,
    tracks: z.array(RecordingTrack),
    /** The current transcript version, or the newest one while none is complete. */
    transcript: RecordingTranscriptVersion.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type Recording = z.infer<typeof Recording>;

export const ListRecordingsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    recordings: z.array(Recording),
    /** Pass as `beforeStartedAt` and `beforeId` for the next page; null at the end. */
    nextBefore: z.object({ startedAt: z.string(), id: z.string() }).nullable(),
  }),
);
export type ListRecordingsResponse = z.infer<typeof ListRecordingsResponse>;

export const FinalizeRecordingResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ recording: Recording, transcript: RecordingTranscriptVersion }),
);
export type FinalizeRecordingResponse = z.infer<typeof FinalizeRecordingResponse>;

export const ListRecordingTranscriptVersionsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ versions: z.array(RecordingTranscriptVersion) }),
);
export type ListRecordingTranscriptVersionsResponse = z.infer<
  typeof ListRecordingTranscriptVersionsResponse
>;

export const RecordingPerson = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string(),
    displayName: z.string(),
    memberSubjectId: z.string().nullable(),
    email: z.string().nullable(),
    externalRef: z.string().nullable(),
    createdAt: z.string(),
    /**
     * Whether this person's voice is remembered. `consent` is present once
     * they agreed; `learned` is false until a confirmed speaker taught it
     * their voice. The voice vectors themselves are never returned.
     */
    voice: z
      .object({
        consent: RecordingVoiceprintConsent,
        consentedAt: z.string(),
        learned: z.boolean(),
        updatedAt: z.string().nullable(),
      })
      .nullable(),
  }),
);
export type RecordingPerson = z.infer<typeof RecordingPerson>;

export const ListRecordingPeopleResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ people: z.array(RecordingPerson) }),
);
export type ListRecordingPeopleResponse = z.infer<typeof ListRecordingPeopleResponse>;

export const RecordingSpeaker = /* @__PURE__ */ defineSchema(() =>
  z.object({
    label: z.string(),
    /**
     * Resolved display name: the person's name or the plain name someone gave
     * the label, else its default (see defaultRecordingSpeakerName).
     */
    name: z.string(),
    personId: z.string().nullable(),
    /** How the label got its name; null when nobody named it and `name` is the default. */
    source: RecordingSpeakerSource.nullable(),
    confidence: z.number().nullable(),
  }),
);
export type RecordingSpeaker = z.infer<typeof RecordingSpeaker>;

const DIARIZED_SPEAKER_LABEL = /^(?:t\d+_)?speaker_(\d+)$/u;
const TRACK_SPEAKER_LABEL = /^track-(\d+)$/u;

/**
 * True when a recording's microphone is the person recording it: computer
 * or tab audio sits beside it, so everyone else is on that track. A
 * microphone alone (a phone, a room) may hear several people.
 */
export function recordingMicrophoneIsOwner(
  tracks: readonly { source: RecordingTrackSource }[],
): boolean {
  return (
    tracks.some((track) => track.source === "microphone") &&
    tracks.some((track) => track.source === "system")
  );
}

/** What an unnamed speaker label stands for, for clients that word it in the reader's language. */
export type RecordingSpeakerDefault =
  | { kind: "speaker"; number: number }
  | { kind: "microphone" }
  | { kind: "system" }
  | { kind: "track"; number: number }
  | { kind: "label"; label: string };

/**
 * What a speaker label stands for until someone names it: the diarizer's
 * `speaker_1` (or `t0_speaker_1`) is speaker 2, and a whole-track label such as
 * `track-0` is that track's microphone, shared audio or plain track number.
 */
export function recordingSpeakerDefault(
  label: string,
  tracks: readonly { trackNumber: number; source: RecordingTrackSource }[],
): RecordingSpeakerDefault {
  const diarized = DIARIZED_SPEAKER_LABEL.exec(label);
  if (diarized) return { kind: "speaker", number: Number(diarized[1]) + 1 };
  const track = TRACK_SPEAKER_LABEL.exec(label);
  if (track) {
    const trackNumber = Number(track[1]);
    const source = tracks.find((candidate) => candidate.trackNumber === trackNumber)?.source;
    if (source === "microphone") return { kind: "microphone" };
    if (source === "system") return { kind: "system" };
    return { kind: "track", number: trackNumber + 1 };
  }
  return { kind: "label", label };
}

/**
 * The name a speaker label has until someone names it: "Speaker 2" for a
 * diarizer's `speaker_1` (or `t0_speaker_1` when several tracks were
 * diarized), and the track's role for a whole-track label such as `track-0`.
 * Servers and clients both use this, so the same voice reads the same
 * everywhere.
 */
export function defaultRecordingSpeakerName(
  label: string,
  tracks: readonly { trackNumber: number; source: RecordingTrackSource }[],
): string {
  const named = recordingSpeakerDefault(label, tracks);
  switch (named.kind) {
    case "speaker":
      return `Speaker ${named.number}`;
    case "microphone":
      return "Microphone";
    case "system":
      return "Shared audio";
    case "track":
      return `Track ${named.number}`;
    case "label":
      return named.label;
  }
}

export const UpdateRecordingSpeakersResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ speakers: z.array(RecordingSpeaker) }),
);
export type UpdateRecordingSpeakersResponse = z.infer<typeof UpdateRecordingSpeakersResponse>;

export const RecordingTranscriptSegment = /* @__PURE__ */ defineSchema(() =>
  z.object({
    index: z.number().int(),
    startMilliseconds: z.number().int(),
    endMilliseconds: z.number().int(),
    trackNumber: z.number().int().nullable(),
    /** Effective label after human edits; null when the model gave none. */
    speakerLabel: z.string().nullable(),
    /** Effective text after human edits. */
    text: z.string(),
    /** A person corrected this segment's text. */
    edited: z.boolean(),
  }),
);
export type RecordingTranscriptSegment = z.infer<typeof RecordingTranscriptSegment>;

export const UpdateRecordingSegmentsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ segments: z.array(RecordingTranscriptSegment) }),
);
export type UpdateRecordingSegmentsResponse = z.infer<typeof UpdateRecordingSegmentsResponse>;

export const RecordingTranscriptPage = /* @__PURE__ */ defineSchema(() =>
  z.object({
    version: RecordingTranscriptVersion,
    speakers: z.array(RecordingSpeaker),
    segments: z.array(RecordingTranscriptSegment),
    /** Pass as `after` to read the next page; null at the end. */
    nextAfter: z.number().int().nullable(),
  }),
);
export type RecordingTranscriptPage = z.infer<typeof RecordingTranscriptPage>;

/** A short-lived link to one track's prepared audio, for playback. */
export const RecordingTrackAudio = /* @__PURE__ */ defineSchema(() =>
  z.object({
    url: z.string(),
    expiresAt: z.string(),
    mimeType: z.string(),
    bytes: z.number().int(),
  }),
);
export type RecordingTrackAudio = z.infer<typeof RecordingTrackAudio>;

export const RecordingTranscriptionCapabilities = /* @__PURE__ */ defineSchema(() =>
  z.object({
    batch: z.boolean(),
    live: z.boolean(),
    diarization: z.boolean(),
    liveDiarization: z.boolean(),
    /** Transcribes several tracks in one call and keeps them apart. */
    multichannel: z.boolean(),
    maxSpeakers: z.number().int().nullable(),
    wordTimestamps: z.boolean(),
    /** ISO 639 codes the model supports; empty means it does not say. */
    languages: z.array(z.string()),
    languageDetection: z.boolean(),
    keyterms: z.boolean(),
    /** Provider-side matching against registered voices. */
    speakerLibrary: z.boolean(),
    maxDurationSeconds: z.number().nullable(),
    maxFileBytes: z.number().nullable(),
  }),
);
export type RecordingTranscriptionCapabilities = z.infer<typeof RecordingTranscriptionCapabilities>;

/**
 * Who pays for a speech-to-text model: the workspace's own provider key
 * (`workspace_key`), a subscription the workspace signed in to, which
 * Opengeni never charges (`workspace_subscription`), or an account the
 * deployment holds, charged in Opengeni credits where credit billing is on
 * (`deployment`).
 */
export const RecordingTranscriptionFunding = /* @__PURE__ */ defineSchema(() =>
  z.enum(["workspace_key", "workspace_subscription", "deployment"]),
);
export type RecordingTranscriptionFunding = z.infer<typeof RecordingTranscriptionFunding>;

export const RecordingTranscriptionModel = /* @__PURE__ */ defineSchema(() =>
  z.object({
    providerId: z.string(),
    providerName: z.string(),
    model: z.string(),
    name: z.string(),
    /** The provider can serve this workspace now (its key, sign-in or account is set up). */
    available: z.boolean(),
    funding: RecordingTranscriptionFunding,
    capabilities: RecordingTranscriptionCapabilities,
    /**
     * What an audio hour costs this workspace in USD: the list price on its
     * own key, or the credits charged for a deployment's model. Null when it
     * pays nothing per hour (a subscription, or a model the deployment covers)
     * or the price is unknown.
     */
    usdPerHour: z.number().nullable(),
  }),
);
export type RecordingTranscriptionModel = z.infer<typeof RecordingTranscriptionModel>;

export const ListRecordingModelsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Every speech-to-text model the deployment offers, for any use. */
    models: z.array(RecordingTranscriptionModel),
    /** The model new meeting transcripts use when a request names none. */
    default: z.object({ providerId: z.string(), model: z.string() }),
    /**
     * The model dictation tries first; null when none is set, which tries
     * the deployment's providers in order.
     */
    dictationDefault: z.object({ providerId: z.string(), model: z.string() }).nullable(),
    /** The deployment uses one model for everything; workspaces cannot pick. */
    pinned: z.boolean(),
    /**
     * The language this workspace's meetings are transcribed in unless a
     * recording names another; null detects it. Absent from older servers.
     */
    language: z.string().nullable().optional(),
  }),
);
export type ListRecordingModelsResponse = z.infer<typeof ListRecordingModelsResponse>;

/**
 * The wire protocols a live transcription session can speak. Clients connect
 * to the provider directly with a short-lived grant from the API, so the
 * workspace's provider key never leaves the server.
 *
 * `elevenlabs.scribe_realtime`: JSON over WebSocket. The client sends
 * `{"message_type":"input_audio_chunk","audio_base_64":…,"commit":false,"sample_rate":…}`
 * with little-endian 16-bit mono PCM; the provider answers with
 * `partial_transcript` and `committed_transcript_with_timestamps` messages.
 *
 * `openai.realtime`: an OpenAI Realtime transcription session (OpenAI or
 * Azure OpenAI), already configured. `token` is a short-lived client secret,
 * sent as `Authorization: Bearer <token>`. A browser posts its WebRTC offer
 * (`application/sdp`) to `webrtcUrl`, sends the track's audio as media and
 * reads events on a data channel named `oai-events`. A client that can set
 * headers on a WebSocket (React Native) opens `url` instead and sends
 * `{"type":"input_audio_buffer.append","audio":…}` with base64 PCM at
 * `audio.sampleRate`. Either way the provider answers with
 * `input_audio_buffer.speech_started`/`speech_stopped` (with `audio_start_ms`
 * and `audio_end_ms`) and
 * `conversation.item.input_audio_transcription.delta`/`completed` events.
 */
export const RecordingLiveProtocol = /* @__PURE__ */ defineSchema(() =>
  z.enum(["elevenlabs.scribe_realtime", "openai.realtime"]),
);
export type RecordingLiveProtocol = z.infer<typeof RecordingLiveProtocol>;

/** Ask for a live transcription session for one track of a recording being captured. */
export const CreateRecordingLiveSessionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      trackNumber: z
        .number()
        .int()
        .min(0)
        .max(RECORDING_MAX_TRACKS - 1),
      /** A live model; defaults to the deployment's live model. */
      providerId: z.string().trim().min(1).max(128).optional(),
      model: z.string().trim().min(1).max(128).optional(),
    })
    .strict(),
);
export type CreateRecordingLiveSessionRequest = z.infer<typeof CreateRecordingLiveSessionRequest>;

/**
 * A grant to stream one track to a live model. Connect before `expiresAt`,
 * and ask for a new session to reconnect. For `elevenlabs.scribe_realtime`,
 * `url` carries the single-use credential and the audio format; for
 * `openai.realtime`, the credential is `token` (see {@link RecordingLiveProtocol}).
 */
export const RecordingLiveSession = /* @__PURE__ */ defineSchema(() =>
  z.object({
    providerId: z.string(),
    model: z.string(),
    protocol: RecordingLiveProtocol,
    url: z.string(),
    /** A short-lived client secret, for protocols that take it in a header. */
    token: z.string().optional(),
    /** Where a browser posts its WebRTC offer, for protocols that offer WebRTC. */
    webrtcUrl: z.string().optional(),
    audio: z.object({ encoding: z.literal("pcm_s16le"), sampleRate: z.number().int() }),
    expiresAt: z.string(),
  }),
);
export type RecordingLiveSession = z.infer<typeof RecordingLiveSession>;

/**
 * A finished stretch of live text on one track. Times are from the start of
 * the recording. Live segments are a preview: they are removed once the
 * recording's first transcript is ready.
 */
export const RecordingLiveSegment = /* @__PURE__ */ defineSchema(() =>
  z.object({
    trackNumber: z.number().int(),
    /** The recorder's own counter for the track, starting at 0. */
    segmentNumber: z.number().int(),
    startMilliseconds: z.number().int(),
    endMilliseconds: z.number().int(),
    text: z.string(),
    /** Order across tracks; pass the last one seen as `after`. */
    sequence: z.number().int(),
  }),
);
export type RecordingLiveSegment = z.infer<typeof RecordingLiveSegment>;

/**
 * Save finished live text for one track. Sending a segment number again
 * keeps the first copy, so a recorder can retry freely.
 */
export const AppendRecordingLiveSegmentsRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      trackNumber: z
        .number()
        .int()
        .min(0)
        .max(RECORDING_MAX_TRACKS - 1),
      /** All audio streamed for this track so far, for the cost estimate. */
      streamedMilliseconds: z.number().int().min(0).max(RECORDING_MAX_DURATION_MILLISECONDS),
      segments: z
        .array(
          z
            .object({
              segmentNumber: z.number().int().min(0).max(1_000_000),
              startMilliseconds: z.number().int().min(0).max(RECORDING_MAX_DURATION_MILLISECONDS),
              endMilliseconds: z.number().int().min(0).max(RECORDING_MAX_DURATION_MILLISECONDS),
              text: z.string().max(16_384),
            })
            .strict()
            .refine((segment) => segment.endMilliseconds >= segment.startMilliseconds, {
              message: "endMilliseconds is before startMilliseconds",
            }),
        )
        .max(100),
    })
    .strict(),
);
export type AppendRecordingLiveSegmentsRequest = z.infer<typeof AppendRecordingLiveSegmentsRequest>;

export const ListRecordingLiveSegmentsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    segments: z.array(RecordingLiveSegment),
    /** Pass as `after` for newer segments; the same value when there are none yet. */
    after: z.number().int(),
    /** A transcript is ready, so the live preview is over and its segments are gone. */
    ended: z.boolean(),
  }),
);
export type ListRecordingLiveSegmentsResponse = z.infer<typeof ListRecordingLiveSegmentsResponse>;

/**
 * A meeting's two Markdown documents. `notepad` is what people jot down
 * while it is recorded; `notes` is the written-up summary, decisions and
 * action items, by a person or an agent, afterwards.
 */
export const RECORDING_NOTE_KINDS = ["notepad", "notes"] as const;
export const RecordingNoteKind = /* @__PURE__ */ defineSchema(() => z.enum(RECORDING_NOTE_KINDS));
export type RecordingNoteKind = z.infer<typeof RecordingNoteKind>;

/** Notes can hold about 50 pages of text. */
export const RECORDING_NOTE_MAX_BYTES = 262_144;

export const RecordingNote = /* @__PURE__ */ defineSchema(() =>
  z.object({
    kind: RecordingNoteKind,
    /** Markdown. */
    body: z.string(),
    /** Goes up by one with every save; send it back as `expectedRevision`. */
    revision: z.number().int().min(1),
    updatedAt: z.string(),
    updatedBy: z.object({
      subjectId: z.string(),
      /** The chat whose agent saved it, when an agent did. */
      sessionId: z.string().uuid().nullable(),
    }),
  }),
);
export type RecordingNote = z.infer<typeof RecordingNote>;

export const ListRecordingNotesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** The notes saved so far; a kind nobody has written yet is absent. */
    notes: z.array(RecordingNote),
  }),
);
export type ListRecordingNotesResponse = z.infer<typeof ListRecordingNotesResponse>;

/**
 * Replace one of a meeting's notes. With `expectedRevision`, the save is
 * refused (409 `notes_changed`) when someone saved a newer revision first;
 * 0 means "nobody has written it yet". Without it, the save always wins.
 */
export const SaveRecordingNoteRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      body: z
        .string()
        .refine((body) => new TextEncoder().encode(body).length <= RECORDING_NOTE_MAX_BYTES, {
          message: `Notes can be at most ${RECORDING_NOTE_MAX_BYTES} bytes`,
        }),
      expectedRevision: z.number().int().min(0).optional(),
    })
    .strict(),
);
export type SaveRecordingNoteRequest = z.infer<typeof SaveRecordingNoteRequest>;

export const RECORDING_EVENT_TYPES = [
  "recording.started",
  "recording.finished",
  "recording.transcript.ready",
  "recording.transcript.failed",
  "recording.transcript.current_changed",
  "recording.speakers.updated",
  "recording.notes.updated",
  "recording.deleted",
] as const;
export type RecordingEventType = (typeof RECORDING_EVENT_TYPES)[number];

/**
 * The `data` of a recording webhook event. Events carry ids, states and
 * numbers only, never a title, audio or transcript text, so a receiver reads
 * the recording through the API with its own authority.
 */
export type RecordingEventData = {
  recordingId: string;
  ownerSubjectId: string;
  visibility: RecordingVisibility;
  externalRef: string | null;
  state: RecordingState;
  durationMilliseconds?: number;
  versionId?: string;
  versionNumber?: number;
  providerId?: string;
  model?: string;
  segmentCount?: number;
  languages?: string[];
  errorCode?: string | null;
  previousVersionId?: string | null;
  /** `recording.notes.updated`: which notes, their new revision, and the chat whose agent saved them. */
  noteKind?: RecordingNoteKind;
  noteRevision?: number;
  sessionId?: string | null;
};
