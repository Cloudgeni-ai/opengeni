import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniApiError } from "../src/errors";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  OPENGENI_CORRELATION_HEADER,
} from "../src/types";
import { WORKSPACE_ID } from "./helpers";

describe("OpenGeniClient.transcribeAudio", () => {
  test("uploads multipart audio once with auth headers and no retry", async () => {
    let calls = 0;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "og_test_key",
      fetch: async (input, init) => {
        calls += 1;
        const request = new Request(input, init);
        expect(request.method).toBe("POST");
        expect(request.url).toBe(
          `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/transcriptions`,
        );
        expect(request.headers.get("authorization")).toBe("Bearer og_test_key");
        expect(request.headers.get(OPENGENI_API_CONTRACT_HEADER)).toBe(
          OPENGENI_API_CONTRACT_REVISION,
        );
        expect(request.headers.get("content-type") ?? "").toContain("multipart/form-data");
        const form = await request.formData();
        const audio = form.get("audio");
        expect(audio).toBeInstanceOf(Blob);
        expect(form.get("mimeType")).toBe("audio/webm");
        expect(form.get("durationSeconds")).toBe("1.5");
        return new Response(JSON.stringify({ text: "hello world", languages: ["en"] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
            [OPENGENI_CORRELATION_HEADER]: "corr-1",
          },
        });
      },
    });

    const result = await client.transcribeAudio(WORKSPACE_ID, {
      audio: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/webm",
      durationSeconds: 1.5,
    });
    expect(result).toEqual({ text: "hello world", languages: ["en"] });
    expect(calls).toBe(1);
  });

  test("propagates abort without retrying", async () => {
    let calls = 0;
    const abort = new AbortController();
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const pending = client.transcribeAudio(WORKSPACE_ID, {
      audio: new Uint8Array([1]),
      mimeType: "audio/webm",
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  test("maps controlled API failures and rejects invalid response bodies", async () => {
    const failing = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () =>
        new Response(JSON.stringify({ code: "too_large" }), {
          status: 413,
          headers: {
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
        }),
    });
    await expect(
      failing.transcribeAudio(WORKSPACE_ID, {
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      }),
    ).rejects.toBeInstanceOf(OpenGeniApiError);

    const invalid = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () =>
        new Response(JSON.stringify({ provider: "openai", text: "leak" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
        }),
    });
    await expect(
      invalid.transcribeAudio(WORKSPACE_ID, {
        audio: new Uint8Array([1]),
        mimeType: "audio/webm",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
