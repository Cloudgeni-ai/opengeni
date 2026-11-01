import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createRecordingTranscriptionProviderRegistry,
  RecordingTranscriptionError,
  TranscriptionBillingRefusedError,
  TranscriptionServiceError,
  type RecordingDiarizer,
  type RecordingWordAligner,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionRequest,
  type TranscriptionRequest,
  type TranscriptionService,
} from "@opengeni/core";
import { DICTATION_RETENTION_MILLISECONDS } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  completeRecordingTranscriptVersion,
  createDb,
  createRecording,
  createRecordingTranscriptVersion,
  finalizeRecording,
  getRecording,
  getRecordingTranscriptPage,
  listRecordingPeople,
  listRecordingTranscriptVersions,
  markRecordingChunksUploaded,
  markRecordingDeleting,
  rememberRecordingPersonVoice,
  reserveRecordingChunks,
  setRecordingTrackPrepared,
  updateWorkspaceSettings,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { textModelCapabilities } from "@opengeni/core/transcription-service";
import { InferenceRegionRestrictedError } from "@opengeni/runtime/model-call";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createRecordingActivities,
  recordingPieceRequestKey,
  recordingTranscriptBudgetMilliseconds,
  type RecordingActivityOptions,
} from "../src/activities/recordings";
import { RecordingSpeakersError } from "../src/activities/recording-speakers";
import type { ControlActivityServices } from "../src/activities/types";
import { ffmpegPath, gatedOpusWebm, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("recording-activities");
  if (shared) client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    storage: {
      getObjectBytes: async (key: string) => objects.get(key) ?? null,
      putObject: async (args: { key: string; contentType: string; body: Uint8Array }) => {
        objects.set(args.key, { bytes: args.body, contentType: args.contentType });
      },
      deleteObject: async (key: string) => {
        objects.delete(key);
      },
    },
  };
}

function fakeProvider(
  transcribe: (
    request: RecordingTranscriptionRequest,
  ) => ReturnType<RecordingTranscriptionProvider["transcribe"]>,
): RecordingTranscriptionProvider {
  return {
    id: "elevenlabs",
    name: "Fake",
    funding: "workspace_key",
    models: [
      {
        model: "scribe_v2",
        name: "Scribe v2",
        usdPerHour: 0.22,
        capabilities: {
          batch: true,
          live: false,
          diarization: true,
          liveDiarization: false,
          multichannel: false,
          maxSpeakers: 32,
          wordTimestamps: true,
          languages: [],
          languageDetection: true,
          keyterms: true,
          speakerLibrary: false,
          maxDurationSeconds: 36_000,
          maxFileBytes: 3_000_000_000,
        },
      },
    ],
    transcribe: async (request) => await transcribe(request),
  };
}

async function capturedRecording(
  storage: ReturnType<typeof memoryStorage>,
  transcription: { providerId: string; model: string; options: Record<string, unknown> } = {
    providerId: "elevenlabs",
    model: "scribe_v2",
    options: { language: "en" },
  },
  sources: ReadonlyArray<"microphone" | "system"> = ["microphone", "system"],
  silentTracks: ReadonlyArray<number> = [],
) {
  const db = client!.db;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "recording-activities",
    accountExternalId: suffix,
    accountName: "Recording activities",
    workspaceExternalSource: "recording-activities",
    workspaceExternalId: suffix,
    workspaceName: "Recording activities",
    subjectId: `subject-${suffix}`,
    subjectLabel: "Ingrid Solberg",
  });
  const grant = access.workspaceGrants[0]!;
  const actor = { workspaceId: grant.workspaceId!, subjectId: grant.subjectId };
  const recordingId = crypto.randomUUID();
  await createRecording(db, {
    ...actor,
    accountId: grant.accountId,
    recordingId,
    title: "Planning",
    visibility: "private",
    tracks: sources.map((source, trackNumber) => ({
      trackNumber,
      source,
      mimeType: "audio/webm;codecs=opus",
    })),
  });
  for (const trackNumber of sources.keys()) {
    const audio = silentTracks.includes(trackNumber)
      ? gatedOpusWebm(2, [])
      : opusWebm(2, trackNumber === 0 ? 440 : 660);
    const half = Math.ceil(audio.length / 2);
    const parts = [audio.slice(0, half), audio.slice(half)];
    const chunks = parts.map((bytes, chunkNumber) => ({
      chunkNumber,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      startMilliseconds: chunkNumber * 1_000,
      durationMilliseconds: 1_000,
    }));
    const reserved = await reserveRecordingChunks(db, {
      ...actor,
      recordingId,
      trackNumber,
      chunks,
    });
    for (const row of reserved) {
      storage.objects.set(row.objectKey, {
        bytes: parts[row.chunkNumber]!,
        contentType: "audio/webm",
      });
    }
    await markRecordingChunksUploaded(db, {
      ...actor,
      recordingId,
      trackNumber,
      chunkNumbers: [0, 1],
    });
  }
  const versionId = crypto.randomUUID();
  await finalizeRecording(db, {
    ...actor,
    recordingId,
    versionId,
    tracks: sources.map((_, trackNumber) => ({ trackNumber, chunkCount: 2 })),
    transcription,
  });
  return {
    actor,
    input: {
      accountId: grant.accountId,
      workspaceId: actor.workspaceId,
      recordingId,
      ownerSubjectId: actor.subjectId,
      versionId,
      processingOwner: versionId,
    },
  };
}

function activities(
  storage: ReturnType<typeof memoryStorage>,
  provider: RecordingTranscriptionProvider,
  apiKey: string | null = "key",
  diarizer: RecordingDiarizer | null = null,
  aligner: RecordingWordAligner | null = null,
  now?: () => number,
  startMeetingSummary?: RecordingActivityOptions["startMeetingSummary"],
) {
  const warnings: string[] = [];
  const services = async () =>
    ({
      db: client!.db,
      objectStorage: storage.storage,
      settings: testSettings({ voiceInputFfmpegPath: ffmpegPath }),
      observability: { warn: (message: string) => warnings.push(message), info: () => undefined },
      startRecordingWorkflow: null,
    }) as unknown as ControlActivityServices;
  return {
    warnings,
    activities: createRecordingActivities(services, {
      registry: createRecordingTranscriptionProviderRegistry([provider]),
      loadApiKey: async () => apiKey,
      heartbeat: () => undefined,
      cancellationSignal: () => undefined,
      diarizer: () => diarizer,
      aligner: () => aligner,
      ...(now ? { now } : {}),
      ...(startMeetingSummary ? { startMeetingSummary } : {}),
    }),
  };
}

test("a kept piece answers only the same question: model, options, piece and audio", () => {
  const asked = {
    model: "scribe_v2",
    request: { language: "en", diarize: true, maxSpeakers: undefined, keyterms: ["Vista"] },
    audioSha256: "a".repeat(64),
    startMilliseconds: 0,
    endMilliseconds: 60_000,
    whole: false,
    format: null,
  } as const;
  const key = recordingPieceRequestKey(asked);
  expect(key).toMatch(/^[0-9a-f]{64}$/u);
  expect(recordingPieceRequestKey({ ...asked })).toBe(key);
  for (const changed of [
    { ...asked, model: "scribe_v1" },
    { ...asked, request: { ...asked.request, language: "nb" } },
    { ...asked, request: { ...asked.request, keyterms: [] } },
    { ...asked, audioSha256: "b".repeat(64) },
    { ...asked, startMilliseconds: 30_000 },
    { ...asked, format: "flac" as const },
  ]) {
    expect(recordingPieceRequestKey(changed)).not.toBe(key);
  }
});

