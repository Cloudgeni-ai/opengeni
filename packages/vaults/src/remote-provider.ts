/**
 * Generic remote vault provider over the signed `opengeni.vault.v1` protocol.
 *
 * The HTTP transport is injected: the API and worker supply their DNS-pinned,
 * HTTPS-only, no-redirect egress. This adapter only signs exact request
 * bytes, enforces the response byte cap again, verifies the response MAC and
 * strictly parses the operation result. It never retries a mutation: any
 * response that cannot be verified after a write may have been applied and is
 * reported as `provider_outcome_unknown`.
 */
import {
  VAULT_LIMITS,
  VAULT_PROVIDER_WIRE_LIMITS,
  VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER,
  VAULT_PROVIDER_WIRE_VERSION,
  VaultProviderWireRequest,
  parseTotpInput,
  parseVaultProviderWireResponse,
  vaultProviderWireResponseKey,
  vaultProviderWireUtf8Bytes,
  type SecretMaterial,
  type VaultProviderFreshness,
  type VaultProviderOperations,
  type VaultProviderWireFreshness,
  type VaultProviderWireItemMeta,
  type VaultProviderWireOperation,
  type VaultProviderWireOperationName,
  type VaultProviderWireResult,
  type VaultProviderWireVault,
  type VaultProviderWireWriteField,
} from "@opengeni/contracts";
import {
  OPENGENI_SIGNATURE_HEADER,
  signOpenGeniPayload,
  verifyOpenGeniSignature,
} from "@opengeni/contracts/workspace-integration-wire";
import {
  VaultProviderError,
  type ProviderCallOperation,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderPage,
  type ProviderPageRequest,
  type ProviderVault,
  type ProviderWriteItem,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  type VaultProviderErrorCode,
} from "./provider";
import { collectProviderPages } from "./provider-pages";

export type RemoteVaultProviderKind = "external" | "bitwarden";

/** Case-insensitive header lookup, satisfied by `Headers`. */
export interface RemoteVaultHeaders {
  get(name: string): string | null;
}

export interface RemoteVaultHttpRequest {
  url: string;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  /** Send exactly these bytes; the signature covers them. */
  body: string;
  /** Hard deadline for connect, send and the complete response body. */
  timeoutMs: number;
  /** Fail instead of reading more response body bytes than this. */
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export interface RemoteVaultHttpResponse {
  status: number;
  headers: RemoteVaultHeaders;
  body: string;
}

/**
 * Bounded HTTP egress for remote vault calls. Implementations must refuse
 * redirects, enforce `timeoutMs` and `maxResponseBytes`, and apply the
 * deployment's endpoint policy (HTTPS, DNS pinning, private-address refusal).
 */
export interface RemoteVaultTransport {
  post(request: RemoteVaultHttpRequest): Promise<RemoteVaultHttpResponse>;
}

export type RemoteVaultTransportFailure =
  | "refused"
  | "network"
  | "timeout"
  | "redirect"
  | "too_large"
  | "aborted";

/**
 * Transport failure. Set `requestSent: false` only when the transport knows
 * no request bytes left the process (for example a refused DNS policy);
 * otherwise a failed mutation is reported as an unknown outcome.
 */
export class RemoteVaultTransportError extends Error {
  readonly failure: RemoteVaultTransportFailure;
  readonly requestSent: boolean;
  constructor(failure: RemoteVaultTransportFailure, requestSent: boolean) {
    super(`remote vault transport failed: ${failure}`);
    this.name = "RemoteVaultTransportError";
    this.failure = failure;
    this.requestSent = requestSent;
  }
}

export type RemoteVaultFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "manual";
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  type?: string;
  headers: RemoteVaultHeaders;
  body: ReadableStream<Uint8Array> | null;
}>;

/**
 * Adapts a fetch-compatible function (for example the deployment's pinned
 * fetch) to the bounded transport: manual redirects are refused, the whole
 * exchange shares one deadline and the body is read with a byte cap.
 */
