import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTracingDisabled, type ModelRequest } from "@openai/agents";
import {
  bedrockClaudeBaseModelId,
  configuredProviders,
  setBedrockDiscoveredModels,
  type ResolvedModelProvider,
} from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import { AnthropicMessagesModel } from "../src/anthropic-messages";
import {
  bedrockApplicationProfileBaseId,
  bedrockSessionName,
  discoverBedrockModels,
  resetBedrockFallbacksForTests,
  setBedrockCredentialProviderForTests,
  withBedrockCaller,
} from "../src/bedrock";

setTracingDisabled(true);

const ROLE = "arn:aws:iam::123456789012:role/opengeni-bedrock-users";
function bedrockProvider(attribution = false): ResolvedModelProvider {
  const provider = configuredProviders(
    testSettings({
      bedrockRegion: "eu-west-1",
      bedrockModels: "eu.anthropic.claude-opus-5-5",
      ...(attribution ? { bedrockAttributionRoleArn: ROLE } : {}),
    }),
  ).find((candidate) => candidate.id === "bedrock");
  if (!provider) throw new Error("no Bedrock provider");
  return provider;
}

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  input: "Hello",
  systemInstructions: "Instructions",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
  ...overrides,
});

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Hi" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 5,
  },
};

type Call = { url: string; headers: Headers; body: string | undefined };
function recorder(...responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body as string | undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

let credentialCalls = 0;
beforeEach(() => {
  credentialCalls = 0;
  setBedrockCredentialProviderForTests(async () => {
    credentialCalls += 1;
    return { accessKeyId: "AKIDPOD", secretAccessKey: "pod-secret", sessionToken: "pod-token" };
  });
  resetBedrockFallbacksForTests();
});
afterEach(() => {
  setBedrockCredentialProviderForTests(undefined);
  setBedrockDiscoveredModels([]);
});

describe("Amazon Bedrock Messages transport", () => {
  test("signs native Messages requests with SigV4 and sends no Anthropic credential", async () => {
    const { calls, fetch } = recorder(() => json(message, 200, { "x-amzn-requestid": "aws-req" }));
    const model = new AnthropicMessagesModel(
      bedrockProvider(),
      "eu.anthropic.claude-opus-5-5",
      fetch,
    );
    const result = await model.getResponse(request());
    expect(result.responseId).toBe("msg_1");
    const [call] = calls;
    expect(call!.url).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com/anthropic/v1/messages");
    expect(call!.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDPOD\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=[^,]*anthropic-version[^,]*, Signature=[0-9a-f]{64}$/u,
    );
    expect(call!.headers.get("x-amz-security-token")).toBe("pod-token");
    expect(call!.headers.get("x-amz-content-sha256") ?? call!.headers.get("x-amz-date")).toBeTruthy();
    expect(call!.headers.has("x-api-key")).toBe(false);
    const body = JSON.parse(call!.body!);
    expect(body.model).toBe("eu.anthropic.claude-opus-5-5");
    // The Opus 5.5 profile still applies through the Bedrock id: adaptive thinking and 128k output.
    expect(body.max_tokens).toBe(128_000);
  });

  test("streams Anthropic SSE through the signed transport and keeps Bedrock's request id", async () => {
    const frames = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ];
    const { fetch } = recorder(
      () =>
        new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream", "x-amzn-requestid": "aws-stream" },
        }),
    );
    const model = new AnthropicMessagesModel(
      bedrockProvider(),
      "global.anthropic.claude-opus-5-5",
      fetch,
    );
    const events: any[] = [];
    for await (const event of model.getStreamedResponse(request())) events.push(event);
    expect(events.some((event) => event.type === "output_text_delta" && event.delta === "Hello")).toBe(
      true,
    );
    const done = events.find((event) => event.type === "response_done");
    expect(done.response.usage.outputTokens).toBe(4);
  });

  test("AWS errors keep their status, type and request id", async () => {
    const { fetch } = recorder(() =>
      json({ message: "Too many requests, please wait before trying again." }, 429, {
        "x-amzn-errortype": "ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/",
        "x-amzn-requestid": "aws-throttle",
      }),
    );
    const model = new AnthropicMessagesModel(bedrockProvider(), "eu.anthropic.claude-opus-5-5", fetch);
    const error: any = await model.getResponse(request()).catch((caught) => caught);
    expect(error.status).toBe(429);
    expect(error.request_id).toBe("aws-throttle");
    expect(error.errorType).toBe("rate_limit_error");
    expect(error.detail).toContain("ThrottlingException: Too many requests");
  });

  test("a refused beta is retried once without it and left out on that route afterwards", async () => {
    const { calls, fetch } = recorder(
      () => json({ message: "invalid beta flag" }, 400, { "x-amzn-errortype": "ValidationException" }),
      () => json(message),
      () => json(message),
    );
    const model = new AnthropicMessagesModel(bedrockProvider(), "eu.anthropic.claude-opus-5-5", fetch);
    const thinking = request({ modelSettings: { reasoning: { effort: "medium" } } });
    await model.getResponse(thinking);
    expect(calls[0]!.headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
    expect(JSON.parse(calls[0]!.body!).thinking.block_binding).toBeDefined();
    expect(calls[1]!.headers.has("anthropic-beta")).toBe(false);
    expect(JSON.parse(calls[1]!.body!).thinking.block_binding).toBeUndefined();
    expect(JSON.parse(calls[1]!.body!).thinking.type).toBe("adaptive");
    await model.getResponse(thinking);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.headers.has("anthropic-beta")).toBe(false);
  });

  test("a refused forced tool choice falls back to auto", async () => {
    const { calls, fetch } = recorder(
      () =>
        json({ message: "tool_choice type 'any' is not supported for this model" }, 400, {
          "x-amzn-errortype": "ValidationException",
        }),
      () => json(message),
    );
    const model = new AnthropicMessagesModel(bedrockProvider(), "eu.anthropic.claude-opus-5-5", fetch);
    await model.getResponse(
      request({
        modelSettings: { toolChoice: "required" },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Look up",
            parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
            strict: true,
          },
        ],
      }),
    );
    expect(JSON.parse(calls[0]!.body!).tool_choice.type).toBe("any");
    expect(JSON.parse(calls[1]!.body!).tool_choice.type).toBe("auto");
  });

  test("other refusals are not retried", async () => {
    const { calls, fetch } = recorder(() =>
      json({ message: "Operation not allowed" }, 400, { "x-amzn-errortype": "ValidationException" }),
    );
    const model = new AnthropicMessagesModel(bedrockProvider(), "eu.anthropic.claude-opus-5-5", fetch);
    const error: any = await model.getResponse(request()).catch((caught) => caught);
    expect(error.status).toBe(400);
    expect(error.detail).toBe("invalid_request_error: ValidationException: Operation not allowed");
    expect(calls).toHaveLength(1);
  });
});

