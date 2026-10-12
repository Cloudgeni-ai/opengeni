import { createHash } from "node:crypto";
import { readReasoningConfiguration } from "./reasoning-configuration";
import { opaqueProviderArtifactFingerprint } from "./opaque-artifact";

export function conversionDigest(value: unknown): string {
  // JSONB preserves values, not object insertion order. Arrays remain ordered;
  // structurally identical persisted identities must survive a JSONB round trip.
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return Object.fromEntries(
            Object.entries(item).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          );
        }
        return item;
      }),
    )
    .digest("hex");
}

export type ConversionSourceRef = { id: string; position: number; digest: string };
export type ConversionManifest = { version: 1; digest: string; rows: ConversionSourceRef[] };

/** These identities describe a prepared conversion, never grant target authority. */
export type ConversionTarget = { provider: string; modelId: string; connectionId: string };
export type ConversionBudget = {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  totalTokens: number;
};
export type ConversionChunk = {
  key: string;
  inputDigest: string;
  coverage: string[];
  children: string[];
  inputTokens: number;
};
export type ConversionCheckpoint = ConversionChunk & {
  summary: string;
  outputTokens: number;
};

export function conversionChunkKey(
  manifest: ConversionManifest,
  target: ConversionTarget,
  budget: ConversionBudget,
  chunk: Omit<ConversionChunk, "key">,
): string {
  return conversionDigest({
    algorithm: "all_units_v1",
    source: manifest.digest,
    target,
    budget,
    inputDigest: chunk.inputDigest,
    coverage: chunk.coverage,
    children: chunk.children,
    inputTokens: chunk.inputTokens,
  });
}

export function validConversionBudget(budget: ConversionBudget): boolean {
  return (
    [budget.inputTokens, budget.outputTokens, budget.calls, budget.totalTokens].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) && budget.outputTokens < budget.inputTokens
  );
}

/** Retained audit rows, not the active projection. Timestamps retain database precision. */
export type ConversionHistoryRow = {
  id: string;
  position: number;
  turnId: string | null;
  createdAt: string;
  item: Record<string, unknown>;
};

