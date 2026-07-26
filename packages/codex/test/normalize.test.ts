import { describe, expect, test } from "bun:test";
import { buildModelResolver, CODEX_FALLBACK_MODEL_SLUGS, normalizeCodexRequestBody } from "../src";

const identity = (s: string): string => s;

describe("normalizeCodexRequestBody", () => {
  test("forces store:false + stream:true and strips max token fields", () => {
    const body = normalizeCodexRequestBody(
      { model: "gpt-5.6-sol", stream: false, max_output_tokens: 1000, max_completion_tokens: 2000 },
      identity,
    );
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true); // backend is streaming-only
    expect("max_output_tokens" in body).toBe(false);
    expect("max_completion_tokens" in body).toBe(false);
  });

  test("unions include with reasoning.encrypted_content, idempotently", () => {
    expect(normalizeCodexRequestBody({}, identity).include).toEqual([
      "reasoning.encrypted_content",
    ]);
    const already = normalizeCodexRequestBody(
      { include: ["reasoning.encrypted_content"] },
      identity,
    );
    expect(already.include).toEqual(["reasoning.encrypted_content"]);
    const withOther = normalizeCodexRequestBody({ include: ["foo"] }, identity);
    expect(withOther.include).toEqual(["foo", "reasoning.encrypted_content"]);
  });

  test("downgrades reasoning effort minimal -> low, leaves others", () => {
    expect(
      (
        normalizeCodexRequestBody({ reasoning: { effort: "minimal" } }, identity).reasoning as {
          effort: string;
        }
      ).effort,
    ).toBe("low");
    expect(
      (
        normalizeCodexRequestBody({ reasoning: { effort: "high" } }, identity).reasoning as {
          effort: string;
        }
      ).effort,
    ).toBe("high");
  });

  test("strips every item id but PRESERVES call_id", () => {
    const body = normalizeCodexRequestBody(
      {
        input: [
          { type: "message", id: "msg_1", role: "user", content: [] },
          { type: "function_call", id: "fc_1", call_id: "call_abc", name: "x", arguments: "{}" },
          { type: "function_call_output", id: "out_1", call_id: "call_abc", output: "ok" },
          { type: "reasoning", id: "rs_1", encrypted_content: "blob" },
        ],
      },
      identity,
    );
    const input = body.input as Array<Record<string, unknown>>;
    for (const item of input) {
      expect("id" in item).toBe(false);
    }
    expect(input[1]?.call_id).toBe("call_abc");
    expect(input[2]?.call_id).toBe("call_abc");
    expect(input[3]?.encrypted_content).toBe("blob"); // reasoning continuity preserved
  });

  test("does NOT remove item_reference items or convert orphans (verdict §0 a/c)", () => {
    // item_reference never appears from @openai/agents; if one did, we leave it untouched.
    const body = normalizeCodexRequestBody(
      { input: [{ type: "item_reference", id: "x" }] },
      identity,
    );
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.length).toBe(1);
    expect(input[0]?.type).toBe("item_reference");
  });

  test("leaves tools / tool_choice / parallel_tool_calls / text untouched", () => {
    const original = {
      tools: [{ type: "function" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      text: { verbosity: "low" },
    };
    const body = normalizeCodexRequestBody({ ...original }, identity);
    expect(body.tools).toEqual(original.tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.text).toEqual(original.text);
  });

  test("allowlists top-level fields: strips everything the strict backend rejects", () => {
    const body = normalizeCodexRequestBody(
      {
        model: "gpt-5.6-sol",
        instructions: "be helpful",
        input: [{ type: "message", role: "user", content: [] }],
        tools: [{ type: "function", name: "f" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning: { effort: "medium" },
        text: { verbosity: "low" },
        prompt_cache_key: "thread_1",
        // All of these are rejected by the ChatGPT/Codex backend (confirmed live:
        // "Unsupported parameter: …" / "Unsupported service_tier") and MUST be stripped.
        temperature: 0.7,
        top_p: 0.9,
        metadata: { a: "b" },
        previous_response_id: "resp_123",
        logprobs: true,
        top_logprobs: 5,
        service_tier: "auto",
        user: "u",
        safety_identifier: "s",
        truncation: "auto",
        max_tool_calls: 10,
        background: false,
        conversation: "conv_1",
      },
      identity,
    );
    for (const k of [
      "model",
      "instructions",
      "input",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "store",
      "stream",
      "include",
      "prompt_cache_key",
      "text",
    ]) {
      expect(k in body).toBe(true); // allowlisted -> kept
    }
    for (const k of [
      "temperature",
      "top_p",
      "metadata",
      "previous_response_id",
      "logprobs",
      "top_logprobs",
      "service_tier",
      "user",
      "safety_identifier",
      "truncation",
      "max_tool_calls",
      "background",
      "conversation",
    ]) {
      expect(k in body).toBe(false); // not on the allowlist -> stripped
    }
  });

  test("drops hosted-MCP tool entries (Unsupported tool type: mcp), keeps function tools", () => {
    const body = normalizeCodexRequestBody(
      {
        tools: [
          { type: "function", name: "keep_me" },
          { type: "mcp", server_label: "x", server_url: "https://x/mcp" },
          { type: "function", name: "keep_me_too" },
        ],
      },
      identity,
    );
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.type)).toEqual(["function", "function"]);
    expect(tools.map((t) => t.name)).toEqual(["keep_me", "keep_me_too"]);
  });

  test("applies the model resolver to body.model", () => {
    const body = normalizeCodexRequestBody(
      { model: "gpt-5.2-codex-high" },
      buildModelResolver(["gpt-5.2-codex", "gpt-5.6-sol"], "gpt-5.6-sol"),
    );
    expect(body.model).toBe("gpt-5.2-codex");
  });
});

