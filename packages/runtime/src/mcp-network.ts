import { beginMcpPhase, traceparent } from "@opengeni/observability";
import type { Settings } from "@opengeni/config";
import { CODEMODE_ARGUMENTS_MAX_BYTES, MCP_MAX_CATALOG_TOOL_ENTRIES } from "@opengeni/contracts";
import {
  isNonPublicAddress,
  pinnedFetch,
  resolvePinnedDestination,
  type DnsLookup,
  type FetchLike,
} from "@opengeni/network";

export { undiciFetch } from "@opengeni/network";

export const MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Codemode sends its admitted call through the same first-party MCP endpoint.
// Keep enough JSON-RPC envelope headroom above the exact 4 MiB argument bound;
// a lower HTTP limit rejects valid calls before the tool can execute and turns
// a deterministic transport refusal into apparent outcome uncertainty.
export const MCP_MAX_INBOUND_REQUEST_BYTES = CODEMODE_ARGUMENTS_MAX_BYTES + 64 * 1024;
// Rich nested schemas fit within one bounded discovery/disclosure envelope.
// Whole-server and aggregate limits still bound the complete catalog.
export const MCP_MAX_TOOL_DEFINITION_BYTES = 512 * 1024;
export const MCP_MAX_TOOL_LIST_BYTES = 4 * 1024 * 1024;
export const MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES = MCP_MAX_CATALOG_TOOL_ENTRIES;
// One provider may use the available catalog allowance. The shared budget
// still accounts for every provider together; a separate lower count ceiling
// silently excluded otherwise bounded catalogs from best-effort discovery.
export const MCP_MAX_TOOL_LIST_ENTRIES = MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES;
export const MCP_MAX_TOOL_RESULT_BYTES = 1024 * 1024;
export const MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES = MCP_MAX_TOOL_DEFINITION_BYTES + 16 * 1024;
export const MCP_MAX_SELECTED_SERVERS = 64;
export const MCP_MAX_CONCURRENT_SERVER_OPERATIONS = 8;
// @openai/agents has a separate lifecycle fence around MCPServer.connect().
// It defaults to 10 seconds and can otherwise preempt a larger per-server
// transport timeout before that server finishes its own handshake.
export const MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_MAX_AGGREGATE_TOOL_LIST_BYTES = 16 * 1024 * 1024;
// Ordered tool admission never waits longer than this on an earlier server.
export const MCP_ORDERED_ADMISSION_MAX_WAIT_MS = 120_000;

export const MCP_REPLAY_SAFE_METHODS = [
  "initialize",
  "notifications/initialized",
  "tools/list",
] as const;

export type McpJsonRpcId = string | number | null;

export type McpRequestReplayInfo = {
  replaySafeAfter401: boolean;
  batch: boolean;
  responseIds: readonly McpJsonRpcId[];
  method?: string;
  id?: McpJsonRpcId;
  toolName?: string;
  operationId?: string;
};

export type McpTransportFailureCauseDiagnostic = Readonly<{
  kind: "error" | "object" | "string" | "number" | "boolean" | "null" | "other";
  name?: string;
  message?: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  value?: string | number | boolean | null;
}>;

export type McpTransportRequestFailureDiagnostic = Readonly<{
  httpMethod: string;
  rpcMethod?: string;
  /** The thrown source is first, followed by its successive `cause` values. */
  causeChain: readonly McpTransportFailureCauseDiagnostic[];
  causeChainComplete: boolean;
}>;

type ClassifiedMcpJsonRpcRequest = {
  valid: boolean;
  method?: string;
  id?: McpJsonRpcId;
  toolName?: string;
  operationId?: string;
};

