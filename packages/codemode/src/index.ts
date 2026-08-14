import { createHash, randomUUID } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ATTEMPT_TOOL_CATALOG_VERSION,
  ATTEMPT_TOOL_CATALOG_MAX_BYTES,
  AttemptToolCall,
  AttemptToolCatalog,
  AttemptToolCatalogEntry,
  AttemptToolResult,
  CodemodeCallSubmission,
  CodemodeOperation,
  CodemodeDispatchAck,
  CodemodeDispatchRequest,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  type AttemptToolCall as AttemptToolCallValue,
  type AttemptToolCaller,
  type AttemptToolCatalog as AttemptToolCatalogValue,
  type AttemptToolCatalogEntry as AttemptToolCatalogEntryValue,
  type AttemptToolIdentity,
  type AttemptToolResult as AttemptToolResultValue,
  type CodemodeDispatchAck as CodemodeDispatchAckValue,
  type CodemodeDispatchRequest as CodemodeDispatchRequestValue,
  type CodemodeOperation as CodemodeOperationValue,
} from "@opengeni/contracts";

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

export class AttemptToolCatalogStaleError extends Error {
  readonly code = "catalog_stale";

  constructor() {
    super("Codemode catalog is stale for the active execution attempt");
    this.name = "AttemptToolCatalogStaleError";
  }
}

export class AttemptToolNotFoundError extends Error {
  readonly code = "tool_not_found";

  constructor() {
    super("Tool is not present in the active execution attempt catalog");
    this.name = "AttemptToolNotFoundError";
  }
}

export class AttemptToolApprovalRequiredError extends Error {
  readonly code = "approval_required";

  constructor() {
    super("Tool requires human approval and must be invoked through the agent");
    this.name = "AttemptToolApprovalRequiredError";
  }
}

export class AttemptToolCatalogIntegrityError extends Error {
  readonly code = "catalog_integrity_failed";

  constructor() {
    super("Attempt tool catalog digest does not match its authoritative content");
    this.name = "AttemptToolCatalogIntegrityError";
  }
}

export class AttemptToolCatalogTooLargeError extends Error {
  readonly code = "catalog_too_large";

  constructor() {
    super("Attempt tool catalog exceeds the maximum serialized size");
    this.name = "AttemptToolCatalogTooLargeError";
  }
}

export class AttemptToolInputValidationError extends Error {
  readonly code = "invalid_tool_arguments";

  constructor() {
    super("Tool arguments do not match the attempt catalog input schema");
    this.name = "AttemptToolInputValidationError";
  }
}

export class AttemptToolOutputValidationError extends Error {
  readonly code = "invalid_tool_result";

  constructor() {
    super("Tool result does not match the attempt catalog output schema");
    this.name = "AttemptToolOutputValidationError";
  }
}

export class CodemodeTransportError extends Error {
  readonly code = "codemode_transport_error";

  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "CodemodeTransportError";
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
    const catalog = await this.catalog(options.signal ? { signal: options.signal } : {});
    if (
      !catalog.entries.some(
        (entry) =>
          entry.identity.serverId === identity.serverId &&
          entry.identity.toolName === identity.toolName,
      )
    ) {
      throw new AttemptToolNotFoundError();
    }
    const operationId = options.operationId ?? randomUUID();
    const deadline =
      Date.now() + boundedPositiveInteger(options.timeoutMs ?? this.timeoutMs, 1_000, 60 * 60_000);
    let submitted = false;
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
            identity,
            argumentsValue,
            options.signal,
          );
        } catch (error) {
          // The POST may have committed before its response was lost, or an
          // attempt may have closed between submission and a wake retry. The
          // caller-owned id is the recovery handle: read before deciding that
          // another side effect is necessary.
          try {
            operation = await this.read(operationId, options.signal);
          } catch {
            throw error;
          }
        }
      } else {
        operation = await this.read(operationId, options.signal);
      }
      if (operation.state === "completed") return AttemptToolResult.parse(operation.result);
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
    const catalog = await this.catalog(options.signal ? { signal: options.signal } : {});
    const matches = catalog.entries.filter(
      (entry) =>
        entry.codemodePath.length === path.length &&
        entry.codemodePath.every((segment, index) => segment === path[index]),
    );
    if (matches.length !== 1) throw new AttemptToolNotFoundError();
    return await this.call(matches[0]!.identity, argumentsValue, options);
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
    const catalog = await this.catalog(options.signal ? { signal: options.signal } : {});
    const matches = catalog.entries.filter(
      (entry) =>
        entry.codemodePath.length === path.length &&
        entry.codemodePath.every((segment, index) => segment === path[index]),
    );
    if (matches.length !== 1) throw new AttemptToolNotFoundError();
    const entry = matches[0]!;
    const result = await this.call(entry.identity, argumentsValue, options);
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
      try {
        const payload = (await response.json()) as {
          error?: { message?: unknown };
        };
        if (typeof payload.error?.message === "string") message = payload.error.message;
      } catch {
        // The status is sufficient; never echo an unbounded provider body.
      }
      throw new CodemodeTransportError(message, response.status);
    }
    return response;
  }
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