test("a transcript's time budget grows with the audio, up to twelve hours", () => {
  const minutes = (value: number) => value * 60_000;
  expect(recordingTranscriptBudgetMilliseconds(0)).toBe(minutes(30));
  // The 51-minute meeting that sat in Transcribing for hours.
  expect(recordingTranscriptBudgetMilliseconds(minutes(51))).toBe(minutes(30 + 153));
  expect(recordingTranscriptBudgetMilliseconds(minutes(600))).toBe(minutes(720));
  expect(recordingTranscriptBudgetMilliseconds(-5)).toBe(minutes(30));
});

describe.skipIf(!hasFfmpeg)("recording transcription activity", () => {
  test("a meeting's ready transcript starts its summary once; a failure is only logged", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const provider = fakeProvider(async () => ({
      languages: ["eng"],
      audioMilliseconds: 2_000,
      diarized: false,
      words: [
        {
          text: "Hello.",
          startMilliseconds: 100,
          endMilliseconds: 400,
          speaker: null,
          spaceBefore: false,
        },
      ],
    }));
    const started: unknown[] = [];
    const ok = activities(
      storage,
      provider,
      "key",
      null,
      null,
      undefined,
      async (_services, input) => {
        started.push(input);
        return { started: true, sessionId: crypto.randomUUID(), model: "codex/test" };
      },
    );
    expect(await ok.activities.transcribeRecordingVersion(recording.input)).toEqual({
      outcome: "complete",
    });
    expect(started).toEqual([
      {
        accountId: recording.input.accountId,
        workspaceId: recording.input.workspaceId,
        recordingId: recording.input.recordingId,
        versionId: recording.input.versionId,
        ownerSubjectId: recording.input.ownerSubjectId,
      },
    ]);
    // The same version again is already complete: no second summary.
    expect(await ok.activities.transcribeRecordingVersion(recording.input)).toEqual({
      outcome: "skipped",
    });
    expect(started).toHaveLength(1);

    const again = crypto.randomUUID();
    await createRecordingTranscriptVersion(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      versionId: again,
      transcription: { providerId: "elevenlabs", model: "scribe_v2", options: {} },
    });
    const failing = activities(storage, provider, "key", null, null, undefined, async () => {
      throw new Error("no account free");
    });
    expect(
      await failing.activities.transcribeRecordingVersion({
        ...recording.input,
        versionId: again,
        processingOwner: again,
      }),
    ).toEqual({ outcome: "complete" });
    expect(failing.warnings).toContain("meeting summary not started");
  });

  test("past its time budget a transcript fails as timed_out, with no audio sent", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    let called = false;
    const provider = fakeProvider(async () => {
      called = true;
      throw new Error("never asked");
    });
    // A retry that starts a day after the meeting was asked to be transcribed.
    const later = () => Date.now() + 24 * 60 * 60_000;
    expect(
      await activities(
        storage,
        provider,
        "key",
        null,
        null,
        later,
      ).activities.transcribeRecordingVersion(recording.input),
    ).toEqual({ outcome: "failed", errorCode: "timed_out" });
    expect(called).toBe(false);
    const [version] = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(version).toMatchObject({ state: "failed", errorCode: "timed_out" });
  });

  test("a provider still working when the budget runs out fails the version as timed_out", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    let called = false;
    let aborted = false;
    // It never answers and ignores the abort, like a stuck alignment step.
    const provider = fakeProvider(async (request) => {
      called = true;
      request.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return await new Promise<never>(() => undefined);
    });
    // A few seconds of the budget are left: enough to prepare the audio.
    const budget = recordingTranscriptBudgetMilliseconds(2_000);
    const nearlyOut = () => Date.now() + budget - 8_000;
    const started = Date.now();
    expect(
      await activities(
        storage,
        provider,
        "key",
        null,
        null,
        nearlyOut,
      ).activities.transcribeRecordingVersion(recording.input),
    ).toEqual({ outcome: "failed", errorCode: "timed_out" });
    expect(Date.now() - started).toBeLessThan(30_000);
    // On a busy machine the budget can run out before the audio is ready;
    // when the provider was asked, it was told to stop.
    if (called) expect(aborted).toBe(true);
    const [version] = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(version).toMatchObject({ state: "failed", errorCode: "timed_out" });
  }, 60_000);

  test("a transcript that answers after its budget ran out is neither charged nor saved", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "elevenlabs",
      model: "scribe_v2",
      options: { language: "en", diarizer: "ours" },
    });
    const charged = { settled: 0 };
    // A deployment-funded model charged in credits answers at once; telling
    // the speakers apart ignores the abort and finishes after the budget.
    const late = fakeProvider(async () => ({
      languages: ["eng"],
      audioMilliseconds: 2_000,
      diarized: false,
      words: [
        {
          text: "Late.",
          startMilliseconds: 100,
          endMilliseconds: 400,
          speaker: null,
          spaceBefore: false,
        },
      ],
    }));
    const slow: RecordingDiarizer = {
      id: "slow",
      diarize: async (_audio, options) => {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          turns: [{ startMilliseconds: 0, endMilliseconds: 2_000, speaker: "S0" }],
          voices: [],
          voiceModel: "test-voices",
        };
      },
    };
    const funded: RecordingTranscriptionProvider = {
      ...late,
      funding: "deployment",
      models: late.models.map((model) => ({
        ...model,
        creditPricing: { microsPerMinute: 10_000 },
      })),
    };
    const budget = recordingTranscriptBudgetMilliseconds(2_000);
    const nearlyOut = () => Date.now() + budget - 6_000;
    const services = async () =>
      ({
        db: client!.db,
        objectStorage: storage.storage,
        settings: testSettings({ voiceInputFfmpegPath: ffmpegPath, usageLimitsMode: "managed" }),
        observability: { warn: () => undefined, info: () => undefined, error: () => undefined },
        startRecordingWorkflow: null,
      }) as unknown as ControlActivityServices;
    const run = createRecordingActivities(services, {
      registry: createRecordingTranscriptionProviderRegistry([funded]),
      loadApiKey: async () => "key",
      heartbeat: () => undefined,
      cancellationSignal: () => undefined,
      diarizer: () => slow,
      aligner: () => null,
      now: nearlyOut,
      billing: () => ({
        admit: async () => undefined,
        settle: async () => {
          charged.settled += 1;
          return { creditCostMicros: 1_000 };
        },
      }),
    });
    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({
      outcome: "failed",
      errorCode: "timed_out",
    });
    // Give the abandoned work time to reach where it would charge and save.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(charged.settled).toBe(0);
    const [version] = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(version).toMatchObject({ state: "failed", errorCode: "timed_out" });
  }, 60_000);

  test("a charged transcript whose save briefly fails past its budget is still saved", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "elevenlabs",
      model: "scribe_v2",
      options: { language: "en" },
    });
    // The version exists by now, so its budget runs out within `window` of this.
    const window = 30_000;
    const outOfTimeAt = Date.now() + window + 500;
    const answered = fakeProvider(async () => ({
      languages: ["eng"],
      audioMilliseconds: 2_000,
      diarized: false,
      words: [
        {
          text: "Saved.",
          startMilliseconds: 100,
          endMilliseconds: 400,
          speaker: null,
          spaceBefore: false,
        },
      ],
    }));
    const funded: RecordingTranscriptionProvider = {
      ...answered,
      funding: "deployment",
      models: answered.models.map((model) => ({
        ...model,
        creditPricing: { microsPerMinute: 10_000 },
      })),
    };
    const budget = recordingTranscriptBudgetMilliseconds(2_000);
    const charged = { settled: 0 };
    const warnings: string[] = [];
    const services = async () =>
      ({
        db: client!.db,
        objectStorage: storage.storage,
        settings: testSettings({ voiceInputFfmpegPath: ffmpegPath, usageLimitsMode: "managed" }),
        observability: {
          warn: (message: string) => warnings.push(message),
          info: () => undefined,
          error: () => undefined,
        },
        startRecordingWorkflow: null,
      }) as unknown as ControlActivityServices;
    let saves = 0;
    const run = createRecordingActivities(services, {
      registry: createRecordingTranscriptionProviderRegistry([funded]),
      loadApiKey: async () => "key",
      heartbeat: () => undefined,
      cancellationSignal: () => undefined,
      diarizer: () => null,
      aligner: () => null,
      now: () => Date.now() + budget - window,
      saveRetryDelaysMilliseconds: [0, 0, 0],
      startMeetingSummary: async () => ({ started: false, reason: "test" }),
      // The database drops the first two saves, the first one only once the
      // budget has run out.
      saveTranscript: async (db, version) => {
        saves += 1;
        if (saves === 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, outOfTimeAt - Date.now())),
          );
        }
        if (saves <= 2) throw new Error("connection terminated unexpectedly");
        return completeRecordingTranscriptVersion(db, version);
      },
      billing: () => ({
        admit: async () => undefined,
        settle: async () => {
          charged.settled += 1;
          return { creditCostMicros: 1_000 };
        },
      }),
    });
    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({ outcome: "complete" });
    expect(saves).toBe(3);
    expect(charged.settled).toBe(1);
    expect(warnings.filter((message) => message.includes("trying again"))).toHaveLength(2);
    const [version] = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(version).toMatchObject({ state: "complete", errorCode: null });
  }, 60_000);

  test("a charged transcript whose save keeps failing is left to retry, never failed", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "elevenlabs",
      model: "scribe_v2",
      options: { language: "en" },
    });
    const answered = fakeProvider(async () => ({
      languages: ["eng"],
      audioMilliseconds: 2_000,
      diarized: false,
      words: [
        {
          text: "Kept.",
          startMilliseconds: 100,
          endMilliseconds: 400,
          speaker: null,
          spaceBefore: false,
        },
      ],
    }));
    const services = async () =>
      ({
        db: client!.db,
        objectStorage: storage.storage,
        settings: testSettings({ voiceInputFfmpegPath: ffmpegPath }),
        observability: { warn: () => undefined, info: () => undefined, error: () => undefined },
        startRecordingWorkflow: null,
      }) as unknown as ControlActivityServices;
    let saves = 0;
    const run = createRecordingActivities(services, {
      registry: createRecordingTranscriptionProviderRegistry([answered]),
      loadApiKey: async () => "key",
      heartbeat: () => undefined,
      cancellationSignal: () => undefined,
      diarizer: () => null,
      aligner: () => null,
      saveRetryDelaysMilliseconds: [0, 0],
      startMeetingSummary: async () => ({ started: false, reason: "test" }),
      saveTranscript: async () => {
        saves += 1;
        throw new Error("connection terminated unexpectedly");
      },
    });
    await expect(run.transcribeRecordingVersion(recording.input)).rejects.toThrow(
      "connection terminated unexpectedly",
    );
    expect(saves).toBe(3);
    const [version] = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(version?.state).not.toBe("failed");
  }, 60_000);

  test("prepares each track, diarizes every track and names the microphone's one voice after the person recording", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const calls: RecordingTranscriptionRequest[] = [];
    const preparedAtCall: number[] = [];
    const provider = fakeProvider(async (request) => {
      calls.push(request);
      preparedAtCall.push(
        [...storage.objects.keys()].filter((key) => key.includes("/prepared/")).length,
      );
      const microphone = request.audio.fileName === "track-0.webm";
      return {
        languages: ["eng"],
        audioMilliseconds: 2_000,
        diarized: !microphone,
        words: microphone
          ? [
              {
                text: "Hello",
                startMilliseconds: 100,
                endMilliseconds: 400,
                speaker: null,
                spaceBefore: false,
              },
              {
                text: "team.",
                startMilliseconds: 450,
                endMilliseconds: 800,
                speaker: null,
                spaceBefore: true,
              },
            ]
          : [
              {
                text: "Hi",
                startMilliseconds: 900,
                endMilliseconds: 1_100,
                speaker: "speaker_1",
                spaceBefore: false,
              },
              {
                text: "Yes",
                startMilliseconds: 1_300,
                endMilliseconds: 1_500,
                speaker: "speaker_0",
                spaceBefore: true,
              },
            ],
      };
    });
    const { activities: run } = activities(storage, provider);
    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({ outcome: "complete" });

    expect(calls.map((call) => [call.audio.fileName, call.diarize, call.language])).toEqual([
      ["track-0.webm", true, "en"],
      ["track-1.webm", true, "en"],
    ]);
    // The whole meeting can play before the first track is transcribed.
    expect(preparedAtCall).toEqual([2, 2]);
    const prepared = [...storage.objects.keys()].filter((key) => key.includes("/prepared/"));
    expect(prepared.sort()).toEqual([
      `workspaces/${recording.actor.workspaceId}/recordings/${recording.input.recordingId}/prepared/track-0.timeline.webm`,
      `workspaces/${recording.actor.workspaceId}/recordings/${recording.input.recordingId}/prepared/track-1.timeline.webm`,
    ]);
    const stored = await getRecording(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(stored.state).toBe("ready");
    expect(stored.tracks.every((track) => track.playable)).toBe(true);
    const page = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(page.version.diarization).toBe("provider");
    expect(page.version.costUsd).toBeGreaterThan(0);
    expect(page.segments.map((segment) => [segment.speakerLabel, segment.text])).toEqual([
      ["track-0", "Hello team."],
      ["speaker_0", "Hi"],
      ["speaker_1", "Yes"],
    ]);
    // Beside the computer audio, the microphone is the person recording.
    const [me] = await listRecordingPeople(client.db, recording.actor);
    expect(me).toMatchObject({
      displayName: "Ingrid Solberg",
      memberSubjectId: recording.actor.subjectId,
      voice: null,
    });
    expect(page.speakers.find((speaker) => speaker.label === "track-0")).toMatchObject({
      name: "Ingrid Solberg",
      personId: me!.id,
      source: "track",
    });

    // A file prepared under the old name (before tracks kept their timeline)
    // is built again, and the old file is removed.
    const prefix = `workspaces/${recording.actor.workspaceId}/recordings/${recording.input.recordingId}/prepared/`;
    const current = storage.objects.get(`${prefix}track-1.timeline.webm`)!;
    storage.objects.delete(`${prefix}track-1.timeline.webm`);
    storage.objects.set(`${prefix}track-1.webm`, current);
    await setRecordingTrackPrepared(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      trackNumber: 1,
      objectKey: `${prefix}track-1.webm`,
      bytes: current.bytes.byteLength,
      durationMilliseconds: 2_000,
    });
    const rebuilt = crypto.randomUUID();
    await createRecordingTranscriptVersion(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      versionId: rebuilt,
      transcription: { providerId: "elevenlabs", model: "scribe_v2", options: {} },
    });
    expect(
      await run.transcribeRecordingVersion({
        ...recording.input,
        versionId: rebuilt,
        processingOwner: rebuilt,
      }),
    ).toEqual({ outcome: "complete" });
    expect([...storage.objects.keys()].filter((key) => key.startsWith(prefix)).sort()).toEqual([
      `${prefix}track-0.timeline.webm`,
      `${prefix}track-1.timeline.webm`,
    ]);

    // A re-run reuses the prepared audio rather than rebuilding it.
    const second = crypto.randomUUID();
    await createRecordingTranscriptVersion(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      versionId: second,
      transcription: { providerId: "elevenlabs", model: "scribe_v2", options: {} },
    });
    for (const key of storage.objects.keys()) {
      if (!key.includes("/prepared/")) storage.objects.delete(key);
    }
    expect(
      await run.transcribeRecordingVersion({
        ...recording.input,
        versionId: second,
        processingOwner: second,
      }),
    ).toEqual({ outcome: "complete" });
    expect(calls).toHaveLength(6);
  });

  test("the computer's audio, silent through a room meeting, is never sent or billed", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, undefined, ["microphone", "system"], [1]);
    const sent: string[] = [];
    const provider = fakeProvider(async (request) => {
      sent.push(request.audio.fileName);
      return {
        languages: ["eng"],
        audioMilliseconds: 2_000,
        diarized: false,
        words: [
          {
            text: "Hello.",
            startMilliseconds: 100,
            endMilliseconds: 400,
            speaker: null,
            spaceBefore: false,
          },
        ],
      };
    });
    const { activities: run } = activities(storage, provider);
    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({ outcome: "complete" });
    expect(sent).toEqual(["track-0.webm"]);
    const page = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(page.segments.map((segment) => [segment.trackNumber, segment.text])).toEqual([
      [0, "Hello."],
    ]);
    // The model is paid for the microphone's two seconds, not the silent track's.
    expect(page.version.costUsd).toBeGreaterThan(0);
    expect(page.version.costUsd!).toBeLessThan((0.22 * 3) / 3_600);
  });

  test("a microphone alone may be a whole room, so its speakers are told apart and nobody is assumed", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, undefined, ["microphone"]);
    const provider = fakeProvider(async () => ({
      languages: ["eng"],
      audioMilliseconds: 2_000,
      diarized: true,
      words: [
        {
          text: "Hi",
          startMilliseconds: 100,
          endMilliseconds: 400,
          speaker: "a",
          spaceBefore: false,
        },
        {
          text: "Yes",
          startMilliseconds: 900,
          endMilliseconds: 1_200,
          speaker: "b",
          spaceBefore: true,
        },
      ],
    }));
    const { activities: run } = activities(storage, provider);
    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({ outcome: "complete" });
    const page = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(page.speakers.map((speaker) => [speaker.label, speaker.name, speaker.source])).toEqual([
      ["speaker_0", "Speaker 1", null],
      ["speaker_1", "Speaker 2", null],
    ]);
    expect(await listRecordingPeople(client.db, recording.actor)).toEqual([]);
  });

  test("our diarizer names the speakers when asked, and the model's stay if it fails", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const word = (text: string, start: number, speaker: string | null) => ({
      text,
      startMilliseconds: start,
      endMilliseconds: start + 200,
      speaker,
      spaceBefore: true,
    });
    const provider = fakeProvider(async (request) => ({
      languages: ["eng"],
      audioMilliseconds: 2_000,
      diarized: request.diarize,
      words:
        request.audio.fileName === "track-0.webm"
          ? [word("Hello", 100, null)]
          : [word("Hi", 900, "speaker_0"), word("Yes", 1_300, "speaker_0")],
    }));
    const diarized: string[] = [];
    const ours: RecordingDiarizer = {
      id: "test",
      diarize: async (audio) => {
        diarized.push(audio.fileName);
        return {
          turns: [
            { startMilliseconds: 800, endMilliseconds: 1_200, speaker: "S0" },
            { startMilliseconds: 1_250, endMilliseconds: 1_600, speaker: "S1" },
          ],
          voices: [
            { speaker: "S1", speechMilliseconds: 5_000, embedding: [0, 1, 0] },
            { speaker: "S0", speechMilliseconds: 6_000, embedding: [1, 0, 0] },
          ],
          voiceModel: "test-voices",
        };
      },
    };
    const version = async (diarizer: "ours") => {
      const versionId = crypto.randomUUID();
      await createRecordingTranscriptVersion(client!.db, {
        ...recording.actor,
        recordingId: recording.input.recordingId,
        versionId,
        transcription: { providerId: "elevenlabs", model: "scribe_v2", options: { diarizer } },
      });
      return { ...recording.input, versionId, processingOwner: versionId };
    };
    const page = async (versionId: string) =>
      await getRecordingTranscriptPage(client!.db, {
        ...recording.actor,
        recordingId: recording.input.recordingId,
        versionId,
      });

    // `auto` (the default) with a model that diarizes leaves ours unused.
    await activities(storage, provider, "key", ours).activities.transcribeRecordingVersion(
      recording.input,
    );
    expect(diarized).toEqual([]);
    expect((await page(recording.input.versionId)).version.diarization).toBe("provider");

    // Asked for ours: every track goes through it, the microphone too.
    const first = await version("ours");
    expect(
      await activities(storage, provider, "key", ours).activities.transcribeRecordingVersion(first),
    ).toEqual({ outcome: "complete" });
    expect(diarized.sort()).toEqual(["track-0.webm", "track-1.webm"]);
    const mine = await page(first.versionId);
    expect(mine.version.diarization).toBe("ours");
    expect(mine.segments.map((segment) => [segment.speakerLabel, segment.text])).toEqual([
      ["track-0", "Hello"],
      ["speaker_0", "Hi"],
      ["speaker_1", "Yes"],
    ]);

    // Ours failing falls back to the model's own speakers.
    const broken: RecordingDiarizer = {
      id: "broken",
      diarize: async () => {
        throw new Error("no models");
      },
    };
    const third = await version("ours");
    const run = activities(storage, provider, "key", broken);
    const stored = async (versionId: string) =>
      await shared!.admin<{ label: string; channel: string; model: string }[]>`
        select speaker_label as label, channel, model from recording_speaker_voices
        where version_id = ${versionId} order by speaker_label`;
    // Voices are kept only while the workspace recognizes them.
    expect(await stored(first.versionId)).toEqual([]);
    expect(await run.activities.transcribeRecordingVersion(third)).toEqual({ outcome: "complete" });
    expect(run.warnings).toContain("our diarizer failed; using the model's speakers");
    const fallback = await page(third.versionId);
    expect(fallback.version.diarization).toBe("provider");
    expect(fallback.segments.map((segment) => segment.speakerLabel)).toEqual([
      "track-0",
      "speaker_0",
    ]);

    // Recognizing voices uses ours even on `auto`, and keeps each speaker's
    // voice under the label it has in the transcript.
    await updateWorkspaceSettings(client.db, recording.actor.workspaceId, {
      recordings: { voiceprints: true },
    });
    const fourth = crypto.randomUUID();
    await createRecordingTranscriptVersion(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      versionId: fourth,
      transcription: { providerId: "elevenlabs", model: "scribe_v2", options: {} },
    });
    diarized.length = 0;
    expect(
      await activities(storage, provider, "key", ours).activities.transcribeRecordingVersion({
        ...recording.input,
        versionId: fourth,
        processingOwner: fourth,
      }),
    ).toEqual({ outcome: "complete" });
    expect(diarized.sort()).toEqual(["track-0.webm", "track-1.webm"]);
    expect(await stored(fourth)).toEqual([
      { label: "speaker_0", channel: "call", model: "test-voices" },
      { label: "speaker_1", channel: "call", model: "test-voices" },
      { label: "track-0", channel: "microphone", model: "test-voices" },
    ]);
  });

  test("the person recording is found among the voices on their own microphone", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "elevenlabs",
      model: "scribe_v2",
      options: { diarizer: "ours" },
    });
    const word = (text: string, start: number, end: number) => ({
      text,
      startMilliseconds: start,
      endMilliseconds: end,
      speaker: null,
      spaceBefore: true,
    });
    const provider = fakeProvider(async (request) => ({
      languages: ["nor"],
      audioMilliseconds: 2_000,
      diarized: false,
      words:
        request.audio.fileName === "track-0.webm"
          ? [word("Hei.", 100, 300), word("Velkommen", 600, 1_100), word("hit.", 1_150, 1_500)]
          : [word("Hallo.", 1_600, 1_900)],
    }));
    // Someone in the room says a word; the person recording says the most.
    const ours: RecordingDiarizer = {
      id: "test",
      diarize: async (audio) =>
        audio.fileName === "track-0.webm"
          ? {
              turns: [
                { startMilliseconds: 0, endMilliseconds: 400, speaker: "A" },
                { startMilliseconds: 500, endMilliseconds: 1_600, speaker: "B" },
              ],
              voices: [
                { speaker: "A", speechMilliseconds: 5_000, embedding: [1, 0, 0] },
                { speaker: "B", speechMilliseconds: 6_000, embedding: [0, 1, 0] },
              ],
              voiceModel: "test-voices",
            }
          : {
              turns: [{ startMilliseconds: 1_500, endMilliseconds: 2_000, speaker: "A" }],
              voices: [{ speaker: "A", speechMilliseconds: 5_000, embedding: [0, 0, 1] }],
              voiceModel: "test-voices",
            },
    };
    const run = activities(storage, provider, "key", ours).activities;
    const transcript = async (versionId: string) => {
      const page = await getRecordingTranscriptPage(client!.db, {
        ...recording.actor,
        recordingId: recording.input.recordingId,
        versionId,
      });
      return page.segments.map((segment) => [
        segment.speakerLabel,
        page.speakers.find((speaker) => speaker.label === segment.speakerLabel)?.name,
        segment.text,
      ]);
    };

    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({ outcome: "complete" });
    expect(await transcript(recording.input.versionId)).toEqual([
      ["speaker_0", "Speaker 1", "Hei."],
      ["track-0", "Ingrid Solberg", "Velkommen hit."],
      ["speaker_1", "Speaker 2", "Hallo."],
    ]);

    // With voice recognition on, their remembered voice picks theirs, even
    // when someone else on the microphone spoke more.
    await updateWorkspaceSettings(client.db, recording.actor.workspaceId, {
      recordings: { voiceprints: true },
    });
    const [me] = await listRecordingPeople(client.db, recording.actor);
    await rememberRecordingPersonVoice(client.db, {
      ...recording.actor,
      personId: me!.id,
      consent: "self",
    });
    await shared!.admin`
      insert into recording_voiceprints
        (account_id, workspace_id, person_id, channel, model, embedding, speech_milliseconds, sample_count)
      values (${recording.input.accountId}, ${recording.actor.workspaceId}, ${me!.id},
        'microphone', 'test-voices', '{0.9,0.1,0}'::real[], 60000, 3)`;
    const second = crypto.randomUUID();
    await createRecordingTranscriptVersion(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      versionId: second,
      transcription: { providerId: "elevenlabs", model: "scribe_v2", options: {} },
    });
    expect(
      await run.transcribeRecordingVersion({
        ...recording.input,
        versionId: second,
        processingOwner: second,
      }),
    ).toEqual({ outcome: "complete" });
    expect(await transcript(second)).toEqual([
      ["track-0", "Ingrid Solberg", "Hei."],
      ["speaker_0", "Speaker 1", "Velkommen hit."],
      ["speaker_1", "Speaker 2", "Hallo."],
    ]);
  });

  test("the call heard from the speakers doesn't become someone on the microphone", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "elevenlabs",
      model: "scribe_v2",
      options: { diarizer: "ours" },
    });
    await updateWorkspaceSettings(client.db, recording.actor.workspaceId, {
      recordings: { voiceprints: true },
    });
    const word = (text: string, start: number, end: number) => ({
      text,
      startMilliseconds: start,
      endMilliseconds: end,
      speaker: null,
      spaceBefore: true,
    });
    // No headphones: the microphone hears the call a little late, and one
    // misheard word of it ("gave") matches nothing in computer audio.
    const provider = fakeProvider(async (request) => ({
      languages: ["nor"],
      audioMilliseconds: 4_000,
      diarized: false,
      words:
        request.audio.fileName === "track-0.webm"
          ? [
              word("Takk.", 100, 400),
              word("vi", 1_100, 1_600),
              word("kommer", 1_600, 2_100),
              word("på", 2_100, 2_600),
              word("mandag", 2_600, 3_100),
              word("gave", 3_200, 3_600),
            ]
          : [
              word("Vi", 1_000, 1_500),
              word("kommer", 1_500, 2_000),
              word("på", 2_000, 2_500),
              word("mandag.", 2_500, 3_000),
            ],
    }));
    // Our diarizer hears the speakers' sound as a voice of its own on the
    // microphone; what the echo left of it outlasts the person recording.
    const ours: RecordingDiarizer = {
      id: "test",
      diarize: async (audio) =>
        audio.fileName === "track-0.webm"
          ? {
              turns: [
                { startMilliseconds: 0, endMilliseconds: 500, speaker: "A" },
                { startMilliseconds: 1_000, endMilliseconds: 3_700, speaker: "E" },
              ],
              voices: [
                { speaker: "A", speechMilliseconds: 5_000, embedding: [1, 0, 0] },
                { speaker: "E", speechMilliseconds: 6_000, embedding: [0, 1, 0] },
              ],
              voiceModel: "test-voices",
            }
          : {
              turns: [{ startMilliseconds: 900, endMilliseconds: 3_100, speaker: "S" }],
              voices: [{ speaker: "S", speechMilliseconds: 6_000, embedding: [0, 0.9, 0.1] }],
              voiceModel: "test-voices",
            },
    };
    expect(
      await activities(storage, provider, "key", ours).activities.transcribeRecordingVersion(
        recording.input,
      ),
    ).toEqual({ outcome: "complete" });
    const page = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      versionId: recording.input.versionId,
    });
    expect(
      page.segments.map((segment) => [
        segment.speakerLabel,
        page.speakers.find((speaker) => speaker.label === segment.speakerLabel)?.name,
        segment.text,
      ]),
    ).toEqual([
      ["track-0", "Ingrid Solberg", "Takk."],
      ["speaker_0", "Speaker 1", "Vi kommer på mandag."],
    ]);
    // The echo keeps no voice of its own to suggest or learn from.
    expect(
      await shared!.admin<{ label: string; channel: string }[]>`
        select speaker_label as label, channel from recording_speaker_voices
        where version_id = ${recording.input.versionId} order by speaker_label`,
    ).toEqual([
      { label: "speaker_0", channel: "call" },
      { label: "track-0", channel: "microphone" },
    ]);
  });

  test("a missing key fails the version; a provider outage is retried", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const outage = fakeProvider(async () => {
      throw new RecordingTranscriptionError("down", "unavailable", true);
    });
    await expect(
      activities(storage, outage).activities.transcribeRecordingVersion(recording.input),
    ).rejects.toMatchObject({ type: "provider_unavailable" });
    // The same workflow takes its lease back on the next attempt.
    expect(
      await activities(storage, outage, null).activities.transcribeRecordingVersion(
        recording.input,
      ),
    ).toEqual({ outcome: "failed", errorCode: "missing_provider_key" });
    const [version] = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(version).toMatchObject({ state: "failed", errorCode: "missing_provider_key" });
  });

  test("a worker stopping mid-transcript is retried, never failed", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "elevenlabs",
      model: "scribe_v2",
      options: { language: "en", diarizer: "ours" },
    });
    const provider = fakeProvider(async () => ({
      languages: ["eng"],
      audioMilliseconds: 1_000,
      diarized: false,
      words: [],
    }));
    // The speaker models killed with the worker: our speakers aren't
    // quietly dropped for the model's, the attempt is run again.
    const killed: RecordingDiarizer = {
      id: "test-cpu",
      diarize: async () => {
        throw new RecordingSpeakersError("speaker detection was stopped", true);
      },
    };
    await expect(
      activities(storage, provider, "key", killed).activities.transcribeRecordingVersion(
        recording.input,
      ),
    ).rejects.toMatchObject({ type: "interrupted", nonRetryable: false });
    // Temporal cancelled the attempt for the worker's shutdown: whatever that
    // broke (here the provider call), it is an interruption.
    const stopping = new AbortController();
    stopping.abort(new Error("WORKER_SHUTDOWN"));
    const services = async () =>
      ({
        db: client!.db,
        objectStorage: storage.storage,
        settings: testSettings({ voiceInputFfmpegPath: ffmpegPath }),
        observability: { warn: () => undefined, info: () => undefined },
        startRecordingWorkflow: null,
      }) as unknown as ControlActivityServices;
    const cancelled = createRecordingActivities(services, {
      registry: createRecordingTranscriptionProviderRegistry([
        fakeProvider(async () => {
          throw new RecordingTranscriptionError("aborted", "invalid_audio", false);
        }),
      ]),
      loadApiKey: async () => "key",
      heartbeat: () => undefined,
      cancellationSignal: () => stopping.signal,
      diarizer: () => null,
      aligner: () => null,
    });
    await expect(cancelled.transcribeRecordingVersion(recording.input)).rejects.toMatchObject({
      type: "interrupted",
    });
    const versions = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(versions.map((version) => version.state)).not.toContain("failed");
  });

  test("a retry asks the provider afresh, under a request identity no attempt used", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    // Like a subscription provider: one request identity is sent at most once.
    const sent = new Set<string>();
    let lost = true;
    const provider = fakeProvider(async (request) => {
      const identity = request.scope!.requestId;
      if (sent.has(identity)) {
        throw new RecordingTranscriptionError("already sent", "network", true);
      }
      sent.add(identity);
      // The first attempt's worker goes away mid-meeting.
      if (lost) throw new RecordingTranscriptionError("lost", "network", true);
      return {
        languages: ["eng"],
        audioMilliseconds: 2_000,
        diarized: false,
        words: [
          {
            text: "Again.",
            startMilliseconds: 100,
            endMilliseconds: 400,
            speaker: null,
            spaceBefore: false,
          },
        ],
      };
    });
    await expect(
      activities(storage, provider).activities.transcribeRecordingVersion(recording.input),
    ).rejects.toMatchObject({ type: "provider_network" });
    lost = false;
    expect(
      await activities(storage, provider).activities.transcribeRecordingVersion(recording.input),
    ).toEqual({ outcome: "complete" });
    expect([...sent]).toEqual([
      `${recording.input.versionId}:a1:0`,
      `${recording.input.versionId}:a2:0`,
      `${recording.input.versionId}:a2:1`,
    ]);
  });

  test("a retry reuses each track an earlier attempt was already answered for, and pays once", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const sent: string[] = [];
    let lost = true;
    const provider = fakeProvider(async (request) => {
      const identity = request.scope!.requestId;
      sent.push(identity);
      // The worker goes away after the first track came back.
      if (lost && identity.endsWith(":1")) {
        throw new RecordingTranscriptionError("lost", "network", true);
      }
      return {
        languages: ["eng"],
        audioMilliseconds: 2_000,
        diarized: false,
        words: [
          {
            text: identity.endsWith(":0") ? "First." : "Second.",
            startMilliseconds: 100,
            endMilliseconds: 400,
            speaker: null,
            spaceBefore: false,
          },
        ],
      };
    });
    const first = activities(storage, provider);
    await expect(
      first.activities.transcribeRecordingVersion(recording.input),
    ).rejects.toMatchObject({
      type: "provider_network",
    });
    expect(first.warnings).toEqual([]);
    lost = false;
    expect(
      await activities(storage, provider).activities.transcribeRecordingVersion(recording.input),
    ).toEqual({ outcome: "complete" });
    // The first track was heard once; only the lost one is asked again.
    expect(sent).toEqual([
      `${recording.input.versionId}:a1:0`,
      `${recording.input.versionId}:a1:1`,
      `${recording.input.versionId}:a2:1`,
    ]);
    const page = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(page.segments.map((segment) => segment.text).sort()).toEqual(["First.", "Second."]);
    // A finished version keeps nothing for retries.
    const kept = await client.db.execute(
      sql`SELECT count(*)::int AS kept FROM recording_transcript_piece_results WHERE version_id = ${recording.input.versionId}`,
    );
    expect(kept).toEqual([{ kept: 0 }]);
  });

  test("a meeting can't use a model that returns only text, and sends it no audio", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "codex-subscription",
      model: "chatgpt-dictation",
      options: {},
    });
    let heard = 0;
    const subscription: RecordingTranscriptionProvider = {
      id: "codex-subscription",
      name: "ChatGPT subscription",
      funding: "workspace_subscription",
      available: () => true,
      models: [
        {
          model: "chatgpt-dictation",
          name: "ChatGPT dictation",
          usdPerHour: 0,
          capabilities: textModelCapabilities({ maxDurationSeconds: 600, maxFileBytes: null }),
        },
      ],
      transcribe: async () => {
        heard += 1;
        return { languages: [], audioMilliseconds: null, diarized: false, words: [], text: "" };
      },
    };
    const run = activities(storage, subscription, null).activities;
    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({
      outcome: "failed",
      errorCode: "model_unavailable",
    });
    expect(heard).toBe(0);
  });

  test("our aligner times a text-only model's words, and our diarizer names their speakers", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "codex-subscription",
      model: "chatgpt-dictation",
      options: {},
    });
    const subscription: RecordingTranscriptionProvider = {
      id: "codex-subscription",
      name: "ChatGPT subscription",
      funding: "workspace_subscription",
      available: () => true,
      models: [
        {
          model: "chatgpt-dictation",
          name: "ChatGPT dictation",
          usdPerHour: 0,
          capabilities: textModelCapabilities({ maxDurationSeconds: 600, maxFileBytes: null }),
        },
      ],
      transcribe: async (request) => ({
        languages: [],
        audioMilliseconds: null,
        diarized: false,
        words: [],
        text: request.audio.fileName === "track-0.webm" ? " Hello there " : "Hi. Yes!",
      }),
    };
    const aligned: Array<{ fileName: string; words: readonly string[] }> = [];
    const aligner: RecordingWordAligner = {
      id: "test-aligner",
      align: async (audio, words) => {
        aligned.push({ fileName: audio.fileName, words });
        return {
          words: words.map((_, index) => ({
            startMilliseconds: 200 + index * 600,
            endMilliseconds: 600 + index * 600,
            score: -1,
          })),
          anchoredWords: 0,
          spreadWords: 0,
          untimedWords: 0,
        };
      },
    };
    const ours: RecordingDiarizer = {
      id: "test",
      // The microphone holds only the person recording.
      diarize: async (audio) => ({
        voiceModel: "test-voices",
        turns:
          audio.fileName === "track-0.webm"
            ? [{ startMilliseconds: 0, endMilliseconds: 2_000, speaker: "A" }]
            : [
                { startMilliseconds: 0, endMilliseconds: 700, speaker: "A" },
                { startMilliseconds: 700, endMilliseconds: 2_000, speaker: "B" },
              ],
        voices: [],
      }),
    };
    const run = activities(storage, subscription, null, ours, aligner).activities;
    expect(await run.transcribeRecordingVersion(recording.input)).toEqual({ outcome: "complete" });
    expect(aligned).toEqual([
      { fileName: "track-0.webm", words: ["Hello", "there"] },
      { fileName: "track-1.webm", words: ["Hi.", "Yes!"] },
    ]);
    const transcript = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(transcript.version.diarization).toBe("ours");
    expect(
      transcript.segments.map((segment) => [
        segment.speakerLabel,
        segment.text,
        segment.startMilliseconds,
      ]),
    ).toEqual([
      ["track-0", "Hello there", 200],
      ["speaker_0", "Hi.", 200],
      ["speaker_1", "Yes!", 800],
    ]);
  });

  test("a text-only model's answer is kept before its words are placed, so a lost aligner doesn't ask again", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "codex-subscription",
      model: "chatgpt-dictation",
      options: {},
    });
    const asked: string[] = [];
    const subscription: RecordingTranscriptionProvider = {
      id: "codex-subscription",
      name: "ChatGPT subscription",
      funding: "workspace_subscription",
      available: () => true,
      models: [
        {
          model: "chatgpt-dictation",
          name: "ChatGPT dictation",
          usdPerHour: 0,
          capabilities: textModelCapabilities({ maxDurationSeconds: 600, maxFileBytes: null }),
        },
      ],
      transcribe: async (request) => {
        asked.push(request.audio.fileName);
        return {
          languages: [],
          audioMilliseconds: null,
          diarized: false,
          words: [],
          text: "Hello there",
        };
      },
    };
    let lost = true;
    const aligner: RecordingWordAligner = {
      id: "test-aligner",
      align: async (_audio, words) => {
        // The worker goes away while it places the first track's words.
        if (lost) throw new Error("worker lost");
        return {
          words: words.map((_, index) => ({
            startMilliseconds: 200 + index * 600,
            endMilliseconds: 600 + index * 600,
            score: -1,
          })),
          anchoredWords: 0,
          spreadWords: 0,
          untimedWords: 0,
        };
      },
    };
    await expect(
      activities(storage, subscription, null, null, aligner).activities.transcribeRecordingVersion(
        recording.input,
      ),
    ).rejects.toThrow("worker lost");
    lost = false;
    expect(
      await activities(
        storage,
        subscription,
        null,
        null,
        aligner,
      ).activities.transcribeRecordingVersion(recording.input),
    ).toEqual({ outcome: "complete" });
    // The first track was asked once; the retry placed its kept words.
    expect(asked).toEqual(["track-0.webm", "track-1.webm"]);
    const transcript = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(transcript.segments.every((segment) => segment.startMilliseconds === 200)).toBe(true);
  });

  test("deletion removes every object of the recording, then its rows", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const { activities: run } = activities(
      storage,
      fakeProvider(async () => ({
        languages: [],
        audioMilliseconds: 0,
        diarized: false,
        words: [],
      })),
    );
    await run.transcribeRecordingVersion(recording.input);
    expect(storage.objects.size).toBe(6);
    expect(await run.deleteRecordingMedia(recording.input)).toEqual({ deleted: 0, purged: false });
    await markRecordingDeleting(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(await run.deleteRecordingMedia(recording.input)).toEqual({ deleted: 6, purged: true });
    expect(storage.objects.size).toBe(0);
    expect(await run.deleteRecordingMedia(recording.input)).toEqual({ deleted: 0, purged: false });
  });
});

