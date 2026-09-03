import { randomUUID } from "node:crypto";
import {
  ATTEMPT_TOOL_CATALOG_VERSION,
  ATTEMPT_TOOL_CATALOG_MAX_BYTES,
  AttemptToolCall,
  AttemptToolCatalog,
  AttemptToolResult,
  CodemodeCallSubmission,
  CodemodeOperation,
  CodemodeDispatchAck,
  CodemodeDispatchRequest,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  type AttemptToolCall as AttemptToolCallValue,
  AttemptToolCaller,
  type AttemptToolCatalog as AttemptToolCatalogValue,
  type AttemptToolCatalogEntry as AttemptToolCatalogEntryValue,
  type AttemptToolIdentity,
  type AttemptToolResult as AttemptToolResultValue,
  type CodemodeDispatchAck as CodemodeDispatchAckValue,
  type CodemodeDispatchRequest as CodemodeDispatchRequestValue,
  type CodemodeOperation as CodemodeOperationValue,
} from "@opengeni/contracts";
import {
  ToolGateway,
  ToolGatewayApprovalRequiredError as AttemptToolApprovalRequiredError,
  ToolGatewayCatalogIntegrityError as AttemptToolCatalogIntegrityError,
  ToolGatewayCatalogStaleError as AttemptToolCatalogStaleError,
  ToolGatewayCatalogTooLargeError as AttemptToolCatalogTooLargeError,
  ToolGatewayInputValidationError as AttemptToolInputValidationError,
  ToolGatewayOutputValidationError as AttemptToolOutputValidationError,
  ToolGatewayPathCollisionError as AttemptToolPathCollisionError,
  ToolGatewayToolNotFoundError as AttemptToolNotFoundError,
  digestCanonicalJson,
  prepareToolGatewayDefinitions,
  type PreparedToolGatewayCall,
  type ToolGatewayCallLifecycle,
  type ToolGatewayDefinition,
} from "@opengeni/tool-gateway";

export type { AttemptToolCatalog, AttemptToolCatalogEntry } from "@opengeni/contracts";

export type AttemptToolScope = Pick<
  AttemptToolCatalogValue,
  "accountId" | "workspaceId" | "sessionId" | "turnId" | "attemptId" | "executionGeneration"
>;

export type AttemptToolExecutionContext = {
  operationId: string;
  caller: AttemptToolCaller;
  /** In-process transport metadata; never part of catalog identity or digest. */
  transportMeta?: Record<string, unknown> | null;
  signal?: AbortSignal;
};

export type AttemptToolDefinition = Omit<AttemptToolCatalogEntryValue, "codemodePath"> & {
  /** Optional human-readable path. Unsafe/colliding segments are normalized. */
  codemodePath?: readonly string[];
  /** In-process execution lifecycle shared by model MCP and Codemode. */
  lifecycle?: ToolGatewayCallLifecycle;
  execute: (
    args: Record<string, unknown>,
    context: AttemptToolExecutionContext,
  ) => Promise<AttemptToolResultValue> | AttemptToolResultValue;
};

export type AttemptToolAuthorization = (input: {
  call: AttemptToolCallValue;
  entry: AttemptToolCatalogEntryValue;
}) => Promise<void> | void;

export type CreateAttemptToolEnvironmentInput = {
  scope: AttemptToolScope;
  generation: number;
  definitions: readonly AttemptToolDefinition[];
  createdAt?: Date;
  authorize?: AttemptToolAuthorization;
};

export type ModelAttemptToolCall = {
  operationId?: string;
  modelName: string;
  arguments: Record<string, unknown>;
  subjectId: string;
  transportMeta?: Record<string, unknown> | null;
  signal?: AbortSignal;
};

export {
  AttemptToolCatalogStaleError,
  AttemptToolNotFoundError,
  AttemptToolApprovalRequiredError,
  AttemptToolCatalogIntegrityError,
  AttemptToolCatalogTooLargeError,
  AttemptToolInputValidationError,
  AttemptToolOutputValidationError,
  AttemptToolPathCollisionError,
};

