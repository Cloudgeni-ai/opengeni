import { createHash } from "node:crypto";
import type { ModelRequest } from "@openai/agents";
import { ModelContextSnapshot } from "../../packages/contracts/src";
import {
  buildModelContextSnapshotFromRequest,
  buildProviderRequestSnapshot,
} from "../../packages/runtime/src/model-context-inspector";
import { encodeModelContextSnapshotContent } from "../../packages/db/src/session-content-blobs";

// Synthetic, content-free accounting work. No model, database or provider calls.
const tools = Array.from({ length: 128 }, (_, index) => ({
  type: "function" as const,
  name: `fixture_tool_${index}`,
  description: "Inspect or update the selected fixture. ".repeat(12),
  parameters: {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 16 }, (_field, property) => [
        `field_${property}`,
        {
          type: "string",
          description: `Fixture field ${property}: ${'ASCII 日本語 😀 \\ " \n'.repeat(8)}`,
          enum: ["first", "second", "third"],
        },
      ]),
    ),
    required: ["field_0"],
    additionalProperties: false,
  },
}));
const instructions = "Synthetic stable instructions. ".repeat(1_000);
const request = { systemInstructions: instructions, tools } as unknown as ModelRequest;
const body = JSON.stringify({
  instructions,
  tools,
  input: Array.from({ length: 128 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Fixture ${index} ${"Plain history text. 日本語 😀 ".repeat(256)}`,
  })),
});
const now = new Date("2026-01-01T00:00:00Z");
const run = () => {
  const started = performance.now();
  const sdk = buildModelContextSnapshotFromRequest({
    request,
    agent: {},
    persistentLayers: [],
    genesisTitleDirective: "",
    requestIndex: 1,
    skillSelections: [],
    now,
  });
  const afterSdk = performance.now();
  const provider = buildProviderRequestSnapshot({ provider: "fixture", body, requestIndex: 2 });
  provider.capturedAt = now.toISOString();
  const afterProvider = performance.now();
  const parsed = [sdk, provider].map((snapshot) => ModelContextSnapshot.parse(snapshot));
  const sizes = parsed.map((snapshot) => Buffer.byteLength(JSON.stringify(snapshot)));
  const afterParse = performance.now();
  const encoded = parsed.map(encodeModelContextSnapshotContent);
  const end = performance.now();
  return {
    ms: {
      sdk: afterSdk - started,
      provider: afterProvider - afterSdk,
      validationAndSize: afterParse - afterProvider,
      encoding: end - afterParse,
      total: end - started,
    },
    sizes,
    digest: createHash("sha256")
      .update(JSON.stringify({ parsed, refs: encoded.map((item) => item.refs) }))
      .digest("hex"),
  };
};
for (let index = 0; index < 5; index++) run();
const samples = Array.from({ length: 30 }, run);
const median = (numbers: number[]) =>
  numbers.toSorted((a, b) => a - b)[Math.floor(numbers.length / 2)];
console.log(
  JSON.stringify(
    {
      toolCount: tools.length,
      requestBytes: Buffer.byteLength(body),
      samples,
      medianMs: Object.fromEntries(
        Object.keys(samples[0]!.ms).map((key) => [
          key,
          median(samples.map((sample) => sample.ms[key as keyof typeof sample.ms])),
        ]),
      ),
    },
    null,
    2,
  ),
);
