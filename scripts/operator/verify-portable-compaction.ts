/** Live synthetic Azure checkpoint canary; --durable uses disposable PostgreSQL. */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getSettings, type Settings } from "@opengeni/config";
import { buildOpenAIClientFromSettings } from "../../packages/runtime/src/model-provider-client";
import {
  CompactionVerificationError,
  verificationFailureDiagnostics,
} from "./compaction-verification-errors";
import {
  buildCompactionReplacementHistory,
  estimateTokens,
  prepareCompactionPromptInput,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
} from "../../packages/runtime/src/index";
import { compactionHistoryFixture } from "./compaction-history";

type Item = Record<string, unknown>;
type VerificationRequest = Omit<
  Parameters<ReturnType<typeof buildOpenAIClientFromSettings>["responses"]["create"]>[0],
  "model" | "stream"
>;
export function createVerificationClient(settings: Settings) {
  if (
    settings.openaiProvider !== "azure" ||
    !(
      settings.azureOpenaiBaseUrl ||
      (settings.azureOpenaiEndpoint && settings.azureOpenaiDeployment)
    ) ||
    !(settings.azureOpenaiApiKey || settings.azureOpenaiAdToken)
  )
    throw new CompactionVerificationError(
      "Configure Azure with a base URL or endpoint/deployment, an API key or AD token, and a model.",
    );
  return buildOpenAIClientFromSettings(settings);
}

export function assertOpaqueKickoff(output: Item[]): void {
  if (
    !output.some(
      (item) =>
        item.type === "reasoning" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0,
    ) ||
    !output.some((item) => item.type === "message")
  ) {
    throw new CompactionVerificationError(
      "Kickoff must contain opaque reasoning and a dependent assistant message.",
    );
  }
}

export async function main(args: string[] = process.argv.slice(2)) {
  if (!args.includes("--live"))
    throw new CompactionVerificationError("Pass --live to run synthetic provider requests.");
  const settings = getSettings();
  const client = createVerificationClient(settings);
  const receipts: Item[] = [];
  async function request(body: VerificationRequest) {
    const { data, response } = await client.responses
      .create(
        {
          model: settings.openaiModel,
          reasoning: { effort: "medium" },
          ...body,
          stream: false,
        },
        { timeout: 180_000 },
      )
      .withResponse();
    receipts.push({ status: response.status, requestId: response.headers.get("x-request-id") });
    if (data.status !== "completed")
      throw new CompactionVerificationError("Synthetic provider leg did not complete.");
    return data;
  }
  const kickoff = await request({
    input:
      "This is a synthetic compaction test. Remember checkpoint amber-orchid-42. Find the smallest positive integer x such that x mod 17 = 9, x mod 23 = 14, and x mod 31 = 22. Verify all three remainders before answering, then acknowledge the checkpoint.",
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 8192,
  });
  assertOpaqueKickoff(kickoff.output as unknown as Item[]);
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
    throw new CompactionVerificationError("Unexpected kickoff output type");
  });
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
  if (args.includes("--durable")) {
    const { compactDurableFixture } = await import("./compaction-durable");
    const result = await compactDurableFixture(settings, history, summarize);
    replacement = result.replacement;
    durableProof = result.proof;
  } else {
    replacement = buildCompactionReplacementHistory(
      history,
      await summarize(settings, prepared.input),
    );
  }
  if (JSON.stringify(history) !== original)
    throw new CompactionVerificationError("Canonical history mutated");
  const estimatedAfter = estimateTokens(replacement);
  if (estimatedBefore <= 244_800 || estimatedAfter >= estimatedBefore)
    throw new CompactionVerificationError("Long-history/shrink assertion failed");
  // Replacement consists of retained user messages and the summary message.
  // Internal summary markers are durable metadata, not Responses wire fields.
  const input = sanitizeHistoryItemsForModel(replacement).map((item) => {
    if (item.type !== "message" || item.role !== "user" || typeof item.content !== "string")
      throw new CompactionVerificationError(
        "Unexpected replacement shape; use the SDK converter for new types",
      );
    return { role: "user" as const, content: item.content };
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
  if (!call || call.type !== "function_call" || typeof call.arguments !== "string")
    throw new CompactionVerificationError("No continuation tool call");
  const facts = JSON.parse(call.arguments) as Record<string, unknown>;
  if (
    facts.checkpoint !== "amber-orchid-42" ||
    facts.release !== "blue" ||
    facts.patchStatus !== "completed"
  )
    throw new CompactionVerificationError(
      "Synthetic compacted checkpoint, release or patch facts mismatch.",
    );
  const receipt = "verified-amber-orchid-42";
  const continuationOutput = continued.output.map((item) => {
    if (item.type === "message" || item.type === "reasoning" || item.type === "function_call")
      return item;
    throw new CompactionVerificationError("Unexpected continuation output type.");
  });
  const finished = await request({
    input: [
      ...input,
      ...continuationOutput,
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
    throw new CompactionVerificationError("Continuation did not consume the paired tool result");
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
    console.error(JSON.stringify(verificationFailureDiagnostics(error)));
    process.exitCode = 1;
  }
}
