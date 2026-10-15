/**
 * Server-only receiver for Opengeni's signed remote vault protocol
 * (`opengeni.vault.v1`). Import from `@opengeni/sdk/external-vault-receiver`
 * in the server that owns the customer's secrets; never in a browser bundle.
 *
 * Order of checks for every request: bounded body, connection lookup, exact
 * body signature, strict schema, request age and replay, native authority
 * bindings, then the host's own `authorize` mapping (a MAC is not an
 * authorization decision), then the handler. Handler output is projected to
 * the known wire fields and validated before it is signed, so metadata can
 * never carry values and reads return only requested fields.
 *
 * Mutations are claimed in the caller-owned durable store under an
 * idempotency key and an operation digest. A repeated key with the same
 * digest returns the recorded result; a different digest is refused; an
 * unfinished or uncertain claim reports `provider_outcome_unknown` until the
 * host reconciles it. Nothing here retries a mutation.
 */
import {
  OPENGENI_SIGNATURE_HEADER,
  signOpenGeniPayload,
  verifyOpenGeniSignature,
} from "@opengeni/contracts/workspace-integration-wire";
import {
  VAULT_PROVIDER_WIRE_LIMITS,
  VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER,
  VAULT_PROVIDER_WIRE_VERSION,
  VaultProviderWireFreshness,
  VaultProviderWireRequest,
  VaultProviderWireResults,
  isVaultProviderWireMutation,
  vaultProviderWireNameKey,
  vaultProviderWireResponseKey,
  vaultProviderWireUtf8Bytes,
  type VaultProviderWireAuthority,
  type VaultProviderWireErrorCode,
  type VaultProviderWireFailure,
  type VaultProviderWireOperation,
  type VaultProviderWireOperationName,
  type VaultProviderWireOperationOf,
  type VaultProviderWirePage,
  type VaultProviderWireProvider,
  type VaultProviderWireResult,
  type VaultProviderWireSuccess,
  type VaultProviderWireWriteItem,
} from "@opengeni/contracts/vault-provider-wire";

export {
  VAULT_PROVIDER_WIRE_ERROR_CODES,
  VAULT_PROVIDER_WIRE_LIMITS,
  VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER,
  VAULT_PROVIDER_WIRE_VERSION,
  vaultProviderWireResponseKey,
} from "@opengeni/contracts/vault-provider-wire";
export type {
  VaultProviderWireAuthority,
  VaultProviderWireDescribeResult,
  VaultProviderWireErrorCode,
  VaultProviderWireFieldMeta,
  VaultProviderWireFieldValue,
  VaultProviderWireFreshness,
  VaultProviderWireItemMeta,
  VaultProviderWireOperation,
  VaultProviderWireOperationName,
  VaultProviderWirePage,
  VaultProviderWireProvider,
  VaultProviderWireRequest,
  VaultProviderWireResponse,
  VaultProviderWireResult,
  VaultProviderWireVault,
  VaultProviderWireWriteField,
  VaultProviderWireWriteItem,
} from "@opengeni/contracts/vault-provider-wire";

/** A definite, safe receiver failure. Its message is never sent to Opengeni. */
export class ExternalVaultReceiverError extends Error {
  readonly code: VaultProviderWireErrorCode;
  readonly retryAfterMs: number | null;
  readonly freshness: VaultProviderWireFreshness | null;
  constructor(
    code: VaultProviderWireErrorCode,
    options: {
      retryAfterMs?: number;
      freshness?: VaultProviderWireFreshness;
      message?: string;
    } = {},
  ) {
    super(options.message ?? code);
    this.name = "ExternalVaultReceiverError";
    this.code = code;
    this.retryAfterMs =
      options.retryAfterMs === undefined
        ? null
        : Math.min(Math.max(Math.trunc(options.retryAfterMs), 0), 86_400_000);
    this.freshness = options.freshness ?? null;
  }
}

export interface ExternalVaultReceiverConnection<TConnection> {
  provider: VaultProviderWireProvider;
  /**
   * Accepted signing secrets: the current one first, then a previous one
   * during rotation. Responses are signed with the secret that verified.
   */
  signingSecrets: readonly string[];
  /** When set, requests for any other Opengeni account are refused. */
  accountId?: string;
  /** When set, requests for a connection owned by another workspace are refused. */
  connectionWorkspaceId?: string;
  /** Host data for this connection: its fixed inventory scope, not a user. */
  context: TConnection;
}

