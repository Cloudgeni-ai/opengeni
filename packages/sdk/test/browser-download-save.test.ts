import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

const operationId = "11111111-1111-4111-8111-111111111111";
const downloadId = "22222222-2222-4222-8222-222222222222";
const browserSessionId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const save = { operationId, destinationPath: "downloads/large.bin", overwrite: false };

test("download saves opt in to progress and repeat the same operation until materialized", async () => {
  const bodies: unknown[] = [];
  const completed = { operationId, destinationPath: save.destinationPath, replayed: false };
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "synthetic",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).searchParams.get("respondAsync")).toBe("true");
      bodies.push(await request.json());
      return bodies.length < 3
        ? Response.json(
            { state: "uploading", operationId, downloadId, retryAfterMs: 1 },
            { status: 202 },
          )
        : Response.json(completed, { status: 201 });
    }) as typeof fetch,
  });
  expect(
    await client.saveBrowserDownload(workspaceId, browserSessionId, downloadId, save),
  ).toMatchObject(completed);
  expect(bodies).toEqual([save, save, save]);
});

test("an aborted download save stops waiting without starting a new operation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "synthetic",
    fetch: (async () => {
      calls++;
      controller.abort(new Error("caller stopped waiting"));
      return Response.json(
        { state: "uploading", operationId, downloadId, retryAfterMs: 60_000 },
        { status: 202 },
      );
    }) as unknown as typeof fetch,
  });
  await expect(
    client.saveBrowserDownload(workspaceId, browserSessionId, downloadId, save, {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test("progress for another operation is not polled", async () => {
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "synthetic",
    fetch: (async () =>
      Response.json(
        {
          state: "uploading",
          operationId: browserSessionId,
          downloadId,
          retryAfterMs: 0,
        },
        { status: 202 },
      )) as unknown as typeof fetch,
  });
  await expect(
    client.saveBrowserDownload(workspaceId, browserSessionId, downloadId, save),
  ).rejects.toThrow();
});
