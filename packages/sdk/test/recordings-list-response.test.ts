import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, OpenGeniClient, type FetchLike } from "../src";
import { OpenGeniRecordingsClient } from "../src/recordings";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const json = { "content-type": "application/json" };

/** The recordings client over the real transport, with every request answered by `answer`. */
function recordingsAnswering(answer: () => Response) {
  const fetch: FetchLike = async () => answer();
  return new OpenGeniRecordingsClient(
    new OpenGeniClient({
      baseUrl: "https://host.example.test/api/opengeni",
      fetch,
      readRetry: false,
    }),
  );
}

async function listed(answer: () => Response): Promise<unknown> {
  return await recordingsAnswering(answer)
    .listRecordings(WORKSPACE, { purpose: "dictation", limit: 10 })
    .then(
      (value) => value,
      (error: unknown) => error,
    );
}

describe("listRecordings answers", () => {
  test("a recordings list resolves as sent", async () => {
    const recording = { id: "dictation-1", state: "ready", purpose: "dictation" };
    const page = await listed(
      () =>
        new Response(JSON.stringify({ recordings: [recording], nextBefore: null }), {
          headers: json,
        }),
    );
    expect(page).toEqual({ recordings: [recording], nextBefore: null });
  });

  test("a missing or malformed cursor is the end of the list", async () => {
    const page = await listed(
      () =>
        new Response(JSON.stringify({ recordings: [], nextBefore: { id: 3 } }), { headers: json }),
    );
    expect(page).toEqual({ recordings: [], nextBefore: null });
  });

  // A host proxy or test double that answers the route with something else:
  // another route's body (here a session), a differently named list, nothing,
  // or entries without ids. Each is a typed error, never a value without
  // `recordings` for a caller to crash on.
  for (const [name, body] of [
    ["another route's body", { id: "session-1", status: "running", workspaceId: WORKSPACE }],
    ["a list under another name", { items: [] }],
    ["an empty object", {}],
    ["a bare array", []],
    ["null", null],
    ["entries without ids", { recordings: [{ state: "ready" }], nextBefore: null }],
  ] as const) {
    test(`${name} is an invalid_response error`, async () => {
      const error = await listed(() => new Response(JSON.stringify(body), { headers: json }));
      expect(error).toBeInstanceOf(OpenGeniApiError);
      expect((error as OpenGeniApiError).code).toBe("invalid_response");
      expect((error as OpenGeniApiError).retryable).toBe(false);
    });
  }

  test("an empty, HTML or error answer rejects too", async () => {
    const empty = await listed(() => new Response(null, { status: 204 }));
    const html = await listed(
      () =>
        new Response("<!doctype html><title>App</title>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const refused = await listed(
      () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "Not found." } }), {
          status: 404,
          headers: json,
        }),
    );
    for (const error of [empty, html, refused]) expect(error).toBeInstanceOf(OpenGeniApiError);
    expect((refused as OpenGeniApiError).status).toBe(404);
  });
});
