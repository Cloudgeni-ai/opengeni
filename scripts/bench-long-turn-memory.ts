import {
  Agent,
  OpenAIProvider,
  OpenAIResponsesModel,
  Runner,
  tool,
  type AgentInputItem,
} from "@openai/agents";
import { heapStats } from "bun:jsc";
import { createHash } from "node:crypto";
import { sanitizeHistoryItemsForModel } from "../packages/runtime/src/history-sanitizer";
import { AppendOnlyOpenAIResponsesModel } from "../packages/runtime/src/append-only-responses-model";
import { ReplayableJsonOpenAI } from "../packages/runtime/src/replayable-json-body";

const MODEL_CALLS = positiveInteger(process.env.OPENGENI_BENCH_MODEL_CALLS, 300);
const INITIAL_ITEMS = positiveInteger(process.env.OPENGENI_BENCH_INITIAL_ITEMS, 156);
const INITIAL_ITEM_BYTES = positiveInteger(process.env.OPENGENI_BENCH_INITIAL_ITEM_BYTES, 2_400);
const TOOL_OUTPUT_BYTES = positiveInteger(process.env.OPENGENI_BENCH_TOOL_OUTPUT_BYTES, 3_000);
const TOOLS_PER_CALL = positiveInteger(process.env.OPENGENI_BENCH_TOOLS_PER_CALL, 1);
const REASONING_ITEMS_PER_CALL = positiveInteger(
  process.env.OPENGENI_BENCH_REASONING_ITEMS_PER_CALL,
  1,
);
const OPAQUE_REASONING_BYTES = nonNegativeInteger(
  process.env.OPENGENI_BENCH_OPAQUE_REASONING_BYTES,
  100_000,
);
const RECONCILE_EACH_RESPONSE = process.env.OPENGENI_BENCH_RECONCILE === "1";
const REPLAYABLE_JSON = process.env.OPENGENI_BENCH_REPLAYABLE_JSON === "1";
const INCREMENTAL_RESPONSES_INPUT = process.env.OPENGENI_BENCH_INCREMENTAL_RESPONSES_INPUT === "1";
const LAST_MODEL_RESPONSE_ONLY = process.env.OPENGENI_BENCH_LAST_MODEL_RESPONSE_ONLY === "1";
const GC_EACH_REQUEST = process.env.OPENGENI_BENCH_GC_EACH_REQUEST === "1";

