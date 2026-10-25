import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createRecordingTranscriptionProviderRegistry,
  RecordingTranscriptionError,
  TranscriptionBillingRefusedError,
  type RecordingDiarizer,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionRequest,
  type TranscriptionRequest,
  type TranscriptionService,
} from "@opengeni/core";
import { DICTATION_RETENTION_MILLISECONDS } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createRecording,
  createRecordingTranscriptVersion,
  finalizeRecording,
  getRecording,
  getRecordingTranscriptPage,
  listRecordingTranscriptVersions,
  markRecordingChunksUploaded,
  markRecordingDeleting,
  reserveRecordingChunks,
  updateWorkspaceSettings,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { textModelCapabilities } from "@opengeni/core/transcription-service";
import { createHash } from "node:crypto";
import { createRecordingActivities } from "../src/activities/recordings";
import type { ControlActivityServices } from "../src/activities/types";
import { ffmpegPath, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

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
    tracks: [
      { trackNumber: 0, source: "microphone", mimeType: "audio/webm;codecs=opus" },
      { trackNumber: 1, source: "system", mimeType: "audio/webm;codecs=opus" },
    ],
  });
  for (const trackNumber of [0, 1]) {
    const audio = opusWebm(2, trackNumber === 0 ? 440 : 660);
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
    tracks: [
      { trackNumber: 0, chunkCount: 2 },
      { trackNumber: 1, chunkCount: 2 },
    ],
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
    }),
  };
}

describe.skipIf(!hasFfmpeg)("recording transcription activity", () => {
  test("prepares each track, keeps the microphone as one speaker and diarizes the rest", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const calls: RecordingTranscriptionRequest[] = [];
    const provider = fakeProvider(async (request) => {
      calls.push(request);
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
      ["track-0.webm", false, "en"],
      ["track-1.webm", true, "en"],
    ]);
    const prepared = [...storage.objects.keys()].filter((key) => key.includes("/prepared/"));
    expect(prepared.sort()).toEqual([
      `workspaces/${recording.actor.workspaceId}/recordings/${recording.input.recordingId}/prepared/track-0.webm`,
      `workspaces/${recording.actor.workspaceId}/recordings/${recording.input.recordingId}/prepared/track-1.webm`,
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
    expect(calls).toHaveLength(4);
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

    // Asked for ours: only the diarized track goes through it.
    const first = await version("ours");
    expect(
      await activities(storage, provider, "key", ours).activities.transcribeRecordingVersion(first),
    ).toEqual({ outcome: "complete" });
    expect(diarized).toEqual(["track-1.webm"]);
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
    expect(diarized).toEqual(["track-1.webm"]);
    expect(await stored(fourth)).toEqual([
      { label: "speaker_0", channel: "call", model: "test-voices" },
      { label: "speaker_1", channel: "call", model: "test-voices" },
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

  test("a model that returns only text hears each of our diarizer's speakers on their own", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage, {
      providerId: "codex-subscription",
      model: "chatgpt-dictation",
      options: {},
    });
    const heard: Array<{ fileName: string; scope: unknown }> = [];
    let signedIn = true;
    const texts: Record<string, string> = {
      "track-0.webm": "Hello team.",
      "track-1-0.webm": "Hi there.",
      "track-1-1.webm": "Yes.",
    };
    const subscription: RecordingTranscriptionProvider = {
      id: "codex-subscription",
      name: "ChatGPT subscription",
      funding: "workspace_subscription",
      available: () => signedIn,
      models: [
        {
          model: "chatgpt-dictation",
          name: "ChatGPT dictation",
          usdPerHour: 0,
          capabilities: textModelCapabilities({ maxDurationSeconds: 600, maxFileBytes: null }),
        },
      ],
      transcribe: async (request, credentials) => {
        expect(credentials).toBeNull();
        heard.push({ fileName: request.audio.fileName, scope: request.scope });
        return {
          languages: ["en"],
          audioMilliseconds: null,
          diarized: false,
          words: [],
          text: texts[request.audio.fileName] ?? "",
        };
      },
    };
    const ours: RecordingDiarizer = {
      id: "test",
      diarize: async () => ({
        turns: [
          { startMilliseconds: 0, endMilliseconds: 900, speaker: "S0" },
          { startMilliseconds: 1_000, endMilliseconds: 2_000, speaker: "S1" },
        ],
        voices: [],
        voiceModel: "test-voices",
      }),
    };
    const version = async () => {
      const versionId = crypto.randomUUID();
      await createRecordingTranscriptVersion(client!.db, {
        ...recording.actor,
        recordingId: recording.input.recordingId,
        versionId,
        transcription: {
          providerId: "codex-subscription",
          model: "chatgpt-dictation",
          options: {},
        },
      });
      return { ...recording.input, versionId, processingOwner: versionId };
    };
    const run = activities(storage, subscription, null, ours).activities;
    const first = recording.input;
    expect(await run.transcribeRecordingVersion(first)).toEqual({ outcome: "complete" });
    expect(heard.map((call) => call.fileName).sort()).toEqual([
      "track-0.webm",
      "track-1-0.webm",
      "track-1-1.webm",
    ]);
    expect(heard[0]!.scope).toMatchObject({
      accountId: recording.input.accountId,
      workspaceId: recording.input.workspaceId,
      subjectId: recording.input.ownerSubjectId,
    });
    const page = await getRecordingTranscriptPage(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
      versionId: first.versionId,
    });
    expect(page.version.diarization).toBe("ours");
    expect(page.segments.map((segment) => [segment.speakerLabel, segment.text]).sort()).toEqual([
      ["speaker_0", "Hi there."],
      ["speaker_1", "Yes."],
      ["track-0", "Hello team."],
    ]);
    // Signed out of the subscription: the version fails without sending audio.
    signedIn = false;
    const second = await version();
    expect(await run.transcribeRecordingVersion(second)).toEqual({
      outcome: "failed",
      errorCode: "missing_provider_key",
    });
    expect(heard).toHaveLength(3);
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

async function capturedDictation(storage: ReturnType<typeof memoryStorage>, seconds = 3) {
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
      options: {},
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
