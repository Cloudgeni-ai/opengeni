import { createHash } from "node:crypto";
import {
  VAULT_LIMITS,
  VaultProviderError,
  parseTotpInput,
  restrictToOperations,
  type ProviderCallBudget,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderVault,
  type ProviderWriteField,
  type SecretMaterial,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  type VaultProviderOperations,
} from "./contract";
import {
  BitwardenHttp,
  BITWARDEN_MAX_RESPONSE_BYTES,
  CLIENT_HEADERS,
  rateLimited,
  statusError,
  type BitwardenApiKey,
  type BitwardenEndpoints,
  type BitwardenHttpOptions,
  type BitwardenServerConfig,
} from "./client";
import {
  BitwardenCryptoError,
  decryptAttachment,
  decryptBytes,
  decryptOptional,
  decryptUserKey,
  deriveMasterKey,
  encryptAttachment,
  encryptBytes,
  encryptString,
  generateSymmetricKey,
  kdfFromServer,
  rsaDecrypt,
  symmetricKeyBytes,
  symmetricKeyFromBytes,
  toB64,
  type SymmetricKey,
} from "./crypto";
import {
  ATTACHMENT_FIELD_PREFIX,
  WriteRefused,
  archivedDateOf,
  createRequest,
  fieldValue,
  isProtected,
  itemKey,
  json,
  mapCipher,
  revisionOf,
  updateRequest,
  type Json,
  type MappedField,
} from "./mapping";

/**
 * What a Bitwarden account can do through its API key and keys. Logins,
 * notes, cards, identities and SSH keys are Bitwarden's own types; API-key
 * and file items are stored as secure notes (see mapping.ts); files are
 * attachments. Archive is Bitwarden's own Archive where the server and the
 * account have it, else the trash (see `archiveItem`); a vault reports
 * `archiveKind: "trash"` when it falls back.
 */
