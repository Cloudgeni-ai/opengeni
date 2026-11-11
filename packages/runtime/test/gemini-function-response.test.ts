import { describe, expect, test } from "bun:test";
import type { ResolvedModelProvider } from "@opengeni/config";
import {
  escapeGeminiFunctionResponseRefKeys,
  isGeminiUpstreamModel,
} from "../src/gemini-function-response";
import { modelRequestPolicyForProvider } from "../src/model-provider-request-policy";

function provider(
  kind: ResolvedModelProvider["kind"],
  api: ResolvedModelProvider["api"] = "responses",
): ResolvedModelProvider {
  return {
    id: "vertex-gateway",
    label: "Vertex Gateway",
    kind,
    api,
    builtin: false,
    baseUrl: "https://ai-gateway.vercel.sh/v1",
  } as ResolvedModelProvider;
}

// Shape of a `tool_search` result: zod-generated parameter schemas with $defs/$ref.
const toolSearchOutput = JSON.stringify({
  tools: [
    {
      name: "files_write",
      parameters: {
        type: "object",
        $defs: { __schema0: { type: "string" } },
        properties: { path: { $ref: "#/$defs/__schema0" }, nested: { $ref: "x" } },
      },
      description: 'Literal text "$ref": stays inside a value',
    },
  ],
});

function responsesBody(model: string) {
  return {
    model,
    input: [
      { role: "user", content: "search tools" },
      { type: "function_call", call_id: "c1", name: "tool_search", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: toolSearchOutput },
      {
        type: "function_call_output",
        call_id: "c2",
        output: [{ type: "input_text", text: toolSearchOutput }],
      },
    ],
  };
}

describe("Gemini function-response $ref projection", () => {
  test("detects Gemini upstream ids across routes", () => {
    expect(isGeminiUpstreamModel("vmc/gemini-3-8-flash-vertex")).toBe(true);
    expect(isGeminiUpstreamModel("google/gemini-3-pro")).toBe(true);
    expect(isGeminiUpstreamModel("openai/gpt-6.1")).toBe(false);
    expect(isGeminiUpstreamModel(undefined)).toBe(false);
  });

  test("renames only JSON object keys that decode to $ref", () => {
    const escaped = escapeGeminiFunctionResponseRefKeys(toolSearchOutput);
    const parsed = JSON.parse(escaped);
    const params = parsed.tools[0].parameters;
    expect(params.properties.path).toEqual({ _$ref: "#/$defs/__schema0" });
    expect(params.properties.nested).toEqual({ _$ref: "x" });
    expect(params.$defs).toEqual({ __schema0: { type: "string" } });
    expect(parsed.tools[0].description).toBe('Literal text "$ref": stays inside a value');
    expect(escaped).not.toMatch(/"\$ref"\s*:/u);
    // Deterministic and idempotent.
    expect(escapeGeminiFunctionResponseRefKeys(toolSearchOutput)).toBe(escaped);
    expect(escapeGeminiFunctionResponseRefKeys(escaped)).toBe(escaped);
  });

  test("leaves non-JSON and $ref-free text byte-identical", () => {
    const shell = 'grep output: "$ref": "#/a" (not json';
    expect(escapeGeminiFunctionResponseRefKeys(shell)).toBe(shell);
    const plain = JSON.stringify({ ref: 1, value: "$ref" });
    expect(escapeGeminiFunctionResponseRefKeys(plain)).toBe(plain);
  });

  for (const kind of ["api-key", "vercel-gateway-workspace", "openrouter-workspace"] as const) {
    test(`transforms Responses tool outputs for a Gemini upstream (${kind})`, () => {
      const body = responsesBody("vmc/gemini-3-8-flash-vertex");
      const snapshot = structuredClone(body);
      const policy = modelRequestPolicyForProvider(
        provider(kind),
        new Map([["vmc/gemini-3-8-flash-vertex", undefined]]),
      );
      const result = policy({ path: "/responses", body });
      const input = result?.body?.input as Array<Record<string, any>>;
      expect(JSON.stringify(input)).not.toContain('\\"$ref\\":');
      expect(JSON.parse(input[2]!.output).tools[0].parameters.properties.path).toEqual({
        _$ref: "#/$defs/__schema0",
      });
      expect(JSON.parse(input[3]!.output[0].text).tools[0].parameters.properties.path).toEqual({
        _$ref: "#/$defs/__schema0",
      });
      // Copy-on-write: the caller's (canonical) graph is untouched.
      expect(body).toEqual(snapshot);
    });
  }

  test("transforms Chat tool messages for a Gemini upstream", () => {
    const body = {
      model: "google/gemini-3-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "c1", content: toolSearchOutput },
      ],
    };
    const result = modelRequestPolicyForProvider(provider("api-key", "chat"))({
      path: "/chat/completions",
      body,
    });
    const messages = result?.body?.messages as Array<Record<string, any>>;
    expect(messages[1]!.content).not.toMatch(/"\$ref"\s*:/u);
    expect(body.messages[1]!.content).toBe(toolSearchOutput);
  });

  test("leaves non-Gemini routes untouched", () => {
    const body = responsesBody("openai/gpt-6.1");
    const result = modelRequestPolicyForProvider(provider("api-key"))({
      path: "/responses",
      body,
    });
    expect(result).toBeUndefined();
  });
});