export type ExternalVaultMutationClaim =
  | { state: "claimed" }
  | { state: "completed"; result: unknown }
  /** In flight, or uncertain after a failure: report an unknown outcome. */
  | { state: "pending" }
  /** Same key, different operation or caller. */
  | { state: "mismatch" };

/**
 * Caller-owned replay and idempotency storage. Use durable shared storage
 * (for example a database table with unique keys) when the receiver runs in
 * more than one process or must survive restarts.
 */
export interface ExternalVaultReceiverStore {
  /** Atomically record a request id. False when it was already recorded. */
  rememberRequest(input: {
    connectionId: string;
    requestId: string;
    expiresAt: Date;
  }): Promise<boolean>;
  /** Atomically claim a mutation key, or report its existing state. */
  claimMutation(input: {
    connectionId: string;
    idempotencyKey: string;
    digest: string;
    expiresAt: Date;
  }): Promise<ExternalVaultMutationClaim>;
  /** Record the metadata-only result of a confirmed mutation. */
  completeMutation(input: {
    connectionId: string;
    idempotencyKey: string;
    digest: string;
    result: unknown;
  }): Promise<void>;
  /** The handler definitely changed nothing: allow the key to be claimed again. */
  releaseMutation(input: {
    connectionId: string;
    idempotencyKey: string;
    digest: string;
  }): Promise<void>;
}

export interface ExternalVaultHandlerOutput<R> {
  result: R;
  freshness?: VaultProviderWireFreshness | null;
}

type ReadContext = { forceRefresh: boolean; cacheEpoch: string | null };

export interface ExternalVaultCallContext<TConnection, TPrincipal> {
  connectionId: string;
  connection: TConnection;
  /** The host principal returned by `authorize` for this exact request. */
  principal: TPrincipal;
  authority: VaultProviderWireAuthority;
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Inventory handlers receive the connection, not the acting principal: one
 * connection has one fixed inventory, so listings must not vary by subject.
 */
export interface ExternalVaultInventoryContext<TConnection> {
  connectionId: string;
  connection: TConnection;
  requestId: string;
  signal?: AbortSignal;
}

export interface ExternalVaultReceiverHandlers<TConnection, TPrincipal> {
  describe(
    ctx: ExternalVaultInventoryContext<TConnection>,
  ): Promise<ExternalVaultHandlerOutput<VaultProviderWireResult<"describe">>>;
  /** Deliberate upstream refresh; omit when the store is always live. */
  refresh?(
    ctx: ExternalVaultInventoryContext<TConnection>,
  ): Promise<ExternalVaultHandlerOutput<VaultProviderWireResult<"refresh">>>;
  listVaults(
    ctx: ExternalVaultInventoryContext<TConnection>,
    input: { page: VaultProviderWirePage } & ReadContext,
  ): Promise<ExternalVaultHandlerOutput<VaultProviderWireResult<"list_vaults">>>;
  listItems(
    ctx: ExternalVaultInventoryContext<TConnection>,
    input: { externalVaultId: string; page: VaultProviderWirePage } & ReadContext,
  ): Promise<ExternalVaultHandlerOutput<VaultProviderWireResult<"list_items">>>;
  readFields(
    ctx: ExternalVaultCallContext<TConnection, TPrincipal>,
    input: {
      externalVaultId: string;
      externalItemId: string;
      externalFieldIds: readonly string[];
    } & ReadContext,
  ): Promise<ExternalVaultHandlerOutput<VaultProviderWireResult<"read_fields">>>;
  /** Omit when the connection is read-only. Throw only definite failures. */
  writeItem?(
    ctx: ExternalVaultCallContext<TConnection, TPrincipal>,
    input: { externalVaultId: string; item: VaultProviderWireWriteItem; idempotencyKey: string },
  ): Promise<ExternalVaultHandlerOutput<VaultProviderWireResult<"write_item">>>;
  archiveItem?(
    ctx: ExternalVaultCallContext<TConnection, TPrincipal>,
    input: { externalVaultId: string; externalItemId: string; idempotencyKey: string },
  ): Promise<ExternalVaultHandlerOutput<VaultProviderWireResult<"archive_item">>>;
}

export interface ExternalVaultAuthorizeInput<TConnection> {
  connectionId: string;
  connection: TConnection;
  authority: VaultProviderWireAuthority;
  operation: {
    op: VaultProviderWireOperationName;
    externalVaultId?: string;
    externalItemId?: string;
  };
  requestId: string;
}

export interface ExternalVaultReceiverOptions<TConnection, TPrincipal> {
  /** Unknown connections are indistinguishable from bad signatures. */
  resolveConnection(
    connectionId: string,
  ): Promise<ExternalVaultReceiverConnection<TConnection> | null>;
  /**
   * Map Opengeni's native account/workspace/subject to the host tenant and
   * user and recheck access for this operation. Return null to refuse.
   * Called for every request, including inventory reads.
   */
  authorize(input: ExternalVaultAuthorizeInput<TConnection>): Promise<TPrincipal | null>;
  handlers: ExternalVaultReceiverHandlers<TConnection, TPrincipal>;
  store: ExternalVaultReceiverStore;
  /** How long mutation results stay replayable. Default 24 hours. */
  mutationRetentionMs?: number;
  now?: () => number;
  /** Host diagnostics. Never forward these errors to Opengeni. */
  onError?(event: {
    stage: "authorize" | "handler" | "store" | "output";
    op: VaultProviderWireOperationName;
    connectionId: string;
    error: unknown;
  }): void;
}

export interface ExternalVaultReceiverHttpRequest {
  /** The exact raw request body; parse nothing before calling `handle`. */
  body: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  signal?: AbortSignal;
}

export interface ExternalVaultReceiverHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ExternalVaultReceiver {
  handle(request: ExternalVaultReceiverHttpRequest): Promise<ExternalVaultReceiverHttpResponse>;
  /** Fetch-style adapter: POST only, bounded body, then `handle`. */
  fetch(request: Request): Promise<Response>;
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plain(status: number, error: string): ExternalVaultReceiverHttpResponse {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify({ error }) };
}

function headerValue(headers: ExternalVaultReceiverHttpRequest["headers"], name: string) {
  if (headers instanceof Headers) return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value)
        ? value.length === 1
          ? (value[0] ?? null)
          : null
        : (value ?? null);
    }
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Keyed digest of one mutation's exact scope: connection, provider, trusted
 * caller tuple and operation (without its idempotency key). Keyed so the
 * store never holds a plain hash of submitted secret values.
 */
