import { describe, expect, test } from "bun:test";
import { buildModelResolver, normalizeCodexRequestBody } from "../src";

const identity = (s: string): string => s;

describe("normalizeCodexRequestBody", () => {
  test("forces store:false + stream:true and strips max token fields", () => {
    const body = normalizeCodexRequestBody({ model: "gpt-5.5", stream: false, max_output_tokens: 1000, max_completion_tokens: 2000 }, identity);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true); // backend is streaming-only
    expect("max_output_tokens" in body).toBe(false);
    expect("max_completion_tokens" in body).toBe(false);
  });

  test("unions include with reasoning.encrypted_content, idempotently", () => {
    expect(normalizeCodexRequestBody({}, identity).include).toEqual(["reasoning.encrypted_content"]);
    const already = normalizeCodexRequestBody({ include: ["reasoning.encrypted_content"] }, identity);
    expect(already.include).toEqual(["reasoning.encrypted_content"]);
    const withOther = normalizeCodexRequestBody({ include: ["foo"] }, identity);
    expect(withOther.include).toEqual(["foo", "reasoning.encrypted_content"]);
  });

  test("downgrades reasoning effort minimal -> low, leaves others", () => {
    expect((normalizeCodexRequestBody({ reasoning: { effort: "minimal" } }, identity).reasoning as { effort: string }).effort).toBe("low");
    expect((normalizeCodexRequestBody({ reasoning: { effort: "high" } }, identity).reasoning as { effort: string }).effort).toBe("high");
  });

  test("strips every item id but PRESERVES call_id", () => {
    const body = normalizeCodexRequestBody({
      input: [
        { type: "message", id: "msg_1", role: "user", content: [] },
        { type: "function_call", id: "fc_1", call_id: "call_abc", name: "x", arguments: "{}" },
        { type: "function_call_output", id: "out_1", call_id: "call_abc", output: "ok" },
        { type: "reasoning", id: "rs_1", encrypted_content: "blob" },
      ],
    }, identity);
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
    const body = normalizeCodexRequestBody({ input: [{ type: "item_reference", id: "x" }] }, identity);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.length).toBe(1);
    expect(input[0]?.type).toBe("item_reference");
  });

  test("leaves tools / tool_choice / parallel_tool_calls / text untouched", () => {
    const original = { tools: [{ type: "function" }], tool_choice: "auto", parallel_tool_calls: true, text: { verbosity: "low" } };
    const body = normalizeCodexRequestBody({ ...original }, identity);
    expect(body.tools).toEqual(original.tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.text).toEqual(original.text);
  });

  test("allowlists top-level fields: strips everything the strict backend rejects", () => {
    const body = normalizeCodexRequestBody({
      model: "gpt-5.5",
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
    }, identity);
    for (const k of ["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream", "include", "prompt_cache_key", "text"]) {
      expect(k in body).toBe(true); // allowlisted -> kept
    }
    for (const k of ["temperature", "top_p", "metadata", "previous_response_id", "logprobs", "top_logprobs", "service_tier", "user", "safety_identifier", "truncation", "max_tool_calls", "background", "conversation"]) {
      expect(k in body).toBe(false); // not on the allowlist -> stripped
    }
  });

  test("drops hosted-MCP tool entries (Unsupported tool type: mcp), keeps function tools", () => {
    const body = normalizeCodexRequestBody({
      tools: [
        { type: "function", name: "keep_me" },
        { type: "mcp", server_label: "x", server_url: "https://x/mcp" },
        { type: "function", name: "keep_me_too" },
      ],
    }, identity);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.type)).toEqual(["function", "function"]);
    expect(tools.map((t) => t.name)).toEqual(["keep_me", "keep_me_too"]);
  });

  test("applies the model resolver to body.model", () => {
    const body = normalizeCodexRequestBody({ model: "gpt-5.2-codex-high" }, buildModelResolver(["gpt-5.2-codex", "gpt-5.5"], "gpt-5.5"));
    expect(body.model).toBe("gpt-5.2-codex");
  });
});

describe("buildModelResolver", () => {
  const resolve = buildModelResolver(["gpt-5.5", "gpt-5.4", "gpt-5.2-codex", "gpt-5.4-mini"], "gpt-5.5");

  test("longest-prefix match wins", () => {
    expect(resolve("gpt-5.2-codex-xhigh")).toBe("gpt-5.2-codex");
    expect(resolve("gpt-5.4-mini")).toBe("gpt-5.4-mini"); // longer prefix beats gpt-5.4
    expect(resolve("gpt-5.5")).toBe("gpt-5.5");
  });

  test("strips one leading namespace/ segment", () => {
    expect(resolve("openai/gpt-5.5")).toBe("gpt-5.5");
  });

  test("unknown slug -> fallback", () => {
    expect(resolve("o3-pro")).toBe("gpt-5.5");
  });
});
