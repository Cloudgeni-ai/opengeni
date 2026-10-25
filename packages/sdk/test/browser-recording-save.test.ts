import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const recording = {
  recordingId: "33333333-3333-4333-8333-333333333333",
  state: "stopped",
  startedAt: "2026-10-23T20:00:00.000Z",
  stoppedAt: "2026-10-23T20:12:00.000Z",
  stopReason: "requested",
  durationMs: 720_000,
  frameCount: 10,
  frameBytes: 40,
  actionCount: 2,
  bundle: { sizeBytes: 3, sha256: "b".repeat(64) },
  streamError: null,
};

test("a save still uploading is repeated with the same operation until it completes", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "synthetic",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      bodies.push(await request.json());
      calls += 1;
      if (calls < 3) {
        return Response.json({ state: "uploading", recording, retryAfterMs: 1 }, { status: 202 });
      }
      return Response.json(
        {
          recording,
          video: {
            path: "recordings/flow.mp4",
            artifactId: "a".repeat(32),
            sizeBytes: 100,
            durationMs: 720_000,
            width: 1280,
            height: 720,
            frameCount: 10,
          },
          actionLogPath: "recordings/flow.actions.json",
        },
        { status: 201 },
      );
    }) as typeof fetch,
  });
  const saved = await client.saveBrowserRecording(
    "22222222-2222-4222-8222-222222222222",
    "44444444-4444-4444-8444-444444444444",
    recording.recordingId,
    { operationId: "55555555-5555-4555-8555-555555555555" },
  );
  expect(saved.video.path).toBe("recordings/flow.mp4");
  expect(calls).toBe(3);
  expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
});

test("an aborted save stops repeating", async () => {
  const controller = new AbortController();
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "synthetic",
    fetch: (async () => {
      controller.abort(new Error("stopped by caller"));
      return Response.json(
        { state: "uploading", recording, retryAfterMs: 60_000 },
        { status: 202 },
      );
    }) as unknown as typeof fetch,
  });
  await expect(
    client.saveBrowserRecording(
      "22222222-2222-4222-8222-222222222222",
      "44444444-4444-4444-8444-444444444444",
      recording.recordingId,
      { operationId: "55555555-5555-4555-8555-555555555555" },
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
});
