import OpenAI from "openai";
import type { APIPromise } from "openai/core/api-promise";
import { types as utilTypes } from "node:util";

const TARGET_CHUNK_CHARS = 64 * 1024;
const LARGE_STRING_SOURCE_CHARS = 32 * 1024;
// Six ASCII characters is JSON's worst-case expansion for one UTF-16 code
// unit (`\\u00xx`). Keep every native slice below the outer chunk target.
const STRING_SLICE_CODE_UNITS = 10 * 1024;

/** Internal fetch-init hook used only when a transport performs its own retry. */
export const REPLAYABLE_REQUEST_BODY_FACTORY = Symbol.for(
  "opengeni.replayable-request-body-factory",
);

type ReplayableRequestInit = RequestInit & {
  [REPLAYABLE_REQUEST_BODY_FACTORY]?: () => ReadableStream<Uint8Array>;
};

type OpenAIPostOptions = NonNullable<Parameters<OpenAI["post"]>[1]>;
type ResolvedOpenAIPostOptions = Awaited<OpenAIPostOptions>;
type OpenAIBuildOptions = Parameters<OpenAI["buildRequest"]>[0];
type OpenAIBuildContext = Parameters<OpenAI["buildRequest"]>[1];
type OpenAIBuildResult = Awaited<ReturnType<OpenAI["buildRequest"]>>;
type OpenAIOptions = ConstructorParameters<typeof OpenAI>[0];

export type ModelJsonRequestPolicyResult = {
  /** Copy-on-write replacement. Never mutate a nested graph retained by a model cache. */
  body?: Record<string, unknown>;
  /** Internal transport handoff headers, merged case-insensitively. */
  headers?: Record<string, string>;
};

export type ModelJsonRequestPolicy = (request: {
  path: string;
  body: Readonly<Record<string, unknown>>;
}) => ModelJsonRequestPolicyResult | undefined;

export type ReplayableJsonOpenAIHooks = {
  /** Synchronous object-stage policy, run exactly once before serialization. */
  modelRequestPolicy?: ModelJsonRequestPolicy;
};

/**
 * A JSON request body that can be encoded incrementally and replayed exactly.
 *
 * The OpenAI client normally materializes one whole JSON string, after the
 * Agents SDK has already materialized the converted protocol-item graph. Long
 * tool loops therefore need both representations at once and leave large Bun
 * allocator arenas resident. This wrapper keeps the authoritative object graph
 * and emits bounded UTF-8 chunks directly to fetch. Every iterator starts from
 * the beginning, so SDK and authentication retries retain their old semantics.
 */
export class ReplayableJsonBody implements AsyncIterable<Uint8Array> {
  readonly source: unknown;

  constructor(source: unknown) {
    this.source = source;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    const encoder = new TextEncoder();
    for (const chunk of jsonTextChunks(this.source)) {
      yield encoder.encode(chunk);
    }
  }

  createStream(): ReadableStream<Uint8Array> {
    const iterator = this[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await iterator.return?.(reason).catch(() => undefined);
      },
    });
  }
}

/** Consume any request body without assuming the SDK's legacy string form. */
export async function requestBodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return await new Response(body).text();
}

/**
 * OpenAI client with bounded JSON encoding and unchanged retry behavior.
 * Model endpoints alone are wrapped; every other SDK endpoint is untouched.
 */
export class ReplayableJsonOpenAI extends OpenAI {
  private readonly modelRequestPolicy: ModelJsonRequestPolicy | undefined;

  constructor(options: OpenAIOptions, hooks: ReplayableJsonOpenAIHooks = {}) {
    super(options);
    this.modelRequestPolicy = hooks.modelRequestPolicy;
  }

  override post<Rsp>(path: string, opts?: OpenAIPostOptions): APIPromise<Rsp> {
    if (!isModelRequestPath(path) || opts === undefined) {
      return super.post<Rsp>(path, opts);
    }
    const wrapped = Promise.resolve(opts).then((resolved) => {
      const body = resolved.body;
      let prepared = resolved;
      if (this.modelRequestPolicy && isJsonRecordBody(body)) {
        const policy = this.modelRequestPolicy({ path, body });
        if (policy?.body || policy?.headers) {
          prepared = {
            ...resolved,
            ...(policy.body ? { body: policy.body } : {}),
            ...(policy.headers
              ? { headers: mergePolicyHeaders(resolved.headers, policy.headers) }
              : {}),
          };
        }
      }
      return wrapJsonRequestOptions(prepared);
    });
    return super.post<Rsp>(path, wrapped);
  }