export const BITWARDEN_OPERATIONS: VaultProviderOperations = {
  createItemTypes: ["login", "api_key", "note", "file", "card", "identity", "ssh_key"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  archiveKind: "archive",
  deleteItem: false,
  restoreItem: false,
  readFiles: true,
  writeFiles: true,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: false,
};

/** The account's own items ("My vault"); every other vault id is a collection id. */
export const PERSONAL_VAULT_ID = "personal";

/**
 * What Opengeni stores, encrypted, for a connection. The master password is
 * never stored: setup uses it once to open the account's user key, and the
 * user key alone decrypts the vault from then on. Changing the master
 * password keeps the user key; rotating the account's encryption key in
 * Bitwarden needs a reconnect.
 */
export interface BitwardenCredentials extends BitwardenEndpoints, BitwardenApiKey {
  /** Base64 of the 64-byte user key. */
  userKey: string;
}

export interface BitwardenSetupInput {
  /** The server address: https://vault.bitwarden.com, https://vault.bitwarden.eu or a self-hosted one. */
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  masterPassword: string;
}

export interface BitwardenRuntimeOptions extends BitwardenHttpOptions {
  /** Local development against an http:// server only. */
  allowHttp?: boolean;
}

export interface BitwardenVaultProviderOptions extends BitwardenRuntimeOptions {
  credentials: BitwardenCredentials;
  /** Operations verified at setup; the adapter narrows to them and never widens. */
  operations?: VaultProviderOperations;
}

export type BitwardenVaultProvider = VaultProvider & { readonly id: "bitwarden" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, what: string): string {
  if (!UUID.test(value))
    throw new VaultProviderError("provider_not_found", `No such Bitwarden ${what}`);
  return value.toLowerCase();
}

function list(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.map(json).filter((entry): entry is Json => entry !== null)
    : [];
}

function lower(value: unknown): string | null {
  return typeof value === "string" && value ? value.toLowerCase() : null;
}

/** Checks the API key's shape before anything is sent. */
export function parseApiKey(input: { clientId: string; clientSecret: string }): BitwardenApiKey {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (/^organization\./i.test(clientId)) {
    throw new VaultProviderError(
      "provider_auth_invalid",
      "That is an organization API key. Use the personal API key of the account Opengeni should use (Settings, Security, Keys, View API key).",
    );
  }
  if (!/^user\.[0-9a-f-]{36}$/i.test(clientId) || clientSecret.length < 8) {
    throw new VaultProviderError(
      "provider_auth_invalid",
      "Enter the personal API key's client ID (user.…) and client secret from Settings, Security, Keys, View API key.",
    );
  }
  return { clientId, clientSecret };
}

/* ----------------------------------------------------------------------------
   Tokens. One per API key per process, reused until shortly before it
   expires. Login is the rate-limited call; everything else is cheap.
   -------------------------------------------------------------------------- */

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const TOKEN_MARGIN_MS = 120_000;
const tokens = new Map<string, Promise<CachedToken>>();
const settled = new Map<string, CachedToken>();

function tokenKey(endpoints: BitwardenEndpoints, apiKey: BitwardenApiKey): string {
  return createHash("sha256")
    .update(`${endpoints.identityUrl}\n${apiKey.clientId}\n${apiKey.clientSecret}`)
    .digest("hex");
}

/** Forgets every cached token (tests). */
export function resetBitwardenTokens(): void {
  tokens.clear();
  settled.clear();
}

async function accessToken(
  http: BitwardenHttp,
  endpoints: BitwardenEndpoints,
  apiKey: BitwardenApiKey,
  signal: AbortSignal | undefined,
  stale?: string,
): Promise<string> {
  const key = tokenKey(endpoints, apiKey);
  const now = http.clock();
  for (const [other, token] of settled) {
    if (token.expiresAt - TOKEN_MARGIN_MS <= now) {
      settled.delete(other);
      tokens.delete(other);
    }
  }
  const current = settled.get(key);
  if (current && current.accessToken !== stale) return current.accessToken;
  let pending = tokens.get(key);
  if (!pending || (current && current.accessToken === stale)) {
    settled.delete(key);
    pending = http.login(endpoints, apiKey, signal).then((response) => {
      const token = { accessToken: response.accessToken, expiresAt: response.expiresAt };
      settled.set(key, token);
      return token;
    });
    tokens.set(key, pending);
    pending.catch(() => {
      if (tokens.get(key) === pending) tokens.delete(key);
    });
  }
  return (await pending).accessToken;
}

/* ----------------------------------------------------------------------------
   Account keys and the per-attempt vault snapshot.
   -------------------------------------------------------------------------- */

interface AccountKeys {
  userId: string;
  email: string | null;
  /** Premium, personally or through a paid organization: what Bitwarden's Archive needs. */
  premium: boolean;
  userKey: SymmetricKey;
  orgKeys: Map<string, SymmetricKey>;
  orgNames: Map<string, string>;
  /** Organizations whose key this account could not open. */
  unreadableOrgs: Set<string>;
}

interface VaultSnapshot {
  keys: AccountKeys;
  collections: Json[];
  ciphers: Json[];
}

function staleKey(): VaultProviderError {
  return new VaultProviderError(
    "provider_auth_invalid",
    "The saved Bitwarden key no longer opens this account (its encryption key was rotated). Reconnect it with the master password.",
  );
}

/** Opens the private key and organization keys a profile carries. */
export function accountKeys(profile: Json, userKey: SymmetricKey): AccountKeys {
  const userId = lower(profile.id);
  if (!userId)
    throw new VaultProviderError("provider_unavailable", "Bitwarden returned no account");
  let privateKey: Uint8Array | null = null;
  if (typeof profile.privateKey === "string" && profile.privateKey) {
    try {
      privateKey = decryptBytes(profile.privateKey, userKey);
    } catch (error) {
      if (error instanceof BitwardenCryptoError && error.reason === "unsupported") {
        throw new VaultProviderError("provider_unavailable", `Bitwarden: ${error.message}`);
      }
      throw staleKey();
    }
  }
  const orgKeys = new Map<string, SymmetricKey>();
  const orgNames = new Map<string, string>();
  const unreadableOrgs = new Set<string>();
  for (const org of list(profile.organizations)) {
    const id = lower(org.id);
    if (!id) continue;
    if (typeof org.name === "string") orgNames.set(id, org.name);
    // Invited or accepted but unconfirmed members have no key yet.
    if (typeof org.key !== "string" || !org.key || !privateKey) {
      unreadableOrgs.add(id);
      continue;
    }
    try {
      orgKeys.set(id, symmetricKeyFromBytes(rsaDecrypt(org.key, privateKey)));
    } catch {
      unreadableOrgs.add(id);
    }
  }
  return {
    userId,
    email: typeof profile.email === "string" ? profile.email : null,
    premium: profile.premium === true || profile.premiumFromOrganization === true,
    userKey,
    orgKeys,
    orgNames,
    unreadableOrgs,
  };
}

function ownerKey(keys: AccountKeys, cipher: Json): SymmetricKey {
  const org = lower(cipher.organizationId);
  if (!org) return keys.userKey;
  const key = keys.orgKeys.get(org);
  if (!key) {
    throw new VaultProviderError(
      "provider_permission_denied",
      "This Bitwarden account cannot open the organization's items yet; an owner must confirm it in the organization's Members page",
    );
  }
  return key;
}

/**
 * Whether a cipher belongs to a vault. Trashed items do not; archived items
 * do, marked archived (Bitwarden's archive is per person, so this is the
 * connected account's own view).
 */
function inVault(cipher: Json, vaultId: string): boolean {
  if (cipher.deletedDate) return false;
  if (vaultId === PERSONAL_VAULT_ID) return !cipher.organizationId;
  return (
    Array.isArray(cipher.collectionIds) && cipher.collectionIds.some((id) => lower(id) === vaultId)
  );
}

function assertMirrorable(meta: ProviderItemMeta): void {
  if (
    meta.fields.length > VAULT_LIMITS.fieldsPerItem ||
    meta.websites.length > VAULT_LIMITS.websitesPerItem ||
    meta.websites.some((website) => website.length > VAULT_LIMITS.websiteMaxChars)
  ) {
    throw new VaultProviderError(
      "provider_inventory_incomplete",
      `A Bitwarden item has more than ${VAULT_LIMITS.fieldsPerItem} fields or ${VAULT_LIMITS.websitesPerItem} websites (or a website over ${VAULT_LIMITS.websiteMaxChars} characters), more than can be mirrored`,
    );
  }
}

function writeRefused(error: unknown): never {
  if (error instanceof WriteRefused) throw new VaultProviderError(error.code, error.message);
  throw error;
}

/* ----------------------------------------------------------------------------
   Setup.
   -------------------------------------------------------------------------- */

/**
 * Signs in with the API key, opens the account with the master password and
 * returns what to store. The master password is used here only.
 */
export async function connectBitwarden(
  input: BitwardenSetupInput,
  options: BitwardenRuntimeOptions & { signal?: AbortSignal },
): Promise<{ credentials: BitwardenCredentials; accountName: string | null; accountId: string }> {
  const apiKey = parseApiKey(input);
  if (!input.masterPassword) {
    throw new VaultProviderError("provider_auth_invalid", "Enter the account's master password");
  }
  const http = new BitwardenHttp(options);
  const endpoints = await http.discover(input.serverUrl, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.allowHttp ? { allowHttp: true } : {}),
  });
  const token = await accessToken(http, endpoints, apiKey, options.signal);
  const profile = await getJson(
    http,
    endpoints,
    token,
    "/accounts/profile",
    "reading the account",
    options.signal,
  );
  const email = typeof profile.email === "string" ? profile.email : null;
  const protectedKey = typeof profile.key === "string" ? profile.key : null;
  if (!email || !protectedKey) {
    throw new VaultProviderError(
      "provider_unavailable",
      "Bitwarden did not return the account's protected key; this server version is not supported",
    );
  }
  const prelogin = await http.exchange(
    `${endpoints.identityUrl}/accounts/prelogin`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
        ...CLIENT_HEADERS,
      },
      body: JSON.stringify({ email }),
    },
    { signal: options.signal, what: "reading the key settings" },
  );
  if (prelogin.status === 429) throw rateLimited(prelogin.headers, "reading the key settings");
  if (prelogin.status < 200 || prelogin.status >= 300) {
    throw statusError(prelogin.status, "reading the key settings", false);
  }
  let kdfJson: Json | null = null;
  try {
    kdfJson = json(JSON.parse(new TextDecoder().decode(prelogin.body)));
  } catch {
    kdfJson = null;
  }
  let userKey: SymmetricKey;
  try {
    const kdf = kdfFromServer({
      kdf: kdfJson?.kdf ?? kdfJson?.Kdf,
      kdfIterations: kdfJson?.kdfIterations ?? kdfJson?.KdfIterations,
      kdfMemory: kdfJson?.kdfMemory ?? kdfJson?.KdfMemory,
      kdfParallelism: kdfJson?.kdfParallelism ?? kdfJson?.KdfParallelism,
    });
    const masterKey = await deriveMasterKey(input.masterPassword, email, kdf);
    userKey = decryptUserKey(protectedKey, masterKey);
    masterKey.fill(0);
  } catch (error) {
    if (error instanceof BitwardenCryptoError) {
      throw new VaultProviderError(
        error.reason === "unsupported" ? "provider_unavailable" : "provider_auth_invalid",
        error.reason === "unsupported"
          ? `Bitwarden: ${error.message}`
          : "The master password does not open this Bitwarden account",
      );
    }
    throw error;
  }
  const keys = accountKeys(profile, userKey);
  return {
    credentials: { ...endpoints, ...apiKey, userKey: toB64(symmetricKeyBytes(userKey)) },
    accountName: keys.email,
    accountId: keys.userId,
  };
}