const MCP_REPLAY_SAFE_METHOD_SET = new Set<string>(MCP_REPLAY_SAFE_METHODS);
const MCP_TRANSPORT_FAILURE_CAUSE_MAX_NODES = 8;
const MCP_TRANSPORT_FAILURE_LOOKUP_MAX_NODES = 32;
const MCP_TRANSPORT_FAILURE_NESTED_KEYS = ["cause", "error", "response", "data"] as const;
const mcpTransportRequestFailures = new WeakMap<object, McpTransportRequestFailureDiagnostic>();

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyMcpJsonRpcRequest(value: unknown): ClassifiedMcpJsonRpcRequest {
  if (!isJsonObject(value)) {
    return { valid: false };
  }
  const hasId = Object.prototype.hasOwnProperty.call(value, "id");
  const id =
    typeof value.id === "string" || typeof value.id === "number" || value.id === null
      ? value.id
      : undefined;
  const validId = !hasId || id !== undefined;
  const method =
    typeof value.method === "string" && value.method.length > 0 ? value.method : undefined;
  const valid = value.jsonrpc === "2.0" && method !== undefined && validId;
  const params = isJsonObject(value.params) ? value.params : undefined;
  const toolName =
    valid && method === "tools/call" && typeof params?.name === "string" ? params.name : undefined;
  const meta =
    valid && method === "tools/call" && isJsonObject(params?._meta) ? params._meta : null;
  const operationId =
    meta && typeof meta.opengeniOperationId === "string" && meta.opengeniOperationId.length > 0
      ? meta.opengeniOperationId
      : undefined;
  return {
    valid,
    ...(valid && method ? { method } : {}),
    ...(hasId && id !== undefined ? { id } : {}),
    ...(toolName ? { toolName } : {}),
    ...(operationId ? { operationId } : {}),
  };
}

function invalidMcpRequestReplayInfo(batch = false): McpRequestReplayInfo {
  return {
    replaySafeAfter401: false,
    batch,
    responseIds: [],
  };
}

/**
 * Classify one outbound MCP JSON-RPC body for post-401 replay. The policy is
 * deliberately fail-closed: only the exact reviewed handshake/list allowlist
 * may be resent. Unknown extensions, malformed requests, non-list methods, and
 * batches containing any unsafe or invalid entry are outcome-uncertain.
 */
export async function mcpRequestReplayInfo(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<McpRequestReplayInfo> {
  let body: string | null = null;
  if (typeof init?.body === "string") {
    body = init.body;
  } else if (init?.body !== undefined && init.body !== null) {
    return invalidMcpRequestReplayInfo();
  } else if (input instanceof Request && (init?.method ?? input.method).toUpperCase() === "POST") {
    body = await input
      .clone()
      .text()
      .catch(() => null);
  }
  if (!body) {
    return invalidMcpRequestReplayInfo();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return invalidMcpRequestReplayInfo();
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return invalidMcpRequestReplayInfo(true);
    }
    const requests = parsed.map(classifyMcpJsonRpcRequest);
    const valid = requests.every((request) => request.valid);
    const responseIds = requests.flatMap((request) =>
      request.id !== undefined ? [request.id] : [],
    );
    const toolName = requests.find((request) => request.toolName)?.toolName;
    return {
      replaySafeAfter401:
        valid &&
        requests.every(
          (request) =>
            request.method !== undefined && MCP_REPLAY_SAFE_METHOD_SET.has(request.method),
        ),
      batch: true,
      responseIds,
      ...(toolName ? { toolName } : {}),
    };
  }

  const request = classifyMcpJsonRpcRequest(parsed);
  if (!request.valid || request.method === undefined) {
    return {
      ...invalidMcpRequestReplayInfo(),
      ...(request.id !== undefined ? { responseIds: [request.id] } : {}),
    };
  }
  return {
    replaySafeAfter401: MCP_REPLAY_SAFE_METHOD_SET.has(request.method),
    batch: false,
    responseIds: request.id !== undefined ? [request.id] : [],
    method: request.method,
    ...(request.id !== undefined ? { id: request.id } : {}),
    ...(request.toolName ? { toolName: request.toolName } : {}),
    ...(request.operationId ? { operationId: request.operationId } : {}),
  };
}

function mcpTransportHttpMethod(input: string | URL | Request, init?: RequestInit): string {
  try {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    return method.length > 0 ? method.toUpperCase() : "GET";
  } catch {
    return "GET";
  }
}

