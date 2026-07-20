type UsageDetails = Record<string, unknown> | Array<Record<string, unknown>>;

type RequestUsageEntry = {
  inputTokens?: unknown;
  input_tokens?: unknown;
  outputTokens?: unknown;
  output_tokens?: unknown;
  totalTokens?: unknown;
  total_tokens?: unknown;
  inputTokensDetails?: UsageDetails | undefined;
  input_tokens_details?: UsageDetails | undefined;
  outputTokensDetails?: UsageDetails | undefined;
  output_tokens_details?: UsageDetails | undefined;
};

export type ModelCallUsageInput = {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  inputTokensDetails?: UsageDetails | undefined;
  outputTokensDetails?: UsageDetails | undefined;
  requestUsageEntries?: RequestUsageEntry[] | undefined;
};

/**
 * A single provider usage frame above one billion tokens is outside every
 * supported OpenGeni model contract. Keeping the ceiling explicit also prevents
 * malformed-but-finite provider values from corrupting durable accounting or a
 * process-lifetime Prometheus counter.
 */
export const MAX_MODEL_USAGE_TOKEN_COUNT = 1_000_000_000;

export type ModelCallUsageTelemetry = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

export type ModelCallUsageNormalization = {
  telemetry: ModelCallUsageTelemetry;
  totalTokens: number | null;
  /** Bounded field paths only; raw provider values are never retained. */
  rejectedFields: string[];
};

export function modelUsageTokenCountOrNull(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_MODEL_USAGE_TOKEN_COUNT
    ? value
    : null;
}

export function normalizeModelCallUsage(
  usage: ModelCallUsageInput | null | undefined,
): ModelCallUsageNormalization {
  const rejectedFields = new Set<string>();
  if (!usage) {
    return {
      telemetry: {
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
      totalTokens: null,
      rejectedFields: [],
    };
  }

  const requestEntries = requestUsageEntries(usage.requestUsageEntries, rejectedFields);
  const topLevelInputTokens = reportedTokenCount(usage.inputTokens, "inputTokens", rejectedFields);
  const topLevelOutputTokens = reportedTokenCount(
    usage.outputTokens,
    "outputTokens",
    rejectedFields,
  );
  const topLevelTotalTokens = reportedTokenCount(usage.totalTokens, "totalTokens", rejectedFields);
  const requestInputTokens = completeRequestTokenAggregate(
    requestEntries,
    ["inputTokens", "input_tokens"],
    "inputTokens.requestUsageEntries",
    rejectedFields,
  );
  const requestOutputTokens = completeRequestTokenAggregate(
    requestEntries,
    ["outputTokens", "output_tokens"],
    "outputTokens.requestUsageEntries",
    rejectedFields,
  );
  let requestTotalTokens = completeRequestTokenAggregate(
    requestEntries,
    ["totalTokens", "total_tokens"],
    "totalTokens.requestUsageEntries",
    rejectedFields,
  );
  if (rejectInconsistentRequestTotals(requestEntries, rejectedFields)) {
    requestTotalTokens = { ...requestTotalTokens, status: "invalid", value: null };
  }

  // Complete per-request aggregates are the installed SDK's request-level
  // truth. A conflicting top-level field is diagnostic only; it must never
  // override the request sum with a smaller billable/context value. Invalid
  // complete request aggregates fail closed rather than falling back to a
  // potentially undercounting top-level number.
  const inputTokens = canonicalTokenDimension({
    topLevel: topLevelInputTokens,
    topLevelReported: isReported(usage.inputTokens),
    topLevelPath: "inputTokens",
    requestAggregate: requestInputTokens,
    rejectedFields,
  });
  const outputTokens = canonicalTokenDimension({
    topLevel: topLevelOutputTokens,
    topLevelReported: isReported(usage.outputTokens),
    topLevelPath: "outputTokens",
    requestAggregate: requestOutputTokens,
    rejectedFields,
  });
  const totalTokens = canonicalTotalTokens({
    inputTokens,
    outputTokens,
    topLevel: topLevelTotalTokens,
    topLevelReported: isReported(usage.totalTokens),
    requestAggregate: requestTotalTokens,
    rejectedFields,
  });

  const inputDetailSource = preferredDetailSource(
    usage.inputTokensDetails,
    "inputTokensDetails",
    requestEntries,
    ["inputTokensDetails", "input_tokens_details"],
  );
  const outputDetailSource = preferredDetailSource(
    usage.outputTokensDetails,
    "outputTokensDetails",
    requestEntries,
    ["outputTokensDetails", "output_tokens_details"],
  );

  return {
    telemetry: {
      inputTokens,
      outputTokens,
      cachedTokens: aggregateDetailTokenCount(
        inputDetailSource,
        ["cached_tokens", "cachedInputTokens", "cached_input_tokens"],
        "cachedTokens",
        rejectedFields,
      ),
      cacheWriteTokens: aggregateDetailTokenCount(
        inputDetailSource,
        ["cache_write_tokens", "cacheWriteTokens"],
        "cacheWriteTokens",
        rejectedFields,
      ),
      reasoningTokens: aggregateDetailTokenCount(
        outputDetailSource,
        ["reasoning_tokens", "reasoningTokens", "reasoning_output_tokens"],
        "reasoningTokens",
        rejectedFields,
      ),
    },
    totalTokens,
    rejectedFields: [...rejectedFields].slice(0, 32),
  };
}

export function modelCallUsageTelemetry(
  usage: ModelCallUsageInput | null | undefined,
): ModelCallUsageTelemetry {
  return normalizeModelCallUsage(usage).telemetry;
}

function requestUsageEntries(
  value: RequestUsageEntry[] | undefined,
  rejectedFields: Set<string>,
): RequestUsageEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    rejectField(rejectedFields, "requestUsageEntries");
    return [];
  }
  const entries: RequestUsageEntry[] = [];
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      rejectField(rejectedFields, `requestUsageEntries[${index}]`);
      // Preserve the request slot as unknown. Dropping it would let fallback
      // aggregation silently undercount only the well-formed requests.
      entries.push({});
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