type CompiledDefinition = {
  entry: AttemptToolCatalogEntryValue;
  execute: AttemptToolDefinition["execute"];
  validateInput: ValidateFunction<unknown>;
  validateOutput: ValidateFunction<unknown> | null;
};

export class AttemptToolEnvironment {
  readonly catalog: AttemptToolCatalogValue;
  private readonly byIdentity = new Map<string, CompiledDefinition>();
  private readonly byModelName = new Map<string, CompiledDefinition>();

  constructor(
    catalog: AttemptToolCatalogValue,
    definitions: readonly CompiledDefinition[],
    private readonly authorize: AttemptToolAuthorization | undefined,
  ) {
    this.catalog = catalog;
    for (const definition of definitions) {
      this.byIdentity.set(identityKey(definition.entry.identity), definition);
      this.byModelName.set(definition.entry.modelName, definition);
    }
  }

  async call(
    input: AttemptToolCallValue,
    context: {
      transportMeta?: Record<string, unknown> | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<AttemptToolResultValue> {
    const call = AttemptToolCall.parse(input);
    if (call.catalogDigest !== this.catalog.digest) {
      throw new AttemptToolCatalogStaleError();
    }
    const definition = this.byIdentity.get(identityKey(call.identity));
    if (!definition) {
      throw new AttemptToolNotFoundError();
    }
    if (call.caller.kind === "codemode" && definition.entry.approval === "human") {
      throw new AttemptToolApprovalRequiredError();
    }
    if (!definition.validateInput(call.arguments)) {
      throw new AttemptToolInputValidationError();
    }
    await this.authorize?.({ call, entry: definition.entry });
    const result = AttemptToolResult.parse(
      await definition.execute(call.arguments, {
        operationId: call.operationId,
        caller: call.caller,
        ...(context.transportMeta === undefined ? {} : { transportMeta: context.transportMeta }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
    if (!result.isError && definition.validateOutput) {
      if (
        result.structuredContent === undefined ||
        !definition.validateOutput(result.structuredContent)
      ) {
        throw new AttemptToolOutputValidationError();
      }
    }
    return result;
  }

  async callModel(input: ModelAttemptToolCall): Promise<AttemptToolResultValue> {
    const definition = this.byModelName.get(input.modelName);
    if (!definition) {
      throw new AttemptToolNotFoundError();
    }
    const call = AttemptToolCall.parse({
      operationId: input.operationId ?? randomUUID(),
      catalogDigest: this.catalog.digest,
      identity: definition.entry.identity,
      arguments: input.arguments,
      caller: { kind: "model", subjectId: input.subjectId },
    });
    return await this.call(call, {
      ...(input.transportMeta === undefined ? {} : { transportMeta: input.transportMeta }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}

export function createAttemptToolEnvironment(
  input: CreateAttemptToolEnvironmentInput,
): AttemptToolEnvironment {
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  const paths = allocateCodemodePaths(input.definitions);
  const schemaValidators = createSchemaValidators();
  const compiled = input.definitions.map((definition, index): CompiledDefinition => {
    const { execute, codemodePath: _path, ...entryInput } = definition;
    const entry = AttemptToolCatalogEntry.parse({
      ...entryInput,
      codemodePath: paths[index],
    });
    return {
      entry,
      execute,
      validateInput: compileCatalogSchema(schemaValidators, entry.inputSchema),
      validateOutput: entry.outputSchema
        ? compileCatalogSchema(schemaValidators, entry.outputSchema)
        : null,
    };
  });
  const unsigned = {
    version: ATTEMPT_TOOL_CATALOG_VERSION,
    ...input.scope,
    generation: input.generation,
    createdAt,
    entries: compiled.map(({ entry }) => entry),
  };
  const catalog = AttemptToolCatalog.parse({
    ...unsigned,
    digest: digestAttemptToolCatalog(unsigned),
  });
  assertCatalogSize(catalog);
  return new AttemptToolEnvironment(catalog, compiled, input.authorize);
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

type SchemaCompiler = { compile(schema: object): ValidateFunction<unknown> };

// Validator compilation is structural and independent of attempt identity,
// executable closures, credentials, and authorization. Reuse only exact
// content-addressed validators; the attempt environment and catalog remain
// freshly bound and digested on every execution. The hard cap prevents an
// untrusted MCP schema stream from turning this process cache into a memory
// sink.
const COMPILED_CATALOG_SCHEMA_CACHE_MAX_ENTRIES = 512;
const compiledCatalogSchemaCache = new Map<string, ValidateFunction<unknown>>();

function createSchemaValidators(): {
  draft7: SchemaCompiler;
  draft2019: SchemaCompiler;
  draft2020: SchemaCompiler;
} {
  const options = {
    allErrors: false,
    coerceTypes: false,
    strict: false,
    useDefaults: false,
    validateFormats: false,
  } as const;
  return {
    draft7: new Ajv(options),
    draft2019: new Ajv2019(options),
    draft2020: new Ajv2020(options),
  };
}

function compileCatalogSchema(
  validators: ReturnType<typeof createSchemaValidators>,
  schema: AttemptToolCatalogEntryValue["inputSchema"],
): ValidateFunction<unknown> {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  const family = dialect.includes("2020-12")
    ? "2020-12"
    : dialect.includes("2019-09")
      ? "2019-09"
      : "draft7";
  const cacheKey = `${family}:${digestCanonicalJson(schema)}`;
  const cached = compiledCatalogSchemaCache.get(cacheKey);
  if (cached) {
    compiledCatalogSchemaCache.delete(cacheKey);
    compiledCatalogSchemaCache.set(cacheKey, cached);
    return cached;
  }
  const compiled =
    family === "2020-12"
      ? validators.draft2020.compile(schema)
      : family === "2019-09"
        ? validators.draft2019.compile(schema)
        : validators.draft7.compile(schema);
  while (compiledCatalogSchemaCache.size >= COMPILED_CATALOG_SCHEMA_CACHE_MAX_ENTRIES) {
    const oldest = compiledCatalogSchemaCache.keys().next().value;
    if (oldest === undefined) break;
    compiledCatalogSchemaCache.delete(oldest);
  }
  compiledCatalogSchemaCache.set(cacheKey, compiled);
  return compiled;
}

function allocateCodemodePaths(definitions: readonly AttemptToolDefinition[]): string[][] {
  const bases = definitions.map((definition) =>
    (definition.codemodePath?.length
      ? definition.codemodePath
      : [definition.identity.serverId, definition.identity.toolName]
    ).map(safeNamespaceSegment),
  );
  const counts = new Map<string, number>();
  for (const path of bases) {
    const key = path.join("\u0000");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return bases.map((base, index) => {
    const key = base.join("\u0000");
    if (counts.get(key) === 1) return base;
    const suffix = `_${shortIdentityDigest(definitions[index]!.identity)}`;
    const last = base.at(-1)!;
    return [...base.slice(0, -1), `${last.slice(0, 128 - suffix.length)}${suffix}`];
  });
}

function safeNamespaceSegment(value: string): string {
  let normalized = value.replace(/[^A-Za-z0-9_$]/gu, "_");
  if (!/^[A-Za-z_$]/u.test(normalized)) normalized = `_${normalized}`;
  if (["__proto__", "prototype", "constructor"].includes(normalized)) {
    normalized = `_${normalized}`;
  }
  return normalized.slice(0, 128) || "_";
}

function shortIdentityDigest(identity: AttemptToolIdentity): string {
  return createHash("sha256").update(identityKey(identity), "utf8").digest("hex").slice(0, 10);
}

function identityKey(identity: AttemptToolIdentity): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

function digestCanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)), "utf8")
    .digest("hex");
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
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
