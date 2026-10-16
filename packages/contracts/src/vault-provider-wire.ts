/**
 * `opengeni.vault.v1`: the signed remote vault-provider protocol.
 *
 * Opengeni POSTs one JSON request per operation to a registered endpoint,
 * signed over the exact body with the existing `OpenGeni-Signature` scheme
 * (`signOpenGeniPayload`). The receiver verifies the signature, then maps the
 * trusted native authority tuple to its own tenant and user and rechecks
 * access on every operation: a valid MAC authenticates Opengeni, it is not an
 * authorization decision. Responses are signed with a response-only derived
 * key (`vaultProviderWireResponseKey`) so a response can never be replayed as
 * a request.
 *
 * Every shape is strict and bounded. Metadata shapes have no value fields.
 * Mutations carry an idempotency key; Opengeni never retries a mutation
 * automatically and reports an ambiguous outcome instead.
 */
import { z } from "zod";
import { defineSchema } from "./define-schema";
import {
  VAULT_LIMITS,
  VaultFieldKind,
  VaultItemType,
  VaultProviderOperations,
  isReservedVaultFieldName,
  isValidSecretName,
} from "./vaults";

export const VAULT_PROVIDER_WIRE_VERSION = "opengeni.vault.v1" as const;

/** Response signature header. Requests use the shared `OpenGeni-Signature` header. */
export const VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER = "OpenGeni-Vault-Response-Signature";

/**
 * The response signing key is derived from the connection secret with a fixed
 * domain label, so request and response MACs are never interchangeable.
 */
export function vaultProviderWireResponseKey(signingSecret: string): string {
  return `${signingSecret}\u0000${VAULT_PROVIDER_WIRE_VERSION}.response`;
}

export const VAULT_PROVIDER_WIRE_LIMITS = {
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  /** Sum of returned secret value bytes in one read. */
  maxReadValueBytes: 3 * 1024 * 1024,
  pageSizeMax: 100,
  cursorMaxChars: 1_024,
  snapshotMaxChars: 1_024,
  externalIdMaxChars: 300,
  vaultNameMaxChars: 300,
  nativeIdMaxChars: 200,
  readFieldsMax: VAULT_LIMITS.fieldsPerItem,
  idempotencyKeyMaxChars: 200,
  accountIdMaxChars: 300,
  accountNameMaxChars: 300,
  versionMaxChars: 300,
  cacheEpochMaxChars: 200,
  /** Per request deadline enforced by Opengeni's transport. */
  defaultTimeoutMs: 15_000,
  maxTimeoutMs: 60_000,
  /** Accepted request age; matches `OPENGENI_SIGNATURE_TOLERANCE_SECONDS`. */
  signatureToleranceSeconds: 300,
} as const;

/** Mirrors `VAULT_PROVIDER_ERROR_CODES` in `@opengeni/vaults` (parity tested there). */
export const VAULT_PROVIDER_WIRE_ERROR_CODES = [
  "provider_auth_invalid",
  "provider_auth_expired",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_conflict",
  "provider_not_found",
  "provider_permission_denied",
  "provider_locked",
  "provider_inventory_incomplete",
  "provider_outcome_unknown",
] as const;
export type VaultProviderWireErrorCode = (typeof VAULT_PROVIDER_WIRE_ERROR_CODES)[number];

export const VAULT_PROVIDER_WIRE_OPERATIONS = [
  "describe",
  "refresh",
  "list_vaults",
  "list_items",
  "read_fields",
  "write_item",
  "archive_item",
] as const;
export type VaultProviderWireOperationName = (typeof VAULT_PROVIDER_WIRE_OPERATIONS)[number];

export type VaultProviderWireMutationName = "write_item" | "archive_item";
export function isVaultProviderWireMutation(
  op: VaultProviderWireOperationName,
): op is VaultProviderWireMutationName {
  return op === "write_item" || op === "archive_item";
}

/** Remote providers that use this protocol. */
export const VaultProviderWireProvider = /* @__PURE__ */ defineSchema(() =>
  z.enum(["external", "bitwarden"]),
);
export type VaultProviderWireProvider = z.infer<typeof VaultProviderWireProvider>;

// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = /* @__PURE__ */ new TextEncoder();

export function vaultProviderWireUtf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARACTERS.test(value), "control characters are not allowed");
}

const ExternalId = /* @__PURE__ */ defineSchema(() =>
  boundedText(VAULT_PROVIDER_WIRE_LIMITS.externalIdMaxChars),
);
const NativeId = /* @__PURE__ */ defineSchema(() =>
  boundedText(VAULT_PROVIDER_WIRE_LIMITS.nativeIdMaxChars),
);
const ItemName = /* @__PURE__ */ defineSchema(() =>
  z.string().refine(isValidSecretName, "invalid_secret_name"),
);
const FieldName = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .refine(
      (name) => isValidSecretName(name) && !isReservedVaultFieldName(name),
      "invalid_secret_name",
    ),
);
const Website = /* @__PURE__ */ defineSchema(() => boundedText(VAULT_LIMITS.websiteMaxChars));
const Version = /* @__PURE__ */ defineSchema(() =>
  boundedText(VAULT_PROVIDER_WIRE_LIMITS.versionMaxChars),
);
const Cursor = /* @__PURE__ */ defineSchema(() =>
  boundedText(VAULT_PROVIDER_WIRE_LIMITS.cursorMaxChars),
);
const Snapshot = /* @__PURE__ */ defineSchema(() =>
  boundedText(VAULT_PROVIDER_WIRE_LIMITS.snapshotMaxChars),
);
const IdempotencyKey = /* @__PURE__ */ defineSchema(() =>
  boundedText(VAULT_PROVIDER_WIRE_LIMITS.idempotencyKeyMaxChars),
);
const CacheEpoch = /* @__PURE__ */ defineSchema(() =>
  boundedText(VAULT_PROVIDER_WIRE_LIMITS.cacheEpochMaxChars).nullable(),
);

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/** Case-insensitive name identity used for field-name uniqueness. */
export function vaultProviderWireNameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/**
 * The trusted native caller. Opengeni fills it from the authorized registry,
 * never from model or body-supplied arguments.
 */
export const VaultProviderWireAuthority = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      accountId: NativeId,
      workspaceId: NativeId,
      /** Null for workspace-level background work with no acting human. */
      subjectId: NativeId.nullable(),
      /** Workspace that owns the encrypted connection (may differ from the caller). */
      connectionWorkspaceId: NativeId,
      sessionId: NativeId.optional(),
      turnId: NativeId.optional(),
      attemptId: NativeId.optional(),
      siteId: NativeId.optional(),
    })
    .strict(),
);
export type VaultProviderWireAuthority = z.infer<typeof VaultProviderWireAuthority>;

export const VaultProviderWirePage = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      limit: z.number().int().min(1).max(VAULT_PROVIDER_WIRE_LIMITS.pageSizeMax),
      cursor: Cursor.optional(),
      snapshot: Snapshot.optional(),
    })
    .strict(),
);
export type VaultProviderWirePage = z.infer<typeof VaultProviderWirePage>;

export const VaultProviderWireWriteField = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      externalFieldId: ExternalId.optional(),
      name: FieldName,
      kind: VaultFieldKind,
      /** Omitted on an update: keep the current value. */
      value: z
        .string()
        .refine(
          (value) => vaultProviderWireUtf8Bytes(value) <= VAULT_LIMITS.textValueMaxBytes,
          "secret_value_too_large",
        )
        .optional(),
      remove: z.literal(true).optional(),
    })
    .strict()
    .refine((field) => !(field.remove && field.value !== undefined), "remove carries no value")
    .refine((field) => !(field.remove && !field.externalFieldId), "remove needs a field id")
    .refine(
      (field) => !(field.kind === "file" && field.value !== undefined),
      "file writes are not supported",
    ),
);
export type VaultProviderWireWriteField = z.infer<typeof VaultProviderWireWriteField>;