export async function externalVaultMutationDigest(input: {
  signingSecret: string;
  request: VaultProviderWireRequest;
}): Promise<string> {
  const { request } = input;
  const { idempotencyKey: _ignored, ...operation } = request.operation as Extract<
    VaultProviderWireOperation,
    { idempotencyKey: string }
  >;
  return hmacHex(
    `${input.signingSecret}\u0000${VAULT_PROVIDER_WIRE_VERSION}.idempotency`,
    canonicalJson({
      connectionId: request.connectionId.toLowerCase(),
      provider: request.provider,
      accountId: request.authority.accountId,
      workspaceId: request.authority.workspaceId,
      subjectId: request.authority.subjectId,
      connectionWorkspaceId: request.authority.connectionWorkspaceId,
      operation,
    }),
  );
}

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

/** Project handler output to known wire keys only; values never ride along. */
function project(op: VaultProviderWireOperationName, raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const result = raw as Record<string, any>;
  const field = (f: any) =>
    f && typeof f === "object" ? pick(f, ["externalFieldId", "name", "kind"]) : f;
  const item = (i: any) =>
    i && typeof i === "object"
      ? {
          ...pick(i, ["externalItemId", "name", "type", "websites", "version", "updatedAt"]),
          fields: Array.isArray(i.fields) ? i.fields.map(field) : i.fields,
        }
      : i;
  const vault = (v: any) =>
    v && typeof v === "object"
      ? pick(v, [
          "externalVaultId",
          "name",
          "contentVersion",
          "itemCount",
          "writeAccess",
          "operations",
        ])
      : v;
  switch (op) {
    case "describe":
      return pick(result, [
        "accountId",
        "accountName",
        "operations",
        "capabilities",
        "inventoryScope",
      ]);
    case "refresh":
      return pick(result, ["refreshed"]);
    case "list_vaults":
    case "list_items":
      return {
        ...pick(result, ["nextCursor", "snapshot"]),
        items: Array.isArray(result.items)
          ? result.items.map(op === "list_vaults" ? vault : item)
          : result.items,
      };
    case "read_fields":
      return {
        fields: Array.isArray(result.fields)
          ? result.fields.map((f: any) =>
              f && typeof f === "object" ? pick(f, ["externalFieldId", "value"]) : f,
            )
          : result.fields,
      };
    case "write_item":
      return { item: item(result.item) };
    case "archive_item":
      return pick(result, ["archived"]);
  }
}