type RequestTokenAggregate = {
  status: "absent" | "incomplete" | "invalid" | "complete";
  value: number | null;
};

function completeRequestTokenAggregate(
  requestEntries: RequestUsageEntry[],
  requestKeys: string[],
  aggregatePath: string,
  rejectedFields: Set<string>,
): RequestTokenAggregate {
  if (requestEntries.length === 0) {
    return { status: "absent", value: null };
  }
  const values: Array<number | null> = [];
  let incomplete = false;
  let invalid = false;
  for (const [index, entry] of requestEntries.entries()) {
    const selected = firstPresentEntry(entry as Record<string, unknown>, requestKeys);
    if (!selected || selected.value === null) {
      incomplete = true;
      continue;
    }
    const parsed = reportedTokenCount(
      selected.value,
      `requestUsageEntries[${index}].${selected.key}`,
      rejectedFields,
    );
    if (parsed === null) invalid = true;
    values.push(parsed);
  }
  if (invalid) {
    return { status: "invalid", value: null };
  }
  if (incomplete) {
    return { status: "incomplete", value: null };
  }
  const value = boundedTokenSum(values, aggregatePath, rejectedFields);
  return value === null ? { status: "invalid", value: null } : { status: "complete", value };
}

function canonicalTokenDimension(input: {
  topLevel: number | null;
  topLevelReported: boolean;
  topLevelPath: string;
  requestAggregate: RequestTokenAggregate;
  rejectedFields: Set<string>;
}): number | null {
  if (input.requestAggregate.status === "complete") {
    if (
      input.topLevelReported &&
      input.topLevel !== null &&
      input.topLevel !== input.requestAggregate.value
    ) {
      rejectField(input.rejectedFields, input.topLevelPath);
    }
    return input.requestAggregate.value;
  }
  if (input.requestAggregate.status === "invalid") {
    if (input.topLevelReported) {
      rejectField(input.rejectedFields, input.topLevelPath);
    }
    return null;
  }
  return input.topLevel;
}