export const VaultProviderWireWriteItem = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      externalItemId: ExternalId.optional(),
      expectedVersion: Version.nullable().optional(),
      name: ItemName,
      type: VaultItemType.refine((type) => type !== "passkey", "passkeys are hosted only"),
      websites: z.array(Website).max(VAULT_LIMITS.websitesPerItem),
      fields: z.array(VaultProviderWireWriteField).max(VAULT_LIMITS.fieldsPerItem),
    })
    .strict()
    .refine(
      (item) =>
        uniqueBy(
          item.fields.filter((field) => !field.remove),
          (field) => vaultProviderWireNameKey(field.name),
        ) &&
        uniqueBy(
          item.fields.filter((field) => field.externalFieldId !== undefined),
          (field) => field.externalFieldId!,
        ),
      "duplicate fields",
    ),
);
export type VaultProviderWireWriteItem = z.infer<typeof VaultProviderWireWriteItem>;

const ReadContext = {
  /** Recheck upstream; never bypasses authorization or upstream rate limits. */
  forceRefresh: z.boolean(),
  /** Opengeni's mirror freshness epoch, for receiver-side cache invalidation. */
  cacheEpoch: CacheEpoch,
};

export const VaultProviderWireOperation = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("describe") }).strict(),
    z.object({ op: z.literal("refresh") }).strict(),
    z
      .object({ op: z.literal("list_vaults"), page: VaultProviderWirePage, ...ReadContext })
      .strict(),
    z
      .object({
        op: z.literal("list_items"),
        externalVaultId: ExternalId,
        page: VaultProviderWirePage,
        ...ReadContext,
      })
      .strict(),
    z
      .object({
        op: z.literal("read_fields"),
        externalVaultId: ExternalId,
        externalItemId: ExternalId,
        externalFieldIds: z
          .array(ExternalId)
          .min(1)
          .max(VAULT_PROVIDER_WIRE_LIMITS.readFieldsMax)
          .refine((ids) => new Set(ids).size === ids.length, "duplicate field ids"),
        ...ReadContext,
      })
      .strict(),
    z
      .object({
        op: z.literal("write_item"),
        externalVaultId: ExternalId,
        item: VaultProviderWireWriteItem,
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
    z
      .object({
        op: z.literal("archive_item"),
        externalVaultId: ExternalId,
        externalItemId: ExternalId,
        idempotencyKey: IdempotencyKey,
      })
      .strict(),
  ]),
);
export type VaultProviderWireOperation = z.infer<typeof VaultProviderWireOperation>;
export type VaultProviderWireOperationOf<Op extends VaultProviderWireOperationName> = Extract<
  VaultProviderWireOperation,
  { op: Op }
>;

export const VaultProviderWireRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(VAULT_PROVIDER_WIRE_VERSION),
      type: z.literal("request"),
      requestId: z.string().uuid(),
      sentAt: z.string().datetime(),
      provider: VaultProviderWireProvider,
      connectionId: z.string().uuid(),
      authority: VaultProviderWireAuthority,
      operation: VaultProviderWireOperation,
    })
    .strict(),
);
export type VaultProviderWireRequest = z.infer<typeof VaultProviderWireRequest>;

export const VaultProviderWireErrorCode = /* @__PURE__ */ defineSchema(() =>
  z.enum(VAULT_PROVIDER_WIRE_ERROR_CODES),
);

/** Receiver freshness. Opengeni adds its own `lastCheckedAt`. */
export const VaultProviderWireFreshness = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      state: z.enum(["current", "stale", "refreshing", "unavailable"]),
      /** When the receiver last synchronized with its upstream store. */
      sourceSyncedAt: z.string().datetime().nullable(),
      source: z.enum(["live", "cache", "unknown"]),
      errorCode: VaultProviderWireErrorCode.nullable(),
      retryAt: z.string().datetime().nullable(),
    })
    .strict(),
);
export type VaultProviderWireFreshness = z.infer<typeof VaultProviderWireFreshness>;

export const VaultProviderWireVault = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      externalVaultId: ExternalId,
      name: boundedText(VAULT_PROVIDER_WIRE_LIMITS.vaultNameMaxChars),
      contentVersion: Version.nullable(),
      itemCount: z.number().int().nonnegative().nullable(),
      writeAccess: z.enum(["read_only", "read_write", "unknown"]),
      /** Narrows the connection operations for this vault; never widens them. */
      operations: VaultProviderOperations.optional(),
    })
    .strict(),
);
export type VaultProviderWireVault = z.infer<typeof VaultProviderWireVault>;