describe("buildModelResolver", () => {
  const resolve = buildModelResolver(
    ["gpt-5.6-sol", "gpt-5.4", "gpt-5.2-codex", "gpt-5.4-mini"],
    "gpt-5.6-sol",
  );

  test("longest-prefix match wins", () => {
    expect(resolve("gpt-5.2-codex-xhigh")).toBe("gpt-5.2-codex");
    expect(resolve("gpt-5.4-mini")).toBe("gpt-5.4-mini"); // longer prefix beats gpt-5.4
    expect(resolve("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  test("strips one leading namespace/ segment", () => {
    expect(resolve("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  test("unknown slug -> fallback", () => {
    expect(resolve("o3-pro")).toBe("gpt-5.6-sol");
  });

  test("all exposed Codex GPT-5.6 ids reach the exact upstream slug unchanged", () => {
    const resolveExact = buildModelResolver(
      CODEX_FALLBACK_MODEL_SLUGS,
      CODEX_FALLBACK_MODEL_SLUGS[0],
    );

    for (const slug of CODEX_FALLBACK_MODEL_SLUGS) {
      expect(resolveExact(`codex/${slug}`)).toBe(slug);
    }
  });
});

describe("normalizeCodexRequestBody: tool_search replay shapes", () => {
  test("coerces a stringified tool_search_call.arguments to an object (backend 400s a string, verified live)", () => {
    const body: Record<string, unknown> = {
      model: "gpt-5.6-sol",
      input: [
        {
          type: "tool_search_call",
          id: "tsc_x",
          call_id: "c1",
          status: "completed",
          execution: "client",
          arguments: JSON.stringify({ query: "send email", limit: 5 }),
        },
        {
          type: "tool_search_output",
          call_id: "c1",
          status: "completed",
          execution: "client",
          tools: [],
        },
      ],
    };
    const out = normalizeCodexRequestBody(body, (m) => m);
    const call = (out.input as Array<Record<string, unknown>>)[0]!;
    expect(call.arguments).toEqual({ query: "send email", limit: 5 });
    expect("id" in call).toBe(false); // account-bound tsc_ id stripped like every item id
    expect(call.call_id).toBe("c1"); // pairing key preserved
  });

  test("leaves an object tool_search_call.arguments untouched; unparseable string falls back to {}", () => {
    const body: Record<string, unknown> = {
      model: "gpt-5.6-sol",
      input: [
        { type: "tool_search_call", call_id: "c1", arguments: { query: "x" } },
        { type: "tool_search_call", call_id: "c2", arguments: "not json {" },
      ],
    };
    const out = normalizeCodexRequestBody(body, (m) => m);
    const items = out.input as Array<Record<string, unknown>>;
    expect(items[0]!.arguments).toEqual({ query: "x" });
    expect(items[1]!.arguments).toEqual({});
  });

  test("tools[] entries with defer_loading and the tool_search tool type pass the normalizer untouched", () => {
    const body: Record<string, unknown> = {
      model: "gpt-5.6-sol",
      tools: [
        {
          type: "function",
          name: "codex_apps__gmail_send_email",
          defer_loading: true,
          parameters: { type: "object" },
        },
        { type: "tool_search", execution: "client", parameters: { type: "object" } },
        { type: "mcp", server_label: "x" }, // still dropped
      ],
    };
    const out = normalizeCodexRequestBody(body, (m) => m);
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.type)).toEqual(["function", "tool_search"]);
    expect(tools[0]!.defer_loading).toBe(true);
  });
});
