import type { Settings } from "@opengeni/config";
import { boundModelToolOutputItem } from "@opengeni/codex";
import type { Agent, AgentInputItem, CallModelInputFilter } from "@openai/agents";

import {
  CompactionNeededError,
  compactionThresholdTokens,
  estimateCompleteModelInputTokens,
  estimateSerializedValueTokens,
  hasModelGeneratedItem,
  type ProviderContextTokenSignal,
} from "./context-compaction";
import {
  normalizeComputerCallAction,
  normalizeComputerCallActions,
  repairHistoryProtocolItems,
} from "./history-sanitizer";
import {
  restoreGenericDispatchHistoryItem,
  restoreGenericDispatchHistoryItems,
} from "./lazy-tool-transport";

export type ContextRobustnessFilterOptions = {
  contextCompactionSignal?: () => ProviderContextTokenSignal | null | undefined;
  contextCompactionRequested?: () => boolean | Promise<boolean>;
  throwOnCompactionNeeded?: boolean;
};

/**
 * callModelInputFilter that removes provider-assigned item ids (rs_/msg_/fc_…)
 * from every input item immediately before each model call. Responses-API
 * requests that carry item ids are resolved against the provider's stored
 * responses, and that store is not durable enough to anchor long runs on: a
 * response that streamed successfully can be missing from the store on the
 * very next call, which then fails with 400 "Item with id ... not found"
 * (observed live on Azure OpenAI mid-turn). All item content — including the
 * encrypted reasoning payload carried in providerData when
 * `openaiReasoningEncryptedContent` is on — is sent inline, so the ids add
 * fragility without adding information. Pairing fields (`call_id`/`callId`)
 * are separate properties and stay untouched; items are cloned, never mutated.
 */
export const stripProviderItemIdsFilter: CallModelInputFilter = ({ modelData }) => {
  let projected: AgentInputItem[] | null = null;
  for (const [index, item] of modelData.input.entries()) {
    const next = stripProviderItemId(item);
    if (next !== item && projected === null) projected = modelData.input.slice(0, index);
    projected?.push(next);
  }
  return projected ? { ...modelData, input: projected } : modelData;
};

function stripProviderItemId(item: AgentInputItem): AgentInputItem {
  if (!item || typeof item !== "object" || !("id" in item)) return item;
  const { id: _id, ...rest } = item as Record<string, unknown>;
  return rest as AgentInputItem;
}

/**
 * callModelInputFilter that normalizes every `computer_call` carrying BOTH
 * `action` and `actions` down to EXACTLY ONE (keeps `actions`, drops `action`).
 * The Azure computer-use endpoint rejects a request whose computer_call has
 * both with `400 Computer call input must include exactly one of `action` or
 * `actions``; and (live-proven against gpt-5.6-sol's GA computer tool) it also
 * rejects the `action`-only form, accepting ONLY the batched plural `actions`.
 * The SDK 0.14.3 schema allows both, so a freshly-emitted
 * screenshot call carries the redundant pair. This filter runs before EVERY
 * model call — the turn-start history replay AND every mid-turn follow-up — so
 * it covers the just-emitted (non-replayed) computer_call on the same turn,
 * which the turn-start `prepareRunInput` sanitizer never sees. Items are cloned,
 * never mutated.
 */
export const normalizeComputerCallsFilter: CallModelInputFilter = ({ modelData }) => ({
  ...modelData,
  input: normalizeComputerCallActions(
    modelData.input as unknown as Array<Record<string, unknown>>,
  ) as unknown as AgentInputItem[],
});

/** Keep persisted generic-dispatch internals out of every provider request. */
export const restoreLazyToolProviderHistoryFilter: CallModelInputFilter = ({ modelData }) => {
  const input = restoreGenericDispatchHistoryItems(
    modelData.input as unknown as Array<Record<string, unknown>>,
  );
  return input === modelData.input
    ? modelData
    : { ...modelData, input: input as unknown as AgentInputItem[] };
};

/**
 * Canonical Codex-style tool-result bound at the final model-input seam. The
 * identical pure normalizer also runs before conversation rows are persisted,
 * so this is a live-turn defense rather than a request-only alternate history.
 */
export function boundModelToolOutputsFilterForSettings(settings: Settings): CallModelInputFilter {
  return memoizedInputItemProjectionFilter(
    (item) =>
      boundModelToolOutputItem(
        item as unknown as Record<string, unknown>,
        settings.modelToolOutputTruncationTokens,
      ) as unknown as AgentInputItem,
  );
}

