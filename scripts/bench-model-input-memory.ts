import { createHash } from "node:crypto";
import {
  Agent,
  Runner,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";

type OwnershipMode = "sdk" | "external";

type ChildResult = {
  mode: OwnershipMode;
  historyItems: number;
  historyTextBytes: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  peakDeltaBytes: number;
  elapsedMs: number;
  wireItems: number;
  resultHistoryItems: number;
  portableSessionSnapshotItems: number;
  stateOriginalItemBorrowed: boolean;
  modelInputItemBorrowed: boolean;
  durableFingerprintBefore: string;
  durableFingerprintAfter: string;
  wireFingerprint: string;
};

const HISTORY_ITEMS = positiveInteger(process.env.OPENGENI_BENCH_HISTORY_ITEMS, 8_000);
const TEXT_BYTES = positiveInteger(process.env.OPENGENI_BENCH_HISTORY_TEXT_BYTES, 1_024);

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildHistory(): AgentInputItem[] {
  const payload = "x".repeat(TEXT_BYTES);
  return Array.from({ length: HISTORY_ITEMS }, (_, index) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `${index}:${payload}` }],
  })) as AgentInputItem[];
}

function fingerprint(items: readonly unknown[]): string {
  const hash = createHash("sha256");
  for (const item of items) {
    const record = item as Record<string, unknown>;
    hash.update(String(record.type ?? ""));
    hash.update("\0");
    hash.update(String(record.role ?? ""));
    hash.update("\0");
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      const partRecord = part as Record<string, unknown>;
      hash.update(String(partRecord.type ?? ""));
      hash.update("\0");
      hash.update(String(partRecord.text ?? ""));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function finalMessage(text: string): ModelResponse["output"][number] {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

class MeasuringModel implements Model {
  peakRssBytes = 0;
  wireFingerprint = "";
  wireItems = 0;
  modelInputItemBorrowed = false;

  constructor(private readonly originalFirstItem: AgentInputItem | undefined) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error("benchmark requires the streaming path");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.wireItems = request.input.length;
    this.modelInputItemBorrowed = request.input[0] === this.originalFirstItem;
    this.peakRssBytes = Math.max(this.peakRssBytes, process.memoryUsage().rss);
    this.wireFingerprint = fingerprint(request.input);
    this.peakRssBytes = Math.max(this.peakRssBytes, process.memoryUsage().rss);
    yield { type: "response_started" } as StreamEvent;
    yield {
      type: "response_done",
      response: {
        id: "benchmark-response",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [finalMessage("done")],
      },
    } as StreamEvent;
  }
}

async function runChild(mode: OwnershipMode): Promise<void> {
  const history = buildHistory();
  for (const item of history) {
    if (item && typeof item === "object") {
      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === "object") Object.freeze(part);
        }
        Object.freeze(content);
      }
      Object.freeze(item);
    }
  }
  Object.freeze(history);
  const durableFingerprintBefore = fingerprint(history);
  const model = new MeasuringModel(history[0]);
  const runner = new Runner({
    modelProvider: { getModel: () => model },
    tracingDisabled: true,
  });
  const agent = new Agent({
    name: "model-input-memory-benchmark",
    instructions: "Return done.",
    model: "benchmark",
  });
  await Bun.sleep(20);
  const baselineRssBytes = process.memoryUsage().rss;
  const startedAt = performance.now();
  const result = await runner.run(agent, history, {
    stream: true,
    maxTurns: 2,
    callModelInputFilter: ({ modelData }) => modelData,
    ...(mode === "external" ? { historyOwnership: "external" as const } : {}),
  });
  for await (const _event of result.toStream()) void _event;
  await result.completed;
  const elapsedMs = performance.now() - startedAt;
  const peakRssBytes = Math.max(model.peakRssBytes, process.memoryUsage().rss);
  const portableSessionSnapshotItems =
    (result.state as any)._currentTurnSessionHistoryTransactionInputItems?.length ?? 0;
  const childResult: ChildResult = {
    mode,
    historyItems: history.length,
    historyTextBytes: history.length * TEXT_BYTES,
    baselineRssBytes,
    peakRssBytes,
    peakDeltaBytes: Math.max(0, peakRssBytes - baselineRssBytes),
    elapsedMs,
    wireItems: model.wireItems,
    resultHistoryItems: result.history.length,
    portableSessionSnapshotItems,
    stateOriginalItemBorrowed: (result.state as any)._originalInput?.[0] === history[0],
    modelInputItemBorrowed: model.modelInputItemBorrowed,
    durableFingerprintBefore,
    durableFingerprintAfter: fingerprint(history),
    wireFingerprint: model.wireFingerprint,
  };
  console.log(JSON.stringify(childResult));
}

async function collectChild(mode: OwnershipMode): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, import.meta.path, "--child", mode], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`benchmark child ${mode} failed (${exitCode}): ${stderr.trim()}`);
  }
  const line = stdout
    .trim()
    .split("\n")
    .findLast((candidate) => candidate.startsWith("{"));
  if (!line) throw new Error(`benchmark child ${mode} returned no result`);
  return JSON.parse(line) as ChildResult;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(2)) : null;
}

if (Bun.argv[2] === "--child") {
  const mode = Bun.argv[3];
  if (mode !== "sdk" && mode !== "external") throw new Error("invalid child mode");
  await runChild(mode);
} else {
  const sdk = await collectChild("sdk");
  const external = await collectChild("external");
  for (const result of [sdk, external]) {
    if (result.durableFingerprintBefore !== result.durableFingerprintAfter) {
      throw new Error(`${result.mode} mutated application-owned durable input`);
    }
  }
  if (sdk.wireFingerprint !== external.wireFingerprint || sdk.wireItems !== external.wireItems) {
    throw new Error("ownership modes produced different model input");
  }
  if (external.portableSessionSnapshotItems !== 0) {
    throw new Error("external history ownership retained an SDK session snapshot");
  }
  if (!external.stateOriginalItemBorrowed || !external.modelInputItemBorrowed) {
    throw new Error("external history ownership deep-cloned borrowed input");
  }
  if (sdk.stateOriginalItemBorrowed || sdk.modelInputItemBorrowed) {
    throw new Error("SDK history ownership stopped isolating caller input");
  }
  if (sdk.portableSessionSnapshotItems < sdk.historyItems) {
    throw new Error("SDK baseline did not capture the expected portable session snapshot");
  }
  const peakDeltaRatio = ratio(sdk.peakDeltaBytes, external.peakDeltaBytes);
  console.log(
    JSON.stringify(
      {
        sdk,
        external,
        improvement: {
          peakDeltaRatio,
          elapsedRatio: ratio(sdk.elapsedMs, external.elapsedMs),
          removedPortableSnapshotItems:
            sdk.portableSessionSnapshotItems - external.portableSessionSnapshotItems,
        },
      },
      null,
      2,
    ),
  );
  if (process.argv.includes("--check") && (peakDeltaRatio === null || peakDeltaRatio < 2.5)) {
    throw new Error(`external history ownership missed the 2.5x peak RSS reduction floor`);
  }
}
