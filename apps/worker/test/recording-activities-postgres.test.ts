import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createRecordingTranscriptionProviderRegistry,
  RecordingTranscriptionError,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionRequest,
} from "@opengeni/core";
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
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
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
  transcribe: (request: RecordingTranscriptionRequest) => ReturnType<RecordingTranscriptionProvider["transcribe"]>,
): RecordingTranscriptionProvider {
  return {
    id: "elevenlabs",
    name: "Fake",
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

async function capturedRecording(storage: ReturnType<typeof memoryStorage>) {
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
    const reserved = await reserveRecordingChunks(db, { ...actor, recordingId, trackNumber, chunks });
    for (const row of reserved) {
      storage.objects.set(row.objectKey, { bytes: parts[row.chunkNumber]!, contentType: "audio/webm" });
    }
    await markRecordingChunksUploaded(db, { ...actor, recordingId, trackNumber, chunkNumbers: [0, 1] });
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
    transcription: { providerId: "elevenlabs", model: "scribe_v2", options: { language: "en" } },
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
) {
  const warnings: string[] = [];
  const services = async () =>
    ({
      db: client!.db,
      objectStorage: storage.storage,
      settings: { voiceInputFfmpegPath: ffmpegPath },
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
              { text: "Hello", startMilliseconds: 100, endMilliseconds: 400, speaker: null, spaceBefore: false },
              { text: "team.", startMilliseconds: 450, endMilliseconds: 800, speaker: null, spaceBefore: true },
            ]
          : [
              { text: "Hi", startMilliseconds: 900, endMilliseconds: 1_100, speaker: "speaker_1", spaceBefore: false },
              { text: "Yes", startMilliseconds: 1_300, endMilliseconds: 1_500, speaker: "speaker_0", spaceBefore: true },
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
      await activities(storage, outage, null).activities.transcribeRecordingVersion(recording.input),
    ).toEqual({ outcome: "failed", errorCode: "missing_provider_key" });
    const [version] = await listRecordingTranscriptVersions(client.db, {
      ...recording.actor,
      recordingId: recording.input.recordingId,
    });
    expect(version).toMatchObject({ state: "failed", errorCode: "missing_provider_key" });
  });

  test("deletion removes every object of the recording, then its rows", async () => {
    if (!client) return;
    const storage = memoryStorage();
    const recording = await capturedRecording(storage);
    const { activities: run } = activities(
      storage,
      fakeProvider(async () => ({ languages: [], audioMilliseconds: 0, diarized: false, words: [] })),
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