function estimateAgentToolSchemaTokens(agent: Agent<any, any>): number {
  const localTools = Array.isArray((agent as { tools?: unknown }).tools)
    ? ((agent as { tools: unknown[] }).tools ?? [])
    : [];
  const localDescriptors = localTools.map((candidate) => {
    if (!candidate || typeof candidate !== "object") return candidate;
    const tool = candidate as Record<string, unknown>;
    return {
      type: tool.type,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      inputSchema: tool.inputSchema,
      strict: tool.strict,
      providerData: tool.providerData,
    };
  });
  const mcpServers = Array.isArray((agent as { mcpServers?: unknown }).mcpServers)
    ? ((agent as { mcpServers: unknown[] }).mcpServers ?? [])
    : [];
  const mcpTokens = mcpServers.reduce<number>((total, server) => {
    const getter = (server as { modelToolSchemaTokens?: () => number } | null)
      ?.modelToolSchemaTokens;
    return total + (typeof getter === "function" ? getter.call(server) : 0);
  }, 0);
  return estimateSerializedValueTokens(localDescriptors) + mcpTokens;
}

export function contextRobustnessFilterForSettings(
  settings: Settings,
  options: ContextRobustnessFilterOptions = {},
): CallModelInputFilter {
  const thresholdTokens = compactionThresholdTokens(settings);
  let previousRequest: {
    revision: number;
    instructionsTokens: number;
    toolSchemaTokens: number;
  } | null = null;
  let requestRevision = 0;
  return async ({ modelData, agent }) => {
    const input = modelData.input;
    if (options.throwOnCompactionNeeded) {
      const reported = options.contextCompactionSignal?.();
      const instructionsTokens = estimateSerializedValueTokens(modelData.instructions ?? "");
      const toolSchemaTokens = estimateAgentToolSchemaTokens(agent);
      // Stream consumption can lag the SDK's background model loop. A provider
      // usage signal is safe only when its response revision belongs to the
      // immediately preceding request. Never attach a delayed response count to
      // a newer footprint: doing so can hide all model output produced between
      // them and recreate an under-counting compaction loop.
      const boundProvider =
        reported &&
        previousRequest &&
        reported.revision === previousRequest.revision &&
        hasModelGeneratedItem(input as unknown as Array<Record<string, unknown>>)
          ? reported
          : null;
      // Without an exact provider response bound to the immediately preceding
      // request, do not turn a whole-request approximation into a compaction
      // decision. Let the provider accept the request or return its typed
      // context-window error, which the worker already compacts and retries.
      const signalTokens = boundProvider
        ? (estimateCompleteModelInputTokens({
            currentInput: input as unknown as Array<Record<string, unknown>>,
            currentInstructionsTokens: instructionsTokens,
            currentToolSchemaTokens: toolSchemaTokens,
            provider: boundProvider,
            previousRequest: previousRequest!,
          }) ?? 0)
        : 0;
      previousRequest = {
        revision: ++requestRevision,
        instructionsTokens,
        toolSchemaTokens,
      };
      if (await options.contextCompactionRequested?.()) {
        throw new CompactionNeededError({
          signalTokens,
          thresholdTokens,
          signalSource: boundProvider ? "provider" : "operator",
          trigger: "operator",
        });
      }
      if (boundProvider && signalTokens >= thresholdTokens) {
        throw new CompactionNeededError({
          signalTokens,
          thresholdTokens,
          signalSource: "provider",
        });
      }
    }
    return modelData.input === input ? modelData : { ...modelData, input };
  };
}

/**
 * Compose a list of callModelInputFilters into one, applied left-to-right so
 * each sees the prior filter's output.
 */
export function composeCallModelInputFilters(
  filters: CallModelInputFilter[],
): CallModelInputFilter {
  return async (args) => {
    let modelData = args.modelData;
    for (const filter of filters) {
      modelData = await filter({ ...args, modelData });
    }
    return modelData;
  };
}

/**
 * Memoize immutable protocol-item projections for one run. The SDK rebuilds the
 * input array before each call but reuses item identities; caching by identity
 * avoids cloning/bounding the whole historical prefix hundreds of times while
 * still returning a fresh array only when at least one item differs on wire.
 */