export const VaultProviderWireFieldMeta = /* @__PURE__ */ defineSchema(() =>
  z.object({ externalFieldId: ExternalId, name: FieldName, kind: VaultFieldKind }).strict(),
);
export type VaultProviderWireFieldMeta = z.infer<typeof VaultProviderWireFieldMeta>;

/** Item metadata. There is deliberately no value field. */
export const VaultProviderWireItemMeta = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      externalItemId: ExternalId,
      name: ItemName,
      type: VaultItemType,
      websites: z.array(Website).max(VAULT_LIMITS.websitesPerItem),
      fields: z
        .array(VaultProviderWireFieldMeta)
        .max(VAULT_LIMITS.fieldsPerItem)
        .refine(
          (fields) =>
            uniqueBy(fields, (field) => field.externalFieldId) &&
            uniqueBy(fields, (field) => vaultProviderWireNameKey(field.name)),
          "duplicate fields",
        ),
      version: Version.nullable(),
      updatedAt: z.string().datetime().nullable(),
    })
    .strict(),
);
export type VaultProviderWireItemMeta = z.infer<typeof VaultProviderWireItemMeta>;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const VaultProviderWireFieldValue = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      externalFieldId: ExternalId,
      value: z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("text"),
            value: z
              .string()
              .refine(
                (value) => vaultProviderWireUtf8Bytes(value) <= VAULT_LIMITS.textValueMaxBytes,
              ),
          })
          .strict(),
        /** An `otpauth://` URI or Base32 seed; Opengeni computes codes at use. */
        z
          .object({ type: z.literal("totp"), value: boundedText(VAULT_LIMITS.websiteMaxChars) })
          .strict(),
        z
          .object({
            type: z.literal("bytes"),
            base64: z
              .string()
              .max(Math.ceil(VAULT_LIMITS.fileValueMaxBytes / 3) * 4)
              .regex(BASE64),
          })
          .strict(),
      ]),
    })
    .strict(),
);
export type VaultProviderWireFieldValue = z.infer<typeof VaultProviderWireFieldValue>;

function valueBytes(field: VaultProviderWireFieldValue): number {
  if (field.value.type === "bytes") return Math.floor((field.value.base64.length * 3) / 4);
  return vaultProviderWireUtf8Bytes(field.value.value);
}

export const VaultProviderWireDescribeResult = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Stable upstream account or bridge identity; reconnect rejects a change. */
      accountId: boundedText(VAULT_PROVIDER_WIRE_LIMITS.accountIdMaxChars),
      accountName: boundedText(VAULT_PROVIDER_WIRE_LIMITS.accountNameMaxChars).nullable(),
      operations: VaultProviderOperations,
      capabilities: z.object({ totp: z.boolean(), files: z.boolean() }).strict(),
      /** One fixed inventory per connection, independent of the acting subject. */
      inventoryScope: z.literal("connection"),
    })
    .strict(),
);
export type VaultProviderWireDescribeResult = z.infer<typeof VaultProviderWireDescribeResult>;

function pageOf<T extends z.ZodType>(item: T) {
  return z
    .object({
      items: z.array(item).max(VAULT_PROVIDER_WIRE_LIMITS.pageSizeMax),
      nextCursor: Cursor.nullable(),
      /** Null only when the receiver cannot supply snapshot consistency. */
      snapshot: Snapshot.nullable(),
    })
    .strict();
}

export const VaultProviderWireListVaultsResult = /* @__PURE__ */ defineSchema(() =>
  pageOf(VaultProviderWireVault),
);
export const VaultProviderWireListItemsResult = /* @__PURE__ */ defineSchema(() =>
  pageOf(VaultProviderWireItemMeta),
);
export const VaultProviderWireReadFieldsResult = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      fields: z
        .array(VaultProviderWireFieldValue)
        .max(VAULT_PROVIDER_WIRE_LIMITS.readFieldsMax)
        .refine((fields) => uniqueBy(fields, (field) => field.externalFieldId), "duplicate fields")
        .refine(
          (fields) =>
            fields.reduce((total, field) => total + valueBytes(field), 0) <=
            VAULT_PROVIDER_WIRE_LIMITS.maxReadValueBytes,
          "secret values too large",
        ),
    })
    .strict(),
);
export const VaultProviderWireRefreshResult = /* @__PURE__ */ defineSchema(() =>
  z.object({ refreshed: z.literal(true) }).strict(),
);
export const VaultProviderWireWriteItemResult = /* @__PURE__ */ defineSchema(() =>
  z.object({ item: VaultProviderWireItemMeta }).strict(),
);
export const VaultProviderWireArchiveItemResult = /* @__PURE__ */ defineSchema(() =>
  z.object({ archived: z.literal(true) }).strict(),
);