/** Mirrors Opengeni's secret-name rule: usable item/field names from upstream titles. */
export function safeExternalVaultName(raw: string, fallback = "Untitled"): string {
  // oxlint-disable-next-line no-control-regex
  const forbidden = /[/{}#\\\u0000-\u001f\u007f-\u009f]/g;
  const clean = (value: string) =>
    [...value.replace(forbidden, "-").trim()].slice(0, 120).join("").trim();
  let name = clean(typeof raw === "string" ? raw : "");
  if (!name) name = clean(fallback) || "Untitled";
  if (/^id:/i.test(name)) name = `id-${name.slice(3)}`;
  return name;
}

/** A safe field name, unique case-insensitively within `taken` (which it updates). */
export function uniqueExternalVaultFieldName(raw: string, taken: Set<string>, fallback = "field") {
  let base = safeExternalVaultName(raw, fallback);
  if (vaultProviderWireNameKey(base) === "otp") base = "otp-code";
  let candidate = base;
  for (let n = 2; taken.has(vaultProviderWireNameKey(candidate)); n += 1) {
    const suffix = ` (${n})`;
    candidate = `${[...base].slice(0, 120 - suffix.length).join("")}${suffix}`;
  }
  taken.add(vaultProviderWireNameKey(candidate));
  return candidate;
}

/**
 * Process-local store for tests, development and a single-process bridge
 * that accepts losing replay/idempotency memory on restart. It is not durable.
 */
export function createInMemoryExternalVaultReceiverStore(
  options: { maxEntries?: number; now?: () => number } = {},
): ExternalVaultReceiverStore & { size(): number } {
  const maxEntries = options.maxEntries ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const requests = new Map<string, number>();
  const mutations = new Map<
    string,
    { digest: string; expiresAt: number; state: "pending" | "completed"; result?: unknown }
  >();
  const prune = () => {
    const t = now();
    for (const [key, expiresAt] of requests) if (expiresAt <= t) requests.delete(key);
    for (const [key, entry] of mutations) if (entry.expiresAt <= t) mutations.delete(key);
  };
  const full = () => requests.size + mutations.size >= maxEntries;
  return {
    size: () => requests.size + mutations.size,
    async rememberRequest({ connectionId, requestId, expiresAt }) {
      prune();
      const key = `${connectionId}\u0000${requestId}`;
      if (requests.has(key)) return false;
      // Refuse rather than forget: forgetting would reopen a replay window.
      if (full()) throw new ExternalVaultReceiverError("provider_rate_limited");
      requests.set(key, expiresAt.getTime());
      return true;
    },
    async claimMutation({ connectionId, idempotencyKey, digest, expiresAt }) {
      prune();
      const key = `${connectionId}\u0000${idempotencyKey}`;
      const existing = mutations.get(key);
      if (existing) {
        if (existing.digest !== digest) return { state: "mismatch" };
        return existing.state === "completed"
          ? { state: "completed", result: structuredClone(existing.result) }
          : { state: "pending" };
      }
      if (full()) throw new ExternalVaultReceiverError("provider_rate_limited");
      mutations.set(key, { digest, expiresAt: expiresAt.getTime(), state: "pending" });
      return { state: "claimed" };
    },
    async completeMutation({ connectionId, idempotencyKey, digest, result }) {
      const entry = mutations.get(`${connectionId}\u0000${idempotencyKey}`);
      if (!entry || entry.digest !== digest) throw new Error("mutation claim missing");
      entry.state = "completed";
      entry.result = structuredClone(result);
    },
    async releaseMutation({ connectionId, idempotencyKey, digest }) {
      const key = `${connectionId}\u0000${idempotencyKey}`;
      if (mutations.get(key)?.digest === digest) mutations.delete(key);
    },
  };
}

function operationTarget(operation: VaultProviderWireOperation) {
  return {
    op: operation.op,
    ...("externalVaultId" in operation ? { externalVaultId: operation.externalVaultId } : {}),
    ...("externalItemId" in operation ? { externalItemId: operation.externalItemId } : {}),
    ...(operation.op === "write_item" && operation.item.externalItemId
      ? { externalItemId: operation.item.externalItemId }
      : {}),
  };
}

export function createExternalVaultReceiver<TConnection, TPrincipal>(
  options: ExternalVaultReceiverOptions<TConnection, TPrincipal>,
): ExternalVaultReceiver {
  const now = options.now ?? (() => Date.now());
  const tolerance = VAULT_PROVIDER_WIRE_LIMITS.signatureToleranceSeconds;
  const retentionMs = Math.max(options.mutationRetentionMs ?? 86_400_000, tolerance * 2_000);
  const report = (
    stage: "authorize" | "handler" | "store" | "output",
    op: VaultProviderWireOperationName,
    connectionId: string,
    error: unknown,
  ) => {
    try {
      options.onError?.({ stage, op, connectionId, error });
    } catch {
      // Diagnostics never change the protocol outcome.
    }
  };

  async function signed(
    secret: string,
    response: VaultProviderWireSuccess | VaultProviderWireFailure,
  ): Promise<ExternalVaultReceiverHttpResponse> {
    const body = JSON.stringify(response);
    const signature = await signOpenGeniPayload(
      vaultProviderWireResponseKey(secret),
      body,
      Math.floor(now() / 1000),
    );
    return {
      status: 200,
      headers: { ...JSON_HEADERS, [VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER]: signature },
      body,
    };
  }

  async function handle(
    request: ExternalVaultReceiverHttpRequest,
  ): Promise<ExternalVaultReceiverHttpResponse> {
    if (typeof request.body !== "string") return plain(400, "invalid_request");
    if (vaultProviderWireUtf8Bytes(request.body) > VAULT_PROVIDER_WIRE_LIMITS.maxRequestBytes) {
      return plain(413, "request_too_large");
    }
    const signature = headerValue(request.headers, OPENGENI_SIGNATURE_HEADER);
    if (!signature) return plain(401, "unauthorized");
    let raw: unknown;
    try {
      raw = JSON.parse(request.body);
    } catch {
      return plain(400, "invalid_request");
    }
    const claimedConnectionId =
      raw && typeof raw === "object" ? (raw as { connectionId?: unknown }).connectionId : undefined;
    if (typeof claimedConnectionId !== "string" || !UUID.test(claimedConnectionId)) {
      return plain(401, "unauthorized");
    }
    const connectionId = claimedConnectionId.toLowerCase();
    let connection: ExternalVaultReceiverConnection<TConnection> | null;
    try {
      connection = await options.resolveConnection(connectionId);
    } catch (error) {
      report("store", "describe", connectionId, error);
      return plain(503, "unavailable");
    }
    if (!connection || connection.signingSecrets.length === 0) return plain(401, "unauthorized");
    let secret: string | null = null;
    for (const candidate of connection.signingSecrets.slice(0, 4)) {
      if (
        await verifyOpenGeniSignature({
          secret: candidate,
          body: request.body,
          signature,
          toleranceSeconds: tolerance,
          nowSeconds: Math.floor(now() / 1000),
        })
      ) {
        secret = candidate;
        break;
      }
    }
    if (!secret) return plain(401, "unauthorized");
    const parsed = VaultProviderWireRequest.safeParse(raw);
    if (!parsed.success) return plain(400, "invalid_request");
    const wire = parsed.data;
    const op = wire.operation.op;
    const sentAt = Date.parse(wire.sentAt);
    if (!Number.isFinite(sentAt) || Math.abs(now() - sentAt) > tolerance * 1000) {
      return plain(401, "unauthorized");
    }

    const failure = (
      code: VaultProviderWireErrorCode,
      extra: { retryAfterMs?: number | null; freshness?: VaultProviderWireFreshness | null } = {},
    ) =>
      signed(secret!, {
        version: VAULT_PROVIDER_WIRE_VERSION,
        type: "response",
        requestId: wire.requestId,
        ok: false,
        op,
        error: { code, retryAfterMs: extra.retryAfterMs ?? null },
        freshness: extra.freshness ?? null,
      });

    try {
      const fresh = await options.store.rememberRequest({
        connectionId,
        requestId: wire.requestId,
        expiresAt: new Date(now() + tolerance * 2_000),
      });
      if (!fresh) return plain(409, "replayed_request");
    } catch (error) {
      report("store", op, connectionId, error);
      if (error instanceof ExternalVaultReceiverError) return failure(error.code);
      return failure("provider_unavailable");
    }

    if (
      wire.provider !== connection.provider ||
      (connection.accountId !== undefined && wire.authority.accountId !== connection.accountId) ||
      (connection.connectionWorkspaceId !== undefined &&
        wire.authority.connectionWorkspaceId !== connection.connectionWorkspaceId)
    ) {
      return failure("provider_permission_denied");
    }

    let principal: TPrincipal | null;
    try {
      principal = await options.authorize({
        connectionId,
        connection: connection.context,
        authority: wire.authority,
        operation: operationTarget(wire.operation),
        requestId: wire.requestId,
      });
    } catch (error) {
      report("authorize", op, connectionId, error);
      if (error instanceof ExternalVaultReceiverError) return failure(error.code);
      return failure("provider_unavailable");
    }
    if (principal === null || principal === undefined) {
      return failure("provider_permission_denied");
    }

    const inventory: ExternalVaultInventoryContext<TConnection> = {
      connectionId,
      connection: connection.context,
      requestId: wire.requestId,
      ...(request.signal ? { signal: request.signal } : {}),
    };
    const call: ExternalVaultCallContext<TConnection, TPrincipal> = {
      ...inventory,
      principal,
      authority: wire.authority,
    };

    const respond = async (
      output: ExternalVaultHandlerOutput<unknown>,
    ): Promise<
      | { ok: true; response: ExternalVaultReceiverHttpResponse; result: unknown }
      | { ok: false; code: VaultProviderWireErrorCode }
    > => {
      const projected = project(op, output?.result);
      const result = VaultProviderWireResults[op].safeParse(projected);
      const freshness =
        output?.freshness == null ? null : VaultProviderWireFreshness.safeParse(output.freshness);
      if (!result.success || (freshness && !freshness.success)) {
        report("output", op, connectionId, result.error ?? freshness?.error);
        return { ok: false, code: "provider_unavailable" };
      }
      const consistency = checkConsistency(wire.operation, result.data);
      if (consistency) return { ok: false, code: consistency };
      return {
        ok: true,
        result: result.data,
        response: await signed(secret!, {
          version: VAULT_PROVIDER_WIRE_VERSION,
          type: "response",
          requestId: wire.requestId,
          ok: true,
          op,
          result: result.data,
          freshness: freshness ? freshness.data : null,
        } as VaultProviderWireSuccess),
      };
    };

    if (!isVaultProviderWireMutation(op)) {
      try {
        const output = await runRead(wire.operation, inventory, call);
        if (!output) return failure("provider_permission_denied");
        const outcome = await respond(output);
        return outcome.ok ? outcome.response : failure(outcome.code);
      } catch (error) {
        if (error instanceof ExternalVaultReceiverError) {
          return failure(error.code, {
            retryAfterMs: error.retryAfterMs,
            freshness: error.freshness,
          });
        }
        report("handler", op, connectionId, error);
        return failure("provider_unavailable");
      }
    }

    const mutation = wire.operation as VaultProviderWireOperationOf<"write_item" | "archive_item">;
    const handler =
      mutation.op === "write_item" ? options.handlers.writeItem : options.handlers.archiveItem;
    if (!handler) return failure("provider_permission_denied");
    const digest = await externalVaultMutationDigest({ signingSecret: secret, request: wire });
    const key = { connectionId, idempotencyKey: mutation.idempotencyKey, digest };
    let claim: ExternalVaultMutationClaim;
    try {
      claim = await options.store.claimMutation({
        ...key,
        expiresAt: new Date(now() + retentionMs),
      });
    } catch (error) {
      report("store", op, connectionId, error);
      // Nothing was claimed or run.
      return failure(
        error instanceof ExternalVaultReceiverError ? error.code : "provider_unavailable",
      );
    }
    if (claim.state === "mismatch") return failure("provider_conflict");
    if (claim.state === "pending") return failure("provider_outcome_unknown");
    if (claim.state === "completed") {
      const outcome = await respond({ result: claim.result });
      return outcome.ok ? outcome.response : failure("provider_outcome_unknown");
    }

    let output: ExternalVaultHandlerOutput<unknown>;
    try {
      output =
        mutation.op === "write_item"
          ? await options.handlers.writeItem!(call, {
              externalVaultId: mutation.externalVaultId,
              item: mutation.item,
              idempotencyKey: mutation.idempotencyKey,
            })
          : await options.handlers.archiveItem!(call, {
              externalVaultId: mutation.externalVaultId,
              externalItemId: mutation.externalItemId,
              idempotencyKey: mutation.idempotencyKey,
            });
    } catch (error) {
      if (
        error instanceof ExternalVaultReceiverError &&
        error.code !== "provider_outcome_unknown"
      ) {
        // Definite failure: the key may be used again.
        try {
          await options.store.releaseMutation(key);
        } catch (storeError) {
          report("store", op, connectionId, storeError);
        }
        return failure(error.code, {
          retryAfterMs: error.retryAfterMs,
          freshness: error.freshness,
        });
      }
      // Unknown: keep the claim pending so a repeat cannot apply it twice.
      report("handler", op, connectionId, error);
      return failure("provider_outcome_unknown");
    }
    const outcome = await respond(output);
    if (!outcome.ok) return failure("provider_outcome_unknown");
    try {
      await options.store.completeMutation({ ...key, result: outcome.result });
    } catch (error) {
      report("store", op, connectionId, error);
    }
    return outcome.response;
  }

  async function runRead(
    operation: VaultProviderWireOperation,
    inventory: ExternalVaultInventoryContext<TConnection>,
    call: ExternalVaultCallContext<TConnection, TPrincipal>,
  ): Promise<ExternalVaultHandlerOutput<unknown> | null> {
    const handlers = options.handlers;
    switch (operation.op) {
      case "describe":
        return handlers.describe(inventory);
      case "refresh":
        return handlers.refresh ? handlers.refresh(inventory) : null;
      case "list_vaults":
        return handlers.listVaults(inventory, {
          page: operation.page,
          forceRefresh: operation.forceRefresh,
          cacheEpoch: operation.cacheEpoch,
        });
      case "list_items":
        return handlers.listItems(inventory, {
          externalVaultId: operation.externalVaultId,
          page: operation.page,
          forceRefresh: operation.forceRefresh,
          cacheEpoch: operation.cacheEpoch,
        });
      case "read_fields":
        return handlers.readFields(call, {
          externalVaultId: operation.externalVaultId,
          externalItemId: operation.externalItemId,
          externalFieldIds: operation.externalFieldIds,
          forceRefresh: operation.forceRefresh,
          cacheEpoch: operation.cacheEpoch,
        });
      default:
        return null;
    }
  }

  return {
    handle,
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "method_not_allowed" }), {
          status: 405,
          headers: { ...JSON_HEADERS, allow: "POST" },
        });
      }
      const max = VAULT_PROVIDER_WIRE_LIMITS.maxRequestBytes;
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > max) {
        await request.body?.cancel().catch(() => {});
        const response = plain(413, "request_too_large");
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = request.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > max) {
            await reader.cancel().catch(() => {});
            const response = plain(413, "request_too_large");
            return new Response(response.body, {
              status: response.status,
              headers: response.headers,
            });
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        const response = plain(400, "invalid_request");
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      const response = await handle({ body, headers: request.headers, signal: request.signal });
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
  };
}