async function getJson(
  http: BitwardenHttp,
  endpoints: BitwardenEndpoints,
  token: string,
  path: string,
  what: string,
  signal?: AbortSignal,
): Promise<Json> {
  const response = await http.api(endpoints, token, "GET", path, undefined, { signal, what });
  if (response.status === 429) throw rateLimited(response.headers, what);
  if (response.status < 200 || response.status >= 300)
    throw statusError(response.status, what, false, response.json);
  const body = json(response.json);
  if (!body)
    throw new VaultProviderError(
      "provider_unavailable",
      `Bitwarden returned unreadable data (${what})`,
    );
  return body;
}

/* ----------------------------------------------------------------------------
   The provider.
   -------------------------------------------------------------------------- */

export function createBitwardenVaultProvider(
  options: BitwardenVaultProviderOptions,
): BitwardenVaultProvider {
  const http = new BitwardenHttp(options);
  const credentials = options.credentials;
  const endpoints: BitwardenEndpoints = {
    serverUrl: credentials.serverUrl,
    apiUrl: credentials.apiUrl,
    identityUrl: credentials.identityUrl,
  };
  const apiKey: BitwardenApiKey = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
  let userKey: SymmetricKey;
  try {
    userKey = symmetricKeyFromBytes(new Uint8Array(Buffer.from(credentials.userKey, "base64")));
  } catch {
    throw staleKey();
  }
  if (!userKey.macKey) throw staleKey();

  // One vault snapshot and one profile per attempt, never across attempts:
  // values are always read live, and only encrypted data is held, briefly.
  const snapshots = new WeakMap<ProviderCallBudget, Map<string, Promise<VaultSnapshot>>>();
  const profiles = new WeakMap<ProviderCallBudget, Promise<AccountKeys>>();
  const configs = new WeakMap<ProviderCallBudget, Promise<BitwardenServerConfig>>();

  /** One authenticated request; a token the server no longer accepts is replaced once. */
  async function request(
    ctx: VaultProviderContext,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    what: string,
    extra: { write?: boolean; maxBytes?: number } = {},
  ): Promise<{ status: number; json: unknown }> {
    let token = await accessToken(http, endpoints, apiKey, ctx.signal);
    for (let attempt = 0; ; attempt += 1) {
      const response = await http.api(endpoints, token, method, path, body, {
        signal: ctx.signal,
        what,
        ...(extra.write ? { write: true } : {}),
        ...(extra.maxBytes ? { maxBytes: extra.maxBytes } : {}),
      });
      // A 401 is answered before the request is handled, so even a write is safe to resend.
      if (response.status === 401 && attempt === 0) {
        token = await accessToken(http, endpoints, apiKey, ctx.signal, token);
        continue;
      }
      if (response.status === 429) throw rateLimited(response.headers, what);
      if (response.status < 200 || response.status >= 300) {
        throw statusError(response.status, what, extra.write === true, response.json);
      }
      return { status: response.status, json: response.json };
    }
  }

  async function requestJson(
    ctx: VaultProviderContext,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    what: string,
    extra: { write?: boolean; maxBytes?: number } = {},
  ): Promise<Json> {
    const response = await request(ctx, method, path, body, what, extra);
    const parsed = json(response.json);
    if (!parsed)
      throw new VaultProviderError(
        "provider_unavailable",
        `Bitwarden returned unreadable data (${what})`,
      );
    return parsed;
  }

  function account(ctx: VaultProviderContext): Promise<AccountKeys> {
    let pending = ctx.forceRefresh ? undefined : profiles.get(ctx.budget);
    if (!pending) {
      pending = requestJson(ctx, "GET", "/accounts/profile", undefined, "reading the account").then(
        (profile) => accountKeys(profile, userKey),
      );
      profiles.set(ctx.budget, pending);
      pending.catch(() => {
        if (profiles.get(ctx.budget) === pending) profiles.delete(ctx.budget);
      });
    }
    return pending;
  }

  function snapshot(ctx: VaultProviderContext): Promise<VaultSnapshot> {
    let byEpoch = snapshots.get(ctx.budget);
    if (!byEpoch) {
      byEpoch = new Map();
      snapshots.set(ctx.budget, byEpoch);
    }
    const epoch = ctx.cacheEpoch ?? "";
    let pending = ctx.forceRefresh ? undefined : byEpoch.get(epoch);
    if (!pending) {
      ctx.budget.take("list");
      pending = requestJson(
        ctx,
        "GET",
        "/sync?excludeDomains=true",
        undefined,
        "reading the vault",
        {
          maxBytes: BITWARDEN_MAX_RESPONSE_BYTES,
        },
      ).then((sync) => {
        const profile = json(sync.profile);
        if (!profile)
          throw new VaultProviderError("provider_unavailable", "Bitwarden returned no account");
        const keys = accountKeys(profile, userKey);
        profiles.set(ctx.budget, Promise.resolve(keys));
        return { keys, collections: list(sync.collections), ciphers: list(sync.ciphers) };
      });
      const entry = pending;
      byEpoch.set(epoch, entry);
      entry.catch(() => {
        if (byEpoch!.get(epoch) === entry) byEpoch!.delete(epoch);
      });
    }
    return pending;
  }

  function forget(ctx: VaultProviderContext) {
    snapshots.delete(ctx.budget);
  }

  function serverConfig(ctx: VaultProviderContext): Promise<BitwardenServerConfig> {
    let pending = configs.get(ctx.budget);
    if (!pending) {
      pending = http.serverConfig(endpoints, ctx.signal);
      configs.set(ctx.budget, pending);
      pending.catch(() => {
        if (configs.get(ctx.budget) === pending) configs.delete(ctx.budget);
      });
    }
    return pending;
  }

  /**
   * Whether Opengeni's Archive can use Bitwarden's own Archive for this
   * account: the server offers it and the account has premium (Vaultwarden
   * gives every account premium). Otherwise archiving moves items to the trash.
   */
  async function archiveAvailable(ctx: VaultProviderContext, keys?: AccountKeys): Promise<boolean> {
    const config = await serverConfig(ctx);
    if (!config.archive) return false;
    return (keys ?? (await account(ctx))).premium;
  }

  function reportFresh(ctx: VaultProviderContext) {
    const at = new Date(http.clock()).toISOString();
    ctx.onFreshness?.({
      state: "current",
      lastCheckedAt: at,
      sourceSyncedAt: at,
      source: "live",
      errorCode: null,
      retryAt: null,
    });
  }

  /** The collection a vault id names, from this attempt's snapshot. */
  function collectionOf(snap: VaultSnapshot, vaultId: string): Json {
    const collection = snap.collections.find((candidate) => lower(candidate.id) === vaultId);
    if (!collection)
      throw new VaultProviderError("provider_not_found", "No such Bitwarden collection");
    return collection;
  }

  function vaultOf(externalVaultId: string): string {
    return externalVaultId === PERSONAL_VAULT_ID
      ? PERSONAL_VAULT_ID
      : assertUuid(externalVaultId, "collection");
  }

  async function liveCipher(
    ctx: VaultProviderContext,
    vault: string,
    itemId: string,
  ): Promise<Json> {
    const cipher = await requestJson(
      ctx,
      "GET",
      `/ciphers/${assertUuid(itemId, "item")}/details`,
      undefined,
      "reading the item",
    );
    // An item is addressed through its vault; never read or change it through another.
    if (!inVault(cipher, vault))
      throw new VaultProviderError("provider_not_found", "No such item in this Bitwarden vault");
    return cipher;
  }

  /**
   * Adds one file to a cipher as an attachment, encrypted as Bitwarden
   * clients do: a new attachment key wrapped in the item's key, the file name
   * encrypted with the item's key, and the body under the attachment key. The
   * server says where the body goes: to itself (self-hosted, Vaultwarden) or
   * to blob storage (Bitwarden cloud).
   */
  async function addAttachment(
    ctx: VaultProviderContext,
    cipher: Json,
    ownerKeyValue: SymmetricKey,
    file: { name: string; bytes: Uint8Array },
  ): Promise<void> {
    const holder = itemKey(cipher, ownerKeyValue);
    const attachmentKey = generateSymmetricKey();
    const body = encryptAttachment(file.bytes, attachmentKey);
    const fileName = encryptString(file.name, holder);
    const cipherId = lower(cipher.id);
    const upload = await requestJson(
      ctx,
      "POST",
      `/ciphers/${cipherId}/attachment/v2`,
      {
        key: encryptBytes(symmetricKeyBytes(attachmentKey), holder),
        fileName,
        fileSize: body.byteLength,
        adminRequest: false,
      },
      "adding the attachment",
      { write: true },
    );
    const attachmentId = typeof upload.attachmentId === "string" ? upload.attachmentId : null;
    if (!attachmentId) {
      throw new VaultProviderError(
        "provider_outcome_unknown",
        "Bitwarden did not confirm the attachment; check the item before trying again",
      );
    }
    if (upload.fileUploadType === 1 && typeof upload.url === "string") {
      await http.uploadToBlob(upload.url, body, ctx.signal);
      return;
    }
    const form = new FormData();
    form.append("data", new Blob([body.slice().buffer]), fileName);
    await request(
      ctx,
      "POST",
      `/ciphers/${cipherId}/attachment/${encodeURIComponent(attachmentId)}`,
      form,
      "uploading the attachment",
      { write: true },
    );
  }

  async function deleteAttachment(
    ctx: VaultProviderContext,
    cipher: Json,
    attachmentId: string,
  ): Promise<void> {
    await request(
      ctx,
      "DELETE",
      `/ciphers/${lower(cipher.id)}/attachment/${encodeURIComponent(attachmentId)}`,
      undefined,
      "removing the attachment",
      { write: true },
    );
  }

  /** What a write does to attachments, checked before anything is sent. */
  function attachmentPlan(
    fields: readonly ProviderWriteField[],
    existing: readonly MappedField[],
  ): { add: Array<{ name: string; bytes: Uint8Array }>; remove: string[] } {
    const add: Array<{ name: string; bytes: Uint8Array }> = [];
    const remove: string[] = [];
    const removedNames = new Set<string>();
    const key = (name: string) => name.normalize("NFC").trim().toLowerCase();
    for (const field of fields) {
      const id = field.externalFieldId;
      if (id === undefined || !id.startsWith(ATTACHMENT_FIELD_PREFIX)) continue;
      const current = existing.find((candidate) => candidate.id === id);
      if (!current || current.source.type !== "attachment") {
        throw new VaultProviderError("provider_not_found", `The item has no field ${id}`);
      }
      if (!field.remove && !field.file) {
        throw new VaultProviderError(
          "provider_conflict",
          `Send the content of "${current.name}" to change it; Bitwarden attachments change by uploading them again`,
        );
      }
      remove.push(String(current.source.attachment.id));
      removedNames.add(key(current.name));
      // An attachment is named by its file name, so it keeps the field's name.
      if (field.file) add.push({ name: field.name, bytes: field.file.bytes });
    }
    const taken = new Set(
      existing.map((field) => key(field.name)).filter((name) => !removedNames.has(name)),
    );
    for (const field of fields) {
      if (field.externalFieldId !== undefined || field.kind !== "file") continue;
      if (!field.file) {
        throw new VaultProviderError("provider_conflict", `"${field.name}" has no file content`);
      }
      if (taken.has(key(field.name))) {
        throw new VaultProviderError(
          "provider_conflict",
          `The item already has a field named "${field.name}"`,
        );
      }
      taken.add(key(field.name));
      add.push({ name: field.name, bytes: field.file.bytes });
    }
    return { add, remove };
  }

  async function keyFor(ctx: VaultProviderContext, cipher: Json): Promise<SymmetricKey> {
    if (!cipher.organizationId) return userKey;
    return ownerKey(await account(ctx), cipher);
  }

  function material(name: string, kind: MappedField["kind"], value: string): SecretMaterial {
    if (kind !== "totp") return { type: "text", value };
    try {
      return { type: "totp", params: parseTotpInput(value) };
    } catch {
      throw new VaultProviderError(
        "provider_unavailable",
        `The one-time password in "${name}" is not a valid TOTP seed`,
      );
    }
  }

  async function readAttachment(
    ctx: VaultProviderContext,
    cipher: Json,
    key: SymmetricKey,
    field: MappedField,
  ): Promise<Uint8Array> {
    if (field.source.type !== "attachment") throw new Error("not an attachment");
    const attachmentId = String(field.source.attachment.id);
    const info = await requestJson(
      ctx,
      "GET",
      `/ciphers/${String(cipher.id)}/attachment/${encodeURIComponent(attachmentId)}`,
      undefined,
      "reading the attachment",
    );
    const limit = VAULT_LIMITS.fileValueMaxBytes;
    const size = Number(info.size ?? field.source.attachment.size);
    if (!Number.isFinite(size) || size > limit) {
      throw new VaultProviderError(
        "provider_unavailable",
        `"${field.name}" is larger than can be read from Bitwarden`,
      );
    }
    if (typeof info.url !== "string") {
      throw new VaultProviderError(
        "provider_unavailable",
        "Bitwarden returned no download address",
      );
    }
    const holder = itemKey(cipher, key);
    const attachmentKey =
      typeof info.key === "string" && info.key
        ? symmetricKeyFromBytes(decryptBytes(info.key, holder))
        : holder;
    const url = new URL(info.url, `${endpoints.serverUrl}/`).toString();
    // Type byte, IV, MAC and up to one block of padding.
    const body = await http.download(url, limit + 1 + 16 + 32 + 16, ctx.signal);
    const plain = decryptAttachment(body, attachmentKey);
    if (plain.byteLength > limit) {
      throw new VaultProviderError(
        "provider_unavailable",
        `"${field.name}" is larger than can be read from Bitwarden`,
      );
    }
    return plain;
  }

  function cryptoFailure(error: unknown, what: string): never {
    if (error instanceof BitwardenCryptoError) {
      throw new VaultProviderError(
        error.reason === "unsupported" ? "provider_unavailable" : "provider_inventory_incomplete",
        error.reason === "unsupported"
          ? `Bitwarden: ${error.message}`
          : `${what} could not be decrypted`,
      );
    }
    throw error;
  }

  const provider: BitwardenVaultProvider = {
    id: "bitwarden",

    capabilities(): VaultProviderCapabilities {
      return {
        write: true,
        createVault: false,
        totp: true,
        // The legacy flag means file writes; reads are declared in operations.
        files: true,
        groupGrants: false,
        passkeys: false,
        operations: {
          ...BITWARDEN_OPERATIONS,
          createItemTypes: [...BITWARDEN_OPERATIONS.createItemTypes],
        },
      };
    },

    async validate(ctx) {
      ctx.budget.take("list");
      const keys = await account({ ...ctx, forceRefresh: true });
      return { accountName: keys.email, accountId: keys.userId };
    },

    async listVaults(ctx): Promise<ProviderVault[]> {
      const snap = await snapshot(ctx);
      // Without Bitwarden's Archive here, Opengeni's Archive uses the trash.
      const vaultOperations: VaultProviderOperations | undefined = (await archiveAvailable(
        ctx,
        snap.keys,
      ))
        ? undefined
        : { ...BITWARDEN_OPERATIONS, archiveKind: "trash" };
      const fingerprint = (vault: string, name: string) => {
        const hash = createHash("sha256").update(name);
        let count = 0;
        const entries = snap.ciphers
          .filter((cipher) => inVault(cipher, vault))
          // Archiving is per person and may not change the revision, so it is part of the version.
          .map(
            (cipher) =>
              `${lower(cipher.id)}@${revisionOf(cipher) ?? ""}${archivedDateOf(cipher) ? "#archived" : ""}`,
          )
          .sort();
        for (const entry of entries) {
          hash.update(`\n${entry}`);
          if (!entry.endsWith("#archived")) count += 1;
        }
        return { contentVersion: hash.digest("hex").slice(0, 32), itemCount: count };
      };
      const vaults: ProviderVault[] = [
        {
          externalVaultId: PERSONAL_VAULT_ID,
          name: "My vault",
          ...fingerprint(PERSONAL_VAULT_ID, "My vault"),
          writeAccess: "read_write",
          ...(vaultOperations ? { operations: vaultOperations } : {}),
        },
      ];
      const multipleOrgs = snap.keys.orgNames.size > 1;
      for (const collection of snap.collections) {
        const id = lower(collection.id);
        const org = lower(collection.organizationId);
        if (!id || !org) continue;
        const key = snap.keys.orgKeys.get(org);
        if (!key) continue;
        let name: string;
        try {
          name = decryptOptional(collection.name, key) ?? "Collection";
        } catch (error) {
          cryptoFailure(error, "A Bitwarden collection name");
        }
        const orgName = snap.keys.orgNames.get(org);
        const label = multipleOrgs && orgName ? `${name} (${orgName})` : name;
        vaults.push({
          externalVaultId: id,
          name: label.replace(/[/\\{}#]/g, "-").slice(0, VAULT_LIMITS.nameMaxChars) || "Collection",
          ...fingerprint(id, label),
          writeAccess: collection.readOnly === true ? "read_only" : "read_write",
          ...(vaultOperations ? { operations: vaultOperations } : {}),
        });
      }
      reportFresh(ctx);
      return vaults;
    },

    async listItems(ctx, externalVaultId): Promise<ProviderItemMeta[]> {
      const vault = vaultOf(externalVaultId);
      const snap = await snapshot(ctx);
      if (vault !== PERSONAL_VAULT_ID) {
        const org = lower(collectionOf(snap, vault).organizationId);
        if (!org || !snap.keys.orgKeys.has(org)) {
          throw new VaultProviderError(
            "provider_permission_denied",
            "This Bitwarden account cannot open the organization's items yet; an owner must confirm it in the organization's Members page",
          );
        }
      }
      const metas: ProviderItemMeta[] = [];
      for (const cipher of snap.ciphers) {
        if (!inVault(cipher, vault)) continue;
        let meta: ProviderItemMeta;
        try {
          meta = mapCipher(cipher, ownerKey(snap.keys, cipher)).meta;
        } catch (error) {
          cryptoFailure(error, "A Bitwarden item");
        }
        assertMirrorable(meta);
        metas.push(meta);
      }
      if (metas.length > VAULT_LIMITS.itemsPerVault) {
        throw new VaultProviderError(
          "provider_inventory_incomplete",
          "The Bitwarden vault has more items than can be mirrored at once",
        );
      }
      reportFresh(ctx);
      return metas;
    },

    async readFields(
      ctx,
      externalVaultId,
      externalItemId,
      externalFieldIds,
    ): Promise<ProviderFieldValue[]> {
      const vault = vaultOf(externalVaultId);
      ctx.budget.take("read");
      const cipher = await liveCipher(ctx, vault, externalItemId);
      const key = await keyFor(ctx, cipher);
      let fields: MappedField[];
      try {
        fields = mapCipher(cipher, key).fields;
      } catch (error) {
        cryptoFailure(error, "This Bitwarden item");
      }
      const values: ProviderFieldValue[] = [];
      for (const externalFieldId of externalFieldIds) {
        const field = fields.find((candidate) => candidate.id === externalFieldId);
        if (!field) {
          throw new VaultProviderError(
            "provider_not_found",
            `The Bitwarden item has no field ${externalFieldId}`,
          );
        }
        // A hide-passwords collection lets the account use the item, not see its secrets.
        if (cipher.viewPassword === false && (isProtected(field) || field.kind === "file")) {
          throw new VaultProviderError(
            "provider_permission_denied",
            `This account may not view "${field.name}" in Bitwarden (the collection hides passwords)`,
          );
        }
        try {
          values.push({
            externalFieldId,
            material:
              field.kind === "file"
                ? { type: "bytes", value: await readAttachment(ctx, cipher, key, field) }
                : material(field.name, field.kind, fieldValue(cipher, key, field)),
          });
        } catch (error) {
          cryptoFailure(error, `"${field.name}"`);
        }
      }
      return values;
    },

    async writeItem(ctx, externalVaultId, item): Promise<ProviderItemMeta> {
      const vault = vaultOf(externalVaultId);
      ctx.budget.take("write");
      let saved: Json;
      let files: { add: Array<{ name: string; bytes: Uint8Array }>; remove: string[] };
      let ownerKeyValue: SymmetricKey;
      if (item.externalItemId === undefined) {
        let orgId: string | null = null;
        let key = userKey;
        if (vault !== PERSONAL_VAULT_ID) {
          const snap = await snapshot(ctx);
          const collection = collectionOf(snap, vault);
          if (collection.readOnly === true) {
            throw new VaultProviderError(
              "provider_permission_denied",
              "This Bitwarden collection is read-only for this account",
            );
          }
          orgId = lower(collection.organizationId);
          key = ownerKey(snap.keys, { organizationId: orgId });
        }
        ownerKeyValue = key;
        files = attachmentPlan(item.fields, []);
        let body: Json;
        try {
          body = createRequest(item, key, orgId, (await account(ctx)).userId);
        } catch (error) {
          writeRefused(error);
        }
        saved = orgId
          ? await requestJson(
              ctx,
              "POST",
              "/ciphers/create",
              { cipher: body, collectionIds: [vault] },
              "creating the item",
              { write: true },
            )
          : await requestJson(ctx, "POST", "/ciphers", body, "creating the item", { write: true });
      } else {
        const cipher = await liveCipher(ctx, vault, item.externalItemId);
        if (cipher.edit === false) {
          throw new VaultProviderError(
            "provider_permission_denied",
            "This Bitwarden item is read-only for this account",
          );
        }
        if (
          item.expectedVersion !== undefined &&
          item.expectedVersion !== null &&
          revisionOf(cipher) !== item.expectedVersion
        ) {
          throw new VaultProviderError(
            "provider_conflict",
            "The Bitwarden item changed since it was read; read it again before writing",
          );
        }
        const key = await keyFor(ctx, cipher);
        ownerKeyValue = key;
        try {
          files = attachmentPlan(item.fields, mapCipher(cipher, key).fields);
        } catch (error) {
          if (error instanceof BitwardenCryptoError) cryptoFailure(error, "This Bitwarden item");
          throw error;
        }
        let body: Json;
        try {
          body = updateRequest(cipher, key, item, (await account(ctx)).userId);
        } catch (error) {
          if (error instanceof BitwardenCryptoError) cryptoFailure(error, "This Bitwarden item");
          writeRefused(error);
        }
        saved = await requestJson(
          ctx,
          "PUT",
          `/ciphers/${lower(cipher.id)}`,
          body,
          "saving the item",
          { write: true },
        );
      }
      if (files.add.length > 0 || files.remove.length > 0) {
        // The item is saved; a failure from here on leaves part of the change applied.
        try {
          for (const file of files.add) await addAttachment(ctx, saved, ownerKeyValue, file);
          for (const attachmentId of files.remove) await deleteAttachment(ctx, saved, attachmentId);
          saved = await requestJson(
            ctx,
            "GET",
            `/ciphers/${lower(saved.id)}/details`,
            undefined,
            "reading the item",
          );
        } catch (error) {
          forget(ctx);
          throw new VaultProviderError(
            "provider_outcome_unknown",
            `Bitwarden saved the item, but its attachments did not all change${error instanceof Error ? ` (${error.message})` : ""}; check the item before trying again`,
          );
        }
      }
      forget(ctx);
      try {
        return mapCipher(saved, await keyFor(ctx, saved)).meta;
      } catch {
        throw new VaultProviderError(
          "provider_outcome_unknown",
          "Bitwarden saved the item but its answer could not be read; list the vault again",
        );
      }
    },

    async archiveItem(ctx, externalVaultId, externalItemId) {
      const vault = vaultOf(externalVaultId);
      ctx.budget.take("write");
      const cipher = await liveCipher(ctx, vault, externalItemId);
      if (await archiveAvailable(ctx)) {
        // Bitwarden's Archive is per person: this hides the item for the
        // connected account only. Others who share it still see it active.
        if (!cipher.archivedDate) {
          await request(
            ctx,
            "PUT",
            `/ciphers/${lower(cipher.id)}/archive`,
            undefined,
            "archiving the item",
            { write: true },
          );
        }
      } else {
        // Soft delete: the item moves to Bitwarden's trash and can be restored there.
        await request(
          ctx,
          "PUT",
          `/ciphers/${lower(cipher.id)}/delete`,
          undefined,
          "moving the item to the trash",
          { write: true },
        );
      }
      forget(ctx);
    },
  };

  return restrictToOperations(provider, options.operations, ATTACHMENT_FIELD_PREFIX);
}
