import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniApiError } from "../src/errors";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  type TranscriptionRecording,
} from "../src/types";
import { WORKSPACE_ID } from "./helpers";

const RECORDING_ID = "33333333-3333-4333-8333-333333333333";
const SHA256 = "a".repeat(64);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
  });
}

function initialRecording(): TranscriptionRecording {
  return {
    id: RECORDING_ID,
    workspaceId: WORKSPACE_ID,
    mimeType: "audio/webm",
    state: "uploading",
    nextChunkNumber: 0,
    chunkCount: 0,
    totalBytes: 0,
    totalDurationMilliseconds: 0,
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
  };
}

describe("OpenGeniClient resumable transcription recordings", () => {
  test("deduplicates a cross-browser chunk and resumes a 30+ minute recording", async () => {
    let recording = initialRecording();
    let uploaded = false;
    const requests: Array<{ method: string; path: string }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path });
      expect(request.headers.get("authorization")).toBe("Bearer shared-subject-token");

      if (request.method === "POST" && path.endsWith("/transcription-recordings")) {
        expect(await request.json()).toEqual({
          recordingId: RECORDING_ID,
          mimeType: "audio/webm",
        });
        return json({ recording, segments: [] }, 201);
      }
      if (request.method === "PUT" && path.endsWith("/chunks/0")) {
        expect(request.headers.get("x-opengeni-chunk-sha256")).toBe(SHA256);
        expect(request.headers.get("x-opengeni-chunk-start-milliseconds")).toBe("0");
        expect(request.headers.get("x-opengeni-chunk-duration-milliseconds")).toBe("1805000");
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        const deduplicated = uploaded;
        if (!uploaded) {
          uploaded = true;
          recording = {
            ...recording,
            nextChunkNumber: 1,
            chunkCount: 1,
            totalBytes: 3,
            totalDurationMilliseconds: 1_805_000,
          };
        }
        return json({
          recording,
          chunk: {
            chunkNumber: 0,
            byteLength: 3,
            sha256: SHA256,
            startMilliseconds: 0,
            durationMilliseconds: 1_805_000,
            deduplicated,
          },
        });
      }
      if (request.method === "POST" && path.endsWith("/finalize")) {
        expect(await request.json()).toEqual({
          chunkCount: 1,
          totalBytes: 3,
          totalDurationMilliseconds: 1_805_000,
        });
        recording = { ...recording, state: "ready", segmentCount: 37 };
        return json({ recording, segments: [] });
      }
      if (request.method === "GET" && path.endsWith("/transcription-recordings")) {
        return json({ recordings: [recording] });
      }
      if (request.method === "GET" && path.endsWith(`/${RECORDING_ID}`)) {
        return json({ recording, segments: [] });
      }
      if (request.method === "POST" && path.endsWith("/process-next")) {
        recording = {
          ...recording,
          state: "complete",
          completedSegmentCount: 37,
          transcriptText: "cross-browser transcript",
          languages: ["en"],
        };
        return json({ recording, segments: [] });
      }
      return json({ code: "not_found" }, 404);
    };

    const browserA = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "shared-subject-token",
      fetch,
    });
    const browserB = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "shared-subject-token",
      fetch,
    });

    await browserA.createTranscriptionRecording(WORKSPACE_ID, {
      recordingId: RECORDING_ID,
      mimeType: "audio/webm",
    });
    const first = await browserA.uploadTranscriptionRecordingChunk(WORKSPACE_ID, RECORDING_ID, 0, {
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/webm",
      sha256: SHA256,
      startMilliseconds: 0,
      durationMilliseconds: 1_805_000,
    });
    const duplicate = await browserB.uploadTranscriptionRecordingChunk(
      WORKSPACE_ID,
      RECORDING_ID,
      0,
      {
        audio: new Uint8Array([1, 2, 3]),
        mimeType: "audio/webm",
        sha256: SHA256,
        startMilliseconds: 0,
        durationMilliseconds: 1_805_000,
      },
    );
    expect(first.chunk.deduplicated).toBe(false);
    expect(duplicate.chunk.deduplicated).toBe(true);

    await browserA.finalizeTranscriptionRecording(WORKSPACE_ID, RECORDING_ID, {
      chunkCount: 1,
      totalBytes: 3,
      totalDurationMilliseconds: 1_805_000,
    });
    expect((await browserB.listTranscriptionRecordings(WORKSPACE_ID)).recordings).toEqual([
      recording,
    ]);
    expect(
      (await browserB.getTranscriptionRecording(WORKSPACE_ID, RECORDING_ID)).recording.state,
    ).toBe("ready");
    const completed = await browserB.processNextTranscriptionRecordingSegment(
      WORKSPACE_ID,
      RECORDING_ID,
    );
    expect(completed.recording).toMatchObject({
      state: "complete",
      transcriptText: "cross-browser transcript",
      completedSegmentCount: 37,
    });
    expect(requests.filter((request) => request.path.endsWith("/chunks/0"))).toHaveLength(2);
  });

  test("rejects malformed resumable recording responses", async () => {
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () => json({ recordings: [{ id: RECORDING_ID, transcriptText: "leak" }] }),
    });
    await expect(client.listTranscriptionRecordings(WORKSPACE_ID)).rejects.toBeInstanceOf(
      OpenGeniApiError,
    );

    const invalidRetryHintClient = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () =>
        json({
          recording: initialRecording(),
          segments: [],
          retryAfterMilliseconds: 60_001,
        }),
    });
    await expect(
      invalidRetryHintClient.getTranscriptionRecording(WORKSPACE_ID, RECORDING_ID),
    ).rejects.toBeInstanceOf(OpenGeniApiError);
  });
});