function memoizedInputItemProjectionFilter(
  project: (item: AgentInputItem) => AgentInputItem,
): CallModelInputFilter {
  const cache = new WeakMap<object, AgentInputItem>();
  return ({ modelData }) => {
    let projected: AgentInputItem[] | null = null;
    for (const [index, item] of modelData.input.entries()) {
      let next = item;
      if (item && typeof item === "object") {
        const cached = cache.get(item);
        if (cached) {
          next = cached;
        } else {
          next = project(item);
          cache.set(item, next);
        }
      }
      if (next !== item && projected === null) projected = modelData.input.slice(0, index);
      projected?.push(next);
    }
    return projected ? { ...modelData, input: projected } : modelData;
  };
}

const IMAGE_CONTENT_TYPES = new Set([
  "image",
  "input_image",
  "image_url",
  "computer_screenshot",
  // Compact durable marker used for a direct function-image result before
  // attempt-local artifact materialization. Text-only wires project it out
  // without reading the retained object back into RAM.
  "retained_artifact",
]);

const FILE_CONTENT_TYPES = new Set(["file", "input_file"]);

const IMAGE_OMITTED_TEXT =
  "[Image content omitted because the selected model does not support image input.]";

const FILE_OMITTED_TEXT =
  "[File content omitted because the selected model does not support this file type.]";

function modelInputItemType(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function modelInputFileMediaType(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of ["contentType", "content_type", "mediaType", "media_type", "mimeType"]) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.toLowerCase().split(";", 1)[0]!.trim();
    }
  }
  const fileValue = record.file;
  if (typeof fileValue === "string") {
    const match = /^data:([^;,]+)[;,]/i.exec(fileValue);
    if (match?.[1]) return match[1].toLowerCase();
  }
  if (fileValue && typeof fileValue === "object") return modelInputFileMediaType(fileValue);
  return null;
}

function acceptsModelInputFile(value: unknown, accepted: readonly string[] | undefined): boolean {
  if (accepted === undefined) return true;
  const mediaType = modelInputFileMediaType(value);
  if (!mediaType) return false;
  return accepted.some(
    (candidate) =>
      candidate === mediaType ||
      (candidate.endsWith("/*") && mediaType.startsWith(candidate.slice(0, -1))),
  );
}

export type ModelInputProjectionPolicy = {
  supportsImageInput: boolean;
  inputFileMediaTypes?: readonly string[];
};

function omittedContentTextPart(kind: "image" | "file"): Record<string, string> {
  return { type: "input_text", text: kind === "image" ? IMAGE_OMITTED_TEXT : FILE_OMITTED_TEXT };
}

function unsupportedContentKind(
  value: unknown,
  policy: ModelInputProjectionPolicy,
): "image" | "file" | null {
  const type = modelInputItemType(value) ?? "";
  if (IMAGE_CONTENT_TYPES.has(type) && !policy.supportsImageInput) return "image";
  if (FILE_CONTENT_TYPES.has(type) && !acceptsModelInputFile(value, policy.inputFileMediaTypes)) {
    return "file";
  }
  return null;
}

function stripUnsupportedContentParts(
  value: unknown,
  policy: ModelInputProjectionPolicy,
): { value: unknown; removed: boolean } {
  if (Array.isArray(value)) {
    let removed = false;
    const kept: unknown[] = [];
    for (const part of value) {
      const kind = unsupportedContentKind(part, policy);
      if (kind) {
        removed = true;
        kept.push(omittedContentTextPart(kind));
        continue;
      }
      kept.push(part);
    }
    return { value: removed ? kept : value, removed };
  }
  if (unsupportedContentKind(value, policy)) {
    return { value: undefined, removed: true };
  }
  return { value, removed: false };
}

function stripUnsupportedContentFromModelInputItem<T extends Record<string, unknown>>(
  item: T,
  policy: ModelInputProjectionPolicy,
): T | null {
  if (unsupportedContentKind(item, policy)) return null;
  let clone: Record<string, unknown> | null = null;
  for (const field of ["content", "output"] as const) {
    if (!(field in item)) continue;
    const originalField = item[field];
    const projected = stripUnsupportedContentParts(originalField, policy);
    if (!projected.removed) continue;
    clone ??= { ...item };
    const omittedKind = unsupportedContentKind(originalField, policy) ?? "file";
    clone[field] =
      projected.value === undefined ||
      (Array.isArray(projected.value) && projected.value.length === 0)
        ? [omittedContentTextPart(omittedKind)]
        : projected.value;
  }
  return (clone ?? item) as T;
}