function canonicalTotalTokens(input: {
  inputTokens: number | null;
  outputTokens: number | null;
  topLevel: number | null;
  topLevelReported: boolean;
  requestAggregate: RequestTokenAggregate;
  rejectedFields: Set<string>;
}): number | null {
  if (input.inputTokens !== null && input.outputTokens !== null) {
    const derived = boundedTokenSum(
      [input.inputTokens, input.outputTokens],
      "totalTokens.aggregate",
      input.rejectedFields,
    );
    if (derived === null) {
      // Both canonical components are known and exceed the supported aggregate
      // ceiling. Any bounded reported total necessarily undercounts them.
      if (input.topLevelReported) rejectField(input.rejectedFields, "totalTokens");
      if (input.requestAggregate.status === "complete") {
        rejectField(input.rejectedFields, "totalTokens.requestUsageEntries");
      }
      return null;
    }
    if (input.topLevelReported && input.topLevel !== null && input.topLevel !== derived) {
      rejectField(input.rejectedFields, "totalTokens");
    }
    if (input.requestAggregate.status === "complete" && input.requestAggregate.value !== derived) {
      rejectField(input.rejectedFields, "totalTokens.requestUsageEntries");
    }
    return derived;
  }

  if (input.requestAggregate.status === "complete") {
    const requestTotal = input.requestAggregate.value;
    if (
      requestTotal === null ||
      !totalCoversKnownComponents(requestTotal, input.inputTokens, input.outputTokens)
    ) {
      rejectField(input.rejectedFields, "totalTokens.requestUsageEntries");
      if (input.topLevelReported) rejectField(input.rejectedFields, "totalTokens");
      return null;
    }
    if (input.topLevelReported && input.topLevel !== null && input.topLevel !== requestTotal) {
      rejectField(input.rejectedFields, "totalTokens");
    }
    return requestTotal;
  }
  if (input.requestAggregate.status === "invalid") {
    if (input.topLevelReported) rejectField(input.rejectedFields, "totalTokens");
    return null;
  }
  if (
    input.topLevel !== null &&
    !totalCoversKnownComponents(input.topLevel, input.inputTokens, input.outputTokens)
  ) {
    rejectField(input.rejectedFields, "totalTokens");
    return null;
  }
  return input.topLevel;
}

function totalCoversKnownComponents(
  total: number,
  inputTokens: number | null,
  outputTokens: number | null,
): boolean {
  return (
    (inputTokens === null || total >= inputTokens) &&
    (outputTokens === null || total >= outputTokens)
  );
}

function rejectInconsistentRequestTotals(
  requestEntries: RequestUsageEntry[],
  rejectedFields: Set<string>,
): boolean {
  let inconsistent = false;
  for (const [index, entry] of requestEntries.entries()) {
    const record = entry as Record<string, unknown>;
    const selectedInput = firstPresentEntry(record, ["inputTokens", "input_tokens"]);
    const selectedOutput = firstPresentEntry(record, ["outputTokens", "output_tokens"]);
    const selectedTotal = firstPresentEntry(record, ["totalTokens", "total_tokens"]);
    if (!selectedInput || !selectedOutput || !selectedTotal) continue;
    const inputTokens = modelUsageTokenCountOrNull(selectedInput.value);
    const outputTokens = modelUsageTokenCountOrNull(selectedOutput.value);
    const totalTokens = modelUsageTokenCountOrNull(selectedTotal.value);
    if (inputTokens === null || outputTokens === null || totalTokens === null) continue;
    const derived =
      inputTokens <= MAX_MODEL_USAGE_TOKEN_COUNT - outputTokens ? inputTokens + outputTokens : null;
    if (derived === null || totalTokens !== derived) {
      rejectField(rejectedFields, `requestUsageEntries[${index}].${selectedTotal.key}`);
      inconsistent = true;
    }
  }
  return inconsistent;
}

