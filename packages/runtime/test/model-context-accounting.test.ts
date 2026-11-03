import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "@openai/agents";
import { estimateSerializedValueTokens } from "../src/context-compaction";
import {
  buildModelContextSnapshotFromRequest,
  buildProviderRequestSnapshot,
} from "../src/model-context-inspector";

const values: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1.25,
  1e-30,
  1e30,
  "",
  "ascii",
  "日本語",
  "😀",
  "\ud800",
  "\udc00",
  '\u0000\n\r\t"\\',
  [],
  {},
  [null, "😀", 7],
  { "日本語\ud800": "😀", nested: [true, {}] },
];
for (let index = 0; index < 200; index++) {
  values.push({
    [`field_${index}_😀`]: values[index % 20],
    nested: [values[(index + 7) % 20], { leaf: values[(index + 13) % 20] }],
  });
}

function sdkSnapshot(tools: unknown[]) {
  const request = { systemInstructions: "Unchanged instructions 😀", tools } as ModelRequest;
  const before = JSON.stringify(request);
  const snapshot = buildModelContextSnapshotFromRequest({
    request,
    agent: {},
    persistentLayers: [],
    genesisTitleDirective: "",
    requestIndex: 4,
    skillSelections: [],
    now: new Date("2026-01-01T00:00:00Z"),
  });
  expect(JSON.stringify(request)).toBe(before);
  expect(snapshot.instructions).toBe(request.systemInstructions);
  return snapshot;
}

describe("observational model-context accounting", () => {
  test("tool counters match the original estimator for JSON and omitted fields", () => {
    const inputs = [...values, undefined, { omitted: undefined, list: [undefined, NaN] }].map(
      (schema, index) => ({
        type: "function",
        name: `tool_${index}`,
        description: index % 2 ? "" : "日本語😀",
        namespace: index % 3 ? undefined : "fixture",
        parameters: schema,
      }),
    );
    const snapshot = sdkSnapshot(inputs);
    for (const [index, tool] of snapshot.tools.entries()) {
      const input = inputs[index]!;
      const measured = {
        name: input.name,
        type: input.type,
        description: input.description,
        namespace: input.namespace,
        schema: input.parameters,
      };
      expect(tool.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(measured)));
      expect(tool.estimatedTokens).toBe(estimateSerializedValueTokens(measured));
    }
    expect(snapshot.tokens.tools).toBe(
      snapshot.tools.reduce((sum, tool) => sum + tool.estimatedTokens, 0),
    );
  });

  test("provider part and per-item counters preserve raw-string and JSON rules", () => {
    for (const value of values) {
      const body = JSON.stringify({ fixture: value, input: [value, "日本語", "\ud800"] });
      const snapshot = buildProviderRequestSnapshot({ provider: "fixture", body, requestIndex: 2 });
      expect(snapshot.providerRequest?.body).toBe(body);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(snapshot.providerRequest?.parts).toEqual(
        Object.entries(parsed).map(([key, part]) => ({
          key,
          estimatedTokens: estimateSerializedValueTokens(part),
          utf8Bytes: Buffer.byteLength(JSON.stringify(part)),
          ...(Array.isArray(part)
            ? { itemEstimatedTokens: part.map(estimateSerializedValueTokens) }
            : {}),
        })),
      );
    }
  });

  test("media and encrypted content still have unknown token estimates", () => {
    for (const opaque of [
      { type: "input_image", url: "fixture" },
      { type: "image_url" },
      { type: "input_audio" },
      { type: "input_file" },
      { type: "compaction" },
      { encrypted_content: "" },
      { nested: [{ encrypted_content: "opaque" }] },
    ]) {
      const body = JSON.stringify({ input: ["plain", opaque], nested: { opaque } });
      const snapshot = buildProviderRequestSnapshot({ provider: "fixture", body, requestIndex: 3 });
      expect(snapshot.providerRequest?.body).toBe(body);
      expect(snapshot.providerRequest?.parts[0]?.estimatedTokens).toBeNull();
      expect(snapshot.providerRequest?.parts[0]?.itemEstimatedTokens).toEqual([
        estimateSerializedValueTokens("plain"),
        null,
      ]);
      expect(snapshot.providerRequest?.parts[1]?.estimatedTokens).toBeNull();
    }
  });

  test("reused mutable tool objects are recounted without cross-capture caching", () => {
    const tool = { type: "function", name: "fixture", parameters: { description: "short" } };
    const first = sdkSnapshot([tool]);
    tool.parameters.description = "日本語".repeat(200);
    const second = sdkSnapshot([tool]);
    expect(second.tools[0]!.utf8Bytes).toBeGreaterThan(first.tools[0]!.utf8Bytes);
    expect(second.tools[0]!.estimatedTokens).toBeGreaterThan(first.tools[0]!.estimatedTokens);
    const fallback = sdkSnapshot([{ type: "hosted", providerData: { value: "😀" } }]);
    expect(fallback.tools[0]!.schema).toEqual({ value: "😀" });
  });
});

describe("native Anthropic provider snapshots", () => {
  const layers = [
    {
      id: "identity" as const,
      title: "Identity",
      content: "You are a fixture agent.",
      joinBefore: "",
    },
    {
      id: "operational_contract" as const,
      title: "Operational contract",
      content: "# Rules\n\nBe precise.",
      joinBefore: "\n\n",
    },
  ];
  const instructions = "You are a fixture agent.\n\n# Rules\n\nBe precise.";
  const tools = [
    {
      name: "search_documents",
      description: "Search the product's documents.",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
      cache_control: { type: "ephemeral" },
    },
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  ];

  test("system text becomes the instructions and layers, and tools are listed", () => {
    for (const system of [
      [{ type: "text", text: instructions }],
      // The cache split: a stable prefix and its tail concatenate back exactly.
      [
        {
          type: "text",
          text: "You are a fixture agent.\n\n",
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: "# Rules\n\nBe precise." },
      ],
    ]) {
      const body = JSON.stringify({
        model: "claude-fixture",
        // A folded developer history item is context, not instructions.
        system: [...system, { type: "text", text: "<opengeni_skill_catalog>…" }],
        tools,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      const snapshot = buildProviderRequestSnapshot({
        provider: "anthropic",
        body,
        requestIndex: 1,
        persistentLayers: layers,
      });
      expect(snapshot.instructions).toBe(instructions);
      expect(snapshot.layers.map((layer) => layer.id)).toEqual([
        "identity",
        "operational_contract",
      ]);
      expect(snapshot.tokens.instructions).toBeGreaterThan(0);
      expect(snapshot.tools.map((tool) => [tool.name, tool.type, tool.visibility])).toEqual([
        ["search_documents", "function", "eager"],
        ["web_search", "web_search_20250305", "eager"],
      ]);
      expect(snapshot.tools[0]!.description).toBe("Search the product's documents.");
      expect(snapshot.tools[0]!.schema).toEqual(tools[0]!.input_schema);
      expect(snapshot.tools[1]!.schema).toEqual({ max_uses: 5 });
      expect(snapshot.providerRequest?.body).toBe(body);
    }
  });

  test("Responses bodies keep the body as the only copy of their contents", () => {
    const body = JSON.stringify({ instructions, tools: [{ type: "function", name: "x" }] });
    const snapshot = buildProviderRequestSnapshot({
      provider: "openai",
      body,
      requestIndex: 1,
      persistentLayers: layers,
    });
    expect(snapshot.instructions).toBe("");
    expect(snapshot.tools).toEqual([]);
    expect(snapshot.layers.map((layer) => layer.id)).toEqual(["identity", "operational_contract"]);
  });
});