/** Build the non-mutating model-wire view for images and typed files. */
export function projectModelInputForCapabilities<T extends Record<string, unknown>>(
  items: readonly T[],
  policy: ModelInputProjectionPolicy,
): T[] {
  if (policy.supportsImageInput && policy.inputFileMediaTypes === undefined) return items as T[];

  let changed = false;
  const projected: T[] = [];
  for (const item of items) {
    const type = modelInputItemType(item);
    if (!policy.supportsImageInput && type === "computer_call") {
      while (modelInputItemType(projected.at(-1)) === "reasoning") projected.pop();
      changed = true;
      continue;
    }
    if (!policy.supportsImageInput && type === "computer_call_result") {
      changed = true;
      continue;
    }
    const stripped = stripUnsupportedContentFromModelInputItem(item, policy);
    if (!stripped) {
      changed = true;
      continue;
    }
    if (stripped !== item) changed = true;
    projected.push(stripped);
  }
  return changed ? (repairHistoryProtocolItems(projected) as T[]) : (items as T[]);
}

/**
 * Build the per-request view for a model's input modalities. Image-capable
 * models receive the exact original array. Text-only models replace ordinary
 * image parts with a visible text marker. Hosted computer call/result pairs are
 * removed because `computer_call_result.output` cannot legally carry text.
 * Durable history is never mutated.
 */
export function projectModelInputForImageSupport<T extends Record<string, unknown>>(
  items: readonly T[],
  supportsImageInput: boolean,
): T[] {
  return projectModelInputForCapabilities(items, { supportsImageInput });
}

export function incrementalModelInputProjectionFilter(
  policy: ModelInputProjectionPolicy,
  initialInputAlreadyProjected: boolean,
): CallModelInputFilter | undefined {
  if (policy.supportsImageInput && policy.inputFileMediaTypes === undefined) return undefined;
  let sourcePrefixLength: number | null = initialInputAlreadyProjected ? null : -1;
  let cachedProjectedPrefix: Array<Record<string, unknown>> | null = null;
  return async ({ modelData }) => ({
    ...modelData,
    input: (() => {
      const input = modelData.input as unknown as Array<Record<string, unknown>>;
      if (sourcePrefixLength === null) {
        // This exact prefix was projected before SDK state construction. Record
        // its length; future calls inspect only items generated this turn.
        sourcePrefixLength = input.length;
        return modelData.input;
      }
      if (sourcePrefixLength < 0 || input.length < sourcePrefixLength) {
        // Approval/human resumes restore an SDK RunState rather than receiving a
        // preprojected durable array. Project that request once and retain only
        // its request-local view; later calls reuse it without mutating RunState.
        const projected = projectModelInputForCapabilities(input, policy);
        sourcePrefixLength = input.length;
        cachedProjectedPrefix = projected === input ? null : projected;
        return projected as typeof modelData.input;
      }
      const tail = input.slice(sourcePrefixLength);
      if (tail.length === 0) return modelData.input;
      const projectedTail = projectModelInputForCapabilities(tail, policy);
      const tailUnchanged =
        projectedTail.length === tail.length &&
        projectedTail.every((item, index) => item === tail[index]);
      if (tailUnchanged && cachedProjectedPrefix === null) {
        return modelData.input;
      }
      return [
        ...(cachedProjectedPrefix ?? input.slice(0, sourcePrefixLength)),
        ...projectedTail,
      ] as typeof modelData.input;
    })(),
  });
}

/**
 * The model-input filter applied before every model call. The computer_call
 * action/actions normalizer is ALWAYS on (the Azure endpoint 400s without it);
 * the provider-item-id strip is layered on top when the configured policy
 * selects it; the context-robustness guard then raises the proactive durable
 * compaction signal on the client-compaction path. Model-specific modality
 * projection is composed by runAgentStream immediately before that final
 * accounting guard.
 */
export function callModelInputFilterForSettings(
  settings: Settings,
  options: ContextRobustnessFilterOptions = {},
): CallModelInputFilter | undefined {
  return composeCallModelInputFilters([
    baseModelInputFilterForSettings(settings),
    boundModelToolOutputsFilterForSettings(settings),
    contextRobustnessFilterForSettings(settings, options),
  ]);
}

/** Rules that normalize history but do not impose final bounds/accounting. */
export function baseModelInputFilterForSettings(settings: Settings): CallModelInputFilter {
  const stripProviderIds = settings.openaiProviderItemIds === "strip";
  return memoizedInputItemProjectionFilter((source) => {
    let item = restoreGenericDispatchHistoryItem(source);
    item = normalizeComputerCallAction(
      item as unknown as Record<string, unknown>,
    ) as unknown as AgentInputItem;
    return stripProviderIds ? stripProviderItemId(item) : item;
  });
}
