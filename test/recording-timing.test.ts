import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  createSpeechToTextDeployment,
  createTranscriptionService,
} from "@opengeni/core/transcription-service";
import { bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { createObservability, recordingTimingContext } from "@opengeni/observability";
import {
  createMemoryRecordingChunkStore,
  OpenGeniRecordingsClient,
  RecordingUploader,
} from "@opengeni/sdk/recordings";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createApp, type AppDependencies } from "../apps/api/src/app";
import { createRecordingActivities } from "../apps/worker/src/activities/recordings";
import type { ControlActivityServices } from "../apps/worker/src/activities/types";
import { ffmpegPath, hasFfmpeg, opusWebm } from "../apps/worker/test/recording-audio-fixtures";

let shared: SharedTestDatabase;
let db: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("recording-timing");
  if (!acquired) throw new Error("Recording timing test requires PostgreSQL");
  shared = acquired;
  db = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await db?.close();
  await shared?.release();
}, 60_000);

type Span = {
  name: string;
  attributes: Array<{
    key: string;
    value: { stringValue?: string; intValue?: string; doubleValue?: number };
  }>;
};
type TraceExport = { resourceSpans: Array<{ scopeSpans: Array<{ spans: Span[] }> }> };

test.skipIf(!hasFfmpeg)(
  "one dictation emits correlated storage, API, queue, audio, provider and total durations",
  async () => {
    const settings = testSettings({
      productAccessMode: "managed",
      sandboxBackend: "none",
      delegationSecret: "recording-timing-delegation-test-key",
      voiceInputProviderOrder: "openai",
      voiceInputOpenaiApiKey: "test-key",
      voiceInputFfmpegPath: ffmpegPath,
      observabilityStructuredLogs: true,
      observabilityOtlpEndpoint: "http://collector.example:4318",
    });
    const access = await bootstrapWorkspace(db.db, {
      accountExternalSource: "recording-timing",
      accountExternalId: crypto.randomUUID(),
      accountName: "Recording test",
      workspaceExternalSource: "recording-timing",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Recording test",
      subjectId: "recording-timing-user",
    });
    const workspaceId = access.defaultWorkspaceId!;
    const token = await signDelegatedAccessToken(settings.delegationSecret!, {
      accountId: access.defaultAccountId!,
      workspaceId,
      subjectId: access.subjectId,
      permissions: ["workspace:read", "sessions:create", "sessions:read"],
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1_000) + 120,
    });
    const spans: Span[] = [];
    const observability = (component: string) =>
      createObservability(settings, {
        component,
        exporter: async (_url, body) => {
          for (const resource of (body as TraceExport).resourceSpans ?? []) {
            for (const scope of resource.scopeSpans) spans.push(...scope.spans);
          }
        },
      });
    const apiObs = observability("api");
    const workerObs = observability("worker");
    const providerFetch = (async () => {
      await Bun.sleep(40);
      return Response.json({ text: "Test dictation" });
    }) as typeof fetch;
    const deployment = createSpeechToTextDeployment(
      { settings, db: db.db },
      { fetch: providerFetch },
    );
    const transcription = createTranscriptionService({ settings, db: db.db, deployment });
    const objects = new Map<string, Uint8Array>();
    const storage = {
      createPutUrl: async ({ key }: { key: string }) => ({
        url: `https://storage.example/${key}?signed=put`,
        requiredHeaders: {},
        expiresAt: new Date(Date.now() + 60_000),
      }),
      headObject: async (key: string) => ({ ContentLength: objects.get(key)?.byteLength }),
      getObjectBytes: async (key: string) => ({ bytes: objects.get(key) }),
    };
    const worker = createRecordingActivities(
      async () =>
        ({
          db: db.db,
          settings,
          objectStorage: storage,
          observability: workerObs,
        }) as unknown as ControlActivityServices,
      { dictationTranscription: () => transcription },
    );
    let job: Parameters<typeof worker.transcribeRecordingVersion>[0] | undefined;
    const app = createApp({
      db: db.db,
      settings,
      bus: new MemoryEventBus(),
      objectStorage: storage,
      observability: apiObs,
      transcription,
      speechToText: deployment,
      managedAuth: null,
      workflowClient: {
        startRecordingWorkflow: async (input: NonNullable<typeof job> & { kind: string }) => {
          if (input.kind === "transcript") job = { ...input, processingOwner: input.versionId };
        },
      },
    } as unknown as AppDependencies);
    const reports: Promise<void>[] = [];
    const sdk = new OpenGeniRecordingsClient({
      async requestJson<T>(method: string, path: string, body?: unknown, query = {}) {
        const u = new URL(path, "https://api.example");
        u.search = new URLSearchParams(query).toString();
        const response = await app.request(u, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok)
          throw Object.assign(new Error(await response.text()), { status: response.status });
        return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
      },
    });
    const put = (async (url: string, init: RequestInit) => {
      await Bun.sleep(30);
      objects.set(new URL(url).pathname.slice(1), init.body as unknown as Uint8Array);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const uploader = new RecordingUploader({
      client: {
        createRecording: sdk.createRecording.bind(sdk),
        createRecordingUploads: sdk.createRecordingUploads.bind(sdk),
        completeRecordingChunks: sdk.completeRecordingChunks.bind(sdk),
        finalizeRecording: sdk.finalizeRecording.bind(sdk),
        deleteRecording: sdk.deleteRecording.bind(sdk),
        reportRecordingTimings: (...args) => {
          const report = sdk.reportRecordingTimings(...args);
          reports.push(report);
          return report;
        },
      },
      store: createMemoryRecordingChunkStore(),
      fetch: put,
    });
    const recordingId = crypto.randomUUID();
    const recordingKey = recordingTimingContext(recordingId).recordingKey;
    const logs: Record<string, unknown>[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => {
      if (line.startsWith("{")) logs.push(JSON.parse(line));
    });
    const value = (span: Span, key: string): string | number | undefined => {
      const field = span.attributes.find((attribute) => attribute.key === key)?.value;
      return (
        field?.stringValue ??
        field?.doubleValue ??
        (field?.intValue === undefined ? undefined : Number(field.intValue))
      );
    };
    const durations: Record<string, number> = {};
    try {
      const bytes = opusWebm(2, 440);
      await uploader.begin({
        workspaceId,
        recordingId,
        create: {
          recordingId,
          purpose: "dictation",
          startedAt: new Date().toISOString(),
          tracks: [{ trackNumber: 0, source: "microphone", mimeType: "audio/webm;codecs=opus" }],
        },
      });
      const stopped = performance.now();
      await uploader.addChunk({
        recordingId,
        trackNumber: 0,
        chunkNumber: 0,
        bytes,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        startMilliseconds: 0,
        durationMilliseconds: 2_000,
      });
      expect(await uploader.finish(recordingId, { stoppedAtMs: stopped })).toMatchObject({
        finalized: true,
      });
      expect(job?.recordingId).toBe(recordingId);
      const waitStarted = performance.now();
      const waiting = sdk.listRecordingTranscriptVersions(workspaceId, recordingId, {
        waitSeconds: 3,
      });
      await Bun.sleep(120);
      expect(await worker.transcribeRecordingVersion(job!)).toMatchObject({ outcome: "complete" });
      expect((await waiting)[0]?.state).toBe("complete");
      const page = await sdk.getRecordingTranscript(workspaceId, recordingId);
      expect(page.segments[0]?.text).toBe("Test dictation");
      const heard = performance.now();
      await sdk.deleteRecording(workspaceId, recordingId);
      await sdk.reportRecordingTimings(workspaceId, recordingId, {
        purpose: "dictation",
        transcriptWaitMs: heard - waitStarted,
        stopToTranscriptMs: heard - stopped,
        stopToComposerMs: performance.now() - stopped,
      });
      await Promise.all(reports);
      await Promise.all([apiObs.flush(), workerObs.flush()]);
      const recordingSpans = spans.filter((span) => value(span, "recordingKey") === recordingKey);
      for (const stage of [
        "chunk_put",
        "stop_to_last_put",
        "client_finalize",
        "finalize",
        "queue_wait",
        "audio_prepare",
        "audio_normalize",
        "provider_request",
        "transcript_long_poll_wait",
        "transcript_list_work",
        "client_transcript_wait",
        "stop_to_transcript",
        "stop_to_composer",
      ]) {
        const stageSpans = recordingSpans.filter((span) => span.name === `recording.${stage}`);
        expect(stageSpans.length, stage).toBeGreaterThan(0);
        durations[stage] = stageSpans.reduce(
          (sum, span) => sum + Number(value(span, "durationMs")),
          0,
        );
        expect(durations[stage], stage).toBeGreaterThan(0);
      }
      expect(durations.chunk_put).toBeGreaterThanOrEqual(25);
      expect(durations.provider_request).toBeGreaterThanOrEqual(35);
      expect(durations.transcript_long_poll_wait).toBeGreaterThan(100);
      expect(
        value(recordingSpans.find((span) => span.name === "recording.chunk_put")!, "audioBytes"),
      ).toBe(bytes.byteLength);
      const request = recordingSpans.find((span) => span.name === "recording.provider_request")!;
      expect(value(request, "provider")).toBe("openai");
      expect(value(request, "model")).toBe("gpt-transcribe");
      expect(value(request, "recordingProviderRegion")).toBeDefined();
      expect(value(request, "providerAttempt")).toBe(1);
      expect(value(request, "audioSeconds")).toBeGreaterThan(1);
      expect(logs.find((entry) => entry.message === "recording processed")).toMatchObject({
        recordingKey,
        audioSeconds: expect.any(Number),
        outcome: "complete",
      });
      for (const metrics of await Promise.all([
        apiObs.prometheusMetrics(),
        workerObs.prometheusMetrics(),
      ])) {
        expect(metrics).toContain("opengeni_recording_stage_duration_seconds_bucket");
        expect(metrics).not.toContain(recordingKey);
      }
    } finally {
      uploader.dispose();
      log.mockRestore();
    }
    if (process.env.OPENGENI_TEST_TRACE_EXAMPLE === "1")
      console.log("Recording stage milliseconds:", durations);
  },
);
