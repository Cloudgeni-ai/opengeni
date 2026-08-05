import { createHash } from "node:crypto";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  signDelegatedAccessToken,
  TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS,
  type Permission,
  type TranscriptionRecording,
  type TranscriptionRecordingResponse,
} from "@opengeni/contracts";
import {
  TranscriptionServiceError,
  type TranscriptionSegmenter,
  type TranscriptionService,
} from "@opengeni/core";
import * as dbModule from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

const SECRET = "test-delegation-secret";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const RECORDING_ID = "33333333-3333-4333-8333-333333333333";
const SUBJECT_ID = "user:resumable-transcription-test";
const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";

function response(
  state: TranscriptionRecording["state"],
  overrides: Partial<TranscriptionRecording> = {},
): TranscriptionRecordingResponse {
  return {
    recording: {
      id: RECORDING_ID,
      workspaceId: WORKSPACE_ID,
      mimeType: "audio/webm",
      state,
      nextChunkNumber: 1,
      chunkCount: 1,
      totalBytes: 1,
      totalDurationMilliseconds: 1_850_000,
      segmentCount: 0,
      completedSegmentCount: 0,
      transcriptText: null,
      languages: [],
      errorCode: null,
      retryable: false,
      objectsCleaned: false,
      createdAt: "2026-08-04T07:00:00.000Z",
      updatedAt: "2026-08-04T07:00:00.000Z",
      expiresAt: "2026-08-05T07:00:00.000Z",
      ...overrides,
    },
    segments: [],
  };
}

function storage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    bucket: "test",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    createPutUrl: async () => {
      throw new Error("not used");
    },
    createGetUrl: async () => {
      throw new Error("not used");
    },
    headFile: async () => {
      throw new Error("not used");
    },
    fileExists: async () => false,
    getFileBytes: async () => {
      throw new Error("not used");
    },
    getFileRange: async () => null,
    getObjectBytes: async () => null,
    putObject: async () => undefined,
    deleteObject: async () => undefined,
    ...overrides,
  };
}

function app(input: {
  transcription: TranscriptionService;
  segmenter: TranscriptionSegmenter;
  objectStorage: ObjectStorage;
}) {
  return createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      voiceInputProviderOrder: "",
      voiceInputResumableEnabled: true,
      voiceInputResumableMaxDurationSeconds: 2 * 60 * 60,
    }),
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    transcription: input.transcription,
    transcriptionSegmenter: input.segmenter,
    objectStorage: input.objectStorage,
  });
}