async function mcpTransportRpcMethod(
  input: string | URL | Request,
  init: RequestInit | undefined,
  httpMethod: string,
): Promise<string | undefined> {
  if (httpMethod !== "POST") return undefined;
  try {
    return (await mcpRequestReplayInfo(input, init)).method;
  } catch {
    // Request diagnostics must never preempt or replace the transport call.
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mcpTransportFailureCauseDiagnostic(value: unknown): {
  diagnostic: McpTransportFailureCauseDiagnostic;
  complete: boolean;
} {
  if (value === null) {
    return { diagnostic: Object.freeze({ kind: "null", value: null }), complete: true };
  }
  if (typeof value === "string") {
    return { diagnostic: Object.freeze({ kind: "string", value }), complete: true };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { diagnostic: Object.freeze({ kind: "number", value }), complete: true };
  }
  if (typeof value === "boolean") {
    return { diagnostic: Object.freeze({ kind: "boolean", value }), complete: true };
  }
  if (!value || typeof value !== "object") {
    return { diagnostic: Object.freeze({ kind: "other" }), complete: false };
  }

  const diagnostic: {
    kind: "error" | "object";
    name?: string;
    message?: string;
    code?: string | number;
    status?: number;
    statusCode?: number;
  } = { kind: "object" };
  try {
    const record = value as Record<string, unknown>;
    diagnostic.kind = value instanceof Error ? "error" : "object";
    const name = record.name;
    const message = record.message;
    const code = record.code;
    const rawStatus = record.status;
    const rawStatusCode = record.statusCode;
    if (typeof name === "string") diagnostic.name = name;
    if (typeof message === "string") diagnostic.message = message;
    if (typeof code === "string" || finiteNumber(code) !== undefined) {
      diagnostic.code = code as string | number;
    }
    const status = finiteNumber(rawStatus);
    const statusCode = finiteNumber(rawStatusCode);
    if (status !== undefined) diagnostic.status = status;
    if (statusCode !== undefined) diagnostic.statusCode = statusCode;
    return { diagnostic: Object.freeze(diagnostic), complete: true };
  } catch {
    // The source error remains authoritative even when a hostile getter keeps
    // one optional diagnostic field from being inspected.
    return { diagnostic: Object.freeze(diagnostic), complete: false };
  }
}

function snapshotMcpTransportFailureCauseChain(error: unknown): {
  causeChain: readonly McpTransportFailureCauseDiagnostic[];
  causeChainComplete: boolean;
} {
  const causeChain: McpTransportFailureCauseDiagnostic[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = error;
  let causeChainComplete = true;

  for (let index = 0; index < MCP_TRANSPORT_FAILURE_CAUSE_MAX_NODES; index += 1) {
    if (current && typeof current === "object" && seen.has(current)) {
      causeChainComplete = false;
      break;
    }
    const snapshot = mcpTransportFailureCauseDiagnostic(current);
    causeChain.push(snapshot.diagnostic);
    if (!snapshot.complete) causeChainComplete = false;
    if (!current || typeof current !== "object") break;
    seen.add(current);
    try {
      if (!("cause" in current)) break;
      const cause = (current as Record<string, unknown>).cause;
      if (cause === undefined) break;
      current = cause;
    } catch {
      causeChainComplete = false;
      break;
    }
    if (index === MCP_TRANSPORT_FAILURE_CAUSE_MAX_NODES - 1) {
      causeChainComplete = false;
    }
  }

  return {
    causeChain: Object.freeze(causeChain),
    causeChainComplete,
  };
}

function recordMcpTransportRequestFailure(
  error: unknown,
  request: { httpMethod: string; rpcMethod?: string },
): void {
  if (!error || typeof error !== "object") return;
  try {
    mcpTransportRequestFailures.set(
      error,
      Object.freeze({
        httpMethod: request.httpMethod,
        ...(request.rpcMethod ? { rpcMethod: request.rpcMethod } : {}),
        ...snapshotMcpTransportFailureCauseChain(error),
      }),
    );
  } catch {
    // Diagnostics are out-of-band and must never replace the exact failure.
  }
}

/**
 * Recover the request identity captured at the MCP transport boundary. SDK
 * layers may retain the source under a structural wrapper, so lookup follows a
 * bounded error graph without mutating or reclassifying any Error object.
 */
export function mcpTransportRequestFailureDiagnostic(
  error: unknown,
): McpTransportRequestFailureDiagnostic | null {
  const pending: unknown[] = [error];
  const seen = new WeakSet<object>();
  let inspected = 0;

  while (pending.length > 0 && inspected < MCP_TRANSPORT_FAILURE_LOOKUP_MAX_NODES) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    inspected += 1;
    const diagnostic = mcpTransportRequestFailures.get(current);
    if (diagnostic) return diagnostic;
    try {
      const record = current as Record<string, unknown>;
      for (const key of MCP_TRANSPORT_FAILURE_NESTED_KEYS) {
        const nested = record[key];
        if (nested && typeof nested === "object") pending.push(nested);
      }
      if (Array.isArray(record.errors)) pending.push(...record.errors.slice(0, 8));
    } catch {
      // A hostile wrapper cannot erase diagnostics attached to another node.
    }
  }
  return null;
}

export function mcpJsonRpcErrorPayloadForRequest(
  request: McpRequestReplayInfo,
  error: { code: number; message: string; data?: unknown },
):
  | {
      jsonrpc: "2.0";
      id: McpJsonRpcId;
      error: { code: number; message: string; data?: unknown };
    }
  | Array<{
      jsonrpc: "2.0";
      id: McpJsonRpcId;
      error: { code: number; message: string; data?: unknown };
    }> {
  const payload = (id: McpJsonRpcId) => ({ jsonrpc: "2.0" as const, id, error });
  if (request.batch) {
    const ids = request.responseIds.length > 0 ? request.responseIds : [null];
    return ids.map(payload);
  }
  return payload(request.id ?? null);
}

export class McpPayloadTooLargeError extends Error {
  constructor(
    readonly label: string,
    readonly actualBytes: number,
    readonly maxBytes: number,
    readonly unit: "byte" | "entry" = "byte",
  ) {
    super(`${label} exceeds the ${maxBytes}-${unit} safety limit`);
    this.name = "McpPayloadTooLargeError";
  }
}

/** A size-limit refusal anywhere in an error's cause chain, across SDK copies. */
export function isMcpPayloadTooLargeError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    if (
      current instanceof McpPayloadTooLargeError ||
      (current as { name?: unknown }).name === "McpPayloadTooLargeError"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function mcpSerializedSizeBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    throw new Error("MCP payload is not JSON serializable");
  }
  return Buffer.byteLength(serialized);
}

export function assertMcpPayloadWithinBytes(value: unknown, maxBytes: number, label: string): void {
  const actualBytes = mcpSerializedSizeBytes(value);
  if (actualBytes > maxBytes) {
    throw new McpPayloadTooLargeError(label, actualBytes, maxBytes);
  }
}

export function assertMcpToolListWithinBounds<T>(tools: readonly T[]): readonly T[] {
  if (tools.length > MCP_MAX_TOOL_LIST_ENTRIES) {
    throw new McpPayloadTooLargeError(
      "MCP tool list",
      tools.length,
      MCP_MAX_TOOL_LIST_ENTRIES,
      "entry",
    );
  }
  for (const tool of tools) {
    const toolBytes = mcpSerializedSizeBytes(tool);
    if (toolBytes > MCP_MAX_TOOL_DEFINITION_BYTES) {
      throw new McpPayloadTooLargeError(
        "MCP tool definition",
        toolBytes,
        MCP_MAX_TOOL_DEFINITION_BYTES,
      );
    }
  }
  // Measure the complete JSON array, including brackets and separators. Summing
  // definitions alone under-counts by one byte per separator plus the array
  // delimiters and makes the advertised serialized-byte ceiling porous.
  const totalBytes = mcpSerializedSizeBytes(tools);
  if (totalBytes > MCP_MAX_TOOL_LIST_BYTES) {
    throw new McpPayloadTooLargeError("MCP tool list", totalBytes, MCP_MAX_TOOL_LIST_BYTES);
  }
  return tools;
}

export function assertMcpServerSelectionWithinBounds<T>(servers: readonly T[]): readonly T[] {
  if (servers.length > MCP_MAX_SELECTED_SERVERS) {
    throw new McpPayloadTooLargeError(
      "selected MCP server count",
      servers.length,
      MCP_MAX_SELECTED_SERVERS,
      "entry",
    );
  }
  return servers;
}

/** Why one listed tool was left out of a server's tool list for this attempt. */
export type McpToolListDropReason =
  | "definition_unreadable"
  | "definition_too_large"
  | "list_entry_limit"
  | "list_byte_limit"
  | "aggregate_entry_limit"
  | "aggregate_byte_limit"
  | "model_name_taken";

export type McpToolListDrop = {
  /** The listed name, bounded; empty when the listing had none. */
  name: string;
  reason: McpToolListDropReason;
};

export type McpToolListFit<T> = {
  tools: T[];
  dropped: McpToolListDrop[];
};

export type McpToolListFitOptions<T> = {
  /** Tools to admit before all others (harness control, eager tools). */
  keepFirst?: (tool: T) => boolean;
  maxEntries?: number;
  maxBytes?: number;
  /** Reasons recorded for tools that do not fit; list limits by default. */
  limitReasons?: { entries: McpToolListDropReason; bytes: McpToolListDropReason };
};

function listedToolName(tool: unknown): string {
  const name = (tool as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name.slice(0, 256) : "";
}

/**
 * Fit one tools/list inside the safety limits without failing it: a
 * definition over the per-tool limit is left out, then tools are admitted
 * `keepFirst` tools first and otherwise by name while the list stays within
 * its entry and serialized-byte limits. The result keeps the listing order and
 * names every tool left out, so the caller can warn and tell the model.
 */
export function fitMcpToolListWithinBounds<T>(
  tools: readonly T[],
  options: McpToolListFitOptions<T> = {},
): McpToolListFit<T> {
  const maxEntries = options.maxEntries ?? MCP_MAX_TOOL_LIST_ENTRIES;
  const maxBytes = options.maxBytes ?? MCP_MAX_TOOL_LIST_BYTES;
  const reasons = options.limitReasons ?? {
    entries: "list_entry_limit" as const,
    bytes: "list_byte_limit" as const,
  };
  const dropped: McpToolListDrop[] = [];
  const sizes = new Array<number>(tools.length);
  const candidates: number[] = [];
  tools.forEach((tool, index) => {
    let size: number;
    try {
      size = mcpSerializedSizeBytes(tool);
    } catch {
      dropped.push({ name: listedToolName(tool), reason: "definition_unreadable" });
      return;
    }
    if (size > MCP_MAX_TOOL_DEFINITION_BYTES) {
      dropped.push({ name: listedToolName(tool), reason: "definition_too_large" });
      return;
    }
    sizes[index] = size;
    candidates.push(index);
  });
  // Choose what to keep by stable names, not listing order: a provider can
  // list the same tools in a different order (or page) on another turn, and
  // the kept set must stay the same for the same tools.
  const keepFirst = options.keepFirst;
  const pinned = (index: number) => (keepFirst?.(tools[index]!) ? 0 : 1);
  const order = [...candidates].sort((left, right) => {
    const byPin = pinned(left) - pinned(right);
    if (byPin !== 0) return byPin;
    const leftName = listedToolName(tools[left]);
    const rightName = listedToolName(tools[right]);
    return leftName < rightName ? -1 : leftName > rightName ? 1 : left - right;
  });
  const accepted = new Set<number>();
  // A JSON array serializes as "[" + items joined by "," + "]", so this is the
  // exact serialized size of the accepted list, not an estimate.
  let bytes = 2;
  for (const index of order) {
    const added = sizes[index]! + (accepted.size > 0 ? 1 : 0);
    if (accepted.size + 1 > maxEntries) {
      dropped.push({ name: listedToolName(tools[index]), reason: reasons.entries });
    } else if (bytes + added > maxBytes) {
      dropped.push({ name: listedToolName(tools[index]), reason: reasons.bytes });
    } else {
      accepted.add(index);
      bytes += added;
    }
  }
  return {
    tools: tools.filter((_, index) => accepted.has(index)),
    dropped,
  };
}

/** One plain sentence for the model about tools left out of one server's list. */
export function describeMcpToolListDrops(dropped: readonly McpToolListDrop[]): string {
  const counts = new Map<string, number>();
  for (const { reason } of dropped) {
    const why =
      reason === "model_name_taken"
        ? "their names clash with another integration's tools"
        : reason === "definition_too_large" || reason === "definition_unreadable"
          ? "their definitions are too large or unreadable"
          : "the integration lists more tools than one turn can hold";
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  const parts = [...counts].map(([why, count]) => `${count} because ${why}`);
  const names = dropped
    .map(({ name }) => name)
    .filter(Boolean)
    .slice(0, 5);
  return (
    `connected, but ${dropped.length} of its tools are unavailable this turn (${parts.join("; ")})` +
    (names.length ? `, for example ${names.join(", ")}` : "") +
    ". Its other tools work."
  ).slice(0, 1_000);
}

export function mcpOuterConnectTimeoutMs(
  configuredTimeouts: readonly (number | undefined)[],
): number {
  return Math.max(
    MCP_DEFAULT_OUTER_CONNECT_TIMEOUT_MS,
    ...configuredTimeouts.flatMap((timeoutMs) => (timeoutMs === undefined ? [] : [timeoutMs])),
  );
}

type McpToolListContribution = {
  entries: number;
  bytes: number;
};

/**
 * Atomic aggregate accounting shared by every exposed tools/list in one run.
 * A repeated list for the same source REPLACES its prior contribution, so
 * cache invalidation/relisting cannot ratchet the budget upward. Failed
 * replacements leave the previous accounting intact.
 */
export class McpAggregateToolListBudget {
  private readonly contributions = new Map<string, McpToolListContribution>();
  /** Model name -> the source that listed it first this run. */
  private readonly modelNameClaims = new Map<string, string>();
  /** Admission order: a source admits only after every source before it. */
  private readonly order: string[] = [];
  /** Starts a source's own listing, so a later source never waits on idle work. */
  private readonly starters = new Map<string, () => unknown>();
  private readonly settled = new Map<
    string,
    { done: boolean; promise: Promise<void>; resolve: () => void }
  >();
  private totalEntries = 0;
  private totalBytes = 0;

  constructor(
    private readonly label = "aggregate MCP tool list",
    private readonly maxEntries = MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES,
    private readonly maxBytes = MCP_MAX_AGGREGATE_TOOL_LIST_BYTES,
  ) {}

  replace<T>(sourceId: string, tools: readonly T[]): readonly T[] {
    assertMcpToolListWithinBounds(tools);
    const contribution = {
      entries: tools.length,
      // Conservatively account each server as its complete serialized array.
      // Summing these arrays slightly over-counts the brackets relative to one
      // flattened array, which is intentional for a fail-closed hard ceiling.
      bytes: mcpSerializedSizeBytes(tools),
    };
    const previous = this.contributions.get(sourceId) ?? { entries: 0, bytes: 0 };
    const nextEntries = this.totalEntries - previous.entries + contribution.entries;
    if (nextEntries > this.maxEntries) {
      throw new McpPayloadTooLargeError(this.label, nextEntries, this.maxEntries, "entry");
    }
    const nextBytes = this.totalBytes - previous.bytes + contribution.bytes;
    if (nextBytes > this.maxBytes) {
      throw new McpPayloadTooLargeError(this.label, nextBytes, this.maxBytes);
    }
    this.contributions.set(sourceId, contribution);
    this.totalEntries = nextEntries;
    this.totalBytes = nextBytes;
    return tools;
  }

  /**
   * Admit one source's list without failing it: tools whose model name another
   * source already listed are left out (first listing wins), then the list is
   * fitted to the per-list limits and to what is left of the aggregate budget.
   * This keeps every server's listing disjoint by model name, so one connector
   * can never take another's name or fail the run with a duplicate. Like
   * `replace`, a relist replaces this source's earlier contribution and claims.
   */
  admit<T>(
    sourceId: string,
    tools: readonly T[],
    options: Pick<McpToolListFitOptions<T>, "keepFirst"> = {},
  ): McpToolListFit<T> {
    const dropped: McpToolListDrop[] = [];
    const unclaimed = tools.filter((tool) => {
      const name = (tool as { name?: unknown } | null)?.name;
      if (typeof name !== "string") return true;
      const owner = this.modelNameClaims.get(name);
      if (owner === undefined || owner === sourceId) return true;
      dropped.push({ name: name.slice(0, 256), reason: "model_name_taken" });
      return false;
    });
    const listed = fitMcpToolListWithinBounds(unclaimed, options);
    const previous = this.contributions.get(sourceId) ?? { entries: 0, bytes: 0 };
    const fitted = fitMcpToolListWithinBounds(listed.tools, {
      ...options,
      maxEntries: this.maxEntries - (this.totalEntries - previous.entries),
      maxBytes: this.maxBytes - (this.totalBytes - previous.bytes),
      limitReasons: { entries: "aggregate_entry_limit", bytes: "aggregate_byte_limit" },
    });
    this.remove(sourceId);
    const contribution = {
      entries: fitted.tools.length,
      bytes: fitted.tools.length > 0 ? mcpSerializedSizeBytes(fitted.tools) : 0,
    };
    this.contributions.set(sourceId, contribution);
    this.totalEntries += contribution.entries;
    this.totalBytes += contribution.bytes;
    for (const tool of fitted.tools) {
      const name = (tool as { name?: unknown } | null)?.name;
      if (typeof name === "string") this.modelNameClaims.set(name, sourceId);
    }
    this.settlement(sourceId).resolve();
    return { tools: fitted.tools, dropped: [...dropped, ...listed.dropped, ...fitted.dropped] };
  }

  /**
   * Fix the admission order of these sources (appended after any already
   * ordered). Servers list concurrently, so first-come admission would make
   * the kept set depend on network timing; ordered admission makes the same
   * selection keep the same tools on every turn and replica.
   */
  sequence(sources: readonly (string | { sourceId: string; start: () => unknown })[]): void {
    for (const source of sources) {
      const sourceId = typeof source === "string" ? source : source.sourceId;
      if (!this.order.includes(sourceId)) this.order.push(sourceId);
      if (typeof source !== "string" && !this.starters.has(sourceId)) {
        this.starters.set(sourceId, source.start);
      }
    }
  }

  /**
   * `admit` once every source ordered before this one has admitted or been
   * removed. Waiting starts each unsettled predecessor's own listing (listing
   * is idempotent), so progress never depends on another caller listing it.
   * A predecessor that still never settles delays this one by at most
   * `maxWaitMs`, after which it admits anyway rather than hang the turn.
   */
  async admitInOrder<T>(
    sourceId: string,
    tools: readonly T[],
    options: Pick<McpToolListFitOptions<T>, "keepFirst"> = {},
    maxWaitMs = MCP_ORDERED_ADMISSION_MAX_WAIT_MS,
  ): Promise<McpToolListFit<T>> {
    const index = this.order.indexOf(sourceId);
    if (index > 0) {
      const predecessors = Promise.all(
        this.order.slice(0, index).map((id) => {
          const settlement = this.settlement(id);
          if (!settlement.done) {
            try {
              void Promise.resolve(this.starters.get(id)?.()).catch(() => undefined);
            } catch {
              // A failed start settles through the source's own failure path.
            }
          }
          return settlement.promise;
        }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        predecessors.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), maxWaitMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) {
        console.warn("[mcp] ordered tool admission waited too long; admitting now", {
          event: "tool_catalog_degraded",
          code: "admission_order_timeout",
          sourceId: sourceId.slice(0, 256),
        });
      }
    }
    return this.admit(sourceId, tools, options);
  }

  private settlement(sourceId: string) {
    let entry = this.settled.get(sourceId);
    if (!entry) {
      const created = { done: false } as {
        done: boolean;
        promise: Promise<void>;
        resolve: () => void;
      };
      created.promise = new Promise<void>((done) => {
        created.resolve = () => {
          created.done = true;
          done();
        };
      });
      entry = created;
      this.settled.set(sourceId, entry);
    }
    return entry;
  }

  remove(sourceId: string): void {
    this.settlement(sourceId).resolve();
    for (const [name, owner] of this.modelNameClaims) {
      if (owner === sourceId) this.modelNameClaims.delete(name);
    }
    const previous = this.contributions.get(sourceId);
    if (!previous) return;
    this.contributions.delete(sourceId);
    this.totalEntries -= previous.entries;
    this.totalBytes -= previous.bytes;
  }

  snapshot(): Readonly<McpToolListContribution> {
    return { entries: this.totalEntries, bytes: this.totalBytes };
  }
}

/** Stable-order parallel map with a hard in-flight ceiling and fail-stop drain. */
export async function boundedParallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("bounded parallel map concurrency must be a positive integer");
  }
  if (values.length === 0) return [];

  const results = new Array<R>(values.length);
  const errors: Array<{ index: number; error: unknown }> = [];
  let nextIndex = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      if (index >= values.length) return;
      nextIndex += 1;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        errors.push({ index, error });
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  if (errors.length > 0) {
    errors.sort((left, right) => left.index - right.index);
    throw errors[0]!.error;
  }
  return results;
}

/**
 * Guard normal MCP traffic with the same deployment policy as OAuth traffic.
 * The pinned transport resolves and policy-checks the destination after the
 * caller has composed any credential headers, then performs the final network
 * call through the vetted Agent. It forces manual redirects, so an
 * Authorization-bearing request never follows a provider-controlled Location
 * to an unvalidated host.
 *
 * This module is deliberately agent-loop-free. API code imports the explicit
 * `@opengeni/runtime/mcp-network` leaf rather than the runtime root barrel.
 */
export function guardedMcpFetch<TInput extends string | URL | Request>(
  settings: Pick<Settings, "environment" | "integrationsAllowPrivateNetworkTargets">,
  fetchImpl: (input: TInput, init?: RequestInit) => Promise<Response>,
  options: {
    maxResponseBytes?: number;
    dnsLookup?: DnsLookup;
    pinResolvedDestination?: boolean;
    requireHttpsOutsideLocalTest?: boolean;
    usePinnedRequestTransport?: boolean;
  } = {},
): (input: TInput, init?: RequestInit) => Promise<Response> {
  return async (input: TInput, init?: RequestInit) => {
    const httpMethod = mcpTransportHttpMethod(input, init);
    const rpcMethod = await mcpTransportRpcMethod(input, init, httpMethod);
    const destinationOptions = {
      ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
      label: "MCP endpoint",
      requireHttpsOutsideLocalTest: options.requireHttpsOutsideLocalTest ?? true,
    };
    let response: Response;
    const observation = beginMcpPhase("network_headers");
    // RequestInit headers replace Request headers in Fetch; do not accidentally
    // restore a credential the caller deliberately omitted from an override.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete("traceparent");
    headers.delete("tracestate");
    headers.delete("baggage");
    const parent = observation.traceContext && traceparent(observation.traceContext);
    if (parent) headers.set("traceparent", parent);
    const tracedInit = { ...init, headers };
    try {
      if (options.pinResolvedDestination === false) {
        await resolvePinnedDestination(input instanceof Request ? input.url : input, settings, {
          ...destinationOptions,
        });
        response = await observation.run(() =>
          fetchImpl(input, { ...tracedInit, redirect: "manual" }),
        );
      } else {
        response = await observation.run(() =>
          pinnedFetch(input, tracedInit, settings, {
            ...(options.usePinnedRequestTransport ? {} : { fetchImpl: fetchImpl as FetchLike }),
            ...destinationOptions,
          }),
        );
      }
      observation.end(response.ok ? "completed" : "rejected");
    } catch (error) {
      observation.end("failed");
      recordMcpTransportRequestFailure(error, {
        httpMethod,
        ...(rpcMethod ? { rpcMethod } : {}),
      });
      throw error;
    }
    return observation.run(() =>
      boundMcpResponseBody(response, options.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES),
    );
  };
}

export function boundMcpResponseBody(response: Response, maxBytes: number): Response {
  const observation = beginMcpPhase("network_body");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    observation.end("rejected");
    void response.body?.cancel().catch(() => undefined);
    throw new McpPayloadTooLargeError("MCP response", declaredLength, maxBytes);
  }
  if (!response.body) {
    observation.end();
    return response;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    observation.end("failed");
    throw error;
  }
  let receivedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          observation.end();
          controller.close();
          return;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maxBytes) {
          observation.end("rejected");
          await reader.cancel().catch(() => undefined);
          controller.error(new McpPayloadTooLargeError("MCP response", receivedBytes, maxBytes));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        observation.end("failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      observation.end("cancelled");
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(bounded, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url },
  });
  return bounded;
}

export async function cancelMcpResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Read and rebuild an inbound MCP request before the SDK parses it. */
export async function boundedMcpRequest(
  request: Request,
  maxBytes = MCP_MAX_INBOUND_REQUEST_BYTES,
): Promise<Request> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^\d+$/.test(normalized)) {
      await request.body?.cancel().catch(() => undefined);
      throw new McpPayloadTooLargeError("MCP request", 0, maxBytes);
    }
    const declaredBytes = Number(normalized);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      throw new McpPayloadTooLargeError("MCP request", declaredBytes, maxBytes);
    }
  }
  if (!request.body) {
    return request;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      receivedBytes += result.value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpPayloadTooLargeError("MCP request", receivedBytes, maxBytes);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body, headers: request.headers });
}

export async function assertMcpDestinationAllowed(
  rawUrl: string,
  settings: Pick<Settings, "environment" | "integrationsAllowPrivateNetworkTargets">,
  options: { dnsLookup?: DnsLookup } = {},
): Promise<void> {
  await resolvePinnedDestination(rawUrl, settings, {
    ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
    label: "MCP endpoint",
    requireHttpsOutsideLocalTest: true,
  });
}

export const isNonPublicMcpAddress = isNonPublicAddress;
