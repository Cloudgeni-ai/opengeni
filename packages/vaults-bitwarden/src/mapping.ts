/**
 * Bitwarden ciphers <-> Opengeni items. Cipher shapes follow the server's
 * `CipherDetailsResponseModel` and `CipherRequestModel` (camelCase JSON):
 * type 1 login, 2 secure note, 3 card, 4 identity, 5 SSH key; custom field
 * type 0 text, 1 hidden, 2 boolean, 3 linked.
 *
 * Listing decrypts display metadata: the item name, website addresses, custom
 * field names, attachment file names and the login username hint. Other values are decrypted only on read, for the
 * exact fields asked for. Writes re-encrypt only what changes and send every
 * other encrypted value back untouched, so passkeys, attachments, history and
 * anything this mapping does not know survive an update.
 *
 * Logins, secure notes, cards, identities and SSH keys are Bitwarden's own
 * types, and their fields go into the type's own slots (named as Opengeni
 * names a type's standard fields, also under their common other names, such
 * as "cvv" for a card's security code). Bitwarden has no API-key or file item
 * and no categories, so an Opengeni `api_key` or `file` item is written as a
 * secure note, and the item's type and category, when its Bitwarden type
 * does not say them, are kept in an `opengeni.type` custom field that reads
 * back as that type and stays hidden from the item's fields. Any other field
 * is a custom field (hidden when concealed) and files are attachments.
 */
import { createHash } from "node:crypto";
import { isValidTotpInput, standardVaultFieldName, type VaultItemType } from "@opengeni/contracts";
import {
  VAULT_TYPE_MARKER_FIELD,
  decodeItemTypeMarker,
  encodeItemTypeMarker,
  isItemTypeMarkerName,
  parseCardExpiry,
  providerUsernameHint,
} from "@opengeni/vaults";
import {
  VAULT_LIMITS,
  VaultProviderError,
  type ProviderFieldMeta,
  type ProviderItemMeta,
  type ProviderWriteItem,
  type VaultFieldKind,
} from "./contract";
import {
  BitwardenCryptoError,
  decryptOptional,
  encryptString,
  sha256B64,
  symmetricKeyFromBytes,
  decryptBytes,
  type SymmetricKey,
} from "./crypto";

export type Json = Record<string, unknown>;

export const CIPHER_LOGIN = 1;
export const CIPHER_SECURE_NOTE = 2;
export const CIPHER_CARD = 3;
export const CIPHER_IDENTITY = 4;
export const CIPHER_SSH_KEY = 5;
export const FIELD_TEXT = 0;
export const FIELD_HIDDEN = 1;
export const FIELD_BOOLEAN = 2;

export const ATTACHMENT_FIELD_PREFIX = "attachment:";
export const NOTES_FIELD_ID = "notes";
const PASSWORD_HISTORY_KEEP = 5;

type Kind = Exclude<VaultFieldKind, "file">;