export type ConversionCompactionEvent = {
  sequence: number;
  turnId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type CompactionSourceResult =
  | {
      rebuilt: true;
      sourceRows: ConversionHistoryRow[];
      manifest: ConversionManifest;
      excludedRows: number;
      layout: "integer_compaction_v1";
      /** Request-copy exclusions only; no durable source is changed. */
      omissions: Array<{
        reason: "pre_clear" | "replacement_block" | "opaque_artifact" | "empty_reasoning";
        positions: number[];
      }>;
    }
  | { rebuilt: false; reason: "unsupported_layout" | "ambiguous_block" | "missing_event" };

function isClear(row: ConversionHistoryRow): boolean {
  return (
    row.turnId === null &&
    row.item.type === "message" &&
    row.item.role === "user" &&
    row.item.content === "[context cleared]"
  );
}

/**
 * Dormant SUB-FAIL-09 conversion preparation; no provider calls. Never infer
 * provenance from active flags. Unknown/fractional layouts and unattributed
 * forks fail closed rather than feeding synthetic checkpoints as conversation.
 * The DB reader must supply complete retained rows/events, including inactive
 * rows. Only blocks after the latest real clear boundary need reconstruction.
 */
export function attributeCompactionConversation(input: {
  rows: readonly ConversionHistoryRow[];
  events: readonly ConversionCompactionEvent[];
}): CompactionSourceResult {
  const fail = (
    reason: "unsupported_layout" | "ambiguous_block" | "missing_event",
  ): CompactionSourceResult => ({ rebuilt: false, reason });
  const ordered = [...input.rows].sort((a, b) => a.position - b.position);
  // Retained copies of the marker inside a compaction transaction are not clears.
  const eventTimes = new Set(input.events.map((event) => event.createdAt));
  const clear = [...ordered]
    .reverse()
    .find((row) => isClear(row) && !eventTimes.has(row.createdAt));
  if (
    clear &&
    (!Number.isSafeInteger(clear.position) || !Number.isFinite(Date.parse(clear.createdAt)))
  )
    return fail("unsupported_layout");
  const rows = clear ? ordered.filter((row) => row.position > clear.position) : ordered;
  const events = input.events
    .filter((event) => !clear || Date.parse(event.createdAt) >= Date.parse(clear.createdAt))
    .sort((left, right) => left.sequence - right.sequence);
  if (
    (rows.length > 0 && rows[0]!.position !== (clear ? clear.position + 1 : 0)) ||
    rows.some(
      (row, index) =>
        !row.id ||
        rows.some((other, otherIndex) => otherIndex !== index && other.id === row.id) ||
        !Number.isSafeInteger(row.position) ||
        row.position < 0 ||
        !Number.isFinite(Date.parse(row.createdAt)) ||
        (index > 0 && row.position !== rows[index - 1]!.position + 1),
    )
  ) {
    return fail("unsupported_layout");
  }
  const excluded = new Set<number>();
  for (const event of events) {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
      return fail("unsupported_layout");
    const { summaryPosition, supersededFrom, blockLength } = event.payload;
    if (
      !Number.isSafeInteger(summaryPosition) ||
      !event.turnId ||
      !Number.isFinite(Date.parse(event.createdAt))
    )
      return fail("unsupported_layout");
    const summary = rows.find((row) => row.position === summaryPosition);
    if (!summary || summary.turnId !== event.turnId || summary.createdAt !== event.createdAt) {
      return fail("ambiguous_block");
    }
    if (events.filter((other) => other.createdAt === event.createdAt).length !== 1) {
      return fail("ambiguous_block");
    }
    // A legacy block is the entire transaction cohort, anchored by exactly one
    // summary with the event's turn. Null-turn rows alone are never evidence.
    const cohort = rows.filter((row) => row.createdAt === event.createdAt);
    let block = cohort;
    if (supersededFrom !== undefined || blockLength !== undefined) {
      if (
        !Number.isSafeInteger(supersededFrom) ||
        !Number.isSafeInteger(blockLength) ||
        (blockLength as number) < 1 ||
        (supersededFrom as number) < 0
      ) {
        return fail("unsupported_layout");
      }
      block = rows.filter(
        (row) =>
          row.position >= (supersededFrom as number) &&
          row.position < (supersededFrom as number) + (blockLength as number),
      );
      if (
        block.length !== blockLength ||
        !block.includes(summary) ||
        cohort.length !== block.length
      )
        return fail("ambiguous_block");
    } else if (event.payload.implementation !== "responses_compaction_v2") {
      // Only the retained whole-number remote-v2 writer is a supported legacy layout.
      return fail("unsupported_layout");
    } else {
      // Bound legacy support to the known writer's shape. An unrelated
      // null-turn append sharing the transaction is not a replacement merely
      // because its timestamp matches. Truncated/transformed legacy copies
      // without explicit block metadata are conservatively unsupported.
      let previousSourcePosition = -1;
      const unambiguousCopies = block
        .filter((row) => row.position < summary.position)
        .every((row) => {
          const matches = rows.filter(
            (prior) =>
              prior.position < block[0]!.position &&
              !excluded.has(prior.position) &&
              JSON.stringify(prior.item) === JSON.stringify(row.item),
          );
          if (
            row.item.type !== "message" ||
            !["user", "system", "developer"].includes(String(row.item.role)) ||
            matches.length !== 1 ||
            matches[0]!.position <= previousSourcePosition
          )
            return false;
          previousSourcePosition = matches[0]!.position;
          return true;
        });
      if (
        summary.item.type !== "compaction" ||
        typeof summary.item.encrypted_content !== "string" ||
        !unambiguousCopies ||
        block.filter((row) => row.position > summary.position).length > 1 ||
        block.some(
          (row) => row.position > summary.position && !readReasoningConfiguration(row.item),
        )
      ) {
        return fail("unsupported_layout");
      }
    }
    if (
      block.some(
        (row, index) =>
          row.createdAt !== event.createdAt ||
          excluded.has(row.position) ||
          (row === summary ? row.turnId !== event.turnId : row.turnId !== null) ||
          (index > 0 && row.position !== block[index - 1]!.position + 1),
      )
    ) {
      return fail("ambiguous_block");
    }
    for (const row of block) excluded.add(row.position);
  }
  const conversation = rows
    .filter((row) => !excluded.has(row.position))
    .map(({ id, position, turnId, createdAt, item }) => ({
      id,
      position,
      turnId,
      createdAt,
      item,
    }));
  // Forks copy rows without their turn/event provenance. Likewise, opaque
  // checkpoints without an attributed event cannot establish what they replaced.
  if (conversation.some((row) => row.turnId === null || row.item.type === "compaction")) {
    return fail("missing_event");
  }
  return {
    rebuilt: true,
    sourceRows: conversation,
    manifest: (() => {
      const refs = conversation.map((row) => ({
        id: row.id,
        position: row.position,
        digest: conversionDigest(row.item),
      }));
      return {
        version: 1 as const,
        rows: refs,
        digest: conversionDigest({ version: 1, rows: refs }),
      };
    })(),
    excludedRows: excluded.size,
    layout: "integer_compaction_v1",
    omissions: [
      {
        reason: "pre_clear",
        positions: clear
          ? ordered.filter((row) => row.position <= clear.position).map((row) => row.position)
          : [],
      },
      { reason: "replacement_block", positions: [...excluded].sort((left, right) => left - right) },
      {
        reason: "opaque_artifact",
        positions: rows
          .filter((row) => opaqueProviderArtifactFingerprint(row.item) !== null)
          .map((row) => row.position),
      },
      {
        reason: "empty_reasoning",
        positions: conversation
          .filter((row) => row.item.type === "reasoning" && Object.keys(row.item).length === 1)
          .map((row) => row.position),
      },
    ],
  };
}
