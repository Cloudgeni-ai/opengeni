/** Live synthetic Azure checkpoint canary; --durable uses disposable PostgreSQL. */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getSettings } from "@opengeni/config";
import {
  buildCompactionReplacementHistory,
  compactionProviderFailureDiagnostics,
  estimateTokens,
  prepareCompactionPromptInput,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
} from "../packages/runtime/src/index";
import { compactionHistoryFixture } from "./fixtures/compaction-history";

type Item = Record<string, unknown>;
type ProviderResponse = { output: Item[]; usage?: Item; id?: string };

async function main() {
  if (!process.argv.includes("--live"))
    throw new Error("Pass --live to run synthetic provider requests");
  const settings = getSettings();
  if (
    settings.openaiProvider !== "azure" ||
    !settings.azureOpenaiBaseUrl ||
    !settings.azureOpenaiApiKey
  ) {
    throw new Error(
      "Set OPENGENI_OPENAI_PROVIDER=azure and the explicit Azure base URL, API key and model",
    );
  }
  const base = settings.azureOpenaiBaseUrl.replace(/\/+$/, "");
  const apiKey = settings.azureOpenaiApiKey;
  const receipts: Item[] = [];
  async function request(body: Item): Promise<ProviderResponse> {
    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        model: settings.openaiModel,
        reasoning: { effort: "medium" },
        ...body,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    receipts.push({ status: response.status, requestId: response.headers.get("x-request-id") });
    if (!response.ok)
      throw new Error(
        `Synthetic provider request failed (HTTP ${response.status}); request id recorded`,
      );
    const result = (await response.json()) as ProviderResponse;
    if (!Array.isArray(result.output)) throw new Error("Provider did not return structured output");
    return result;
  }
  const kickoff = await request({
    input:
      "This is a synthetic compaction test. Remember checkpoint amber-orchid-42. Find the smallest positive integer x such that x mod 17 = 9, x mod 23 = 14, and x mod 31 = 22. Verify all three remainders before answering, then acknowledge the checkpoint.",
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 8192,
  });
  const initialOutput: Item[] = kickoff.output.map((item) => {
    if (item.type === "reasoning") {
      const summary = item.summary as Array<{ text: string }>;
      return {
        type: "reasoning",
        id: item.id,
        content: summary.map(({ text }) => ({ type: "input_text", text })),
        providerData: item,
      };
    }
    if (item.type === "message") return { ...item, providerData: { id: item.id } };
    throw new Error("Unexpected kickoff output type");
  });
  if (
    !initialOutput.some((item) => item.type === "reasoning") ||
    !initialOutput.some((item) => item.type === "message")
  ) {
    throw new Error(
      `Kickoff must produce reasoning/message dependency: ${JSON.stringify({ types: kickoff.output.map((item) => item.type), usage: kickoff.usage })}`,
    );
  }
  const history: Item[] = [
    {
      type: "message",
      role: "user",
      content: "Remember checkpoint amber-orchid-42. Preserve it through compaction.",
    },
    ...initialOutput,
    ...compactionHistoryFixture(),
  ];
  const original = JSON.stringify(history);
  const estimatedBefore = estimateTokens(history);
  const prepared = prepareCompactionPromptInput(sanitizeHistoryItemsForModel(history), 214_200);
  let summaryUsage: unknown;
  const summarize = (activeSettings: typeof settings, input: Item[]) =>
    summarizeForCompaction(activeSettings, input, {
      maxOutputTokens: 20_000,
      model: settings.openaiModel,
      systemInstructions:
        "Preserve the checkpoint, release color, and the last completed patch result in the summary.",
      onUsage: (usage) => {
        summaryUsage = usage;
      },
    });
  let durableProof: unknown;
  let replacement: Item[];
  if (process.argv.includes("--durable")) {
    const { compactDurableFixture } = await import("./fixtures/durable-compaction");
    const result = await compactDurableFixture(settings, history, summarize);
    replacement = result.replacement;
    durableProof = result.proof;
  } else {
    replacement = buildCompactionReplacementHistory(
      history,
      await summarize(settings, prepared.input),
    );
  }
  if (JSON.stringify(history) !== original) throw new Error("Canonical history mutated");
  const estimatedAfter = estimateTokens(replacement);
  if (estimatedBefore <= 244_800 || estimatedAfter >= estimatedBefore)
    throw new Error("Long-history/shrink assertion failed");
  // Replacement consists of retained user messages and the summary message.
  // Internal summary markers are durable metadata, not Responses wire fields.
  const input = sanitizeHistoryItemsForModel(replacement).map((item) => {
    if (item.type !== "message" || item.role !== "user")
      throw new Error("Unexpected replacement shape; use the SDK converter for new types");
    return { role: "user", content: item.content };
  });
  const continued = await request({
    input: [
      ...input,
      {
        role: "user",
        content:
          "Call verify_checkpoint using the remembered checkpoint, release color, and patch outcome.",
      },
    ],
    tools: [
      {
        type: "function",
        name: "verify_checkpoint",
        description: "Verify remembered synthetic checkpoint facts.",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            checkpoint: { type: "string" },
            release: { type: "string" },
            patchStatus: { type: "string", enum: ["completed", "failed", "unknown"] },
          },
          required: ["checkpoint", "release", "patchStatus"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: "function", name: "verify_checkpoint" },
    max_output_tokens: 8192,
  });
  const call = continued.output.find(
    (item) => item.type === "function_call" && item.name === "verify_checkpoint",
  );
  if (!call || typeof call.arguments !== "string") throw new Error("No continuation tool call");
  const args = JSON.parse(call.arguments) as Record<string, unknown>;
  if (
    args.checkpoint !== "amber-orchid-42" ||
    args.release !== "blue" ||
    args.patchStatus !== "completed"
  )
    throw new Error(`Synthetic compacted facts mismatch: ${JSON.stringify(args)}`);
  const receipt = "verified-amber-orchid-42";
  const finished = await request({
    input: [
      ...input,
      ...continued.output,
      { type: "function_call_output", call_id: call.call_id, output: receipt },
      { role: "user", content: "Reply with the exact verification receipt from the tool result." },
    ],
    max_output_tokens: 8192,
  });
  const text = finished.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content as Array<{ text?: string }>)
    .map((part) => part.text ?? "")
    .join("");
  if (!text.includes(receipt))
    throw new Error("Continuation did not consume the paired tool result");
  const manifest = {
    model: settings.openaiModel,
    historyItems: history.length,
    estimatedBefore,
    estimatedAfter,
    preparationPreview: {
      inputBudget: 214_200,
      preparedItems: prepared.input.length,
      rewrittenToolOutputs: prepared.rewrittenToolOutputs,
      droppedHistoryItems: prepared.droppedHistoryItems,
    },
    summaryUsage,
    providerReceipts: receipts,
    canonicalHistoryUnchanged: true,
    continuedToolFactsVerified: true,
    pairedToolResultConsumed: true,
    durableSessionWritten: Boolean(durableProof),
    durableProof,
  };
  const output =
    process.env.COMPACTION_VERIFICATION_OUTPUT ?? "tmp/verification/opengeni-compaction.json";
  await mkdir(dirname(output), { recursive: true });
  await Bun.write(output, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Never let the CLI print SDK causes containing raw provider messages.
    console.error(
      JSON.stringify({ verificationFailed: true, ...compactionProviderFailureDiagnostics(error) }),
    );
    process.exitCode = 1;
  }
}