async function capturedDictation(
  storage: ReturnType<typeof memoryStorage>,
  seconds = 3,
  options: { language?: string; keyterms?: string[] } = {},
) {
  const db = client!.db;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "recording-activities",
    accountExternalId: suffix,
    accountName: "Dictation activities",
    workspaceExternalSource: "recording-activities",
    workspaceExternalId: suffix,
    workspaceName: "Dictation activities",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const actor = { workspaceId: grant.workspaceId!, subjectId: grant.subjectId };
  const recordingId = crypto.randomUUID();
  await createRecording(db, {
    ...actor,
    accountId: grant.accountId,
    recordingId,
    purpose: "dictation",
    // Asking to share is ignored: a dictation is only ever its owner's.
    visibility: "workspace",
    tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm;codecs=opus" }],
  });
  const audio = opusWebm(seconds, 440);
  const [row] = await reserveRecordingChunks(db, {
    ...actor,
    recordingId,
    trackNumber: 0,
    chunks: [
      {
        chunkNumber: 0,
        byteLength: audio.length,
        sha256: createHash("sha256").update(audio).digest("hex"),
        startMilliseconds: 0,
        durationMilliseconds: seconds * 1_000,
      },
    ],
  });
  storage.objects.set(row!.objectKey, { bytes: audio, contentType: "audio/webm" });
  await markRecordingChunksUploaded(db, {
    ...actor,
    recordingId,
    trackNumber: 0,
    chunkNumbers: [0],
  });
  const versionId = crypto.randomUUID();
  await finalizeRecording(db, {
    ...actor,
    recordingId,
    versionId,
    tracks: [{ trackNumber: 0, chunkCount: 1 }],
    transcription: {
      providerId: "voice-one",
      model: "voice-input",
      options,
      creditAttribution: { kind: "human", initiatingHumanSubjectId: actor.subjectId },
    },
  });
  return {
    actor,
    input: {
      accountId: grant.accountId,
      workspaceId: actor.workspaceId,
      recordingId,
      ownerSubjectId: actor.subjectId,
      versionId,
      processingOwner: versionId,
    },
  };
}

