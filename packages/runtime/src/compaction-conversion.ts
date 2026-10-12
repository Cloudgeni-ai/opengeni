import {
  attributeCompactionConversation,
  opaqueProviderArtifactFingerprint,
  type CompactionSourceResult,
  type ConversionHistoryRow,
  type ConversionCompactionEvent,
  conversionDigest,
  conversionChunkKey,
  validConversionBudget,
  type ConversionTarget,
  type ConversionBudget,
  type ConversionChunk,
  type ConversionCheckpoint,
  conversionWorkUnits,
  type ConversionWorkUnit,
} from "@opengeni/codex";
import { omitOpaqueArtifactsFromPortableCompactionHistory } from "./context-compaction";
import { projectRejectedReasoningArtifact } from "./history-sanitizer";

export type { ConversionHistoryRow, ConversionCompactionEvent } from "@opengeni/codex";
export type CompactionRebuildResult = CompactionSourceResult extends infer Result
  ? Result extends { rebuilt: true }
    ? Result & { items: Record<string, unknown>[] }
    : Result
  : never;

/** Pure reconstruction. Source attribution is shared with the persistence verifier. */
export function rebuildCompactionConversation(input: {
  rows: readonly ConversionHistoryRow[];
  events: readonly ConversionCompactionEvent[];
}): CompactionRebuildResult {
  const source = attributeCompactionConversation(input);
  if (!source.rebuilt) return source;
  return {
    ...source,
    items: omitOpaqueArtifactsFromPortableCompactionHistory(
      source.sourceRows.map(({ item }) =>
        item.type === "reasoning" && opaqueProviderArtifactFingerprint(item) !== null
          ? projectRejectedReasoningArtifact(item)
          : item,
      ),
    ),
  };
}

export type ConversionPlanStep =
  | {
      kind: "request";
      chunk: ConversionChunk;
      text: string;
      maxOutputTokens: number;
      tools: "disabled";
    }
  | { kind: "complete"; checkpoint: ConversionCheckpoint }
  | {
      kind: "refused";
      reason:
        | "conversion_unsupported_content"
        | "conversion_unit_exceeds_budget"
        | "conversion_budget_exhausted"
        | "conversion_summary_failed"
        | "conversion_coverage_invalid";
      coveredRows: number;
      remainingRows: number;
    };

/**
 * Plan exactly one next call, or a complete reduction root. No API calls,
 * truncation, replay or tool execution. Checkpoints must come from the fenced
 * DB reader; their coverage is still independently checked here. Token counts
 * use the target's pure tokenizer over the complete request-copy text; callers
 * reserve prompt/output overhead in the supplied conversion-only budgets.
 */
export function planCompactionConversionStep(input: {
  rebuilt: Extract<CompactionRebuildResult, { rebuilt: true }>;
  target: ConversionTarget;
  budget: ConversionBudget;
  checkpoints: readonly ConversionCheckpoint[];
  countTokens: (text: string) => number;
}): ConversionPlanStep {
  const { rebuilt, target, budget, checkpoints, countTokens } = input;
  const covered = new Set(checkpoints.flatMap((checkpoint) => checkpoint.coverage));
  const refuse = (
    reason: Extract<ConversionPlanStep, { kind: "refused" }>["reason"],
  ): ConversionPlanStep => ({
    kind: "refused",
    reason,
    coveredRows: covered.size,
    remainingRows: Math.max(0, rebuilt.manifest.rows.length - covered.size),
  });
  if (!validConversionBudget(budget)) return refuse("conversion_budget_exhausted");
  if (
    rebuilt.manifest.digest !== conversionDigest({ version: 1, rows: rebuilt.manifest.rows }) ||
    conversionDigest(
      rebuilt.sourceRows.map((row) => ({
        id: row.id,
        position: row.position,
        digest: conversionDigest(row.item),
      })),
    ) !== conversionDigest(rebuilt.manifest.rows)
  ) {
    return refuse("conversion_coverage_invalid");
  }
  type Unit = ConversionWorkUnit;
  const units = conversionWorkUnits(rebuilt.sourceRows);
  if (!units) return refuse("conversion_unsupported_content");
  const known = new Map(checkpoints.map((checkpoint) => [checkpoint.key, checkpoint]));
  if (known.size !== checkpoints.length) return refuse("conversion_coverage_invalid");
  const used = new Set<string>();
  let frontier = units;
  let chargedTokens = 0;
  let chargedCalls = 0;
  for (let level = 0; level <= budget.calls; level++) {
    const groups: Unit[][] = [];
    let group: Unit[] = [];
    for (const unit of frontier) {
      const tokens = countTokens(unit.text);
      if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > budget.inputTokens)
        return refuse("conversion_unit_exceeds_budget");
      if (
        group.length &&
        countTokens([...group, unit].map((part) => part.text).join("\n")) > budget.inputTokens
      ) {
        groups.push(group);
        group = [];
      }
      group.push(unit);
    }
    if (group.length) groups.push(group);
    const next: Unit[] = [];
    for (const parts of groups) {
      const text = parts.map((part) => part.text).join("\n");
      const base = {
        inputDigest: conversionDigest(text),
        coverage: parts.flatMap((part) => part.coverage),
        children: parts.flatMap((part) => (part.key ? [part.key] : [])),
        inputTokens: countTokens(text),
      };
      const chunk = { ...base, key: conversionChunkKey(rebuilt.manifest, target, budget, base) };
      const saved = known.get(chunk.key);
      if (!saved) {
        if (used.size !== known.size) return refuse("conversion_coverage_invalid");
        if (
          chargedCalls + 1 > budget.calls ||
          chargedTokens + chunk.inputTokens + budget.outputTokens > budget.totalTokens
        )
          return refuse("conversion_budget_exhausted");
        return {
          kind: "request",
          chunk,
          text,
          maxOutputTokens: budget.outputTokens,
          tools: "disabled",
        };
      }
      if (
        saved.key !== chunk.key ||
        saved.inputDigest !== chunk.inputDigest ||
        saved.inputTokens !== chunk.inputTokens ||
        conversionDigest(saved.coverage) !== conversionDigest(chunk.coverage) ||
        conversionDigest(saved.children) !== conversionDigest(chunk.children) ||
        new Set(saved.coverage).size !== saved.coverage.length
      )
        return refuse("conversion_coverage_invalid");
      const outputTokens = countTokens(saved.summary);
      if (
        !saved.summary.trim() ||
        outputTokens !== saved.outputTokens ||
        !Number.isSafeInteger(outputTokens) ||
        outputTokens < 1 ||
        outputTokens > budget.outputTokens ||
        outputTokens >= chunk.inputTokens
      )
        return refuse("conversion_summary_failed");
      chargedCalls++;
      chargedTokens += chunk.inputTokens + outputTokens;
      used.add(chunk.key);
      if (chargedCalls > budget.calls || chargedTokens > budget.totalTokens)
        return refuse("conversion_budget_exhausted");
      next.push({ text: saved.summary, coverage: saved.coverage, key: saved.key });
    }
    if (next.length === 1) {
      const root = known.get(next[0]!.key!)!;
      if (
        used.size !== known.size ||
        conversionDigest(root.coverage) !==
          conversionDigest(rebuilt.manifest.rows.map((row) => row.id))
      )
        return refuse("conversion_coverage_invalid");
      return { kind: "complete", checkpoint: root };
    }
    frontier = next;
  }
  return refuse("conversion_budget_exhausted");
}