describe("per-user cost attribution", () => {
  const sts = (key: string, expiresInMs = 3_600_000) => () =>
    new Response(
      `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${key}</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t-${key}</SessionToken><Expiration>${new Date(Date.now() + expiresInMs).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      { headers: { "content-type": "text/xml" } },
    );

  test("each person's requests sign with their own role session, cached until near expiry", async () => {
    const { calls, fetch } = recorder(
      sts("AKIDALICE"),
      () => json(message),
      () => json(message),
      () => json(message),
    );
    const model = new AnthropicMessagesModel(
      bedrockProvider(true),
      "eu.anthropic.claude-opus-5-5",
      fetch,
    );
    await withBedrockCaller("user_alice", () => model.getResponse(request()));
    await withBedrockCaller("user_alice", () => model.getResponse(request()));
    await model.getResponse(request());
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual([
      "sts.eu-west-1.amazonaws.com",
      "bedrock-runtime.eu-west-1.amazonaws.com",
      "bedrock-runtime.eu-west-1.amazonaws.com",
      "bedrock-runtime.eu-west-1.amazonaws.com",
    ]);
    const assume = new URLSearchParams(calls[0]!.body!);
    expect(assume.get("Action")).toBe("AssumeRole");
    expect(assume.get("RoleArn")).toBe(ROLE);
    expect(assume.get("RoleSessionName")).toBe("og-user_alice");
    expect(calls[0]!.headers.get("authorization")).toContain("Credential=AKIDPOD/");
    expect(calls[1]!.headers.get("authorization")).toContain("Credential=AKIDALICE/");
    expect(calls[2]!.headers.get("authorization")).toContain("Credential=AKIDALICE/");
    // Work started by no one (background calls) uses the deployment identity.
    expect(calls[3]!.headers.get("authorization")).toContain("Credential=AKIDPOD/");
  });

  test("a session about to expire is renewed", async () => {
    const { calls, fetch } = recorder(
      sts("AKIDOLD", 60_000),
      () => json(message),
      sts("AKIDNEW"),
      () => json(message),
    );
    const model = new AnthropicMessagesModel(
      bedrockProvider(true),
      "eu.anthropic.claude-opus-5-5",
      fetch,
    );
    await withBedrockCaller("user_bob", () => model.getResponse(request()));
    await withBedrockCaller("user_bob", () => model.getResponse(request()));
    expect(calls[3]!.headers.get("authorization")).toContain("Credential=AKIDNEW/");
  });

  test("a refused AssumeRole fails the request with the role and STS code, not a fallback", async () => {
    const { fetch } = recorder(
      () =>
        new Response(
          "<ErrorResponse><Error><Code>AccessDenied</Code><Message>not authorized</Message></Error></ErrorResponse>",
          { status: 403 },
        ),
    );
    const model = new AnthropicMessagesModel(
      bedrockProvider(true),
      "eu.anthropic.claude-opus-5-5",
      fetch,
    );
    const error: any = await withBedrockCaller("user_carol", () =>
      model.getResponse(request()),
    ).catch((caught) => caught);
    expect(error.message).toContain(ROLE);
    expect(error.message).toContain("AccessDenied");
  });

  test("session names use the stable user id and never an email address", () => {
    expect(bedrockSessionName("user_2abcDEF")).toBe("og-user_2abcDEF");
    expect(bedrockSessionName("3f1c2e4a-1234-4abc-9def-0123456789ab")).toBe(
      "og-3f1c2e4a-1234-4abc-9def-0123456789ab",
    );
    for (const id of ["harry@example.com", "id with spaces", "x".repeat(80)]) {
      const name = bedrockSessionName(id);
      expect(name).toMatch(/^og-[0-9a-f]{40}$/u);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("model discovery", () => {
  test("lists active Claude profiles, on-demand models and application profiles with their base", async () => {
    const pages: Record<string, unknown> = {
      SYSTEM_DEFINED: {
        inferenceProfileSummaries: [
          { inferenceProfileId: "eu.anthropic.claude-opus-5-5", status: "ACTIVE" },
          { inferenceProfileId: "global.anthropic.claude-opus-5-5", status: "ACTIVE" },
          { inferenceProfileId: "eu.amazon.nova-pro-v1:0", status: "ACTIVE" },
          { inferenceProfileId: "eu.anthropic.claude-3-haiku-20240307-v1:0", status: "ACTIVE" },
        ],
      },
      APPLICATION: {
        inferenceProfileSummaries: [
          {
            inferenceProfileArn:
              "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/team-a",
            inferenceProfileName: "team-a",
            status: "ACTIVE",
            models: [
              { modelArn: "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-opus-5-5" },
              { modelArn: "arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-opus-5-5" },
            ],
          },
        ],
      },
    };
    const seen: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(url.pathname + url.search);
      expect(new Headers(init?.headers).get("authorization")).toContain("/eu-west-1/bedrock/");
      if (url.pathname === "/foundation-models")
        return json({
          modelSummaries: [
            { modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", modelLifecycle: { status: "ACTIVE" } },
          ],
        });
      return json(pages[url.searchParams.get("type")!]);
    }) as typeof globalThis.fetch;
    const found = await discoverBedrockModels({ bedrockRegion: "eu-west-1" }, fetch);
    expect(found).toEqual([
      { upstreamModelId: "eu.anthropic.claude-opus-5-5" },
      { upstreamModelId: "global.anthropic.claude-opus-5-5" },
      { upstreamModelId: "anthropic.claude-haiku-4-5-20251001-v1:0" },
      {
        upstreamModelId:
          "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/team-a",
        baseUpstreamModelId: "eu.anthropic.claude-opus-5-5",
        name: "team-a",
      },
    ]);
    expect(seen[0]).toContain("type=SYSTEM_DEFINED");
    setBedrockDiscoveredModels(found);
    expect(
      bedrockClaudeBaseModelId(
        "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/team-a",
      ),
    ).toBe("claude-opus-5-5");
  });

  test("application profiles map to the system profile they copy", () => {
    const arn = (region: string) =>
      `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-opus-5-5`;
    expect(bedrockApplicationProfileBaseId([arn("eu-west-1")], "eu-west-1")).toBe(
      "anthropic.claude-opus-5-5",
    );
    expect(bedrockApplicationProfileBaseId([arn(""), arn("eu-west-1")], "eu-west-1")).toBe(
      "global.anthropic.claude-opus-5-5",
    );
    expect(bedrockApplicationProfileBaseId([arn("us-east-1"), arn("us-west-2")], "us-east-1")).toBe(
      "us.anthropic.claude-opus-5-5",
    );
    expect(bedrockApplicationProfileBaseId([arn("us-east-1"), arn("eu-west-1")], "us-east-1")).toBe(
      "global.anthropic.claude-opus-5-5",
    );
  });
});