export class CodemodeTransportError extends Error {
  readonly code = "codemode_transport_error";
  readonly remoteCode: string | null;
  readonly retryable: boolean | null;
  readonly outcomeUnknown: boolean | null;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(
    message: string,
    readonly status: number | null = null,
    options: {
      code?: string;
      retryable?: boolean;
      outcomeUnknown?: boolean;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = "CodemodeTransportError";
    this.remoteCode = options.code ?? null;
    this.retryable = options.retryable ?? null;
    this.outcomeUnknown = options.outcomeUnknown ?? null;
    this.details = options.details ?? null;
  }
}

export class CodemodeOperationError extends Error {
  constructor(
    readonly operation: CodemodeOperationValue,
    readonly code: string,
  ) {
    super(operation.errorMessage ?? `Codemode operation ${operation.state}`);
    this.name = "CodemodeOperationError";
  }
}

export type CodemodeTokenProvider = string | (() => string | Promise<string>);

export type CodemodeClientOptions = {
  /** `/v1/workspaces/:workspaceId/codemode` base URL. */
  baseUrl: string;
  token: CodemodeTokenProvider;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type CodemodeCallOptions = {
  operationId?: string;
  /** Stops client observation only; it never cancels an already-created server operation. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type CodemodeToolFunction = (
  argumentsValue?: Record<string, unknown>,
  options?: CodemodeCallOptions,
) => Promise<unknown>;

export type CodemodeToolResult = AttemptToolResultValue;

export class CodemodeToolCallError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(readonly result: AttemptToolResultValue) {
    const error = structuredToolError(result);
    super(error.message);
    this.name = "CodemodeToolCallError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export class CodemodeToolContractError extends Error {
  readonly code = "invalid_tool_result";

  constructor(message: string) {
    super(message);
    this.name = "CodemodeToolContractError";
  }
}

export interface CodemodeTools {
  [key: string]: CodemodeTools | CodemodeToolFunction;
}

/** Persistent, idempotent client for one exact sandbox attempt bearer. */
export class CodemodeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private catalogSnapshot: AttemptToolCatalogValue | null = null;

  constructor(private readonly options: CodemodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    if (!/^https?:\/\//u.test(this.baseUrl)) {
      throw new Error("Codemode baseUrl must be an absolute HTTP(S) URL");
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.pollIntervalMs = boundedPositiveInteger(options.pollIntervalMs ?? 500, 50, 30_000);
    this.timeoutMs = boundedPositiveInteger(options.timeoutMs ?? 10 * 60_000, 1_000, 60 * 60_000);
  }

  async catalog(
    options: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<AttemptToolCatalogValue> {
    if (this.catalogSnapshot && !options.refresh) return this.catalogSnapshot;
    const response = await this.request("/catalog", {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const catalog = parseVerifiedAttemptToolCatalog(await response.json());
    this.catalogSnapshot = catalog;
    return catalog;
  }

  async tools(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<CodemodeTools> {
    return compileCodemodeTools(await this.catalog(options), this);
  }

  async call(
    identity: AttemptToolIdentity,
    argumentsValue: Record<string, unknown> = {},
    options: CodemodeCallOptions = {},
  ): Promise<AttemptToolResultValue> {
    return (
      await this.callResolved(
        (catalog) =>
          catalog.entries.find(
            (entry) =>
              entry.identity.serverId === identity.serverId &&
              entry.identity.toolName === identity.toolName,
          ) ?? null,
        argumentsValue,
        options,
      )
    ).result;
  }

  private async callResolved(
    resolveEntry: (catalog: AttemptToolCatalogValue) => AttemptToolCatalogEntryValue | null,
    argumentsValue: Record<string, unknown>,
    options: CodemodeCallOptions,
  ): Promise<{ result: AttemptToolResultValue; entry: AttemptToolCatalogEntryValue }> {
    let catalog = await this.catalog(options.signal ? { signal: options.signal } : {});
    let entry = resolveEntry(catalog);
    if (!entry) throw new AttemptToolNotFoundError();
    const operationId = options.operationId ?? randomUUID();
    const deadline =
      Date.now() + boundedPositiveInteger(options.timeoutMs ?? this.timeoutMs, 1_000, 60 * 60_000);
    let submitted = false;
    let staleRefreshAttempted = false;
    let operation: CodemodeOperationValue | null = null;
    let nextNotifyAt = 0;
    while (true) {
      throwIfAborted(options.signal);
      if (Date.now() >= deadline) {
        throw new CodemodeTransportError(
          `Codemode operation ${operationId} did not settle before the client deadline`,
        );
      }
      const shouldNotify =
        !submitted || (operation?.state === "queued" && Date.now() >= nextNotifyAt);
      if (shouldNotify) {
        submitted = true;
        nextNotifyAt = Date.now() + 2_000;
        try {
          operation = await this.submit(
            operationId,
            catalog.digest,
            entry.identity,
            argumentsValue,
            options.signal,
          );
        } catch (error) {
          if (
            operation === null &&
            !staleRefreshAttempted &&
            error instanceof CodemodeTransportError &&
            error.remoteCode === "codemode_catalog_stale"
          ) {
            staleRefreshAttempted = true;
            catalog = await this.catalog({
              refresh: true,
              ...(options.signal ? { signal: options.signal } : {}),
            });
            entry = resolveEntry(catalog);
            if (!entry) throw new AttemptToolNotFoundError();
            submitted = false;
            nextNotifyAt = 0;
            continue;
          }
          if (options.signal?.aborted) throw error;
          if (operation === null && !canReconcileCodemodeSubmission(error)) throw error;
          // The POST may have committed before its response was lost, or an
          // already-bound operation may have settled while a later wake
          // notification failed deterministically. The caller-owned id is the
          // recovery handle: read and re-prove the exact binding before
          // deciding that another side effect is necessary.
          let recovered: CodemodeOperationValue;
          try {
            recovered = await this.read(operationId, options.signal);
          } catch (recoveryError) {
            if (options.signal?.aborted) throw recoveryError;
            throw new CodemodeTransportError(
              `Codemode operation ${operationId} could not be reconciled after its submission response failed`,
              null,
              {
                code: "codemode_operation_recovery_unavailable",
                retryable: true,
                outcomeUnknown: true,
                details: { operationId },
              },
            );
          }
          assertRecoveredCodemodeOperation(recovered, {
            operationId,
            catalog,
            identity: entry.identity,
            arguments: argumentsValue,
          });
          operation = recovered;
        }
      } else {
        operation = await this.read(operationId, options.signal);
      }
      if (operation.state === "completed") {
        return { result: AttemptToolResult.parse(operation.result), entry };
      }
      if (["failed", "outcome_unknown", "cancelled"].includes(operation.state)) {
        throw new CodemodeOperationError(
          operation,
          operation.errorCode ?? `codemode_${operation.state}`,
        );
      }
      await abortableDelay(this.pollIntervalMs, options.signal);
    }
  }

  /** Resolve and call one exact generated namespace path without parsing a wire name. */
  async callPath(
    path: readonly string[],
    argumentsValue: Record<string, unknown> = {},
    options: CodemodeCallOptions = {},
  ): Promise<AttemptToolResultValue> {
    if (path.length < 2 || path.some((segment) => segment.length === 0)) {
      throw new AttemptToolNotFoundError();
    }
    return (
      await this.callResolved(
        (catalog) => catalogEntryForPath(catalog, path),
        argumentsValue,
        options,
      )
    ).result;
  }

  /** Return structured content when the catalog declares it; otherwise retain the full MCP result. */
  async callPathValue(
    path: readonly string[],
    argumentsValue: Record<string, unknown> = {},
    options: CodemodeCallOptions = {},
  ): Promise<unknown> {
    if (path.length < 2 || path.some((segment) => segment.length === 0)) {
      throw new AttemptToolNotFoundError();
    }
    const { result, entry } = await this.callResolved(
      (catalog) => catalogEntryForPath(catalog, path),
      argumentsValue,
      options,
    );
    if (!entry.outputSchema) return result;
    if (result.isError) throw new CodemodeToolCallError(result);
    if (!result.structuredContent) {
      throw new CodemodeToolContractError(
        `Codemode tool ${path.join(".")} declared outputSchema but returned no structured content`,
      );
    }
    return result.structuredContent;
  }

  private async submit(
    operationId: string,
    catalogDigest: string,
    identity: AttemptToolIdentity,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CodemodeOperationValue> {
    const response = await this.request("/calls", {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId,
        catalogDigest,
        identity,
        arguments: argumentsValue,
      }),
    });
    return CodemodeCallSubmission.parse(await response.json()).operation;
  }

  private async read(operationId: string, signal?: AbortSignal): Promise<CodemodeOperationValue> {
    const response = await this.request(`/calls/${operationId}`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    return CodemodeOperation.parse(await response.json());
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const token =
      typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      let message = `Codemode request failed with HTTP ${response.status}`;
      let errorOptions: {
        code?: string;
        retryable?: boolean;
        outcomeUnknown?: boolean;
        details?: Readonly<Record<string, unknown>>;
      } = {};
      try {
        const error = parseCodemodeApiError(await response.json());
        if (error?.message) message = error.message;
        if (error) {
          errorOptions = {
            ...(error.code ? { code: error.code } : {}),
            ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
            ...(error.outcomeUnknown === undefined ? {} : { outcomeUnknown: error.outcomeUnknown }),
            ...(error.details ? { details: error.details } : {}),
          };
        }
      } catch {
        // The status is sufficient; never echo an unbounded provider body.
      }
      throw new CodemodeTransportError(message, response.status, errorOptions);
    }
    return response;
  }
}

function canReconcileCodemodeSubmission(error: unknown): boolean {
  return !(error instanceof CodemodeTransportError) || error.outcomeUnknown === true;
}

function assertRecoveredCodemodeOperation(
  operation: CodemodeOperationValue,
  expected: {
    operationId: string;
    catalog: AttemptToolCatalogValue;
    identity: AttemptToolIdentity;
    arguments: Record<string, unknown>;
  },
): void {
  const matches =
    operation.operationId === expected.operationId &&
    operation.accountId === expected.catalog.accountId &&
    operation.workspaceId === expected.catalog.workspaceId &&
    operation.sessionId === expected.catalog.sessionId &&
    operation.turnId === expected.catalog.turnId &&
    operation.attemptId === expected.catalog.attemptId &&
    operation.executionGeneration === expected.catalog.executionGeneration &&
    operation.catalogDigest === expected.catalog.digest &&
    operation.identity.serverId === expected.identity.serverId &&
    operation.identity.toolName === expected.identity.toolName &&
    digestCanonicalJson(operation.arguments) === digestCanonicalJson(expected.arguments);
  if (matches) return;
  throw new CodemodeTransportError(
    "Codemode operation id is already bound to a different request",
    409,
    {
      code: "codemode_operation_conflict",
      retryable: false,
      outcomeUnknown: false,
    },
  );
}

export function compileCodemodeTools(
  catalog: AttemptToolCatalogValue,
  client: CodemodeClient,
): CodemodeTools {
  const verified = parseVerifiedAttemptToolCatalog(catalog);
  const root: CodemodeTools = Object.create(null) as CodemodeTools;
  for (const entry of verified.entries) {
    let cursor = root;
    for (const segment of entry.codemodePath.slice(0, -1)) {
      let existing = cursor[segment];
      if (typeof existing === "function") throw new Error("Codemode path collides with a tool");
      if (!existing) {
        existing = Object.create(null) as CodemodeTools;
        cursor[segment] = existing;
      }
      cursor = existing;
    }
    const leaf = entry.codemodePath.at(-1)!;
    const invoke: CodemodeToolFunction = async (args = {}, options = {}) =>
      await client.callPathValue(entry.codemodePath, args, options);
    Object.defineProperty(invoke, "entry", { value: entry, enumerable: false });
    cursor[leaf] = invoke;
  }
  return root;
}

export class AttemptToolEnvironment {
  constructor(
    readonly catalog: AttemptToolCatalogValue,
    private readonly gateway: ToolGateway,
  ) {}

  async call(
    input: AttemptToolCallValue,
    context: {
      transportMeta?: Record<string, unknown> | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<AttemptToolResultValue> {
    return await (await this.prepareCall(input, context)).execute();
  }

  async prepareCall(
    input: AttemptToolCallValue,
    context: {
      transportMeta?: Record<string, unknown> | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<PreparedToolGatewayCall> {
    const call = AttemptToolCall.parse(input);
    return await this.gateway.prepareCall(call, context);
  }

  async callModel(input: ModelAttemptToolCall): Promise<AttemptToolResultValue> {
    return await this.gateway.callModel(input);
  }
}

export function createAttemptToolEnvironment(
  input: CreateAttemptToolEnvironmentInput,
): AttemptToolEnvironment {
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  const prepared = prepareToolGatewayDefinitions(
    input.definitions.map(
      (definition): ToolGatewayDefinition => ({
        ...definition,
        execute: async (argumentsValue, context) =>
          await definition.execute(argumentsValue, {
            ...context,
            caller: AttemptToolCaller.parse(context.caller),
          }),
      }),
    ),
  );
  const unsigned = {
    version: ATTEMPT_TOOL_CATALOG_VERSION,
    ...input.scope,
    generation: input.generation,
    createdAt,
    entries: [...prepared.entries],
  };
  const catalog = AttemptToolCatalog.parse({
    ...unsigned,
    digest: digestAttemptToolCatalog(unsigned),
  });
  assertCatalogSize(catalog);
  return new AttemptToolEnvironment(
    catalog,
    prepared.create({
      catalogDigest: catalog.digest,
      requireApproval: (entry, caller) => caller.kind === "codemode" && entry.approval === "human",
      ...(input.authorize
        ? {
            authorize: async ({ call, entry }) =>
              await input.authorize!({
                call: AttemptToolCall.parse(call),
                entry,
              }),
          }
        : {}),
    }),
  );
}

export function digestAttemptToolCatalog(catalog: Omit<AttemptToolCatalogValue, "digest">): string {
  const { createdAt: _createdAt, ...authoritative } = catalog;
  return digestCanonicalJson(authoritative);
}

export function digestCodemodeOperationRequest(
  input: Pick<AttemptToolCallValue, "catalogDigest" | "identity" | "arguments" | "caller">,
): string {
  return digestCanonicalJson(input);
}

export function codemodeDispatchSubject(workspaceId: string, attemptId: string): string {
  if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(attemptId)) {
    throw new Error("Codemode dispatch subject requires UUID workspace and attempt ids");
  }
  return `codemode.${workspaceId}.${attemptId}.dispatch`;
}

export function encodeCodemodeDispatchRequest(input: CodemodeDispatchRequestValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(CodemodeDispatchRequest.parse(input)));
}

export function decodeCodemodeDispatchRequest(input: Uint8Array): CodemodeDispatchRequestValue {
  return CodemodeDispatchRequest.parse(JSON.parse(new TextDecoder().decode(input)));
}

export function encodeCodemodeDispatchAck(input: CodemodeDispatchAckValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(CodemodeDispatchAck.parse(input)));
}

export function decodeCodemodeDispatchAck(input: Uint8Array): CodemodeDispatchAckValue {
  return CodemodeDispatchAck.parse(JSON.parse(new TextDecoder().decode(input)));
}

export function parseVerifiedAttemptToolCatalog(input: unknown): AttemptToolCatalogValue {
  const catalog = AttemptToolCatalog.parse(input);
  assertCatalogSize(catalog);
  const { digest, ...unsigned } = catalog;
  if (digestAttemptToolCatalog(unsigned) !== digest) {
    throw new AttemptToolCatalogIntegrityError();
  }
  return catalog;
}

function assertCatalogSize(catalog: AttemptToolCatalogValue): void {
  if (
    new TextEncoder().encode(JSON.stringify(catalog)).byteLength > ATTEMPT_TOOL_CATALOG_MAX_BYTES
  ) {
    throw new AttemptToolCatalogTooLargeError();
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedPositiveInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function structuredToolError(result: AttemptToolResultValue): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const structured = result.structuredContent as
    | { error?: { code?: unknown; message?: unknown; retryable?: unknown } }
    | undefined;
  const error = structured?.error;
  return {
    code: typeof error?.code === "string" ? error.code : "tool_error",
    message: typeof error?.message === "string" ? error.message : "Codemode tool failed",
    retryable: error?.retryable === true,
  };
}

function catalogEntryForPath(
  catalog: AttemptToolCatalogValue,
  path: readonly string[],
): AttemptToolCatalogEntryValue | null {
  const matches = catalog.entries.filter(
    (entry) =>
      entry.codemodePath.length === path.length &&
      entry.codemodePath.every((segment, index) => segment === path[index]),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function parseCodemodeApiError(input: unknown): {
  message?: string;
  code?: string;
  retryable?: boolean;
  outcomeUnknown?: boolean;
  details?: Readonly<Record<string, unknown>>;
} | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const root = input as Record<string, unknown>;
  const nested =
    root.error && typeof root.error === "object" && !Array.isArray(root.error)
      ? (root.error as Record<string, unknown>)
      : root;
  const details =
    nested.details && typeof nested.details === "object" && !Array.isArray(nested.details)
      ? (nested.details as Readonly<Record<string, unknown>>)
      : undefined;
  const detailCode = details?.code;
  const code =
    typeof detailCode === "string" && /^[a-z0-9_]{1,128}$/u.test(detailCode)
      ? detailCode
      : undefined;
  const message = typeof nested.message === "string" ? nested.message : undefined;
  const retryable = typeof nested.retryable === "boolean" ? nested.retryable : undefined;
  const outcomeUnknown =
    typeof nested.outcomeUnknown === "boolean" ? nested.outcomeUnknown : undefined;
  return message || code || retryable !== undefined || outcomeUnknown !== undefined || details
    ? {
        ...(message ? { message } : {}),
        ...(code ? { code } : {}),
        ...(retryable === undefined ? {} : { retryable }),
        ...(outcomeUnknown === undefined ? {} : { outcomeUnknown }),
        ...(details ? { details } : {}),
      }
    : null;
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export * from "./environment";
export * from "./interaction";
export * from "./artifacts";
export * from "./structured";
export * from "./declarations";