/** Cross-checks the schema cannot express on its own. */
function checkConsistency(
  operation: VaultProviderWireOperation,
  result: unknown,
): VaultProviderWireErrorCode | null {
  switch (operation.op) {
    case "list_vaults":
    case "list_items": {
      const page = result as VaultProviderWireResult<"list_items" | "list_vaults">;
      if (page.items.length > operation.page.limit) return "provider_unavailable";
      const ids = new Set<string>();
      for (const entry of page.items as Array<{
        externalVaultId?: string;
        externalItemId?: string;
      }>) {
        const id = entry.externalVaultId ?? entry.externalItemId ?? "";
        if (ids.has(id)) return "provider_unavailable";
        ids.add(id);
      }
      return null;
    }
    case "read_fields": {
      const fields = (result as VaultProviderWireResult<"read_fields">).fields;
      const requested = new Set(operation.externalFieldIds);
      if (fields.some((field) => !requested.has(field.externalFieldId))) {
        return "provider_unavailable";
      }
      return fields.length === requested.size ? null : "provider_not_found";
    }
    case "write_item": {
      const item = (result as VaultProviderWireResult<"write_item">).item;
      const expected = operation.item.externalItemId;
      return expected !== undefined && item.externalItemId !== expected
        ? "provider_outcome_unknown"
        : null;
    }
    default:
      return null;
  }
}