  override async buildRequest(
    inputOptions: OpenAIBuildOptions,
    context?: OpenAIBuildContext,
  ): Promise<OpenAIBuildResult> {
    const replayable =
      inputOptions.body instanceof ReplayableJsonBody ? inputOptions.body : undefined;
    const priorStreamingMarker = inputOptions.__metadata?.hasStreamingBody;
    const built = await super.buildRequest(inputOptions, context);
    if (!replayable) return built;

    // The SDK correctly refuses to retry arbitrary one-shot streams. This body
    // is different: buildRequest is invoked again for every retry and creates a
    // fresh iterator. Restore the prior marker so network/5xx retries remain
    // byte-for-byte equivalent to the legacy JSON-string path.
    if (priorStreamingMarker === undefined) {
      if (inputOptions.__metadata) delete inputOptions.__metadata.hasStreamingBody;
    } else {
      inputOptions.__metadata = {
        ...inputOptions.__metadata,
        hasStreamingBody: priorStreamingMarker,
      };
    }
    const request = built.req as ReplayableRequestInit;
    request[REPLAYABLE_REQUEST_BODY_FACTORY] = () => replayable.createStream();
    return built;
  }
}

function isModelRequestPath(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? path;
  return pathname.endsWith("/responses") || pathname.endsWith("/chat/completions");
}

function wrapJsonRequestOptions(options: ResolvedOpenAIPostOptions): ResolvedOpenAIPostOptions {
  const body = options.body;
  if (!isJsonObjectBody(body) || body instanceof ReplayableJsonBody) return options;
  return {
    ...options,
    body: new ReplayableJsonBody(body) as unknown as ResolvedOpenAIPostOptions["body"],
    headers: mergePolicyHeaders(options.headers, { "content-type": "application/json" }),
  };
}

function isJsonObjectBody(value: unknown): value is Record<string, unknown> | unknown[] {
  if (!value || typeof value !== "object") return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  if (value instanceof Blob || value instanceof FormData || value instanceof URLSearchParams) {
    return false;
  }
  if (value instanceof ReadableStream) return false;
  return !(Symbol.asyncIterator in value) && !(Symbol.iterator in value);
}

function isJsonRecordBody(value: unknown): value is Record<string, unknown> {
  return isJsonObjectBody(value) && !Array.isArray(value);
}

function mergePolicyHeaders(
  headers: ResolvedOpenAIPostOptions["headers"],
  additions: Record<string, string>,
): ResolvedOpenAIPostOptions["headers"] {
  const replacedNames = new Set(Object.keys(additions).map((name) => name.toLowerCase()));
  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    for (const [name, value] of Object.entries(additions)) merged.set(name, value);
    return merged;
  }
  // OpenAI's internal header builder preserves explicit nulls so a request can
  // remove a client default. A resolved NullableHeaders value is intentionally
  // branded with a private symbol, so recognize only its public data shape and
  // project it back to the ordinary tuple form without losing those removals.
  if (
    headers &&
    typeof headers === "object" &&
    "values" in headers &&
    "nulls" in headers &&
    (headers as { values?: unknown }).values instanceof Headers &&
    (headers as { nulls?: unknown }).nulls instanceof Set
  ) {
    const resolved = headers as unknown as { values: Headers; nulls: Set<string> };
    const rows: Array<[string, string | null]> = [
      ...resolved.values.entries(),
      ...[...resolved.nulls].map((name): [string, null] => [name, null]),
    ];
    return mergePolicyHeaders(rows as ResolvedOpenAIPostOptions["headers"], additions);
  }
  if (Array.isArray(headers)) {
    return [
      ...headers.filter(
        (row) =>
          !Array.isArray(row) ||
          typeof row[0] !== "string" ||
          !replacedNames.has(row[0].toLowerCase()),
      ),
      ...Object.entries(additions),
    ];
  }
  const merged = { ...(headers ?? {}) } as Record<string, unknown>;
  for (const name of Object.keys(merged)) {
    if (replacedNames.has(name.toLowerCase())) delete merged[name];
  }
  return { ...merged, ...additions } as ResolvedOpenAIPostOptions["headers"];
}

/**
 * JSON.stringify-equivalent bounded chunks, without materializing the complete
 * request string. This follows SerializeJSONProperty/Array/Object semantics:
 * `toJSON` receives its real property key, keys and array length are snapshotted
 * at the native points, getters run in order, unsupported object values are
 * omitted, unsupported array values become null, and only the active ancestor
 * chain is considered cyclic.
 */
function* jsonTextChunks(value: unknown): Generator<string> {
  const fragments = jsonValueFragments(value, "", new Set<object>(), 0);
  if (!fragments) throw new TypeError("Model request body is not JSON serializable");

  let buffered = "";
  for (const fragment of fragments) {
    if (buffered.length > 0 && buffered.length + fragment.length > TARGET_CHUNK_CHARS) {
      yield buffered;
      buffered = "";
    }
    if (fragment.length >= TARGET_CHUNK_CHARS) yield fragment;
    else buffered += fragment;
  }
  if (buffered.length > 0) yield buffered;
}