export function json(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function list(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.map(json).filter((entry): entry is Json => entry !== null)
    : [];
}

function encrypted(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A built-in field: where its encrypted value lives and how it is shown. */
interface BuiltIn {
  id: string;
  section: "login" | "card" | "identity" | "sshKey";
  key: string;
  name: string;
  kind: Kind;
}

const LOGIN_FIELDS: BuiltIn[] = [
  { id: "login.username", section: "login", key: "username", name: "username", kind: "text" },
  { id: "login.password", section: "login", key: "password", name: "password", kind: "concealed" },
  { id: "login.totp", section: "login", key: "totp", name: "one-time password", kind: "totp" },
];

const CARD_FIELDS: BuiltIn[] = [
  ["cardholderName", "cardholder name", "text"],
  ["brand", "brand", "text"],
  ["number", "number", "concealed"],
  ["expMonth", "expiry month", "text"],
  ["expYear", "expiry year", "text"],
  ["code", "security code", "concealed"],
].map(([key, name, kind]) => ({
  id: `card.${key}`,
  section: "card" as const,
  key: key!,
  name: name!,
  kind: kind as Kind,
}));

const IDENTITY_FIELDS: BuiltIn[] = [
  ["title", "title", "text"],
  ["firstName", "first name", "text"],
  ["middleName", "middle name", "text"],
  ["lastName", "last name", "text"],
  ["username", "username", "text"],
  ["company", "company", "text"],
  ["email", "email", "text"],
  ["phone", "phone", "text"],
  ["address1", "address 1", "text"],
  ["address2", "address 2", "text"],
  ["address3", "address 3", "text"],
  ["city", "city", "text"],
  ["state", "state", "text"],
  ["postalCode", "postal code", "text"],
  ["country", "country", "text"],
  ["ssn", "national ID number", "concealed"],
  ["passportNumber", "passport number", "concealed"],
  ["licenseNumber", "license number", "concealed"],
].map(([key, name, kind]) => ({
  id: `identity.${key}`,
  section: "identity" as const,
  key: key!,
  name: name!,
  kind: kind as Kind,
}));

const SSH_FIELDS: BuiltIn[] = [
  {
    id: "sshKey.privateKey",
    section: "sshKey",
    key: "privateKey",
    name: "private key",
    kind: "concealed",
  },
  { id: "sshKey.publicKey", section: "sshKey", key: "publicKey", name: "public key", kind: "text" },
  {
    id: "sshKey.keyFingerprint",
    section: "sshKey",
    key: "keyFingerprint",
    name: "fingerprint",
    kind: "text",
  },
];

function builtIns(type: unknown): BuiltIn[] {
  switch (type) {
    case CIPHER_LOGIN:
      return LOGIN_FIELDS;
    case CIPHER_CARD:
      return CARD_FIELDS;
    case CIPHER_IDENTITY:
      return IDENTITY_FIELDS;
    case CIPHER_SSH_KEY:
      return SSH_FIELDS;
    default:
      return [];
  }
}

function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

// Mirrors Opengeni's secret-name rule: no / { } # \ or control characters,
// 1..120 characters, not "id:..."; field names may not be "otp".
// oxlint-disable-next-line no-control-regex
const FORBIDDEN = /[/{}#\\\u0000-\u001f\u007f-\u009f]/g;

export function safeName(raw: string, fallback: string): string {
  const clean = (value: string) =>
    [...value.replace(FORBIDDEN, "-").trim()].slice(0, VAULT_LIMITS.nameMaxChars).join("").trim();
  let name = clean(raw);
  if (!name) name = clean(fallback) || "Untitled";
  if (/^id:/i.test(name)) name = `id-${name.slice(3)}`;
  return name;
}

function uniqueFieldName(raw: string, taken: Set<string>): string {
  let base = safeName(raw, "field");
  if (nameKey(base) === "otp") base = "otp-code";
  let candidate = base;
  for (let n = 2; taken.has(nameKey(candidate)); n += 1) {
    const suffix = ` (${n})`;
    candidate = `${[...base].slice(0, VAULT_LIMITS.nameMaxChars - suffix.length).join("")}${suffix}`;
  }
  taken.add(nameKey(candidate));
  return candidate;
}

/** Stable custom-field id from its name and occurrence, never its value. */
export function customFieldId(name: string, occurrence: number): string {
  const digest = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 32);
  return `field:${digest}:${occurrence}`;
}

/** The key that opens a cipher's values: its own key when it has one, else its owner's. */
export function itemKey(cipher: Json, ownerKey: SymmetricKey): SymmetricKey {
  if (!encrypted(cipher.key)) return ownerKey;
  return symmetricKeyFromBytes(decryptBytes(cipher.key, ownerKey));
}

export type MappedField =
  | { id: string; name: string; kind: Kind; source: { type: "builtin"; field: BuiltIn } }
  | { id: string; name: string; kind: Kind; source: { type: "notes" } }
  | {
      id: string;
      name: string;
      kind: Kind;
      source: { type: "custom"; index: number; fieldType: number };
    }
  | { id: string; name: string; kind: "file"; source: { type: "attachment"; attachment: Json } };

export interface MappedCipher {
  meta: ProviderItemMeta;
  fields: MappedField[];
  /** Index in `cipher.fields` of the `opengeni.type` marker, or -1. */
  markerIndex: number;
}

/** Custom fields with their decrypted names and stable ids, values untouched. */
function customFields(cipher: Json, key: SymmetricKey) {
  const seen = new Map<string, number>();
  return list(cipher.fields).map((field, index) => {
    const name = decryptOptional(field.name, key) ?? "";
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return {
      index,
      name,
      id: customFieldId(name, occurrence),
      fieldType: typeof field.type === "number" ? field.type : -1,
      hasValue: encrypted(field.value),
    };
  });
}

function websites(cipher: Json, key: SymmetricKey): string[] {
  if (cipher.type !== CIPHER_LOGIN) return [];
  const out: string[] = [];
  for (const entry of list(json(cipher.login)?.uris)) {
    const uri = decryptOptional(entry.uri, key);
    // oxlint-disable-next-line no-control-regex
    if (!uri || /[\u0000-\u001f\u007f-\u009f]/.test(uri)) continue;
    out.push(uri);
  }
  return out;
}

export function revisionOf(cipher: Json): string | null {
  const value = cipher.revisionDate;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * When the connected account archived the item. Bitwarden's archive is per
 * person: the date is this account's own choice, not the item owner's.
 */
export function archivedDateOf(cipher: Json): string | null {
  const value = cipher.archivedDate;
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

/** The Bitwarden cipher type an Opengeni item type is stored as. */
export function cipherTypeFor(type: ProviderWriteItem["type"]): number | null {
  switch (type) {
    case "login":
      return CIPHER_LOGIN;
    case "note":
    case "api_key":
    case "file":
      return CIPHER_SECURE_NOTE;
    case "card":
      return CIPHER_CARD;
    case "identity":
      return CIPHER_IDENTITY;
    case "ssh_key":
      return CIPHER_SSH_KEY;
    default:
      return null;
  }
}

/** The Opengeni type of a Bitwarden cipher type; null for a type this mapping does not know. */
export function itemTypeOfCipher(cipherType: unknown): VaultItemType | null {
  switch (cipherType) {
    case CIPHER_LOGIN:
      return "login";
    case CIPHER_SECURE_NOTE:
      return "note";
    case CIPHER_CARD:
      return "card";
    case CIPHER_IDENTITY:
      return "identity";
    case CIPHER_SSH_KEY:
      return "ssh_key";
    default:
      return null;
  }
}

/**
 * The `opengeni.type` marker a write needs: the type and category, unless
 * the cipher type alone already says them.
 */
export function markerFor(write: Pick<ProviderWriteItem, "type" | "category">): string | null {
  const native = itemTypeOfCipher(cipherTypeFor(write.type));
  if (native === write.type && !write.category) return null;
  return encodeItemTypeMarker({ type: write.type, category: write.category ?? null });
}

/** A marker counts when it fits the cipher: a secure note holds notes, API keys and files. */
function markedType(
  cipherType: unknown,
  marker: ReturnType<typeof decodeItemTypeMarker>,
): { type: VaultItemType; category: string | null } | null {
  const native = itemTypeOfCipher(cipherType);
  if (!marker || !native) return null;
  const fits =
    native === "note"
      ? marker.type === "note" || marker.type === "api_key" || marker.type === "file"
      : marker.type === native;
  return fits ? marker : null;
}

/**
 * Metadata and field layout. Only display metadata is decrypted; a field is listed when
 * it holds a value. Fails with `BitwardenCryptoError` when a name cannot be
 * opened.
 */
export function mapCipher(cipher: Json, ownerKey: SymmetricKey): MappedCipher {
  const key = itemKey(cipher, ownerKey);
  const taken = new Set<string>();
  const fields: MappedField[] = [];
  for (const field of builtIns(cipher.type)) {
    if (!encrypted(json(cipher[field.section])?.[field.key])) continue;
    fields.push({
      id: field.id,
      name: uniqueFieldName(field.name, taken),
      kind: field.kind,
      source: { type: "builtin", field },
    });
  }
  if (encrypted(cipher.notes)) {
    fields.push({
      id: NOTES_FIELD_ID,
      name: uniqueFieldName(cipher.type === CIPHER_SECURE_NOTE ? "note" : "notes", taken),
      kind: "text",
      source: { type: "notes" },
    });
  }
  let markerIndex = -1;
  let marker: ReturnType<typeof decodeItemTypeMarker> = null;
  for (const field of customFields(cipher, key)) {
    if (markerIndex < 0 && field.fieldType === FIELD_TEXT && isItemTypeMarkerName(field.name)) {
      // Opengeni's own record of the item's type; never one of its fields.
      markerIndex = field.index;
      marker = decodeItemTypeMarker(decryptOptional(list(cipher.fields)[field.index]?.value, key));
      continue;
    }
    if (!field.hasValue) continue; // Linked fields and empty values hold nothing to read.
    if (
      field.fieldType !== FIELD_TEXT &&
      field.fieldType !== FIELD_HIDDEN &&
      field.fieldType !== FIELD_BOOLEAN
    ) {
      continue;
    }
    fields.push({
      id: field.id,
      name: uniqueFieldName(field.name, taken),
      kind: field.fieldType === FIELD_HIDDEN ? "concealed" : "text",
      source: { type: "custom", index: field.index, fieldType: field.fieldType },
    });
  }
  for (const attachment of list(cipher.attachments)) {
    if (typeof attachment.id !== "string") continue;
    fields.push({
      id: `${ATTACHMENT_FIELD_PREFIX}${attachment.id}`,
      name: uniqueFieldName(decryptOptional(attachment.fileName, key) ?? "attachment", taken),
      kind: "file",
      source: { type: "attachment", attachment },
    });
  }
  const revision = revisionOf(cipher);
  const typed = markedType(cipher.type, marker) ?? {
    type: itemTypeOfCipher(cipher.type) ?? "note",
    category: null,
  };
  const meta: ProviderItemMeta = {
    externalItemId: String(cipher.id).toLowerCase(),
    name: safeName(decryptOptional(cipher.name, key) ?? "", "Untitled item"),
    type: typed.type,
    ...(typed.category ? { category: typed.category } : {}),
    username:
      cipher.type === CIPHER_LOGIN
        ? providerUsernameHint(decryptOptional(json(cipher.login)?.username, key))
        : null,
    websites: websites(cipher, key),
    fields: fields.map(
      ({ id, name, kind }): ProviderFieldMeta => ({ externalFieldId: id, name, kind }),
    ),
    version: revision,
    updatedAt: revision ? new Date(revision).toISOString() : null,
    archivedAt: archivedDateOf(cipher),
  };
  return { meta, fields, markerIndex };
}

/** Concealed and one-time-code values, which a hide-passwords collection withholds. */
export function isProtected(field: MappedField): boolean {
  return field.kind === "concealed" || field.kind === "totp";
}

/** Decrypts one non-file field's value. */
export function fieldValue(cipher: Json, ownerKey: SymmetricKey, field: MappedField): string {
  const key = itemKey(cipher, ownerKey);
  let raw: unknown;
  if (field.source.type === "builtin") {
    raw = json(cipher[field.source.field.section])?.[field.source.field.key];
  } else if (field.source.type === "notes") {
    raw = cipher.notes;
  } else if (field.source.type === "custom") {
    raw = list(cipher.fields)[field.source.index]?.value;
  } else {
    throw new Error("attachments are read as files");
  }
  const value = decryptOptional(raw, key);
  if (value === null) {
    throw new VaultProviderError("provider_not_found", `"${field.name}" has no value`);
  }
  return value;
}

export class WriteRefused extends Error {
  readonly code: "provider_conflict" | "provider_not_found" | "provider_permission_denied";
  constructor(code: WriteRefused["code"], message: string) {
    super(message);
    this.name = "WriteRefused";
    this.code = code;
  }
}

function customType(kind: VaultFieldKind): number {
  if (kind === "text") return FIELD_TEXT;
  if (kind === "concealed") return FIELD_HIDDEN;
  throw new WriteRefused(
    "provider_permission_denied",
    `Bitwarden custom fields hold text or hidden values, not ${kind}`,
  );
}

function checkTotp(value: string | undefined): string {
  if (value === undefined || !isValidTotpInput(value)) {
    throw new WriteRefused(
      "provider_conflict",
      "The one-time password seed is not a valid TOTP seed",
    );
  }
  return value;
}

function encryptedUri(uri: string, key: SymmetricKey): Json {
  return {
    uri: encryptString(uri, key),
    uriChecksum: encryptString(sha256B64(uri), key),
    match: null,
  };
}

/**
 * The cipher slot a field fills: a login's username, password or one-time
 * password by name and kind, or a card's, identity's or SSH key's standard
 * field by any of its names (whatever its kind).
 */
function slotFor(cipherType: unknown, field: { name: string; kind: VaultFieldKind }) {
  const slots = builtIns(cipherType);
  if (cipherType === CIPHER_LOGIN) {
    const wanted = nameKey(field.name);
    return slots.find((candidate) =>
      field.kind === "totp"
        ? candidate.kind === "totp"
        : candidate.kind === field.kind &&
          (nameKey(candidate.name) === wanted || nameKey(candidate.key) === wanted),
    );
  }
  const type = itemTypeOfCipher(cipherType);
  const standard = type ? standardVaultFieldName(type, field.name) : null;
  return standard ? slots.find((candidate) => candidate.name === standard) : undefined;
}

const CARD_EXPIRY_NAMES = new Set(["expiry date", "expiry", "expiration date", "expiration"]);

/** A card's one-value expiry ("12/2030"), split into its month and year slots. */
function cardExpiry(
  cipherType: unknown,
  field: { name: string; kind: VaultFieldKind; value?: string },
): { month: string; year: string } | null {
  if (cipherType !== CIPHER_CARD || !CARD_EXPIRY_NAMES.has(nameKey(field.name))) return null;
  return field.value === undefined ? null : parseCardExpiry(field.value);
}

function markerEntry(marker: string, key: SymmetricKey): Json {
  return {
    name: encryptString(VAULT_TYPE_MARKER_FIELD, key),
    value: encryptString(marker, key),
    type: FIELD_TEXT,
    linkedId: null,
  };
}

/** Bitwarden's apps need an SSH key's public key and fingerprint next to its private key. */
function checkSshKey(sshKey: Json | null) {
  if (!sshKey) return;
  if (!encrypted(sshKey.privateKey) || !encrypted(sshKey.publicKey)) {
    throw new WriteRefused(
      "provider_conflict",
      'A Bitwarden SSH key needs its "private key" and "public key"',
    );
  }
}

/** A new cipher body (`CipherRequestModel`), encrypted with the owner's key. */
export function createRequest(
  write: ProviderWriteItem,
  key: SymmetricKey,
  organizationId: string | null,
  encryptedFor: string,
): Json {
  const cipherType = cipherTypeFor(write.type);
  if (cipherType === null) {
    throw new WriteRefused(
      "provider_permission_denied",
      `Bitwarden cannot hold ${write.type} items`,
    );
  }
  const isLogin = cipherType === CIPHER_LOGIN;
  if (!isLogin && write.websites.length > 0) {
    throw new WriteRefused("provider_conflict", "Only Bitwarden logins have websites");
  }
  const sections: Record<BuiltIn["section"], Json | null> = {
    login: isLogin ? { uris: write.websites.map((uri) => encryptedUri(uri, key)) } : null,
    card: cipherType === CIPHER_CARD ? {} : null,
    identity: cipherType === CIPHER_IDENTITY ? {} : null,
    sshKey: cipherType === CIPHER_SSH_KEY ? {} : null,
  };
  for (const slot of builtIns(cipherType)) sections[slot.section]![slot.key] = null;
  let notes: string | null = null;
  const fields: Json[] = [];
  const names = new Set<string>();
  const marker = markerFor(write);
  if (marker) fields.push(markerEntry(marker, key));
  for (const field of write.fields) {
    if (field.remove || field.externalFieldId !== undefined) {
      throw new WriteRefused("provider_conflict", "A new item has no existing fields to change");
    }
    const name = nameKey(field.name);
    if (names.has(name)) {
      throw new WriteRefused("provider_conflict", `Two fields are named "${field.name}"`);
    }
    names.add(name);
    // Files become attachments once the item exists.
    if (field.kind === "file") continue;
    if (isItemTypeMarkerName(field.name)) {
      throw new WriteRefused("provider_conflict", `"${field.name}" is reserved for the item type`);
    }
    const value = field.value ?? "";
    const slot = slotFor(cipherType, field);
    const target = slot ? sections[slot.section]! : null;
    const expiry = cardExpiry(cipherType, field);
    if (slot && target && target[slot.key] === null) {
      target[slot.key] = encryptString(slot.kind === "totp" ? checkTotp(value) : value, key);
      if (slot.id === "login.password") target.passwordRevisionDate = new Date().toISOString();
    } else if (field.kind === "totp") {
      throw new WriteRefused(
        "provider_conflict",
        isLogin
          ? "Only one Bitwarden login field holds a one-time password"
          : "Only a Bitwarden login holds a one-time password",
      );
    } else if (expiry && sections.card!.expMonth === null && sections.card!.expYear === null) {
      sections.card!.expMonth = encryptString(expiry.month, key);
      sections.card!.expYear = encryptString(expiry.year, key);
    } else if ((name === "note" || name === "notes") && field.kind === "text" && notes === null) {
      notes = encryptString(value, key);
    } else {
      fields.push({
        name: encryptString(field.name, key),
        value: encryptString(value, key),
        type: customType(field.kind),
        linkedId: null,
      });
    }
  }
  checkSshKey(sections.sshKey);
  return {
    type: cipherType,
    organizationId,
    encryptedFor,
    folderId: null,
    favorite: false,
    reprompt: 0,
    key: null,
    name: encryptString(write.name, key),
    notes,
    fields,
    passwordHistory: [],
    login: sections.login,
    secureNote: cipherType === CIPHER_SECURE_NOTE ? { type: 0 } : null,
    card: sections.card,
    identity: sections.identity,
    sshKey: sections.sshKey,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Applies an Opengeni write to the current encrypted cipher and returns the
 * full `PUT /ciphers/{id}` body, for every item type: the name, notes, custom
 * fields and the type's own fields (a login's username, password and
 * one-time password, a card's or an identity's fields). Unchanged values are
 * sent back as the same encrypted strings, so passkeys, attachments, password
 * history, address match rules, linked fields and anything this mapping does
 * not model survive. `lastKnownRevisionDate` makes the server refuse the
 * update if the item changed in between.
 */
export function updateRequest(
  cipher: Json,
  ownerKey: SymmetricKey,
  write: ProviderWriteItem,
  encryptedFor: string,
): Json {
  const key = itemKey(cipher, ownerKey);
  const mapped = mapCipher(cipher, ownerKey);
  // A secure note stands for Opengeni notes, API keys and files alike.
  if (cipherTypeFor(write.type) !== cipher.type) {
    throw new WriteRefused(
      "provider_conflict",
      `This Bitwarden item is stored as a ${mapped.meta.type}; its type can't change`,
    );
  }
  const slots = builtIns(cipher.type);
  const sections = new Map<BuiltIn["section"], Json>();
  const section = (part: BuiltIn["section"]): Json => {
    let copy = sections.get(part);
    if (!copy) {
      copy = { ...(json(cipher[part]) ?? {}) };
      sections.set(part, copy);
    }
    return copy;
  };
  const login = cipher.type === CIPHER_LOGIN ? section("login") : null;
  const byId = new Map(mapped.fields.map((field) => [field.id, field]));
  const custom = new Map(customFields(cipher, key).map((field) => [field.id, field]));
  const names = new Set(mapped.fields.map((field) => nameKey(field.name)));
  let notes: unknown = cipher.notes ?? null;
  const fields = list(cipher.fields).map((field) => ({ ...field }));
  const removed = new Set<number>();
  const history = list(cipher.passwordHistory);
  const now = new Date().toISOString();
  let name: unknown = cipher.name;

  const setSlot = (slot: BuiltIn, value: string | null) => {
    const target = section(slot.section);
    if (slot.id === "login.password" && encrypted(target.password)) {
      history.unshift({ password: target.password, lastUsedDate: now });
    }
    target[slot.key] =
      value === null ? null : encryptString(slot.kind === "totp" ? checkTotp(value) : value, key);
    if (slot.id === "login.password" && value !== null) target.passwordRevisionDate = now;
  };

  if (decryptOptional(cipher.name, key) !== write.name) name = encryptString(write.name, key);
  if (login) {
    if (!sameList(mapped.meta.websites, write.websites)) {
      const current = new Map<string, Json>();
      for (const entry of list(login.uris)) {
        const uri = decryptOptional(entry.uri, key);
        if (uri !== null && !current.has(uri)) current.set(uri, entry);
      }
      // Kept addresses keep their match rule and checksum.
      login.uris = write.websites.map((uri) => current.get(uri) ?? encryptedUri(uri, key));
    }
  } else if (write.websites.length > 0) {
    throw new WriteRefused("provider_conflict", "Only Bitwarden logins have websites");
  }

  for (const field of write.fields) {
    const id = field.externalFieldId;
    // Attachments are added, replaced and removed by the provider after this update.
    if (field.kind === "file" || id?.startsWith(ATTACHMENT_FIELD_PREFIX)) continue;
    if (id === undefined) {
      const wanted = nameKey(field.name);
      if (names.has(wanted)) {
        throw new WriteRefused(
          "provider_conflict",
          `The item already has a field named "${field.name}"`,
        );
      }
      names.add(wanted);
      if (isItemTypeMarkerName(field.name)) {
        throw new WriteRefused(
          "provider_conflict",
          `"${field.name}" is reserved for the item type`,
        );
      }
      // A new field fills the type's own empty field of the same name (a
      // login's one-time password is the only TOTP field).
      const slot = slotFor(cipher.type, field);
      if (slot && !encrypted(section(slot.section)[slot.key])) {
        setSlot(slot, field.value ?? "");
        continue;
      }
      const expiry = cardExpiry(cipher.type, field);
      if (expiry && !encrypted(section("card").expMonth) && !encrypted(section("card").expYear)) {
        section("card").expMonth = encryptString(expiry.month, key);
        section("card").expYear = encryptString(expiry.year, key);
        continue;
      }
      if (field.kind === "totp") {
        throw new WriteRefused(
          "provider_conflict",
          login
            ? "This Bitwarden login already has a one-time password"
            : "Only a Bitwarden login holds a one-time password",
        );
      }
      if ((wanted === "note" || wanted === "notes") && field.kind === "text" && !encrypted(notes)) {
        notes = encryptString(field.value ?? "", key);
        continue;
      }
      fields.push({
        name: encryptString(field.name, key),
        value: encryptString(field.value ?? "", key),
        type: customType(field.kind),
        linkedId: null,
      });
      continue;
    }
    const slot = slots.find((candidate) => candidate.id === id);
    if (slot) {
      if (field.remove) setSlot(slot, null);
      else if (field.value !== undefined) setSlot(slot, field.value);
      continue;
    }
    if (id === NOTES_FIELD_ID) {
      if (field.remove) notes = null;
      else if (field.value !== undefined) notes = encryptString(field.value, key);
      continue;
    }
    const target = byId.get(id);
    const existing = custom.get(id);
    if (!existing || !target || target.source.type !== "custom") {
      throw new WriteRefused("provider_not_found", `The item has no field ${id}`);
    }
    if (field.remove) {
      removed.add(existing.index);
      continue;
    }
    const entry = fields[existing.index]!;
    if (nameKey(field.name) !== nameKey(target.name)) {
      if (names.has(nameKey(field.name))) {
        throw new WriteRefused(
          "provider_conflict",
          `The item already has a field named "${field.name}"`,
        );
      }
      names.delete(nameKey(target.name));
      names.add(nameKey(field.name));
      entry.name = encryptString(field.name, key);
    }
    if (field.kind !== target.kind) entry.type = customType(field.kind);
    if (field.value !== undefined) entry.value = encryptString(field.value, key);
  }

  // The item's type and category, where its cipher type does not say them.
  const marker = markerFor(write);
  if (mapped.markerIndex >= 0) {
    if (!marker) removed.add(mapped.markerIndex);
    else if (marker !== mapped.meta.type + (mapped.meta.category ? `/${mapped.meta.category}` : ""))
      fields[mapped.markerIndex]!.value = encryptString(marker, key);
  } else if (marker) {
    fields.push(markerEntry(marker, key));
  }
  if (cipher.type === CIPHER_SSH_KEY) checkSshKey(section("sshKey"));

  const sectionBody = (part: BuiltIn["section"] | "secureNote") =>
    (part !== "secureNote" ? sections.get(part) : undefined) ?? cipher[part] ?? null;
  return {
    type: cipher.type,
    organizationId: cipher.organizationId ?? null,
    encryptedFor,
    folderId: cipher.folderId ?? null,
    favorite: cipher.favorite === true,
    reprompt: typeof cipher.reprompt === "number" ? cipher.reprompt : 0,
    key: encrypted(cipher.key) ? cipher.key : null,
    name,
    notes,
    fields: fields.filter((_, index) => !removed.has(index)),
    passwordHistory: history.slice(0, PASSWORD_HISTORY_KEEP),
    login: sectionBody("login"),
    secureNote: sectionBody("secureNote"),
    card: sectionBody("card"),
    identity: sectionBody("identity"),
    sshKey: sectionBody("sshKey"),
    lastKnownRevisionDate: revisionOf(cipher),
    // Vaultwarden un-archives an item for this account when an update omits it.
    archivedDate: typeof cipher.archivedDate === "string" ? cipher.archivedDate : null,
  };
}

/** True when the error came from decrypting data rather than from the server. */
export function isCryptoError(error: unknown): error is BitwardenCryptoError {
  return error instanceof BitwardenCryptoError;
}