function isReported(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function preferredDetailSource(
  aggregateDetails: UsageDetails | undefined,
  aggregatePath: string,
  requestEntries: RequestUsageEntry[],
  requestKeys: string[],
): Array<{ details: unknown; path: string; missing?: boolean }> {
  const requestDetails: Array<{ details: unknown; path: string; missing?: boolean }> = [];
  let sawRequestDetails = false;
  for (const [index, entry] of requestEntries.entries()) {
    const selected = firstPresentEntry(entry as Record<string, unknown>, requestKeys);
    if (!selected) {
      requestDetails.push({
        details: undefined,
        path: `requestUsageEntries[${index}].${requestKeys[0]}`,
        missing: true,
      });
      continue;
    }
    sawRequestDetails = true;
    requestDetails.push({
      details: selected.value,
      path: `requestUsageEntries[${index}].${selected.key}`,
    });
  }
  // The installed Agents SDK explicitly carries per-request entries. Prefer
  // them when they include detail records; otherwise fall back to the aggregate
  // detail arrays that Usage.add() appends in request order.
  return sawRequestDetails
    ? requestDetails
    : aggregateDetails === undefined
      ? []
      : [{ details: aggregateDetails, path: aggregatePath }];
}

function aggregateDetailTokenCount(
  sources: Array<{ details: unknown; path: string; missing?: boolean }>,
  keys: string[],
  field: string,
  rejectedFields: Set<string>,
): number | null {
  const values: Array<number | null> = [];
  let sawReportedValue = false;
  let sawMissingValue = false;
  for (const source of sources) {
    if (source.missing) {
      sawMissingValue = true;
      continue;
    }
    const details = detailRecords(source.details, source.path, rejectedFields);
    if (!details.complete) {
      sawMissingValue = true;
    }
    for (const detail of details.records) {
      const selected = firstPresentEntry(detail.record, keys);
      if (!selected) {
        sawMissingValue = true;
        continue;
      }
      sawReportedValue = true;
      values.push(
        reportedTokenCount(selected.value, `${detail.path}.${selected.key}`, rejectedFields),
      );
    }
  }
  return sawReportedValue && !sawMissingValue
    ? boundedTokenSum(values, `${field}.aggregate`, rejectedFields)
    : null;
}

function detailRecords(
  details: unknown,
  path: string,
  rejectedFields: Set<string>,
): {
  records: Array<{ record: Record<string, unknown>; path: string }>;
  complete: boolean;
} {
  const entries = Array.isArray(details) ? details : [details];
  const records: Array<{ record: Record<string, unknown>; path: string }> = [];
  let complete = true;
  for (const [index, entry] of entries.entries()) {
    const entryPath = Array.isArray(details) ? `${path}[${index}]` : path;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      rejectField(rejectedFields, entryPath);
      complete = false;
      continue;
    }
    records.push({ record: entry as Record<string, unknown>, path: entryPath });
  }
  return { records, complete };
}

function firstPresentEntry(
  record: Record<string, unknown>,
  keys: string[],
): { key: string; value: unknown } | null {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      // One request can expose the same value under provider and SDK aliases.
      // Pick the first canonical alias instead of adding aliases together.
      return { key, value: record[key] };
    }
  }
  return null;
}

function reportedTokenCount(
  value: unknown,
  field: string,
  rejectedFields: Set<string>,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = modelUsageTokenCountOrNull(value);
  if (normalized === null) {
    rejectField(rejectedFields, field);
  }
  return normalized;
}

function boundedTokenSum(
  values: Array<number | null>,
  field: string,
  rejectedFields: Set<string>,
): number | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  let total = 0;
  for (const value of values as number[]) {
    if (value > MAX_MODEL_USAGE_TOKEN_COUNT - total) {
      rejectField(rejectedFields, field);
      return null;
    }
    total += value;
  }
  return total;
}

function rejectField(rejectedFields: Set<string>, field: string): void {
  if (rejectedFields.size < 32) {
    rejectedFields.add(field);
  }
}