function jsonValueFragments(
  source: unknown,
  key: string,
  ancestors: Set<object>,
  depth: number,
): Iterable<string> | null {
  if (typeof source === "string" && source.length > LARGE_STRING_SOURCE_CHARS) {
    return jsonStringFragments(source);
  }
  // Model payloads are dominated by the top-level input/tools arrays. Keep
  // those arrays incremental, while letting the native engine serialize each
  // bounded item subtree. Wrapping under the real key preserves toJSON(key),
  // getters, boxed primitives, property ordering, and omission semantics.
  if (depth >= 2 || (depth > 0 && !Array.isArray(source))) {
    return nativeJsonPropertyFragments(source, key);
  }

  const value = prepareJsonValue(source, key);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return null;
  }
  if (typeof value === "bigint") {
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (typeof value === "string") {
    return jsonStringFragments(value);
  }
  if (value === null || typeof value !== "object") {
    return [JSON.stringify(value) as string];
  }

  const rawJson = JSON as typeof JSON & { isRawJSON?: (candidate: unknown) => boolean };
  if (rawJson.isRawJSON?.(value)) return [JSON.stringify(value)];
  if (ancestors.has(value)) throw new TypeError("cyclic object value");
  return Array.isArray(value)
    ? jsonArrayFragments(value, ancestors, depth)
    : jsonObjectFragments(value as Record<string, unknown>, ancestors, depth);
}

function* jsonArrayFragments(
  value: unknown[],
  ancestors: Set<object>,
  depth: number,
): Generator<string> {
  ancestors.add(value);
  try {
    const length = value.length;
    yield "[";
    for (let index = 0; index < length; index += 1) {
      if (index > 0) yield ",";
      const child = jsonValueFragments(value[index], String(index), ancestors, depth + 1);
      if (child) yield* child;
      else yield "null";
    }
    yield "]";
  } finally {
    ancestors.delete(value);
  }
}

function* jsonObjectFragments(
  value: Record<string, unknown>,
  ancestors: Set<object>,
  depth: number,
): Generator<string> {
  ancestors.add(value);
  try {
    const keys = Object.keys(value);
    let emitted = false;
    yield "{";
    for (const key of keys) {
      const child = jsonValueFragments(value[key], key, ancestors, depth + 1);
      if (!child) continue;
      if (emitted) yield ",";
      emitted = true;
      yield* jsonStringFragments(key);
      yield ":";
      yield* child;
    }
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

function nativeJsonPropertyFragments(source: unknown, key: string): Iterable<string> | null {
  const holder = Object.create(null) as Record<string, unknown>;
  holder[key] = source;
  const serialized = JSON.stringify(holder);
  if (serialized === "{}") return null;
  const prefix = `{${JSON.stringify(key)}:`;
  if (!serialized.startsWith(prefix) || !serialized.endsWith("}")) {
    throw new TypeError("Model request body is not JSON serializable");
  }
  return boundedNativeJsonFragments(serialized.slice(prefix.length, -1));
}

function* boundedNativeJsonFragments(serialized: string): Generator<string> {
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(serialized.length, start + TARGET_CHUNK_CHARS);
    if (
      end < serialized.length &&
      serialized.charCodeAt(end - 1) >= 0xd800 &&
      serialized.charCodeAt(end - 1) <= 0xdbff &&
      serialized.charCodeAt(end) >= 0xdc00 &&
      serialized.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    yield serialized.slice(start, end);
    start = end;
  }
}

function prepareJsonValue(source: unknown, key: string): unknown {
  let value = source;
  const sourceType = typeof value;
  if (
    value !== null &&
    (sourceType === "object" || sourceType === "function" || sourceType === "bigint")
  ) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") value = toJSON.call(value, key);
  }

  if (value !== null && typeof value === "object") {
    // These predicates inspect the native internal slots without consulting a
    // spoofable Symbol.toStringTag or invoking user-defined coercion hooks.
    if (utilTypes.isNumberObject(value)) return Number.prototype.valueOf.call(value);
    if (utilTypes.isStringObject(value)) return String.prototype.valueOf.call(value);
    if (utilTypes.isBooleanObject(value)) return Boolean.prototype.valueOf.call(value);
    if (utilTypes.isBigIntObject(value)) return BigInt.prototype.valueOf.call(value);
  }
  return value;
}

/**
 * Emit the exact well-formed JSON string representation without first making
 * a second string proportional to a large tool result. Fragments never split
 * a valid surrogate pair, so independently UTF-8 encoding them is lossless.
 */
function* jsonStringFragments(value: string): Generator<string> {
  if (value.length <= LARGE_STRING_SOURCE_CHARS) {
    yield JSON.stringify(value);
    return;
  }

  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + STRING_SLICE_CODE_UNITS);
    // TextEncoder would replace two independently encoded surrogate halves.
    // Keep a valid pair in one native JSON.stringify/TextEncoder fragment.
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    const encoded = JSON.stringify(value.slice(start, end));
    yield encoded.slice(1, -1);
    start = end;
  }
  yield '"';
}
