import { describe, expect, test } from "bun:test";

import { OpenGeniClient, type FetchLike, type FetchResponse } from "../src";
import type { FetchResponse as BrowserFetchResponse } from "../src/browser";
import type { FetchResponse as CoreFetchResponse } from "../src/core";
import type { FetchResponse as ArtifactFetchResponse } from "../src/artifacts";

declare const expoResponse: Omit<Response, "bytes" | "clone" | "textStream"> & {
  clone(): typeof expoResponse;
};
const standardFetchTypeProof: FetchLike = async () => new Response();
const expoFetchTypeProof: FetchLike = async () => expoResponse;

declare const incompleteResponse: Omit<FetchResponse, "text">;
// @ts-expect-error Fetch adapters must provide the complete web Response surface.
const incompleteFetchTypeProof: FetchLike = async () => incompleteResponse;

const browserExportTypeProof = (response: FetchResponse): BrowserFetchResponse => response;
const coreExportTypeProof = (response: FetchResponse): CoreFetchResponse => response;
const artifactExportTypeProof = (response: FetchResponse): ArtifactFetchResponse => response;

void standardFetchTypeProof;
void expoFetchTypeProof;
void incompleteFetchTypeProof;
void browserExportTypeProof;
void coreExportTypeProof;
void artifactExportTypeProof;

function webResponse(body?: BodyInit | null, init?: ResponseInit): FetchResponse {
  const response = new Response(body, init);
  return {
    get body() {
      return response.body;
    },
    get bodyUsed() {
      return response.bodyUsed;
    },
    get headers() {
      return response.headers;
    },
    get ok() {
      return response.ok;
    },
    get redirected() {
      return response.redirected;
    },
    get status() {
      return response.status;
    },
    get statusText() {
      return response.statusText;
    },
    get type() {
      return response.type;
    },
    get url() {
      return response.url;
    },
    arrayBuffer: () => response.arrayBuffer(),
    blob: () => response.blob(),
    clone: () =>
      webResponse(response.clone().body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }),
    formData: () => response.formData(),
    json: () => response.json(),
    text: () => response.text(),
  };
}

describe("FetchLike", () => {
  test("accepts a web-standard response without Bun runtime extensions", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed"));
        controller.close();
      },
    });
    const response = webResponse(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect("bytes" in response).toBe(false);
    expect("textStream" in response).toBe(false);

    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () => response,
    });
    const stream = await client.openEventStream("workspace", "session");
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("streamed");
    expect((await reader.read()).done).toBe(true);
  });

  test("uses JSON and error metadata through the structural response contract", async () => {
    const success = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () =>
        webResponse(JSON.stringify({ value: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(await success.requestJson<{ value: number }>("GET", "/value")).toEqual({ value: 42 });

    const failure = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () =>
        webResponse(JSON.stringify({ message: "denied" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-opengeni-correlation-id": "correlation-test",
          },
        }),
    });
    await expect(failure.requestJson("GET", "/denied")).rejects.toMatchObject({
      status: 403,
      correlationId: "correlation-test",
      body: JSON.stringify({ message: "denied" }),
    });
  });

  test("preserves stream cancellation and request abort signals", async () => {
    let cancelReason: unknown;
    let requestSignal: AbortSignal | null | undefined;
    const response = webResponse(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancelReason = reason;
        },
      }),
      { status: 502, headers: { "content-type": "text/plain" } },
    );
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        requestSignal = init?.signal;
        return response;
      },
    });
    const abort = new AbortController();
    await expect(
      client.requestJson("GET", "/failure", undefined, {}, { signal: abort.signal }),
    ).rejects.toMatchObject({ status: 502, body: "" });
    expect(requestSignal).toBe(abort.signal);
    expect(cancelReason).toBe("discarding API error body");
  });

  test("returns structural responses for artifact downloads", async () => {
    const response = webResponse(Uint8Array.of(1, 2, 3), {
      headers: { "content-type": "application/octet-stream" },
    });
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async () => response,
    });

    const downloaded = await client.downloadEditableArtifactMaterialization(
      "workspace",
      "artifact",
      "job",
      { replicaId: "2222222222222222" },
    );

    expect("bytes" in downloaded).toBe(false);
    expect("textStream" in downloaded).toBe(false);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
  });
});