if (process.argv.includes("--check") && !process.argv.includes("--child")) {
  await runComparison();
  process.exit(0);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function initialHistory(): AgentInputItem[] {
  const payload = "h".repeat(INITIAL_ITEM_BYTES);
  return Array.from({ length: INITIAL_ITEMS }, (_, index) => ({
    type: "message",
    role: index % 2 === 0 ? "user" : "assistant",
    status: index % 2 === 0 ? undefined : "completed",
    content: [
      index % 2 === 0
        ? { type: "input_text", text: `${index}:${payload}` }
        : { type: "output_text", text: `${index}:${payload}` },
    ],
  })) as AgentInputItem[];
}

function terminalEvent(call: number): string {
  const reasoning = Array.from({ length: REASONING_ITEMS_PER_CALL }, (_, index) => ({
    type: "reasoning",
    id: `rs_${call}_${index}`,
    summary: [],
    ...(OPAQUE_REASONING_BYTES > 0
      ? { encrypted_content: `${call}:${index}:`.padEnd(OPAQUE_REASONING_BYTES, "r") }
      : {}),
  }));
  const output =
    call < MODEL_CALLS
      ? [
          ...reasoning,
          ...Array.from({ length: TOOLS_PER_CALL }, (_, index) => ({
            type: "function_call",
            id: `fc_${call}_${index}`,
            call_id: `call_${call}_${index}`,
            name: "benchmark_tool",
            arguments: JSON.stringify({ call, index }),
            status: "completed",
          })),
        ]
      : [
          ...reasoning,
          {
            type: "message",
            id: `msg_${call}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [], logprobs: [] }],
          },
        ];
  return `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: `response_${call}`,
      status: "completed",
      output,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  })}\n\n`;
}

function compactMemory() {
  const memory = process.memoryUsage();
  const heap = heapStats();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    jscHeapBytes: heap.heapSize,
    jscExtraBytes: heap.extraMemorySize,
    jscObjects: heap.objectCount,
  };
}

let call = 0;
let peakRssBytes = 0;
let peakWireBytes = 0;
const aggregateWireHash = createHash("sha256");
const samples: Array<ReturnType<typeof compactMemory> & { call: number; wireBytes: number }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input, init) => {
  call += 1;
  const wire = await measureRequestBody(init?.body);
  const wireBytes = wire.bytes;
  aggregateWireHash.update(wire.sha256).update("\0");
  if (GC_EACH_REQUEST) Bun.gc(false);
  const memory = compactMemory();
  peakRssBytes = Math.max(peakRssBytes, memory.rssBytes);
  peakWireBytes = Math.max(peakWireBytes, wireBytes);
  if (call === 1 || call % 25 === 0 || call === MODEL_CALLS) {
    samples.push({ call, wireBytes, ...memory });
  }
  return new Response(terminalEvent(call), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}) as typeof fetch;
const provider = new OpenAIProvider({
  apiKey: "benchmark",
  baseURL: "https://benchmark.invalid/v1",
  useResponses: true,
});
const providerModel = (await provider.getModel("benchmark")) as OpenAIResponsesModel;
const benchmarkClient = REPLAYABLE_JSON
  ? new ReplayableJsonOpenAI({
      apiKey: "benchmark",
      baseURL: "https://benchmark.invalid/v1",
      maxRetries: 0,
    })
  : (providerModel as unknown as { _client: ConstructorParameters<typeof OpenAIResponsesModel>[0] })
      ._client;
const model = INCREMENTAL_RESPONSES_INPUT
  ? new AppendOnlyOpenAIResponsesModel(benchmarkClient, "benchmark")
  : REPLAYABLE_JSON
    ? new OpenAIResponsesModel(benchmarkClient, "benchmark")
    : providerModel;
const benchmarkTool = tool({
  name: "benchmark_tool",
  description: "Return a deterministic bounded benchmark result.",
  parameters: {
    type: "object",
    properties: { call: { type: "number" }, index: { type: "number" } },
    required: ["call", "index"],
    additionalProperties: false,
  },
  strict: false,
  execute: ({ call: toolCall, index }: { call: number; index: number }) =>
    `${toolCall}:${index}:`.padEnd(TOOL_OUTPUT_BYTES, "t"),
});
const agent = new Agent({
  name: "long-turn-memory-benchmark",
  instructions: "Use the benchmark tool until the model returns done.",
  model,
  tools: [benchmarkTool],
});
const runner = new Runner({ tracingDisabled: true });
const history = initialHistory();
await Bun.sleep(20);
const baseline = compactMemory();
const startedAt = performance.now();
const result = await runner.run(agent, history, {
  stream: true,
  historyOwnership: "external",
  ...(LAST_MODEL_RESPONSE_ONLY ? { modelResponseRetention: "last" as const } : {}),
  maxTurns: MODEL_CALLS + 1,
});
let persistedHistoryCount = history.length;
for await (const event of result.toStream()) {
  if (
    RECONCILE_EACH_RESPONSE &&
    event.type === "raw_model_stream_event" &&
    event.data.type === "response_done"
  ) {
    const reconciled = sanitizeHistoryItemsForModel(
      result.state.history as Array<Record<string, unknown>>,
      8_192,
    );
    const newRows = reconciled.slice(persistedHistoryCount);
    const encoded = JSON.stringify(newRows);
    if (encoded.length < 2) throw new Error("reconcile benchmark lost history");
    persistedHistoryCount = reconciled.length;
  }
}
await result.completed;
globalThis.fetch = originalFetch;
const beforeGc = compactMemory();
Bun.gc(true);
await Bun.sleep(100);
const afterGc = compactMemory();

const serializedStateBytes = Buffer.byteLength(result.state.toString(), "utf8");
console.log(
  JSON.stringify(
    {
      parameters: {
        modelCalls: MODEL_CALLS,
        initialItems: INITIAL_ITEMS,
        initialItemBytes: INITIAL_ITEM_BYTES,
        toolOutputBytes: TOOL_OUTPUT_BYTES,
        toolsPerCall: TOOLS_PER_CALL,
        reasoningItemsPerCall: REASONING_ITEMS_PER_CALL,
        opaqueReasoningBytes: OPAQUE_REASONING_BYTES,
        reconcileEachResponse: RECONCILE_EACH_RESPONSE,
        replayableJson: REPLAYABLE_JSON,
        incrementalResponsesInput: INCREMENTAL_RESPONSES_INPUT,
        lastModelResponseOnly: LAST_MODEL_RESPONSE_ONLY,
        gcEachRequest: GC_EACH_REQUEST,
      },
      elapsedMs: performance.now() - startedAt,
      calls: call,
      peakRssBytes,
      peakWireBytes,
      wireFingerprint: aggregateWireHash.digest("hex"),
      baseline,
      beforeGc,
      afterGc,
      retained: {
        historyItems: result.history.length,
        generatedItems: result.newItems.length,
        modelResponses: result.rawResponses.length,
        serializedStateBytes,
      },
      samples,
    },
    null,
    2,
  ),
);

async function measureRequestBody(
  body: BodyInit | null | undefined,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  if (body === undefined || body === null) return { bytes: 0, sha256: hash.digest("hex") };
  if (typeof body === "string") {
    hash.update(body);
    return { bytes: Buffer.byteLength(body, "utf8"), sha256: hash.digest("hex") };
  }
  if (body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    hash.update(bytes);
    return { bytes: bytes.byteLength, sha256: hash.digest("hex") };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    hash.update(bytes);
    return { bytes: bytes.byteLength, sha256: hash.digest("hex") };
  }
  if (body instanceof ReadableStream) {
    let bytes = 0;
    const reader = body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) return { bytes, sha256: hash.digest("hex") };
      bytes += next.value.byteLength;
      hash.update(next.value);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
  }
  const text = await new Response(body).text();
  hash.update(text);
  return { bytes: Buffer.byteLength(text, "utf8"), sha256: hash.digest("hex") };
}

type BenchmarkOutput = {
  elapsedMs: number;
  calls: number;
  peakRssBytes: number;
  peakWireBytes: number;
  wireFingerprint: string;
  baseline: { rssBytes: number };
  beforeGc: { rssBytes: number };
  retained: {
    historyItems: number;
    generatedItems: number;
    modelResponses: number;
    serializedStateBytes: number;
  };
};

async function runComparison(): Promise<void> {
  const runs = positiveInteger(process.env.OPENGENI_BENCH_RUNS, 3);
  const productionShape = {
    OPENGENI_BENCH_MODEL_CALLS: process.env.OPENGENI_BENCH_MODEL_CALLS ?? "233",
    OPENGENI_BENCH_TOOLS_PER_CALL: process.env.OPENGENI_BENCH_TOOLS_PER_CALL ?? "14",
    OPENGENI_BENCH_REASONING_ITEMS_PER_CALL:
      process.env.OPENGENI_BENCH_REASONING_ITEMS_PER_CALL ?? "12",
    OPENGENI_BENCH_OPAQUE_REASONING_BYTES:
      process.env.OPENGENI_BENCH_OPAQUE_REASONING_BYTES ?? "1900",
    OPENGENI_BENCH_TOOL_OUTPUT_BYTES: process.env.OPENGENI_BENCH_TOOL_OUTPUT_BYTES ?? "3400",
    OPENGENI_BENCH_RECONCILE: process.env.OPENGENI_BENCH_RECONCILE ?? "1",
  };
  const run = async (optimized: boolean): Promise<BenchmarkOutput> => {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...productionShape,
        OPENGENI_BENCH_REPLAYABLE_JSON: optimized ? "1" : "0",
        OPENGENI_BENCH_INCREMENTAL_RESPONSES_INPUT: optimized ? "1" : "0",
        OPENGENI_BENCH_LAST_MODEL_RESPONSE_ONLY: optimized ? "1" : "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`long-turn benchmark failed: ${stderr.trim()}`);
    return JSON.parse(stdout) as BenchmarkOutput;
  };

  const baselineRuns: BenchmarkOutput[] = [];
  const optimizedRuns: BenchmarkOutput[] = [];
  for (let index = 0; index < runs; index += 1) {
    // Alternate order so host temperature and filesystem cache cannot
    // systematically favor either pipeline.
    const order = index % 2 === 0 ? [false, true] : [true, false];
    for (const optimized of order) {
      (optimized ? optimizedRuns : baselineRuns).push(await run(optimized));
    }
  }

  const reference = baselineRuns[0]!;
  for (const candidate of [...baselineRuns, ...optimizedRuns]) {
    if (
      reference.calls !== candidate.calls ||
      reference.peakWireBytes !== candidate.peakWireBytes ||
      reference.wireFingerprint !== candidate.wireFingerprint ||
      reference.retained.historyItems !== candidate.retained.historyItems ||
      reference.retained.generatedItems !== candidate.retained.generatedItems
    ) {
      throw new Error("optimized long-turn pipeline changed model wire bytes or retained history");
    }
  }
  if (optimizedRuns.some((measurement) => measurement.retained.modelResponses !== 1)) {
    throw new Error("optimized long-turn pipeline retained more than the latest raw response");
  }

  const summarize = (results: BenchmarkOutput[]) => ({
    peakRssBytes: median(results.map((measurement) => measurement.peakRssBytes)),
    peakDeltaBytes: median(
      results.map((measurement) =>
        Math.max(0, measurement.peakRssBytes - measurement.baseline.rssBytes),
      ),
    ),
    settledRssBytes: median(results.map((measurement) => measurement.beforeGc.rssBytes)),
    settledDeltaBytes: median(
      results.map((measurement) =>
        Math.max(0, measurement.beforeGc.rssBytes - measurement.baseline.rssBytes),
      ),
    ),
    elapsedMs: median(results.map((measurement) => measurement.elapsedMs)),
    stateBytes: median(results.map((measurement) => measurement.retained.serializedStateBytes)),
  });
  const baselineSummary = summarize(baselineRuns);
  const optimizedSummary = summarize(optimizedRuns);
  const peakRatio = optimizedSummary.peakRssBytes / baselineSummary.peakRssBytes;
  const peakDeltaRatio = optimizedSummary.peakDeltaBytes / baselineSummary.peakDeltaBytes;
  const settledRatio = optimizedSummary.settledRssBytes / baselineSummary.settledRssBytes;
  const settledDeltaRatio = optimizedSummary.settledDeltaBytes / baselineSummary.settledDeltaBytes;
  const elapsedRatio = optimizedSummary.elapsedMs / baselineSummary.elapsedMs;
  console.log(
    JSON.stringify(
      {
        runs,
        calls: reference.calls,
        wireBytes: reference.peakWireBytes,
        wireFingerprint: reference.wireFingerprint,
        baseline: {
          peakRssMiB: +(baselineSummary.peakRssBytes / 1024 ** 2).toFixed(1),
          peakDeltaMiB: +(baselineSummary.peakDeltaBytes / 1024 ** 2).toFixed(1),
          settledRssMiB: +(baselineSummary.settledRssBytes / 1024 ** 2).toFixed(1),
          settledDeltaMiB: +(baselineSummary.settledDeltaBytes / 1024 ** 2).toFixed(1),
          elapsedMs: +baselineSummary.elapsedMs.toFixed(1),
          stateMiB: +(baselineSummary.stateBytes / 1024 ** 2).toFixed(1),
        },
        optimized: {
          peakRssMiB: +(optimizedSummary.peakRssBytes / 1024 ** 2).toFixed(1),
          peakDeltaMiB: +(optimizedSummary.peakDeltaBytes / 1024 ** 2).toFixed(1),
          settledRssMiB: +(optimizedSummary.settledRssBytes / 1024 ** 2).toFixed(1),
          settledDeltaMiB: +(optimizedSummary.settledDeltaBytes / 1024 ** 2).toFixed(1),
          elapsedMs: +optimizedSummary.elapsedMs.toFixed(1),
          stateMiB: +(optimizedSummary.stateBytes / 1024 ** 2).toFixed(1),
        },
        ratios: {
          peak: +peakRatio.toFixed(3),
          peakDelta: +peakDeltaRatio.toFixed(3),
          settled: +settledRatio.toFixed(3),
          settledDelta: +settledDeltaRatio.toFixed(3),
          elapsed: +elapsedRatio.toFixed(3),
        },
        samples: {
          baseline: baselineRuns.map(sampleSummary),
          optimized: optimizedRuns.map(sampleSummary),
        },
      },
      null,
      2,
    ),
  );
  if (
    peakRatio > 0.9 ||
    peakDeltaRatio > 0.8 ||
    settledRatio > 0.9 ||
    settledDeltaRatio > 0.85 ||
    elapsedRatio > 1.5
  ) {
    throw new Error(
      `long-turn optimization floor missed: peak=${peakRatio.toFixed(2)}, peakDelta=${peakDeltaRatio.toFixed(2)}, settled=${settledRatio.toFixed(2)}, settledDelta=${settledDeltaRatio.toFixed(2)}, elapsed=${elapsedRatio.toFixed(2)}`,
    );
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function sampleSummary(measurement: BenchmarkOutput) {
  return {
    peakRssMiB: +(measurement.peakRssBytes / 1024 ** 2).toFixed(1),
    peakDeltaMiB: +((measurement.peakRssBytes - measurement.baseline.rssBytes) / 1024 ** 2).toFixed(
      1,
    ),
    settledRssMiB: +(measurement.beforeGc.rssBytes / 1024 ** 2).toFixed(1),
    settledDeltaMiB: +(
      (measurement.beforeGc.rssBytes - measurement.baseline.rssBytes) /
      1024 ** 2
    ).toFixed(1),
    elapsedMs: +measurement.elapsedMs.toFixed(1),
  };
}