function dictationActivities(
  storage: ReturnType<typeof memoryStorage>,
  transcribe: TranscriptionService["transcribe"],
) {
  const services = async () =>
    ({
      db: client!.db,
      objectStorage: storage.storage,
      settings: testSettings({ voiceInputFfmpegPath: ffmpegPath }),
      observability: { warn: () => undefined, info: () => undefined },
      startRecordingWorkflow: null,
    }) as unknown as ControlActivityServices;
  const service: TranscriptionService = {
    limits: () => ({ maxDurationSeconds: 600, maxSizeBytes: 25_000_000, acceptedMimeTypes: [] }),
    available: () => true,
    transcribe,
  };
  return createRecordingActivities(services, {
    registry: createRecordingTranscriptionProviderRegistry([]),
    loadApiKey: async () => null,
    heartbeat: () => undefined,
    cancellationSignal: () => undefined,
    diarizer: () => null,
    dictationTranscription: () => service,
  });
}

describe.skipIf(!hasFfmpeg)("dictation transcription activity", () => {
  test("voice input hears a dictation once per piece, billed to who asked, then it expires", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const dictation = await capturedDictation(storage);
    const calls: TranscriptionRequest[] = [];
    const run = dictationActivities(storage, async (request) => {
      calls.push(request);
      return {
        text: " Remember to send the numbers. ",
        languages: ["en"],
        providerId: "voice-one",
        audioSeconds: 3,
        latencyMs: 5,
        creditCostMicros: 1_200,
      };
    });
    expect(await run.transcribeRecordingVersion(dictation.input)).toEqual({
      outcome: "complete",
      expireAfterMilliseconds: DICTATION_RETENTION_MILLISECONDS,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      mimeType: "audio/wav",
      preferredProvider: "voice-one",
      subjectId: dictation.actor.subjectId,
      billing: {
        sourceId: `${dictation.input.recordingId}:${dictation.input.versionId}:0`,
        attribution: { kind: "human", initiatingHumanSubjectId: dictation.actor.subjectId },
      },
    });
    expect(calls[0]!.billing!.trustedDurationSeconds).toBeGreaterThan(2);
    // No language was named, so the provider detects it.
    expect(calls[0]!.language).toBeUndefined();

    const stored = await getRecording(client.db, {
      ...dictation.actor,
      recordingId: dictation.input.recordingId,
    });
    expect(stored).toMatchObject({ purpose: "dictation", visibility: "private", state: "ready" });
    const page = await getRecordingTranscriptPage(client.db, {
      ...dictation.actor,
      recordingId: dictation.input.recordingId,
    });
    expect(page.version).toMatchObject({ diarization: "none", languages: ["en"] });
    expect(page.segments.map((segment) => [segment.speakerLabel, segment.text])).toEqual([
      [null, "Remember to send the numbers."],
    ]);
    // Its prepared audio is never stored: the text doesn't wait on a write.
    expect([...storage.objects.keys()].filter((key) => key.includes("/prepared/"))).toEqual([]);
    expect(stored.tracks.every((track) => !track.playable)).toBe(true);

    // The day is up: the dictation and its audio go.
    expect(storage.objects.size).toBeGreaterThan(0);
    expect(await run.expireDictation(dictation.input)).toMatchObject({ purged: true });
    expect(storage.objects.size).toBe(0);
    await expect(
      getRecording(client.db, { ...dictation.actor, recordingId: dictation.input.recordingId }),
    ).rejects.toThrow();
    // Already gone is done.
    expect(await run.expireDictation(dictation.input)).toEqual({ deleted: 0, purged: false });
  });

  test("a dictation started in a language is heard in it, listening for the vocabulary", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const dictation = await capturedDictation(storage, 3, {
      language: "nb",
      keyterms: ["Kubernetes"],
    });
    const calls: TranscriptionRequest[] = [];
    const run = dictationActivities(storage, async (request) => {
      calls.push(request);
      return {
        text: "Husk å sende tallene.",
        languages: ["no"],
        providerId: "voice-one",
        audioSeconds: 3,
        latencyMs: 5,
        creditCostMicros: 0,
      };
    });
    expect(await run.transcribeRecordingVersion(dictation.input)).toMatchObject({
      outcome: "complete",
    });
    expect(calls.map((call) => call.language)).toEqual(["nb"]);
    expect(calls.map((call) => call.keyterms)).toEqual([["Kubernetes"]]);
  });

  test("a retried dictation asks afresh and is still billed once per piece", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const dictation = await capturedDictation(storage);
    const calls: TranscriptionRequest[] = [];
    let lost = true;
    const run = dictationActivities(storage, async (request) => {
      calls.push(request);
      if (lost) {
        throw new TranscriptionServiceError({ code: "network", message: "lost", retryable: true });
      }
      return {
        text: "Again.",
        languages: ["en"],
        providerId: "voice-one",
        audioSeconds: 3,
        latencyMs: 5,
        creditCostMicros: 1_200,
      };
    });
    await expect(run.transcribeRecordingVersion(dictation.input)).rejects.toMatchObject({
      type: "voice_network",
    });
    lost = false;
    expect(await run.transcribeRecordingVersion(dictation.input)).toMatchObject({
      outcome: "complete",
    });
    expect(calls.map((call) => call.requestId)).toEqual([
      `${dictation.input.versionId}:a1:0`,
      `${dictation.input.versionId}:a2:0`,
    ]);
    expect(new Set(calls.map((call) => call.billing!.sourceId))).toEqual(
      new Set([`${dictation.input.recordingId}:${dictation.input.versionId}:0`]),
    );
  });

  test("a credit refusal fails the dictation without retrying", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const dictation = await capturedDictation(storage);
    const run = dictationActivities(storage, async () => {
      throw new TranscriptionBillingRefusedError({
        code: "insufficient_credits",
        message: "No credits left",
      });
    });
    expect(await run.transcribeRecordingVersion(dictation.input)).toEqual({
      outcome: "failed",
      errorCode: "insufficient_credits",
      expireAfterMilliseconds: DICTATION_RETENTION_MILLISECONDS,
    });
  });

  test("an EU-only region refusal fails the dictation without retrying", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const dictation = await capturedDictation(storage);
    let calls = 0;
    const run = dictationActivities(storage, async () => {
      calls += 1;
      throw new InferenceRegionRestrictedError("voice-one");
    });
    expect(await run.transcribeRecordingVersion(dictation.input)).toEqual({
      outcome: "failed",
      errorCode: "region_restricted",
      expireAfterMilliseconds: DICTATION_RETENTION_MILLISECONDS,
    });
    expect(calls).toBe(1);
  });

  test("expiry leaves meetings alone", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const meeting = await capturedRecording(storage);
    const run = dictationActivities(storage, async () => {
      throw new Error("not called");
    });
    expect(await run.expireDictation(meeting.input)).toEqual({ deleted: 0, purged: false });
    expect(
      (await getRecording(client.db, { ...meeting.actor, recordingId: meeting.input.recordingId }))
        .state,
    ).not.toBe("deleting");
  });
});

