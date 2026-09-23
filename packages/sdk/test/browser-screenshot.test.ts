import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const browserSessionId = "00000000-0000-4000-8000-000000000002";
const targetId = "tab-1";
const data = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);

function frameResponse(overrides: Record<string, unknown> = {}): Response {
  const metadata = {
    frameId: "frame-1",
    browserSessionId,
    controllerGeneration: "controller-1",
    targetId,
    targetGeneration: "target-1",
    documentGeneration: "document-1",
    sequence: 0,
    mediaType: "image/jpeg",
    width: 1,
    height: 1,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
    capturedAt: "2026-09-23T12:00:00.000Z",
    ...overrides,
  };
  return new Response(data.slice().buffer, {
    headers: {
      "content-type": "image/jpeg",
      "x-opengeni-browser-frame": Buffer.from(JSON.stringify(metadata)).toString("base64url"),
    },
  });
}

test("captures the requested browser target as a bounded image", async () => {
  let path = "";
  const sdk = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async (input) => {
      path = String(input);
      return frameResponse();
    },
  });
  const frame = await sdk.captureBrowserTarget(workspaceId, browserSessionId, targetId);
  expect(path).toContain(`/browser-sessions/${browserSessionId}/targets/${targetId}/screenshot`);
  expect(frame.data).toEqual(data);
  expect(frame.mediaType).toBe("image/jpeg");
});

test("forwards explicit full-page and encoding options without changing request-options position", async () => {
  let requestedUrl = "";
  const controller = new AbortController();
  const sdk = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requestedUrl = String(input);
      expect(init?.signal).toBe(controller.signal);
      return frameResponse();
    },
  });
  await sdk.captureBrowserTarget(
    workspaceId,
    browserSessionId,
    targetId,
    { signal: controller.signal },
    { fullPage: true, format: "jpeg", quality: 80 },
  );
  expect(new URL(requestedUrl).searchParams.toString()).toBe(
    "fullPage=true&format=jpeg&quality=80",
  );
  await expect(
    sdk.captureBrowserTarget(workspaceId, browserSessionId, targetId, {}, { quality: 101 }),
  ).rejects.toThrow("quality");
});

test("browser session screenshot uses capture options directly", async () => {
  let requestedUrl = "";
  const sdk = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async (input) => {
      requestedUrl = String(input);
      return frameResponse();
    },
  });
  const frame = await sdk.interaction.browsers
    .session(workspaceId, browserSessionId)
    .screenshot(targetId, { fullPage: true });
  expect(new URL(requestedUrl).searchParams.get("fullPage")).toBe("true");
  expect(frame.data).toEqual(data);
});

test("rejects a screenshot bound to another browser target", async () => {
  const sdk = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async () => frameResponse({ targetId: "other-tab" }),
  });
  await expect(sdk.captureBrowserTarget(workspaceId, browserSessionId, targetId)).rejects.toThrow(
    "browser frame evidence does not match its request",
  );
});
