import { describe, expect, test } from "bun:test";
import {
  CODEX_PHYSICAL_REQUEST,
  codexRequestStorage,
  codexSubscriptionFetch,
  type CodexPhysicalRequestInit,
} from "@opengeni/codex";
import { assessModelRequestEvidence, type ModelRequestEvidence } from "@opengeni/contracts";
import {
  beginModelRequestEvidence,
  captureModelUsageEvidence,
  finishModelRequestEvidence,
  publicResponsesEvidence,
  registerModelEvidenceSecrets,
  withModelEvidencePurpose,
  withModelRequestEvidence,
} from "../src/model-request-evidence";
import { instrumentedModelFetch } from "../src/model-provider-client";

const sse = (id: string, usage: unknown = { input_tokens: 4, output_tokens: 2 }) =>
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      usage,
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
    },
  })}\n\n`;
const init = (requestId: string, transportAttempt = 1): CodexPhysicalRequestInit => ({
  method: "POST",
  body: JSON.stringify({ model: "gpt-6.1-sol", instructions: "system", tools: [], input: [] }),
  [CODEX_PHYSICAL_REQUEST]: { requestId, transportAttempt },
});
const usage = (id: string, purpose: "main" | "session-title" | "compaction" = "main") =>
  captureModelUsageEvidence({
    sourceKey: id,
    purpose,
    eventId: `event-${id}`,
    sequence: 10,
    payload: {
      sourceKey: id,
      purpose,
      inputTokens: 4,
      outputTokens: 2,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
  });
async function call(
  id: string,
  options: { attempt?: number; websocket?: boolean; text?: string } = {},
) {
  const request = init(`request-${id}`, options.attempt);
  const fetcher = instrumentedModelFetch("openai", (async (_input, received) => {
    expect((received as CodexPhysicalRequestInit)[CODEX_PHYSICAL_REQUEST]?.requestId).toBe(
      `request-${id}`,
    );
    if (options.websocket)
      (received as CodexPhysicalRequestInit)[CODEX_PHYSICAL_REQUEST]?.onWebSocketPacket?.(
        `{"type":"response.create","input":[]}`,
      );
    return new Response(options.text ?? sse(id), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch);
  return await (await fetcher("https://api.openai.com/v1/responses", request)).text();
}

describe("opt-in physical model evidence", () => {
  test("disabled is a byte-preserving pass through with no recorder", async () => {
    expect(beginModelRequestEvidence("openai", init("disabled"))).toBeUndefined();
    expect(await call("disabled")).toBe(sse("disabled"));
  });

  test("actual fetch joins request bytes, public output and committed nullable usage", async () => {
    const records: ModelRequestEvidence[] = [];
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      async () => {
        expect(await call("one")).toBe(sse("one"));
        await usage("one");
        await finishModelRequestEvidence();
        await finishModelRequestEvidence();
      },
    );
    expect(records.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(records.filter((r) => r.kind === "scope_close")).toHaveLength(1);
    expect(records.find((r) => r.kind === "request")?.content).toEqual({
      body: init("one").body,
      encoding: "normalized_fetch_body",
    });
    expect((records.find((r) => r.kind === "usage")!.content as any).cachedTokens).toBeNull();
    expect(assessModelRequestEvidence(records)).toEqual({ complete: true, issues: [] });
  });

  test("concurrent main/title and compaction retain purpose, identity, and actual websocket packet", async () => {
    const records: ModelRequestEvidence[] = [];
    await withModelRequestEvidence(
      async (r) => {
        await Promise.resolve();
        records.push(r);
      },
      async () => {
        await Promise.all([
          (async () => {
            await call("main", { websocket: true });
            await usage("main");
          })(),
          withModelEvidencePurpose("session-title", async () => {
            await call("title");
            await usage("title", "session-title");
          }),
          withModelEvidencePurpose("compaction", async () => {
            await call("compact");
            await usage("compact", "compaction");
          }),
        ]);
      },
    );
    expect(records.find((r) => r.kind === "wire_request")?.content).toEqual({
      body: '{"type":"response.create","input":[]}',
      encoding: "websocket_response_create",
    });
    for (const record of records.filter((r) => r.physical?.requestId === "request-title"))
      expect(record.purpose).toBe("session-title");
    expect(assessModelRequestEvidence(records).complete).toBe(true);
  });

  test("child scopes are independent, not inferred from parent ordinals", async () => {
    const parent: ModelRequestEvidence[] = [],
      child: ModelRequestEvidence[] = [];
    await withModelRequestEvidence(
      async (r) => {
        parent.push(r);
      },
      async () => {
        await call("parent");
        await usage("parent");
        await withModelRequestEvidence(
          async (r) => {
            child.push(r);
          },
          async () => {
            await call("child");
            await usage("child");
          },
        );
      },
    );
    expect(parent[0]?.scopeId).not.toBe(child[0]?.scopeId);
    expect(assessModelRequestEvidence([...parent, ...child]).complete).toBe(true);
  });

  test("non-streaming title Responses JSON retains actual public output and usage join", async () => {
    const records: ModelRequestEvidence[] = [];
    const body = JSON.stringify({
      id: "title-json",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "A title" }] }],
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      () =>
        withModelEvidencePurpose("session-title", async () => {
          const fetcher = instrumentedModelFetch(
            "openai",
            (async () =>
              new Response(body, {
                headers: { "content-type": "application/json" },
              })) as typeof fetch,
          );
          expect(
            await (await fetcher("https://api.openai.com/v1/responses", init("title-json"))).text(),
          ).toBe(body);
          await usage("title-json", "session-title");
        }),
    );
    expect((records.find((r) => r.kind === "response")!.content as any).encoding).toBe(
      "provider_json_response",
    );
    expect(assessModelRequestEvidence(records).complete).toBe(true);
  });

  test("exact injected credentials only, including JSON escaping; arbitrary task content survives", async () => {
    const records: ModelRequestEvidence[] = [];
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      async () => {
        registerModelEvidenceSecrets(['secret-"injected']);
        const request = beginModelRequestEvidence("openai", init("redacted"))!;
        await request.requestBody(
          JSON.stringify({
            task: "sk-legitimate-task-fixture",
            credential: 'secret-"injected',
            partial: "head ... tail",
            error: "command exit 2",
          }),
        );
      },
    );
    const record = records.find((r) => r.kind === "request")!;
    expect(JSON.stringify(record)).not.toContain("secret-");
    expect(JSON.stringify(record.content)).toContain("sk-legitimate-task-fixture");
    expect(record.redacted).toBe(true);
    expect(record.sourceSha256).toHaveLength(64);
  });

  test("public summaries retained; hidden plaintext and encrypted response state not exported", () => {
    const text = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "hidden",
          channel: "analysis",
          content: [{ text: "hidden-text" }],
        },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "hidden",
        delta: "hidden-delta",
      },
      { type: "response.reasoning_text.delta", delta: "hidden-reasoning" },
      { type: "response.reasoning_summary_text.delta", delta: "public-summary" },
      {
        type: "response.completed",
        response: {
          id: "r",
          output: [
            {
              type: "reasoning",
              summary: [{ text: "public-summary" }],
              encrypted_content: "opaque-secret",
            },
          ],
        },
      },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("");
    const result = JSON.stringify(publicResponsesEvidence(text));
    expect(result).toContain("public-summary");
    for (const absent of ["hidden-text", "hidden-delta", "hidden-reasoning", "opaque-secret"])
      expect(result).not.toContain(absent);
  });

  test("late analysis attribution and unknown provider fields never become public reasoning", () => {
    const text = [
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "late",
        delta: "hidden-late",
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        part: { type: "output_text", text: "hidden-part" },
      },
      { type: "response.future_internal.delta", delta: "unclassified-private" },
      {
        type: "response.completed",
        response: {
          id: "r",
          output: [
            {
              type: "message",
              id: "late",
              channel: "analysis",
              content: [{ text: "hidden-final" }],
            },
          ],
        },
      },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("");
    const projected = publicResponsesEvidence(text);
    for (const privateText of [
      "hidden-late",
      "hidden-part",
      "hidden-final",
      "unclassified-private",
    ])
      expect(JSON.stringify(projected)).not.toContain(privateText);
    expect(projected.unsupported).toBe(true);
  });

  test("offered tools, partial/error tool results and media references stay exact request content", async () => {
    const records: ModelRequestEvidence[] = [];
    const body = JSON.stringify({
      instructions: "system",
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
      input: [
        { type: "function_call_output", call_id: "call", output: "head [truncated] tail; exit 2" },
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://fixture.example/image" }],
        },
      ],
    });
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      async () => {
        const request = init("media");
        request.body = body;
        await beginModelRequestEvidence("openai", request)!.requestBody(body);
      },
    );
    expect((records.find((r) => r.kind === "request")!.content as any).body).toBe(body);
    expect(assessModelRequestEvidence(records).complete).toBe(false); // No response/usage, no invented media bytes.
  });

  test.each([
    "missing-usage",
    "missing-terminal",
    "bad-json",
    "oversize",
    "transport-error",
    "persistence-error",
  ])("strict completeness rejects %s", async (failure) => {
    const records: ModelRequestEvidence[] = [];
    let once = true;
    await withModelRequestEvidence(
      async (r) => {
        if (failure === "persistence-error" && r.kind === "request" && once) {
          once = false;
          throw new Error("fixture persistence rejected");
        }
        records.push(r);
      },
      async () => {
        if (failure === "transport-error") {
          const evidence = beginModelRequestEvidence("openai", init("failure"))!;
          await evidence.requestBody("{}");
          await evidence.failed();
        } else {
          await call("failure", {
            text:
              failure === "missing-terminal"
                ? 'data: {"type":"response.created"}\n\n'
                : failure === "bad-json"
                  ? "data: not-json\n\n"
                  : failure === "oversize"
                    ? "x".repeat(4 * 1024 * 1024 + 1)
                    : sse("failure"),
          });
        }
        if (failure !== "missing-usage") await usage("failure");
      },
    );
    expect(assessModelRequestEvidence(records).complete).toBe(false);
    expect(records.at(-1)?.kind).toBe("scope_close");
  });

  test("cancellation closes stalled observation explicitly without consuming or hanging inference", async () => {
    const records: ModelRequestEvidence[] = [];
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      async () => {
        const evidence = beginModelRequestEvidence("openai", init("cancel"))!;
        await evidence.requestBody("{}");
        const response = evidence.observeResponse(
          new Response(new ReadableStream({ start() {} }), {
            headers: { "content-type": "text/event-stream" },
          }),
        );
        void response.body!.cancel();
      },
    );
    expect(records.some((r) => r.kind === "response" && r.status === "unavailable")).toBe(true);
    expect(assessModelRequestEvidence(records).complete).toBe(false);
  });

  test("a failed provider stream retains the available public prefix as incomplete", async () => {
    const records: ModelRequestEvidence[] = [];
    let read = false;
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      async () => {
        const evidence = beginModelRequestEvidence("openai", init("partial-failure"))!;
        await evidence.requestBody("{}");
        const response = evidence.observeResponse(
          new Response(
            new ReadableStream({
              pull(controller) {
                if (read) controller.error(new Error("fixture stream failed"));
                else {
                  read = true;
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"type":"response.output_text.delta","delta":"public partial text"}\n\n',
                    ),
                  );
                }
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
        await expect(response.text()).rejects.toThrow("fixture stream failed");
      },
    );
    const response = records.find((r) => r.kind === "response")!;
    expect(response.status).toBe("unavailable");
    expect(JSON.stringify(response.content)).toContain("public partial text");
    expect(response.details?.capturedPrefixOnly).toBe(true);
    expect(assessModelRequestEvidence(records).complete).toBe(false);
  });

  test("retry attempts do not collapse and unavailable first physical request denies completeness", async () => {
    const records: ModelRequestEvidence[] = [];
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      async () => {
        const first = beginModelRequestEvidence("openai", init("request-retry", 1))!;
        await first.requestBody("{}");
        await first.failed();
        await call("retry", { attempt: 2 });
        await usage("retry");
      },
    );
    expect(
      records.filter((r) => r.kind === "request").map((r) => r.physical?.transportAttempt),
    ).toEqual([1, 2]);
    expect(assessModelRequestEvidence(records).complete).toBe(false);
  });

  test("a stalled optional sink is bounded, not an inference retry or fabricated pass", async () => {
    const records: ModelRequestEvidence[] = [];
    await withModelRequestEvidence(
      async (r) => {
        if (r.kind === "request") await new Promise<void>(() => {});
        else records.push(r);
      },
      async () => {
        await call("stalled");
        await usage("stalled");
      },
      { sinkTimeoutMs: 10 },
    );
    expect(records.at(-1)?.details?.errors).toBe(1);
    expect(assessModelRequestEvidence(records).complete).toBe(false);
  });

  test("actual Codex auth retry supplies one logical ID and separate physical attempts without evidence wire fields", async () => {
    const records: ModelRequestEvidence[] = [];
    const identities: unknown[] = [];
    let count = 0;
    await withModelRequestEvidence(
      async (r) => {
        records.push(r);
      },
      async () => {
        const fetcher = codexSubscriptionFetch(
          instrumentedModelFetch("codex", (async (_url, request) => {
            identities.push((request as CodexPhysicalRequestInit)[CODEX_PHYSICAL_REQUEST]);
            const headers = new Headers(request?.headers);
            expect([...headers.keys()].some((name) => name.includes("evidence"))).toBe(false);
            expect(String(request?.body)).not.toContain("transportAttempt");
            return ++count === 1
              ? new Response("fixture unauthorized", { status: 401 })
              : new Response(sse("retried"), { headers: { "content-type": "text/event-stream" } });
          }) as typeof fetch),
        );
        await codexRequestStorage.run(
          {
            clientVersion: "fixture",
            nextRequestId: () => "one-logical-request",
            getToken: async () => ({
              accessToken: "fixture-one",
              chatgptAccountId: "fixture",
              isFedramp: false,
            }),
            refresh: async () => ({
              accessToken: "fixture-two",
              chatgptAccountId: "fixture",
              isFedramp: false,
            }),
            resolveModel: (s) => s,
          },
          async () => {
            const response = await fetcher("https://chatgpt.com/backend-api/codex/responses", {
              method: "POST",
              body: JSON.stringify({ model: "gpt-6.1-sol", input: [], stream: true }),
            });
            await response.text();
          },
        );
        await usage("retried");
      },
    );
    expect(identities).toEqual([
      {
        requestId: "one-logical-request",
        transportAttempt: 1,
        onWebSocketPacket: expect.any(Function),
      },
      {
        requestId: "one-logical-request",
        transportAttempt: 2,
        onWebSocketPacket: expect.any(Function),
      },
    ]);
    expect(records.filter((r) => r.kind === "request")).toHaveLength(2);
    expect(records.filter((r) => r.kind === "response")).toHaveLength(2);
    expect(assessModelRequestEvidence(records).complete).toBe(false);
  });
});