describe("stalled recording recovery", () => {
  test("restarts stalled work", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(db, {
      accountExternalSource: "recording-recovery",
      accountExternalId: suffix,
      accountName: "Recording recovery",
      workspaceExternalSource: "recording-recovery",
      workspaceExternalId: suffix,
      workspaceName: "Recording recovery",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const actor = { workspaceId: grant.workspaceId!, subjectId: grant.subjectId };
    const recordingId = crypto.randomUUID();
    await createRecording(db, {
      ...actor,
      accountId: grant.accountId,
      recordingId,
      title: "Stalled",
      visibility: "private",
      tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm;codecs=opus" }],
    });
    await markRecordingDeleting(db, { ...actor, recordingId });
    await shared.admin`
      UPDATE recordings SET updated_at = now() - interval '10 minutes' WHERE id = ${recordingId}
    `;
    const starts: string[] = [];
    const services = async () =>
      ({
        db,
        observability: {
          warn: () => undefined,
          info: () => undefined,
          debug: () => undefined,
        },
        startRecordingWorkflow: async (work: { recordingId: string }) => {
          starts.push(work.recordingId);
          return "started";
        },
      }) as unknown as ControlActivityServices;
    const run = createRecordingActivities(services, {
      registry: createRecordingTranscriptionProviderRegistry([]),
      loadApiKey: async () => null,
      heartbeat: () => undefined,
      cancellationSignal: () => undefined,
    });

    const recovered = await run.recoverRecordingWorkflows();
    expect(recovered.failed).toBe(0);
    expect(starts).toContain(recordingId);
  });
});

// Last: it grants the EXECUTE 0946 withholds.
describe.skipIf(!hasFfmpeg)("recording retention", () => {
  test("retention deletes old audio and keeps the transcript, then hands old meetings to deletion", async () => {
    if (!client || !shared) return;
    const db = client.db;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const { recordingId, workspaceId } = recording.input;
    const { activities: transcribe } = activities(
      storage,
      fakeProvider(async () => ({
        languages: ["en"],
        audioMilliseconds: 1_000,
        diarized: false,
        words: [],
      })),
    );
    await transcribe.transcribeRecordingVersion(recording.input);
    expect(storage.objects.size).toBe(6);
    await shared.admin`
      UPDATE recordings
      SET started_at = now() - interval '10 days', capture_ended_at = now() - interval '10 days'
      WHERE id = ${recordingId}
    `;
    await updateWorkspaceSettings(db, workspaceId, {
      recordings: { retention: { audioDays: 7, transcriptDays: 30 } },
    });
    const starts: string[] = [];
    const services = async () =>
      ({
        db,
        objectStorage: storage.storage,
        observability: {
          warn: () => undefined,
          info: () => undefined,
          debug: () => undefined,
        },
        startRecordingWorkflow: async (work: { recordingId: string }) => {
          starts.push(work.recordingId);
          return "started";
        },
      }) as unknown as ControlActivityServices;
    const run = createRecordingActivities(services, {
      registry: createRecordingTranscriptionProviderRegistry([]),
      loadApiKey: async () => null,
      heartbeat: () => undefined,
      cancellationSignal: () => undefined,
    });

    const audio = await run.applyRecordingRetention();
    expect(audio).toMatchObject({ audioDeleted: 1, recordingsDeleted: 0, failed: 0 });
    expect(storage.objects.size).toBe(0);
    const kept = await getRecording(db, { ...recording.actor, recordingId });
    expect(kept.audioDeletedAt).not.toBeNull();
    expect(kept.transcript?.state).toBe("complete");
    expect(await run.applyRecordingRetention()).toMatchObject({ found: 0 });

    await updateWorkspaceSettings(db, workspaceId, {
      recordings: { retention: { audioDays: 1, transcriptDays: 5 } },
    });
    expect(await run.applyRecordingRetention()).toMatchObject({
      recordingsDeleted: 1,
      failed: 0,
    });
    expect(starts).toEqual([recordingId]);
    await expect(getRecording(db, { ...recording.actor, recordingId })).rejects.toThrow(
      "Recording not found",
    );
  });
});