async function bearer(permissions: Permission[] = ["sessions:create"]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: SUBJECT_ID,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

afterEach(() => {
  mock.restore();
});

describe("resumable transcription recording routes", () => {
  test("segments and persists a 30+ minute recording within the provider bound", async () => {
    const chunkBytes = new Uint8Array([1]);
    const chunkSha256 = createHash("sha256").update(chunkBytes).digest("hex");
    const segmentRequests: Array<{
      totalDurationMilliseconds: number;
      providerSegmentSeconds: number;
    }> = [];
    const segmenter: TranscriptionSegmenter = {
      available: () => true,
      async *segment(input) {
        segmentRequests.push({
          totalDurationMilliseconds: input.totalDurationMilliseconds,
          providerSegmentSeconds: input.providerSegmentSeconds,
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of input.chunks) chunks.push(chunk);
        expect(chunks).toEqual([chunkBytes]);
        for (let segmentNumber = 0; segmentNumber < 37; segmentNumber += 1) {
          yield {
            segmentNumber,
            startMilliseconds: segmentNumber * 50_000,
            durationMilliseconds: 50_000,
            mimeType: "audio/wav",
            bytes: new Uint8Array([segmentNumber + 1]),
          };
        }
      },
    };
    const transcription: TranscriptionService = {
      limits: () => ({
        maxDurationSeconds: 50,
        maxSizeBytes: 25 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
      }),
      available: () => true,
      selectProvider: () => "openai",
      transcribe: async () => {
        throw new Error("not used");
      },
    };
    const putObject = mock(async () => undefined);
    const reserveSegment = spyOn(
      dbModule,
      "reserveTranscriptionRecordingSegment",
    ).mockImplementation(
      async (_db, input) =>
        ({
          ...input,
          objectKey: `segment-${input.segmentNumber}`,
        }) as never,
    );
    const completePreparation = spyOn(
      dbModule,
      "completeTranscriptionRecordingSegmentPreparation",
    ).mockResolvedValue(undefined);
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);
    spyOn(dbModule, "claimTranscriptionRecordingAssembly").mockResolvedValue({
      recording: response("segmenting"),
      claimed: true,
      generation: 1,
      owner: CORRELATION_ID,
      staleObjectKeys: [],
    });
    spyOn(dbModule, "listTranscriptionRecordingChunks").mockResolvedValue([
      {
        chunkNumber: 0,
        byteLength: chunkBytes.byteLength,
        sha256: chunkSha256,
        objectKey: "chunk-0",
        state: "complete",
      } as never,
    ]);
    spyOn(dbModule, "completeTranscriptionRecordingAssembly").mockResolvedValue(
      response("ready", { segmentCount: 37 }),
    );

    const api = app({
      transcription,
      segmenter,
      objectStorage: storage({
        getObjectBytes: async () => ({ bytes: chunkBytes, contentType: "audio/webm" }),
        putObject,
      }),
    });
    const result = await api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/finalize`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "content-type": "application/json",
          "x-opengeni-correlation-id": CORRELATION_ID,
        },
        body: JSON.stringify({
          chunkCount: 1,
          totalBytes: 1,
          totalDurationMilliseconds: 1_850_000,
        }),
      },
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      recording: { state: "ready", segmentCount: 37 },
    });
    expect(segmentRequests).toEqual([
      { totalDurationMilliseconds: 1_850_000, providerSegmentSeconds: 50 },
    ]);
    expect(reserveSegment).toHaveBeenCalledTimes(37);
    expect(putObject).toHaveBeenCalledTimes(37);
    expect(completePreparation).toHaveBeenCalledTimes(37);
  });

  test("persists retryable provider failure without changing the pinned provider", async () => {
    const segmentBytes = new Uint8Array([7, 8, 9]);
    const segmentSha256 = createHash("sha256").update(segmentBytes).digest("hex");
    const requests: Array<{ providerId?: string; requestId: string }> = [];
    const transcription: TranscriptionService = {
      limits: () => ({
        maxDurationSeconds: 50,
        maxSizeBytes: 25 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
      }),
      available: () => true,
      selectProvider: () => "azure-openai",
      transcribe: async (input) => {
        requests.push({ providerId: input.providerId, requestId: input.requestId });
        throw new TranscriptionServiceError({
          code: "provider",
          message: "temporary provider failure",
          retryable: true,
        });
      },
    };
    const claimSegment = spyOn(
      dbModule,
      "claimNextTranscriptionRecordingSegment",
    ).mockResolvedValue({
      recording: response("transcribing", { segmentCount: 1 }),
      claimed: true,
      attemptId: CORRELATION_ID,
      segment: {
        segmentNumber: 0,
        durationMilliseconds: 50_000,
        byteLength: segmentBytes.byteLength,
        sha256: segmentSha256,
        objectKey: "segment-0",
        providerId: "openai",
      } as never,
    });
    const failSegment = spyOn(dbModule, "failTranscriptionRecordingSegment").mockResolvedValue(
      response("failed", {
        segmentCount: 1,
        errorCode: "provider",
        retryable: true,
      }),
    );
    spyOn(dbModule, "startTranscriptionRecordingSegmentProviderCall").mockResolvedValue(undefined);
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);

    const api = app({
      transcription,
      segmenter: {
        available: () => true,
        segment() {
          throw new Error("not used");
        },
      },
      objectStorage: storage({
        getObjectBytes: async () => ({ bytes: segmentBytes, contentType: "audio/wav" }),
      }),
    });
    const result = await api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/process-next`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": CORRELATION_ID,
        },
      },
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      recording: { state: "failed", errorCode: "provider", retryable: true },
    });
    expect(claimSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerId: "azure-openai", attemptId: CORRELATION_ID }),
    );
    expect(requests).toEqual([{ providerId: "openai", requestId: CORRELATION_ID }]);
    expect(failSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        segmentNumber: 0,
        attemptId: CORRELATION_ID,
        errorCode: "provider",
        retryable: true,
      }),
    );
  });

  test("keeps concurrent clients to one live provider attempt and fences the late completion", async () => {
    const firstAttemptId = "55555555-5555-4555-8555-555555555555";
    const successorAttemptId = "66666666-6666-4666-8666-666666666666";
    const segmentBytes = new Uint8Array([7, 8, 9]);
    const segmentSha256 = createHash("sha256").update(segmentBytes).digest("hex");
    const claimed = response("transcribing", { segmentCount: 1 });
    const complete = response("complete", {
      segmentCount: 1,
      completedSegmentCount: 1,
      transcriptText: "one provider call",
    });
    let claimCalls = 0;
    let liveProviderCalls = 0;
    let maximumLiveProviderCalls = 0;
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerReleasePromise = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const claimSegment = spyOn(
      dbModule,
      "claimNextTranscriptionRecordingSegment",
    ).mockImplementation(async (_db, input) => {
      claimCalls += 1;
      if (claimCalls > 1) {
        return {
          recording: claimed,
          claimed: false,
          attemptId: firstAttemptId,
          segment: null,
        };
      }
      return {
        recording: claimed,
        claimed: true,
        attemptId: input.attemptId,
        segment: {
          segmentNumber: 0,
          durationMilliseconds: 50_000,
          byteLength: segmentBytes.byteLength,
          sha256: segmentSha256,
          objectKey: "segment-0",
          providerId: "openai",
        } as never,
      };
    });
    const completeSegment = spyOn(
      dbModule,
      "completeTranscriptionRecordingSegment",
    ).mockResolvedValue(complete);
    const startProviderCall = spyOn(
      dbModule,
      "startTranscriptionRecordingSegmentProviderCall",
    ).mockResolvedValue(undefined);
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);
    const transcription: TranscriptionService = {
      limits: () => ({
        maxDurationSeconds: 50,
        maxSizeBytes: 25 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
      }),
      available: () => true,
      selectProvider: () => "openai",
      transcribe: async () => {
        liveProviderCalls += 1;
        maximumLiveProviderCalls = Math.max(maximumLiveProviderCalls, liveProviderCalls);
        providerStarted();
        await providerReleasePromise;
        liveProviderCalls -= 1;
        return { text: "one provider call", languages: ["en"] };
      },
    };
    const api = app({
      transcription,
      segmenter: { available: () => true, segment: async function* () {} },
      objectStorage: storage({
        getObjectBytes: async () => ({ bytes: segmentBytes, contentType: "audio/wav" }),
      }),
    });

    const first = api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/process-next`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": firstAttemptId,
        },
      },
    );
    await providerStartedPromise;
    const second = await api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/process-next`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": successorAttemptId,
        },
      },
    );
    expect(second.status).toBe(202);
    expect(liveProviderCalls).toBe(1);
    expect(maximumLiveProviderCalls).toBe(1);
    releaseProvider();
    expect((await first).status).toBe(200);
    expect(completeSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: firstAttemptId }),
    );
    expect(startProviderCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: firstAttemptId,
        providerStartedAt: expect.any(Date),
        providerDeadlineAt: expect.any(Date),
      }),
    );
    expect(claimSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerDeadlineAt: expect.any(Date) }),
    );
  });

  test("keeps provider work resumable when the client request aborts", async () => {
    const segmentBytes = new Uint8Array([7, 8, 9]);
    const segmentSha256 = createHash("sha256").update(segmentBytes).digest("hex");
    const clientAbort = new AbortController();
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerReleasePromise = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const claimSegment = spyOn(
      dbModule,
      "claimNextTranscriptionRecordingSegment",
    ).mockResolvedValue({
      recording: response("transcribing", { segmentCount: 1 }),
      claimed: true,
      attemptId: CORRELATION_ID,
      segment: {
        segmentNumber: 0,
        durationMilliseconds: 50_000,
        byteLength: segmentBytes.byteLength,
        sha256: segmentSha256,
        objectKey: "segment-0",
        providerId: "openai",
      } as never,
    });
    const completeSegment = spyOn(
      dbModule,
      "completeTranscriptionRecordingSegment",
    ).mockResolvedValue(
      response("complete", {
        segmentCount: 1,
        completedSegmentCount: 1,
        transcriptText: "completed after client abort",
        objectsCleaned: true,
      }),
    );
    const failSegment = spyOn(dbModule, "failTranscriptionRecordingSegment");
    spyOn(dbModule, "startTranscriptionRecordingSegmentProviderCall").mockResolvedValue(undefined);
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);
    let observedSignal: AbortSignal | undefined;
    const transcription: TranscriptionService = {
      limits: () => ({
        maxDurationSeconds: 50,
        maxSizeBytes: 25 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
      }),
      available: () => true,
      selectProvider: () => "openai",
      transcribe: async (input) => {
        observedSignal = input.signal;
        providerStarted();
        await providerReleasePromise;
        return { text: "completed after client abort", languages: ["en"] };
      },
    };
    const api = app({
      transcription,
      segmenter: { available: () => true, segment: async function* () {} },
      objectStorage: storage({
        getObjectBytes: async () => ({ bytes: segmentBytes, contentType: "audio/wav" }),
      }),
    });

    const request = api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/process-next`,
      {
        method: "POST",
        signal: clientAbort.signal,
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": CORRELATION_ID,
        },
      },
    );
    await providerStartedPromise;
    clientAbort.abort();
    releaseProvider();

    expect((await request).status).toBe(200);
    expect(observedSignal).toBeUndefined();
    expect(completeSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: CORRELATION_ID }),
    );
    expect(failSegment).not.toHaveBeenCalled();
    expect(claimSegment).toHaveBeenCalledTimes(1);
  });

  test("keeps provider cancellation retryable for same-recording recovery", async () => {
    const secondAttemptId = "77777777-7777-4777-8777-777777777777";
    const segmentBytes = new Uint8Array([7, 8, 9]);
    const segmentSha256 = createHash("sha256").update(segmentBytes).digest("hex");
    let transcribeCalls = 0;
    const claimSegment = spyOn(
      dbModule,
      "claimNextTranscriptionRecordingSegment",
    ).mockImplementation(async (_db, input) => ({
      recording: response("transcribing", { segmentCount: 1 }),
      claimed: true,
      attemptId: input.attemptId,
      segment: {
        segmentNumber: 0,
        durationMilliseconds: 50_000,
        byteLength: segmentBytes.byteLength,
        sha256: segmentSha256,
        objectKey: "segment-0",
        providerId: "openai",
      } as never,
    }));
    const failSegment = spyOn(dbModule, "failTranscriptionRecordingSegment").mockResolvedValue(
      response("failed", { segmentCount: 1, errorCode: "cancelled", retryable: true }),
    );
    const completeSegment = spyOn(
      dbModule,
      "completeTranscriptionRecordingSegment",
    ).mockResolvedValue(
      response("complete", {
        segmentCount: 1,
        completedSegmentCount: 1,
        transcriptText: "recovered same recording",
        objectsCleaned: true,
      }),
    );
    spyOn(dbModule, "startTranscriptionRecordingSegmentProviderCall").mockResolvedValue(undefined);
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);
    const transcription: TranscriptionService = {
      limits: () => ({
        maxDurationSeconds: 50,
        maxSizeBytes: 25 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
      }),
      available: () => true,
      selectProvider: () => "openai",
      transcribe: async () => {
        transcribeCalls += 1;
        if (transcribeCalls === 1) {
          throw new TranscriptionServiceError({
            code: "cancelled",
            message: "provider transport cancelled",
          });
        }
        return { text: "recovered same recording", languages: ["en"] };
      },
    };
    const api = app({
      transcription,
      segmenter: { available: () => true, segment: async function* () {} },
      objectStorage: storage({
        getObjectBytes: async () => ({ bytes: segmentBytes, contentType: "audio/wav" }),
      }),
    });

    const first = await api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/process-next`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": CORRELATION_ID,
        },
      },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      recording: { id: RECORDING_ID, state: "failed", errorCode: "cancelled", retryable: true },
    });

    const second = await api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/process-next`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": secondAttemptId,
        },
      },
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      recording: {
        id: RECORDING_ID,
        state: "complete",
        transcriptText: "recovered same recording",
      },
    });
    expect(failSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: CORRELATION_ID,
        errorCode: "cancelled",
        retryable: true,
      }),
    );
    expect(completeSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: secondAttemptId }),
    );
    expect(claimSegment).toHaveBeenCalledTimes(2);
  });

  test("keeps explicit discard destructive after resumable provider work", async () => {
    const discarded = spyOn(dbModule, "discardTranscriptionRecording").mockResolvedValue(
      response("discarded"),
    );
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);
    const api = app({
      transcription: {
        limits: () => ({
          maxDurationSeconds: 50,
          maxSizeBytes: 25 * 1024 * 1024,
          acceptedMimeTypes: ["audio/webm"],
        }),
        available: () => true,
        selectProvider: () => "openai",
        transcribe: async () => ({ text: "unused", languages: [] }),
      },
      segmenter: { available: () => true, segment: async function* () {} },
      objectStorage: storage(),
    });

    const result = await api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}`,
      {
        method: "DELETE",
        headers: { authorization: await bearer() },
      },
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ recording: { state: "discarded" } });
    expect(discarded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordingId: RECORDING_ID, subjectId: SUBJECT_ID }),
    );
  });

  test("keeps an active segment lease nonterminal without invoking the provider", async () => {
    const claimSegment = spyOn(
      dbModule,
      "claimNextTranscriptionRecordingSegment",
    ).mockResolvedValue({
      recording: response("transcribing", { segmentCount: 1 }),
      claimed: false,
      attemptId: CORRELATION_ID,
      segment: null,
    });
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);
    const transcribe = mock(async () => ({ text: "must not run", languages: [] }));
    const transcription: TranscriptionService = {
      limits: () => ({
        maxDurationSeconds: 50,
        maxSizeBytes: 25 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
      }),
      available: () => true,
      selectProvider: () => "openai",
      transcribe,
    };
    const api = app({
      transcription,
      segmenter: { available: () => true, segment: async function* () {} },
      objectStorage: storage(),
    });

    const result = await api.request(
      `/v1/workspaces/${WORKSPACE_ID}/transcription-recordings/${RECORDING_ID}/process-next`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": CORRELATION_ID,
        },
      },
    );

    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({
      recording: { state: "transcribing" },
      retryAfterMilliseconds: TRANSCRIPTION_RECORDING_RECOVERY_RETRY_AFTER_MILLISECONDS,
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(claimSegment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attemptId: CORRELATION_ID,
        staleBefore: expect.any(Date),
        providerDeadlineAt: expect.any(Date),
      }),
    );
  });
});
