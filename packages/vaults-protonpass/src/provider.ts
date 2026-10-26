import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ProviderCallBudget,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderVault,
  type ProviderWriteField,
  type ProviderWriteItem,
  type SecretMaterial,
  VAULT_LIMITS,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  VaultProviderError,
  type VaultItemType,
  type VaultProviderOperations,
  parseTotpInput,
} from "./contract";
import {
  FILE_FIELD_PREFIX,
  IDENTITY_KEYS,
  IDENTITY_STANDARD_KEYS,
  type MappedField,
  type MappedItem,
  identityFieldName,
  mapItem,
} from "./mapping";
import { nameKey, safeSecretName, totpUri } from "./naming";
import { decodeProtonPasskey } from "./passkeys";
import {
  VAULT_TYPE_MARKER_FIELD,
  encodeItemTypeMarker,
  parseCardExpiry,
  restrictToOperations,
  sshPublicKeyFromPrivateKey,
} from "@opengeni/vaults";
import { standardVaultFieldName } from "@opengeni/contracts";
import {
  FullItemList,
  ITEM_HAS_FILES,
  type Item,
  ItemDetails,
  ItemSummaryList,
  SHARE_PERMISSION,
  ShareListOutput,
  type ShareRole,
  VaultListOutput,
} from "./schema";
import { type ProtonCliOptions, type ProtonCommand, ProtonCliSession, parseJson } from "./session";

export const PROTON_PASS_VALUE_CACHE_MS = VAULT_LIMITS.providerValueCacheMs;
/** Agent tokens cannot list with secrets, so each item is viewed; bound that fan-out. */
export const PROTON_PASS_MAX_ITEM_VIEWS_PER_LIST = 500;

/** Operations pass-cli 2.4.2 supports without secrets on argv (see README). */
export const PROTON_PASS_OPERATIONS: VaultProviderOperations = {
  createItemTypes: ["login", "note", "api_key", "card", "identity", "ssh_key"],
  updateItem: false,
  removeField: false,
  archiveItem: true,
  archiveKind: "trash",
  deleteItem: false,
  restoreItem: false,
  readFiles: true,
  writeFiles: false,
  createTotp: true,
  updateTotp: false,
  createVault: false,
  restoreFieldHistory: false,
};

/** The adapter's capabilities; the same for every token (the PAT scope is enforced upstream). */
export function protonPassCapabilities(): VaultProviderCapabilities {
  return {
    write: true,
    createVault: false,
    totp: true,
    // Legacy flag means file writes; reads are declared in operations.readFiles.
    files: false,
    groupGrants: false,
    // Logins can hold passkeys; read through readPasskeys. pass-cli cannot
    // edit items, so the signature counter is not written back.
    passkeys: true,
    operations: {
      ...PROTON_PASS_OPERATIONS,
      createItemTypes: [...PROTON_PASS_OPERATIONS.createItemTypes],
    },
  };
}

export type ProtonPassVaultProviderOptions = ProtonCliOptions & {
  /** Operations verified at setup; the adapter narrows to them and never widens. */
  operations?: VaultProviderOperations;
  /** Personal access token `pst_…::…`, scoped by the customer to vaults or items. */
  token: string;
  valueCacheMs?: number;
  maxItemViewsPerList?: number;
};

export type ProtonPassVaultProvider = VaultProvider & {
  readonly id: "protonpass";
  readPasskeys: NonNullable<VaultProvider["readPasskeys"]>;
  /** Logs the CLI session out and wipes its private state directory. */
  close(): Promise<void>;
};

/**
 * Proton share and item ids are base64 or URL-safe base64, so a real id can
 * start with "-"; anything else cannot exist. Ids only ever reach pass-cli as
 * `--name=value`, so a leading dash is never parsed as an option.
 */
const PROTON_ID = /^[A-Za-z0-9_=+/-]{1,256}$/;
function assertIds(...ids: string[]) {
  for (const id of ids) {
    if (!PROTON_ID.test(id)) {
      throw new VaultProviderError("provider_not_found", "No such Proton Pass vault or item");
    }
  }
}

const TOKEN_SHAPE = /^[\x21-\x7e]{8,4096}$/;