export function createFetchRemoteVaultTransport(fetchImpl: RemoteVaultFetch): RemoteVaultTransport {
  return {
    async post(request) {
      const controller = new AbortController();
      let failure: RemoteVaultTransportFailure | null = null;
      const timer = setTimeout(() => {
        failure = "timeout";
        controller.abort();
      }, request.timeoutMs);
      const onAbort = () => {
        failure ??= "aborted";
        controller.abort();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
      try {
        let response: Awaited<ReturnType<RemoteVaultFetch>>;
        try {
          response = await fetchImpl(request.url, {
            method: "POST",
            headers: { ...request.headers },
            body: request.body,
            redirect: "manual",
            signal: controller.signal,
          });
        } catch {
          throw new RemoteVaultTransportError(failure ?? "network", true);
        }
        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          await response.body?.cancel().catch(() => {});
          throw new RemoteVaultTransportError("redirect", true);
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > request.maxResponseBytes) {
                await reader.cancel().catch(() => {});
                throw new RemoteVaultTransportError("too_large", true);
              }
              chunks.push(value);
            }
          } catch (error) {
            if (error instanceof RemoteVaultTransportError) throw error;
            throw new RemoteVaultTransportError(failure ?? "network", true);
          }
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          status: response.status,
          headers: response.headers,
          body: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export interface RemoteVaultProviderOptions {
  provider: RemoteVaultProviderKind;
  /** Registered endpoint. HTTPS only unless `allowInsecureHttp` (local/test). */
  endpoint: string;
  /** Per-connection secret; signs requests and derives the response key. */
  signingSecret: string;
  transport: RemoteVaultTransport;
  /** The Opengeni connection id; must match `ctx.connectionId` when both exist. */
  connectionId?: string;
  /**
   * Operations verified by the last describe (stored with the connection), so
   * a fresh instance can answer `capabilities()` without a call. Without it,
   * and before `validate`, the provider is read-only.
   */
  operations?: VaultProviderOperations;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  now?: () => number;
  newRequestId?: () => string;
}

export interface RemoteVaultValidation {
  accountName: string | null;
  accountId: string;
  operations: VaultProviderOperations;
  capabilities: { totp: boolean; files: boolean };
}

export interface RemoteVaultProvider extends VaultProvider {
  readonly id: RemoteVaultProviderKind;
  validate(ctx: VaultProviderContext): Promise<RemoteVaultValidation>;
  listVaultPage(
    ctx: VaultProviderContext,
    page: ProviderPageRequest,
  ): Promise<ProviderPage<ProviderVault>>;
  listItemPage(
    ctx: VaultProviderContext,
    externalVaultId: string,
    page: ProviderPageRequest,
  ): Promise<ProviderPage<ProviderItemMeta>>;
  /** Deliberate upstream refresh. Returns the receiver's freshness. */
  refresh(ctx: VaultProviderContext): Promise<VaultProviderFreshness | null>;
}

/** Operations a remote connection can never perform through this protocol. */
export const REMOTE_VAULT_READ_ONLY_OPERATIONS: VaultProviderOperations = Object.freeze({
  createItemTypes: [],
  updateItem: false,
  removeField: false,
  archiveItem: false,
  archiveKind: "none",
  deleteItem: false,
  restoreItem: false,
  readFiles: false,
  writeFiles: false,
  createTotp: false,
  updateTotp: false,
  createVault: false,
  restoreFieldHistory: false,
}) as VaultProviderOperations;

/** Clamp a described operation set to what the v1 wire can express. */
export function remoteVaultOperations(
  operations: VaultProviderOperations,
): VaultProviderOperations {
  const createItemTypes = operations.createItemTypes.filter(
    (type) => type !== "passkey" && type !== "file",
  );
  const archiveItem = operations.archiveItem && operations.archiveKind !== "none";
  return {
    createItemTypes,
    updateItem: operations.updateItem,
    removeField: operations.removeField && operations.updateItem,
    archiveItem,
    archiveKind: archiveItem ? operations.archiveKind : "none",
    deleteItem: false,
    restoreItem: false,
    readFiles: operations.readFiles,
    writeFiles: false,
    createTotp: operations.createTotp && createItemTypes.length > 0,
    updateTotp: operations.updateTotp && operations.updateItem,
    createVault: false,
    restoreFieldHistory: false,
  };
}

const SAFE_MESSAGES: Record<VaultProviderErrorCode, string> = {
  provider_auth_invalid: "The remote vault rejected Opengeni's credentials.",
  provider_auth_expired: "The remote vault needs to be reconnected.",
  provider_rate_limited: "The remote vault is rate limiting requests. Try again later.",
  provider_unavailable: "The remote vault is unavailable.",
  provider_conflict: "The item changed in the remote vault. Reload it and try again.",
  provider_not_found: "The remote vault item or field was not found.",
  provider_permission_denied: "The remote vault does not allow this operation.",
  provider_locked: "The remote vault is locked. Unlock it where it runs, then refresh.",
  provider_inventory_incomplete:
    "The remote vault inventory could not be read completely. The previous inventory was kept.",
  provider_outcome_unknown:
    "The remote vault did not confirm the change. It may or may not have been saved; check the vault before trying again.",
};

function fail(code: VaultProviderErrorCode, retryAfterMs?: number): never {
  throw new VaultProviderError(code, SAFE_MESSAGES[code], retryAfterMs);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function validEndpoint(endpoint: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail("provider_unavailable");
  }
  const schemeOk = url.protocol === "https:" || (allowInsecureHttp && url.protocol === "http:");
  if (!schemeOk || url.username || url.password || url.hash || endpoint.length > 2_048) {
    fail("provider_unavailable");
  }
  return url.toString();
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function retryAfterHeader(headers: RemoteVaultHeaders): number | undefined {
  const value = headers.get("retry-after");
  if (!value || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Math.min(Number(value.trim()) * 1000, 86_400_000);
}

function toProviderItem(item: VaultProviderWireItemMeta): ProviderItemMeta {
  return {
    externalItemId: item.externalItemId,
    name: item.name,
    type: item.type,
    websites: [...item.websites],
    fields: item.fields.map((field) => ({
      externalFieldId: field.externalFieldId,
      name: field.name,
      kind: field.kind,
    })),
    version: item.version,
    updatedAt: item.updatedAt,
  };
}

function toProviderVault(vault: VaultProviderWireVault): ProviderVault {
  return {
    externalVaultId: vault.externalVaultId,
    name: vault.name,
    contentVersion: vault.contentVersion,
    itemCount: vault.itemCount,
    writeAccess: vault.writeAccess,
    ...(vault.operations ? { operations: remoteVaultOperations(vault.operations) } : {}),
  };
}

/**
 * Create a provider for one registered remote connection. Construction
 * validates the endpoint and secret; no request is sent until a method runs.
 */
export function createRemoteVaultProvider(
  options: RemoteVaultProviderOptions,
): RemoteVaultProvider {
  if (options.provider !== "external" && options.provider !== "bitwarden") {
    fail("provider_unavailable");
  }
  const endpoint = validEndpoint(options.endpoint, options.allowInsecureHttp === true);
  if (
    typeof options.signingSecret !== "string" ||
    options.signingSecret.length < 32 ||
    options.signingSecret.length > 4_096
  ) {
    fail("provider_auth_invalid");
  }
  if (options.connectionId !== undefined && !UUID.test(options.connectionId)) {
    fail("provider_unavailable");
  }
  const timeoutMs = Math.min(
    Math.max(Math.trunc(options.timeoutMs ?? VAULT_PROVIDER_WIRE_LIMITS.defaultTimeoutMs), 1_000),
    VAULT_PROVIDER_WIRE_LIMITS.maxTimeoutMs,
  );
  const now = options.now ?? (() => Date.now());
  const newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
  const responseKey = vaultProviderWireResponseKey(options.signingSecret);
  let described: RemoteVaultValidation | null = null;

  function currentOperations(): VaultProviderOperations {
    if (described) return described.operations;
    if (options.operations) return remoteVaultOperations(options.operations);
    return REMOTE_VAULT_READ_ONLY_OPERATIONS;
  }

  function connectionIdFor(ctx: VaultProviderContext): string {
    const fromCtx = ctx.connectionId;
    if (fromCtx && options.connectionId && fromCtx !== options.connectionId) {
      fail("provider_permission_denied");
    }
    const id = fromCtx ?? options.connectionId;
    if (!id || !UUID.test(id)) fail("provider_unavailable");
    return id.toLowerCase();
  }

  function freshnessFrom(wire: VaultProviderWireFreshness | null): VaultProviderFreshness | null {
    if (!wire) return null;
    return {
      state: wire.state,
      lastCheckedAt: new Date(now()).toISOString(),
      sourceSyncedAt: wire.sourceSyncedAt,
      source: wire.source,
      errorCode: wire.errorCode,
      retryAt: wire.retryAt,
    };
  }

  async function call<Op extends VaultProviderWireOperationName>(
    ctx: VaultProviderContext,
    budget: ProviderCallOperation,
    operation: Extract<VaultProviderWireOperation, { op: Op }>,
  ): Promise<{ result: VaultProviderWireResult<Op>; freshness: VaultProviderFreshness | null }> {
    const mutation = operation.op === "write_item" || operation.op === "archive_item";
    // Never send an unauthorized or unattributed request.
    if (!ctx.authority) fail("provider_permission_denied");
    const connectionId = connectionIdFor(ctx);
    ctx.signal?.throwIfAborted();
    ctx.budget.take(budget);
    const requestId = newRequestId();
    const { accountId, workspaceId, subjectId, connectionWorkspaceId } = ctx.authority;
    const parsed = VaultProviderWireRequest.safeParse({
      version: VAULT_PROVIDER_WIRE_VERSION,
      type: "request",
      requestId,
      sentAt: new Date(now()).toISOString(),
      provider: options.provider,
      connectionId,
      authority: {
        accountId,
        workspaceId,
        subjectId,
        connectionWorkspaceId,
        ...(ctx.authority.sessionId ? { sessionId: ctx.authority.sessionId } : {}),
        ...(ctx.authority.turnId ? { turnId: ctx.authority.turnId } : {}),
        ...(ctx.authority.attemptId ? { attemptId: ctx.authority.attemptId } : {}),
        ...(ctx.authority.siteId ? { siteId: ctx.authority.siteId } : {}),
      },
      operation,
    });
    // An unrepresentable request is refused locally; nothing was sent.
    if (!parsed.success) fail("provider_unavailable");
    const body = JSON.stringify(parsed.data);
    if (vaultProviderWireUtf8Bytes(body) > VAULT_PROVIDER_WIRE_LIMITS.maxRequestBytes) {
      fail("provider_unavailable");
    }
    const signature = await signOpenGeniPayload(
      options.signingSecret,
      body,
      Math.floor(now() / 1000),
    );
    const unverified = (code: VaultProviderErrorCode, retryAfterMs?: number): never =>
      mutation ? fail("provider_outcome_unknown") : fail(code, retryAfterMs);

    let response: RemoteVaultHttpResponse;
    try {
      response = await options.transport.post({
        url: endpoint,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [OPENGENI_SIGNATURE_HEADER]: signature,
        },
        body,
        timeoutMs,
        maxResponseBytes: VAULT_PROVIDER_WIRE_LIMITS.maxResponseBytes,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      if (error instanceof RemoteVaultTransportError && !error.requestSent) {
        fail("provider_unavailable");
      }
      if (mutation) fail("provider_outcome_unknown");
      ctx.signal?.throwIfAborted();
      return fail("provider_unavailable");
    }
    if (
      typeof response?.body !== "string" ||
      vaultProviderWireUtf8Bytes(response.body) > VAULT_PROVIDER_WIRE_LIMITS.maxResponseBytes
    ) {
      return unverified("provider_unavailable");
    }
    if (response.status !== 200) {
      // Unsigned status: never trusted as an outcome for a mutation.
      if (response.status === 401 || response.status === 403) {
        return unverified("provider_auth_invalid");
      }
      if (response.status === 429) {
        return unverified("provider_rate_limited", retryAfterHeader(response.headers));
      }
      return unverified("provider_unavailable");
    }
    const verified = await verifyOpenGeniSignature({
      secret: responseKey,
      body: response.body,
      signature: response.headers.get(VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER),
      toleranceSeconds: VAULT_PROVIDER_WIRE_LIMITS.signatureToleranceSeconds,
      nowSeconds: Math.floor(now() / 1000),
    });
    if (!verified) return unverified("provider_unavailable");
    let json: unknown;
    try {
      json = JSON.parse(response.body);
    } catch {
      return unverified("provider_unavailable");
    }
    const envelope = parseVaultProviderWireResponse(json, { requestId, op: operation.op as Op });
    if (!envelope) return unverified("provider_unavailable");
    const freshness = freshnessFrom(envelope.freshness);
    if (!envelope.ok) {
      if (freshness) ctx.onFreshness?.(freshness);
      fail(envelope.error.code, envelope.error.retryAfterMs ?? undefined);
    }
    return { result: envelope.result as VaultProviderWireResult<Op>, freshness };
  }

  function readContext(ctx: VaultProviderContext) {
    const epoch = ctx.cacheEpoch;
    const cacheEpoch =
      typeof epoch === "string" &&
      epoch.length > 0 &&
      epoch.length <= VAULT_PROVIDER_WIRE_LIMITS.cacheEpochMaxChars &&
      !CONTROL.test(epoch)
        ? epoch
        : null;
    return { forceRefresh: ctx.forceRefresh === true, cacheEpoch };
  }

  function wirePage(page: ProviderPageRequest) {
    const limit = Math.trunc(page.limit);
    if (!Number.isSafeInteger(limit) || limit < 1) fail("provider_inventory_incomplete");
    return {
      limit: Math.min(limit, VAULT_PROVIDER_WIRE_LIMITS.pageSizeMax),
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      ...(page.snapshot !== undefined ? { snapshot: page.snapshot } : {}),
    };
  }

  function idempotencyKey(ctx: VaultProviderContext): string {
    const key = ctx.idempotencyKey;
    if (
      typeof key === "string" &&
      key.length > 0 &&
      key.length <= VAULT_PROVIDER_WIRE_LIMITS.idempotencyKeyMaxChars &&
      !CONTROL.test(key)
    ) {
      return key;
    }
    return crypto.randomUUID();
  }

  const provider: RemoteVaultProvider = {
    id: options.provider,

    capabilities(): VaultProviderCapabilities {
      const operations = currentOperations();
      return {
        write:
          operations.createItemTypes.length > 0 || operations.updateItem || operations.archiveItem,
        createVault: false,
        totp: described?.capabilities.totp ?? (operations.createTotp || operations.updateTotp),
        files: operations.readFiles,
        groupGrants: false,
        passkeys: false,
        operations,
      };
    },

    async validate(ctx) {
      const { result, freshness } = await call(ctx, "admin", { op: "describe" });
      if (freshness) ctx.onFreshness?.(freshness);
      const validation: RemoteVaultValidation = {
        accountId: result.accountId,
        accountName: result.accountName,
        operations: remoteVaultOperations(result.operations),
        capabilities: { ...result.capabilities },
      };
      validation.operations.readFiles &&= validation.capabilities.files;
      if (!validation.capabilities.totp) {
        validation.operations.createTotp = false;
        validation.operations.updateTotp = false;
      }
      described = validation;
      return {
        ...validation,
        operations: { ...validation.operations },
        capabilities: { ...validation.capabilities },
      };
    },

    async listVaultPage(ctx, page) {
      const request = wirePage(page);
      const { result, freshness } = await call(ctx, "list", {
        op: "list_vaults",
        page: request,
        ...readContext(ctx),
      });
      if (result.items.length > request.limit) fail("provider_inventory_incomplete");
      return {
        items: result.items.map(toProviderVault),
        nextCursor: result.nextCursor,
        snapshot: result.snapshot,
        ...(freshness ? { freshness } : {}),
      };
    },

    async listItemPage(ctx, externalVaultId, page) {
      const request = wirePage(page);
      const { result, freshness } = await call(ctx, "list", {
        op: "list_items",
        externalVaultId,
        page: request,
        ...readContext(ctx),
      });
      if (result.items.length > request.limit) fail("provider_inventory_incomplete");
      return {
        items: result.items.map(toProviderItem),
        nextCursor: result.nextCursor,
        snapshot: result.snapshot,
        ...(freshness ? { freshness } : {}),
      };
    },

    // Compatibility: a complete bounded traversal or a refusal, never a prefix.
    async listVaults(ctx) {
      return collectProviderPages({
        page: async (page) => {
          const result = await provider.listVaultPage(ctx, page);
          if (result.freshness) ctx.onFreshness?.(result.freshness);
          return result;
        },
        identity: (vault) => vault.externalVaultId,
        maxItems: VAULT_LIMITS.vaultsPerOwnerScope,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },

    async listItems(ctx, externalVaultId) {
      return collectProviderPages({
        page: async (page) => {
          const result = await provider.listItemPage(ctx, externalVaultId, page);
          if (result.freshness) ctx.onFreshness?.(result.freshness);
          return result;
        },
        identity: (item) => item.externalItemId,
        maxItems: VAULT_LIMITS.itemsPerVault,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },

    async readFields(ctx, externalVaultId, externalItemId, externalFieldIds) {
      if (externalFieldIds.length === 0) return [];
      if (
        externalFieldIds.length > VAULT_PROVIDER_WIRE_LIMITS.readFieldsMax ||
        new Set(externalFieldIds).size !== externalFieldIds.length
      ) {
        fail("provider_not_found");
      }
      const { result, freshness } = await call(ctx, "read", {
        op: "read_fields",
        externalVaultId,
        externalItemId,
        externalFieldIds: [...externalFieldIds],
        ...readContext(ctx),
      });
      if (freshness) ctx.onFreshness?.(freshness);
      // Exactly the requested ids, each once: never accept unrequested values.
      const byId = new Map(result.fields.map((field) => [field.externalFieldId, field]));
      if (
        result.fields.length !== externalFieldIds.length ||
        externalFieldIds.some((id) => !byId.has(id))
      ) {
        fail("provider_unavailable");
      }
      const values: ProviderFieldValue[] = [];
      for (const externalFieldId of externalFieldIds) {
        const wire = byId.get(externalFieldId)!.value;
        let material: SecretMaterial;
        if (wire.type === "text") {
          material = { type: "text", value: wire.value };
        } else if (wire.type === "totp") {
          try {
            material = { type: "totp", params: parseTotpInput(wire.value) };
          } catch {
            return fail("provider_unavailable");
          }
        } else {
          let bytes: Uint8Array;
          try {
            bytes = decodeBase64(wire.base64);
          } catch {
            return fail("provider_unavailable");
          }
          if (bytes.byteLength > VAULT_LIMITS.fileValueMaxBytes) fail("provider_unavailable");
          material = { type: "bytes", value: bytes };
        }
        values.push({ externalFieldId, material });
      }
      return values;
    },

    async writeItem(ctx, externalVaultId, item: ProviderWriteItem) {
      const operations = currentOperations();
      const update = item.externalItemId !== undefined;
      const type = item.type;
      if (type === "passkey") return fail("provider_permission_denied");
      if (update ? !operations.updateItem : !operations.createItemTypes.includes(item.type)) {
        fail("provider_permission_denied");
      }
      if (
        item.fields.some((field) => field.kind === "file" && field.value !== undefined) ||
        (update && !operations.removeField && item.fields.some((field) => field.remove)) ||
        (item.fields.some((field) => field.kind === "totp" && field.value !== undefined) &&
          !(update ? operations.updateTotp : operations.createTotp))
      ) {
        fail("provider_permission_denied");
      }
      const fields: VaultProviderWireWriteField[] = item.fields.map((field) => ({
        ...(field.externalFieldId !== undefined ? { externalFieldId: field.externalFieldId } : {}),
        name: field.name,
        kind: field.kind,
        ...(field.value !== undefined ? { value: field.value } : {}),
        ...(field.remove ? { remove: true as const } : {}),
      }));
      const { result, freshness } = await call(ctx, "write", {
        op: "write_item",
        externalVaultId,
        item: {
          ...(update ? { externalItemId: item.externalItemId } : {}),
          ...(item.expectedVersion !== undefined ? { expectedVersion: item.expectedVersion } : {}),
          name: item.name,
          type,
          websites: [...item.websites],
          fields,
        },
        idempotencyKey: idempotencyKey(ctx),
      });
      if (freshness) ctx.onFreshness?.(freshness);
      // A confirmed write that names another item cannot be trusted as this write.
      if (update && result.item.externalItemId !== item.externalItemId) {
        fail("provider_outcome_unknown");
      }
      return toProviderItem(result.item);
    },

    async archiveItem(ctx, externalVaultId, externalItemId) {
      if (!currentOperations().archiveItem) fail("provider_permission_denied");
      const { freshness } = await call(ctx, "write", {
        op: "archive_item",
        externalVaultId,
        externalItemId,
        idempotencyKey: idempotencyKey(ctx),
      });
      if (freshness) ctx.onFreshness?.(freshness);
    },

    async refresh(ctx) {
      const { freshness } = await call(ctx, "admin", { op: "refresh" });
      if (freshness) ctx.onFreshness?.(freshness);
      return freshness;
    },
  };
  return provider;
}