export const VaultProviderWireResults = {
  describe: VaultProviderWireDescribeResult,
  refresh: VaultProviderWireRefreshResult,
  list_vaults: VaultProviderWireListVaultsResult,
  list_items: VaultProviderWireListItemsResult,
  read_fields: VaultProviderWireReadFieldsResult,
  write_item: VaultProviderWireWriteItemResult,
  archive_item: VaultProviderWireArchiveItemResult,
} as const;

export type VaultProviderWireResult<Op extends VaultProviderWireOperationName> = z.infer<
  (typeof VaultProviderWireResults)[Op]
>;

export const VaultProviderWireError = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      code: VaultProviderWireErrorCode,
      retryAfterMs: z.number().int().min(0).max(86_400_000).nullable(),
    })
    .strict(),
);
export type VaultProviderWireError = z.infer<typeof VaultProviderWireError>;

/**
 * Response envelope. `result` is validated separately against
 * `VaultProviderWireResults[op]` for the operation that was requested.
 */
export const VaultProviderWireResponseEnvelope = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("ok", [
    z
      .object({
        version: z.literal(VAULT_PROVIDER_WIRE_VERSION),
        type: z.literal("response"),
        requestId: z.string().uuid(),
        ok: z.literal(true),
        op: z.enum(VAULT_PROVIDER_WIRE_OPERATIONS),
        result: z.unknown(),
        freshness: VaultProviderWireFreshness.nullable(),
      })
      .strict(),
    z
      .object({
        version: z.literal(VAULT_PROVIDER_WIRE_VERSION),
        type: z.literal("response"),
        requestId: z.string().uuid(),
        ok: z.literal(false),
        op: z.enum(VAULT_PROVIDER_WIRE_OPERATIONS),
        error: VaultProviderWireError,
        freshness: VaultProviderWireFreshness.nullable(),
      })
      .strict(),
  ]),
);

export type VaultProviderWireSuccess<
  Op extends VaultProviderWireOperationName = VaultProviderWireOperationName,
> = {
  [K in Op]: {
    version: typeof VAULT_PROVIDER_WIRE_VERSION;
    type: "response";
    requestId: string;
    ok: true;
    op: K;
    result: VaultProviderWireResult<K>;
    freshness: VaultProviderWireFreshness | null;
  };
}[Op];

export type VaultProviderWireFailure = {
  version: typeof VAULT_PROVIDER_WIRE_VERSION;
  type: "response";
  requestId: string;
  ok: false;
  op: VaultProviderWireOperationName;
  error: VaultProviderWireError;
  freshness: VaultProviderWireFreshness | null;
};

export type VaultProviderWireResponse = VaultProviderWireSuccess | VaultProviderWireFailure;

/** Parse one response envelope and its operation-specific result. */
export function parseVaultProviderWireResponse<Op extends VaultProviderWireOperationName>(
  value: unknown,
  expected: { requestId: string; op: Op },
): VaultProviderWireSuccess<Op> | VaultProviderWireFailure | null {
  const envelope = VaultProviderWireResponseEnvelope.safeParse(value);
  if (!envelope.success) return null;
  const response = envelope.data;
  if (response.requestId !== expected.requestId || response.op !== expected.op) return null;
  if (!response.ok) return response as VaultProviderWireFailure;
  const result = VaultProviderWireResults[expected.op].safeParse(response.result);
  if (!result.success) return null;
  return { ...response, op: expected.op, result: result.data } as VaultProviderWireSuccess<Op>;
}