type CachedDetails = { at: number; details: Promise<ItemDetails> };

function writeAccessFor(role: ShareRole): "read_only" | "read_write" {
  if (typeof role === "string") return role === "Viewer" ? "read_only" : "read_write";
  return (role.Custom.permission & SHARE_PERMISSION.create) !== 0 ? "read_write" : "read_only";
}

/** Narrows a custom role's operations to its permission flags; built-in roles keep all. */
function operationsFor(role: ShareRole): VaultProviderOperations | undefined {
  if (typeof role === "string") return undefined;
  const permission = role.Custom.permission;
  const canCreate = (permission & SHARE_PERMISSION.create) !== 0;
  const canTrash = (permission & SHARE_PERMISSION.trash) !== 0;
  return {
    ...PROTON_PASS_OPERATIONS,
    createItemTypes: canCreate ? [...PROTON_PASS_OPERATIONS.createItemTypes] : [],
    createTotp: canCreate,
    archiveItem: canTrash,
    archiveKind: canTrash ? "trash" : "none",
  };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function refuse(message: string): never {
  throw new VaultProviderError("provider_unavailable", message);
}

function fieldValue(field: ProviderWriteField): string {
  if (field.remove) refuse("Proton Pass items cannot have fields removed from here");
  const value = field.value ?? "";
  if (utf8Bytes(value) > VAULT_LIMITS.textValueMaxBytes) {
    refuse(`The value of "${field.name}" is larger than can be stored`);
  }
  return value;
}

function totpValue(field: ProviderWriteField, label: string): string {
  try {
    return totpUri(parseTotpInput(fieldValue(field)), label);
  } catch (error) {
    if (error instanceof VaultProviderError) throw error;
    throw new VaultProviderError(
      "provider_unavailable",
      `"${field.name}" is not a TOTP seed or otpauth:// URI`,
    );
  }
}

type CreatePlan = {
  /** The `item create` subcommand. */
  kind: CreateKind;
  /**
   * The `--from-template -` JSON; for an SSH key, the title and the private
   * key, which goes in alone on stdin (`ssh-key import` reads a key file).
   */
  template: Record<string, unknown>;
  /** The same content as an Item, for metadata when the follow-up read fails. */
  synthetic: Item["content"]["content"];
  note: string;
  extraSections: Array<{ section_name: string; section_fields: Item["content"]["extra_fields"] }>;
};

/** Builds the `--from-template -` JSON for a create; values travel only on stdin. */
export function planCreate(item: ProviderWriteItem): CreatePlan {
  const title = item.name;
  const category = item.category ?? null;
  if (category && (item.type === "login" || item.type === "card" || item.type === "identity")) {
    refuse(
      `Proton Pass ${TYPE_LABEL[item.type]} items cannot carry a category ("${category}"); save it without one`,
    );
  }
  if (category && item.type === "ssh_key") {
    refuse(`Proton Pass SSH keys cannot carry a category ("${category}"); save it without one`);
  }
  if (item.type === "login") {
    let username: string | null = null;
    let email: string | null = null;
    let password: string | null = null;
    let totp: string | null = null;
    for (const field of item.fields) {
      const key = nameKey(field.name);
      if (field.kind === "totp") {
        if (totp !== null) refuse("Proton Pass logins hold one one-time password");
        totp = totpValue(field, title);
      } else if (field.kind === "text" && key === "username" && username === null) {
        username = fieldValue(field);
      } else if (field.kind === "text" && key === "email" && email === null) {
        email = fieldValue(field);
      } else if (field.kind === "concealed" && key === "password" && password === null) {
        // Only a field named "password" becomes the login password; any other
        // name is refused before the create rather than silently renamed.
        password = fieldValue(field);
      } else {
        refuse(
          `Proton Pass logins created from here hold a username, email, password and one one-time password; "${field.name}" needs an API key (custom) item`,
        );
      }
    }
    const urls = item.websites.filter((url) => url.trim().length > 0);
    return {
      kind: "login",
      template: { title, username, email, password, totp_uri: totp, urls },
      synthetic: {
        Login: {
          username: username ?? "",
          email: email ?? "",
          password: password ?? "",
          totp_uri: totp ?? "",
          urls,
          passkeys: [],
        },
      },
      note: "",
      extraSections: [],
    };
  }
  if (item.type === "note") {
    if (item.fields.length > 1) refuse("A Proton Pass note holds one note field");
    const field = item.fields[0];
    if (field && field.kind !== "text" && field.kind !== "concealed") {
      refuse("A Proton Pass note holds text only");
    }
    const note = field ? fieldValue(field) : "";
    if (category) {
      // Proton notes have no categories: a custom item carries the note and
      // the `opengeni.type` marker, and reads back as this note.
      const marker = markerField({ type: "note", category });
      return customPlan(title, note, [{ section_name: "Fields", fields: [marker] }]);
    }
    return {
      kind: "note",
      template: { title, note },
      synthetic: { Note: null },
      note,
      extraSections: [],
    };
  }
  if (item.type === "api_key") {
    if (category === "wifi") {
      const wifi = wifiPlan(title, item.fields);
      if (wifi) return wifi;
    }
    const fields = item.fields.map((field): TemplateField => {
      if (field.kind === "file") refuse("Proton Pass files cannot be written from here");
      const fieldType =
        field.kind === "totp" ? "totp" : field.kind === "concealed" ? "hidden" : "text";
      const value = field.kind === "totp" ? totpValue(field, title) : fieldValue(field);
      return { field_name: field.name, field_type: fieldType, value };
    });
    if (category) fields.push(markerField({ type: "api_key", category }));
    const sections = fields.length ? [{ section_name: "Fields", fields }] : [];
    return customPlan(title, null, sections);
  }
  if (item.type === "card") return cardPlan(title, item.fields);
  if (item.type === "identity") return identityPlan(title, item.fields);
  if (item.type === "ssh_key") return sshKeyPlan(title, item.fields);
  return refuse(
    item.type === "passkey"
      ? "Passkeys live only in workspace-hosted vaults"
      : "Proton Pass file items cannot be created from here",
  );
}

type CreateKind = "login" | "note" | "custom" | "credit-card" | "identity" | "wifi" | "ssh-key";
type TemplateField = { field_name: string; field_type: "text" | "hidden" | "totp"; value: string };

const TYPE_LABEL = { login: "login", card: "card", identity: "identity" } as const;

function markerField(marker: { type: VaultItemType; category: string }): TemplateField {
  return {
    field_name: VAULT_TYPE_MARKER_FIELD,
    field_type: "text",
    value: encodeItemTypeMarker(marker),
  };
}

function customPlan(
  title: string,
  note: string | null,
  sections: Array<{ section_name: string; fields: TemplateField[] }>,
): CreatePlan {
  return {
    kind: "custom",
    template: { title, note, sections },
    synthetic: {
      Custom: {
        sections: sections.map((section) => ({
          section_name: section.section_name,
          section_fields: section.fields.map((field) => ({
            name: field.field_name,
            content:
              field.field_type === "totp"
                ? { Totp: field.value }
                : field.field_type === "hidden"
                  ? { Hidden: field.value }
                  : { Text: field.value },
          })),
        })),
      },
    },
    note: note ?? "",
    extraSections: [],
  };
}

function textOnly(field: ProviderWriteField, what: string): string {
  if (field.kind !== "text" && field.kind !== "concealed") {
    refuse(`The ${what} of a Proton Pass item holds text only`);
  }
  return fieldValue(field);
}

/** A native Wi-Fi item when the fields fit one (ssid, password, note); else null. */
function wifiPlan(title: string, fields: readonly ProviderWriteField[]): CreatePlan | null {
  const slots = new Map<string, string>();
  for (const field of fields) {
    const key = nameKey(field.name);
    if (!["ssid", "password", "note"].includes(key) || slots.has(key)) return null;
    if (field.kind !== "text" && field.kind !== "concealed") return null;
    slots.set(key, fieldValue(field));
  }
  const ssid = slots.get("ssid") ?? "";
  const password = slots.get("password") ?? "";
  const note = slots.get("note") ?? "";
  return {
    kind: "wifi",
    template: { title, ssid, password, security: null, note },
    synthetic: { Wifi: { ssid, password, sections: [] } },
    note,
    extraSections: [],
  };
}

function cardPlan(title: string, fields: readonly ProviderWriteField[]): CreatePlan {
  const card: Record<string, string> = {};
  let month: string | null = null;
  let year: string | null = null;
  const set = (key: string, field: ProviderWriteField) => {
    if (card[key] !== undefined) refuse(`A Proton Pass card holds one "${field.name}"`);
    card[key] = textOnly(field, field.name);
  };
  for (const field of fields) {
    const standard = standardVaultFieldName("card", field.name);
    const key = nameKey(field.name);
    if (standard === "cardholder name") set("cardholder_name", field);
    else if (standard === "number") set("number", field);
    else if (standard === "security code") set("cvv", field);
    else if (standard === "expiry month") month = textOnly(field, field.name).trim();
    else if (standard === "expiry year") year = textOnly(field, field.name).trim();
    else if (key === "expiration date") set("expiration_date", field);
    else if (key === "pin") set("pin", field);
    else if (key === "note") set("note", field);
    else if (standard === "brand") {
      // pass-cli 2.4.2 drops a card type given on create; Proton detects it.
      if (textOnly(field, field.name).trim()) {
        refuse("Proton Pass sets a card's brand itself from its number; leave brand empty");
      }
    } else {
      refuse(
        `Proton Pass cards hold a cardholder name, number, security code, expiry, PIN and note; "${field.name}" has no place in one`,
      );
    }
  }
  if (month !== null || year !== null) {
    const expiry = parseCardExpiry(`${month ?? ""}/${year ?? ""}`);
    if (!expiry || card.expiration_date !== undefined) {
      refuse("A Proton Pass card expiry needs both a month (1-12) and a year");
    }
    card.expiration_date = `${expiry.year}-${expiry.month.padStart(2, "0")}`;
  }
  return {
    kind: "credit-card",
    template: { title, card_type: null, ...card },
    synthetic: {
      CreditCard: {
        cardholder_name: card.cardholder_name ?? "",
        number: card.number ?? "",
        verification_number: card.cvv ?? "",
        expiration_date: card.expiration_date ?? "",
        pin: card.pin ?? "",
      },
    },
    note: card.note ?? "",
    extraSections: [],
  };
}

function identityPlan(title: string, fields: readonly ProviderWriteField[]): CreatePlan {
  const identity: Record<string, string> = {};
  let note = "";
  for (const field of fields) {
    const standard = standardVaultFieldName("identity", field.name);
    const key =
      (standard ? IDENTITY_STANDARD_KEYS[standard] : undefined) ??
      nameKey(field.name).replace(/\s+/g, "_");
    if (key === "note") {
      note = textOnly(field, field.name);
      continue;
    }
    if (!IDENTITY_KEYS.has(key)) {
      refuse(
        `Proton Pass identities have no "${field.name}" field; they hold ${[...IDENTITY_KEYS].map(identityFieldName).join(", ")} and a note`,
      );
    }
    if (identity[key] !== undefined) refuse(`A Proton Pass identity holds one "${field.name}"`);
    identity[key] = textOnly(field, field.name);
  }
  return {
    kind: "identity",
    template: { title, note, ...identity },
    synthetic: { Identity: { ...identity } },
    note,
    extraSections: [],
  };
}

function sshKeyPlan(title: string, fields: readonly ProviderWriteField[]): CreatePlan {
  let privateKey: string | null = null;
  for (const field of fields) {
    const standard = standardVaultFieldName("ssh_key", field.name);
    // Proton derives the public key from the private key, and Opengeni the
    // fingerprint from the public key (core already checked they match).
    if (standard === "public key" || standard === "fingerprint") continue;
    if (standard !== "private key") {
      refuse(
        `Proton Pass SSH keys created from here hold only the key pair; "${field.name}" has no place in one`,
      );
    }
    privateKey = textOnly(field, field.name);
  }
  if (!privateKey?.trim()) refuse('A Proton Pass SSH key needs its "private key"');
  const derived = sshPublicKeyFromPrivateKey(privateKey);
  return {
    kind: "ssh-key",
    template: { title, private_key: privateKey },
    synthetic: {
      SshKey: { private_key: privateKey, public_key: derived?.publicKey ?? "", sections: [] },
    },
    note: "",
    extraSections: [],
  };
}

/** The `item create` argv for a plan, after `--share-id`. */
function createArgs(plan: CreatePlan, shareId: string): { args: string[]; stdin: string } {
  if (plan.kind === "ssh-key") {
    // `ssh-key import` reads a key file; /dev/stdin keeps the key off disk and argv.
    return {
      args: [
        "item",
        "create",
        "ssh-key",
        "import",
        `--share-id=${shareId}`,
        `--title=${String(plan.template.title)}`,
        "--from-private-key=/dev/stdin",
      ],
      stdin: String(plan.template.private_key),
    };
  }
  return {
    args: ["item", "create", plan.kind, `--share-id=${shareId}`, "--from-template", "-"],
    stdin: JSON.stringify(plan.template),
  };
}

const CREATE_CONTEXT = {
  login: /Error creating login item/,
  note: /Error creating note item/,
  custom: /Error creating custom item/,
  "credit-card": /Error creating credit card item/,
  identity: /Error creating identity item/,
  wifi: /Error creating WiFi item/,
  "ssh-key": /Error creating SSH key item|Error reading private key file|Failed to parse/,
} as const satisfies Record<CreateKind, RegExp>;

export function createProtonPassVaultProvider(
  options: ProtonPassVaultProviderOptions,
): ProtonPassVaultProvider {
  const token = options.token.trim();
  if (!TOKEN_SHAPE.test(token)) {
    throw new VaultProviderError(
      "provider_auth_invalid",
      "A Proton Pass personal access token looks like pst_…::…",
    );
  }
  const session = new ProtonCliSession(token, options);
  const now = options.now ?? Date.now;
  const valueCacheMs = options.valueCacheMs ?? PROTON_PASS_VALUE_CACHE_MS;
  // Per provider instance (one token, one session) and per attempt budget.
  // Core shares one budget across every provider in an attempt, so a
  // module-level cache keyed only by budget would let one connection read
  // another's values for the same share and item ids.
  const attemptCaches = new WeakMap<ProviderCallBudget, Map<string, CachedDetails>>();
  const maxViews = options.maxItemViewsPerList ?? PROTON_PASS_MAX_ITEM_VIEWS_PER_LIST;
  /** Last observed access per share; lets a known read-only vault refuse writes locally. */
  const shareAccess = new Map<string, "read_only" | "read_write" | "unknown">();

  function cli(
    ctx: VaultProviderContext,
    op: "list" | "read" | "write",
    command: Omit<ProtonCommand, "authority" | "signal">,
  ): Promise<string> {
    ctx.signal?.throwIfAborted();
    ctx.budget.take(op);
    return session.run({
      ...command,
      ...(ctx.authority ? { authority: ctx.authority } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  }

  function parseOutput<T>(
    stdout: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    code: "provider_inventory_incomplete" | "provider_unavailable",
  ): T {
    const parsed = schema.safeParse(parseJson(stdout));
    if (!parsed.success) {
      throw new VaultProviderError(
        code,
        "pass-cli returned output this release does not understand",
      );
    }
    return parsed.data;
  }

  function viewItem(
    ctx: VaultProviderContext,
    shareId: string,
    itemId: string,
    subject: string,
  ): Promise<ItemDetails> {
    return cli(ctx, "read", {
      args: ["item", "view", `--share-id=${shareId}`, `--item-id=${itemId}`, "--output", "json"],
      subject,
    }).then((stdout) => parseOutput(stdout, ItemDetails, "provider_unavailable"));
  }

  /** Live item read, cached per attempt (keyed by its budget) with single-flight. */
  function cachedItem(ctx: VaultProviderContext, shareId: string, itemId: string) {
    let cache = attemptCaches.get(ctx.budget);
    if (!cache) {
      cache = new Map();
      attemptCaches.set(ctx.budget, cache);
    }
    const key = `${ctx.cacheEpoch ?? ""}|${shareId}/${itemId}`;
    const cached = cache.get(key);
    if (cached && !ctx.forceRefresh && now() - cached.at < valueCacheMs) return cached.details;
    const details = viewItem(ctx, shareId, itemId, "read item");
    const entry = { at: now(), details };
    cache.set(key, entry);
    details.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return details;
  }

  function forgetItem(ctx: VaultProviderContext, shareId: string, itemId: string) {
    const cache = attemptCaches.get(ctx.budget);
    if (!cache) return;
    for (const key of cache.keys()) if (key.endsWith(`|${shareId}/${itemId}`)) cache.delete(key);
  }

  function reportFresh(ctx: VaultProviderContext) {
    const at = new Date(now()).toISOString();
    ctx.onFreshness?.({
      state: "current",
      lastCheckedAt: at,
      sourceSyncedAt: at,
      source: "live",
      errorCode: null,
      retryAt: null,
    });
  }

  async function downloadFile(
    ctx: VaultProviderContext,
    shareId: string,
    itemId: string,
    field: MappedField & { value: { type: "file" } },
  ): Promise<Uint8Array> {
    const attachment = field.value.attachment;
    assertIds(attachment.id);
    if (attachment.size > VAULT_LIMITS.fileValueMaxBytes) {
      refuse(`"${field.name}" is larger than can be read from Proton Pass`);
    }
    const dir = session.privateScratchDir();
    const target = join(dir, "attachment");
    try {
      await cli(ctx, "read", {
        args: [
          "item",
          "attachment",
          "download",
          `--share-id=${shareId}`,
          `--item-id=${itemId}`,
          `--attachment-id=${attachment.id}`,
          `--output=${target}`,
        ],
        subject: "download attachment",
        maxStdoutBytes: 64 * 1024,
      });
      let size: number;
      try {
        const stat = lstatSync(target);
        if (!stat.isFile()) throw new Error("not a file");
        size = stat.size;
      } catch {
        return refuse("pass-cli did not produce the attachment");
      }
      if (size > VAULT_LIMITS.fileValueMaxBytes) {
        refuse(`"${field.name}" is larger than can be read from Proton Pass`);
      }
      return new Uint8Array(readFileSync(target));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function material(
    ctx: VaultProviderContext,
    shareId: string,
    itemId: string,
    mapped: MappedItem,
    externalFieldId: string,
  ): Promise<SecretMaterial> {
    const field = mapped.fields.find((candidate) => candidate.externalFieldId === externalFieldId);
    if (!field) {
      throw new VaultProviderError(
        "provider_not_found",
        `Proton Pass item "${mapped.meta.name}" has no field ${externalFieldId}`,
      );
    }
    const value = field.value;
    if (value.type === "text") return { type: "text", value: value.value };
    if (value.type === "totp") {
      try {
        return { type: "totp", params: parseTotpInput(value.uri) };
      } catch {
        return refuse(`The one-time password in "${mapped.meta.name}" is not a valid TOTP seed`);
      }
    }
    const bytes = await downloadFile(ctx, shareId, itemId, { ...field, value });
    return { type: "bytes", value: bytes };
  }

  const provider: ProtonPassVaultProvider = {
    id: "protonpass",

    capabilities: protonPassCapabilities,

    async validate(ctx) {
      ctx.signal?.throwIfAborted();
      const info = await session.ensureSession(ctx.signal);
      await provider.listVaults(ctx);
      return { accountName: info.tokenName };
    },

    async listVaults(ctx): Promise<ProviderVault[]> {
      let shares: ShareListOutput;
      try {
        shares = parseOutput(
          await cli(ctx, "list", {
            args: ["share", "list", "--only-vaults=true", "--output", "json"],
            subject: "list vaults",
            overflowCode: "provider_inventory_incomplete",
          }),
          ShareListOutput,
          "provider_inventory_incomplete",
        );
      } catch (error) {
        // Roles refine access; when shares are refused or unreadable, list vaults with unknown access.
        if (
          !(error instanceof VaultProviderError) ||
          ![
            "provider_permission_denied",
            "provider_not_found",
            "provider_inventory_incomplete",
          ].includes(error.code)
        ) {
          throw error;
        }
        const vaults = parseOutput(
          await cli(ctx, "list", {
            args: ["vault", "list", "--output", "json"],
            subject: "list vaults",
            overflowCode: "provider_inventory_incomplete",
          }),
          VaultListOutput,
          "provider_inventory_incomplete",
        );
        reportFresh(ctx);
        return vaults.vaults.map((vault) => {
          shareAccess.set(vault.share_id, "unknown");
          return {
            externalVaultId: vault.share_id,
            name: safeSecretName(vault.name, vault.share_id),
            contentVersion: null,
            itemCount: null,
            writeAccess: "unknown" as const,
          };
        });
      }
      reportFresh(ctx);
      return shares.shares
        .filter((share) => share.share_type === "Vault")
        .map((share) => {
          const writeAccess = writeAccessFor(share.share_role);
          shareAccess.set(share.id, writeAccess);
          const operations = operationsFor(share.share_role);
          return {
            externalVaultId: share.id,
            name: safeSecretName(share.name, share.id),
            contentVersion: null,
            itemCount: null,
            writeAccess,
            ...(operations ? { operations } : {}),
          };
        });
    },

    async listItems(ctx, externalVaultId): Promise<ProviderItemMeta[]> {
      assertIds(externalVaultId);
      await session.ensureSession(ctx.signal);
      const agent = session.sessionInfo?.agent ?? false;
      const base = ["item", "list", `--share-id=${externalVaultId}`, "--filter-state", "active"];
      const metas: ProviderItemMeta[] = [];
      if (!agent) {
        const list = parseOutput(
          await cli(ctx, "list", {
            args: [...base, "--show-secrets", "--output", "json"],
            subject: "list items",
            overflowCode: "provider_inventory_incomplete",
          }),
          FullItemList,
          "provider_inventory_incomplete",
        );
        // Only this share's items are viewed, so only they count against the view budget.
        const withFiles = list.items.filter(
          (item) => item.share_id === externalVaultId && item.flags.includes(ITEM_HAS_FILES),
        );
        if (withFiles.length > maxViews) incomplete();
        for (const item of list.items) {
          if (item.share_id !== externalVaultId) continue;
          if (item.flags.includes(ITEM_HAS_FILES)) {
            const details = await viewItem(ctx, externalVaultId, item.id, "list items");
            metas.push(mapItem(details.item, details.attachments).meta);
          } else {
            metas.push(mapItem(item).meta);
          }
        }
      } else {
        // Agent sessions refuse --show-secrets; each item is viewed (and audited) instead.
        const list = parseOutput(
          await cli(ctx, "list", {
            args: [...base, "--output", "json"],
            subject: "list items",
            overflowCode: "provider_inventory_incomplete",
          }),
          ItemSummaryList,
          "provider_inventory_incomplete",
        );
        const summaries = list.items.filter((item) => item.share_id === externalVaultId);
        if (summaries.length > maxViews) incomplete();
        for (const summary of summaries) {
          const details = await viewItem(ctx, externalVaultId, summary.id, "list items");
          metas.push(mapItem(details.item, details.attachments).meta);
        }
      }
      if (metas.length > VAULT_LIMITS.itemsPerVault) incomplete();
      for (const meta of metas) assertMirrorable(meta);
      reportFresh(ctx);
      return metas;
    },

    async readFields(ctx, externalVaultId, externalItemId, externalFieldIds) {
      assertIds(externalVaultId, externalItemId);
      const details = await cachedItem(ctx, externalVaultId, externalItemId);
      if (details.item.share_id !== externalVaultId || details.item.state !== "Active") {
        throw new VaultProviderError("provider_not_found", "No such Proton Pass vault or item");
      }
      const mapped = mapItem(details.item, details.attachments);
      const values: ProviderFieldValue[] = [];
      for (const externalFieldId of externalFieldIds) {
        values.push({
          externalFieldId,
          material: await material(ctx, externalVaultId, externalItemId, mapped, externalFieldId),
        });
      }
      return values;
    },

    async readPasskeys(ctx, externalVaultId, externalItemId) {
      assertIds(externalVaultId, externalItemId);
      const details = await cachedItem(ctx, externalVaultId, externalItemId);
      if (details.item.share_id !== externalVaultId || details.item.state !== "Active") {
        throw new VaultProviderError("provider_not_found", "No such Proton Pass vault or item");
      }
      const content = details.item.content.content;
      if (typeof content !== "object" || !("Login" in content)) return [];
      return content.Login.passkeys.flatMap((passkey) => {
        const decoded = decodeProtonPasskey(passkey);
        return decoded ? [decoded] : [];
      });
    },

    async writeItem(ctx, externalVaultId, item): Promise<ProviderItemMeta> {
      assertIds(externalVaultId);
      if (item.externalItemId !== undefined) {
        throw new VaultProviderError(
          "provider_unavailable",
          "Proton Pass items cannot be updated from here: pass-cli 2.4.2 takes new values only as command-line arguments and cannot edit one-time passwords",
        );
      }
      if (shareAccess.get(externalVaultId) === "read_only") {
        throw new VaultProviderError(
          "provider_permission_denied",
          "The Proton Pass token can only read this vault",
        );
      }
      const plan = planCreate(item);
      const create = createArgs(plan, externalVaultId);
      const stdout = await cli(ctx, "write", {
        args: create.args,
        stdin: create.stdin,
        subject: `create ${plan.kind} item`,
        mutationContext: CREATE_CONTEXT[plan.kind],
        maxStdoutBytes: 64 * 1024,
      });
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const itemId = lines.at(-1);
      if (!itemId || !PROTON_ID.test(itemId)) {
        throw new VaultProviderError(
          "provider_outcome_unknown",
          "Proton Pass did not confirm the new item; check the vault before retrying",
        );
      }
      try {
        const details = await viewItem(ctx, externalVaultId, itemId, "read created item");
        return mapItem(details.item, details.attachments).meta;
      } catch {
        // The item exists; when the follow-up read fails, describe it from what was sent.
        const synthetic = mapItem({
          id: itemId,
          share_id: externalVaultId,
          content: {
            title: item.name,
            note: plan.note,
            content: plan.synthetic,
            extra_fields: [],
          },
          state: "Active",
          flags: [],
          create_time: "1970-01-01T00:00:00",
          modify_time: "1970-01-01T00:00:00",
        }).meta;
        return { ...synthetic, version: null, updatedAt: null };
      }
    },

    async archiveItem(ctx, externalVaultId, externalItemId) {
      assertIds(externalVaultId, externalItemId);
      if (shareAccess.get(externalVaultId) === "read_only") {
        throw new VaultProviderError(
          "provider_permission_denied",
          "The Proton Pass token can only read this vault",
        );
      }
      // Trash is recoverable in Proton Pass; `item delete` (permanent) is never used.
      await cli(ctx, "write", {
        args: ["item", "trash", `--share-id=${externalVaultId}`, `--item-id=${externalItemId}`],
        subject: "trash item",
        mutationContext: /Error trashing item/,
        maxStdoutBytes: 64 * 1024,
      });
      forgetItem(ctx, externalVaultId, externalItemId);
    },

    close: () => session.close(),
  };
  return restrictToOperations(provider, options.operations, FILE_FIELD_PREFIX);
}

function incomplete(): never {
  throw new VaultProviderError(
    "provider_inventory_incomplete",
    "The Proton Pass vault has more items than can be mirrored at once",
  );
}

/**
 * Opengeni mirrors at most `fieldsPerItem` fields and `websitesPerItem`
 * websites of up to `websiteMaxChars` each. A larger item would be cut down
 * and then look complete, so the listing is reported incomplete instead.
 */
function assertMirrorable(meta: ProviderItemMeta): void {
  if (
    meta.fields.length > VAULT_LIMITS.fieldsPerItem ||
    meta.websites.length > VAULT_LIMITS.websitesPerItem ||
    meta.websites.some((website) => website.length > VAULT_LIMITS.websiteMaxChars)
  ) {
    throw new VaultProviderError(
      "provider_inventory_incomplete",
      `A Proton Pass item has more than ${VAULT_LIMITS.fieldsPerItem} fields or ${VAULT_LIMITS.websitesPerItem} websites (or a website over ${VAULT_LIMITS.websiteMaxChars} characters), more than can be mirrored`,
    );
  }
}
