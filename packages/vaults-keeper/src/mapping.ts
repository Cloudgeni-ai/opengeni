import { providerUsernameHint } from "@opengeni/vaults";
import {
  type ProviderItemMeta,
  type ProviderWriteField,
  type ProviderWriteItem,
  type TotpParams,
  VAULT_LIMITS,
  type VaultFieldKind,
  type VaultItemType,
  VaultProviderError,
  parseTotpInput,
} from "./contract";
import { nameKey, safeFieldName, safeSecretName, totpUri, uniqueName } from "./naming";
import { keeperPasskeyMetas } from "./passkeys";
import type { KeeperFile, KeeperRecord } from "./sdk";
import { standardVaultFieldName, vaultItemCategoryToken } from "@opengeni/contracts";
import {
  decodeItemTypeMarker,
  encodeItemTypeMarker,
  isItemTypeMarkerName,
  parseCardExpiry,
  VAULT_TYPE_MARKER_FIELD,
} from "@opengeni/vaults";

/**
 * External field ids are positional, because Keeper record fields have no
 * ids of their own: `f:<type>` for standard fields, `c:<label or type>` for
 * custom fields, `#n` for repeats, `.<property>` for one part of a
 * structured field (`f:paymentCard.cardNumber`), `@notes` for the record
 * notes and `@file:<fileUid>` for attachments.
 */
export const NOTES_FIELD_ID = "@notes";
export const FILE_FIELD_PREFIX = "@file:";

export interface KeeperFieldEntry {
  type: string;
  label?: string;
  value?: unknown[];
  [key: string]: unknown;
}
export interface KeeperRecordData {
  title?: string;
  type?: string;
  fields?: KeeperFieldEntry[];
  custom?: KeeperFieldEntry[];
  notes?: string;
  [key: string]: unknown;
}

export type MappedSource =
  | {
      kind: "field";
      list: "fields" | "custom";
      index: number;
      /** One property of a structured field's value object. */
      prop?: string;
      /** The month or year of a card's "MM/YYYY" expiration date. */
      part?: "month" | "year";
    }
  | { kind: "notes" }
  | { kind: "file"; file: KeeperFile };

export interface MappedKeeperField {
  externalFieldId: string;
  name: string;
  kind: VaultFieldKind;
  source: MappedSource;
  /** Plain value for text/concealed/totp fields; files are read separately. */
  value: string;
}

const CONCEALED_TYPES = new Set(["password", "secret", "pinCode", "note"]);
const TOTP_TYPES = new Set(["oneTimeCode", "otp"]);
const CONCEALED_COMPLEX = new Set(["paymentCard", "bankAccount", "keyPair", "securityQuestion"]);
const SKIPPED_TYPES = new Set(["fileRef", "passkey", "recordRef", "cardRef", "addressRef"]);
const DATE_TYPES = new Set(["date", "birthDate", "expirationDate"]);
const STANDARD_NAMES: Record<string, string> = {
  login: "username",
  password: "password",
  oneTimeCode: "one-time password",
  otp: "one-time password",
  url: "website",
  email: "email",
  note: "note",
  pinCode: "PIN",
};
/** Labels Keeper's own record types give standard fields, as Opengeni names them. */
const LABEL_NAMES: Record<string, string> = {
  cardholderName: "cardholder name",
  licenseNumber: "license number",
  accountNumber: "account number",
};

/**
 * The parts of Keeper's structured fields, as Opengeni names them. A field
 * whose value is one such object is read and written part by part; other
 * properties keep their own names, and a field with several values stays
 * one JSON value.
 */
const STRUCTURED_PARTS: Record<string, ReadonlyArray<readonly [string, string, boolean]>> = {
  paymentCard: [
    ["cardNumber", "number", true],
    ["cardExpirationDate", "expiration date", false],
    ["cardSecurityCode", "security code", true],
  ],
  keyPair: [
    ["privateKey", "private key", true],
    ["publicKey", "public key", false],
  ],
  name: [
    ["first", "first name", false],
    ["middle", "middle name", false],
    ["last", "last name", false],
  ],
  address: [
    ["street1", "address 1", false],
    ["street2", "address 2", false],
    ["city", "city", false],
    ["state", "state", false],
    ["zip", "postal code", false],
    ["country", "country", false],
  ],
  host: [
    ["hostName", "hostname", false],
    ["port", "port", false],
  ],
  bankAccount: [
    ["accountType", "account type", false],
    ["routingNumber", "routing number", false],
    ["accountNumber", "account number", true],
    ["otherType", "other type", false],
  ],
  phone: [
    ["number", "phone", false],
    ["ext", "phone extension", false],
    ["region", "phone region", false],
    ["type", "phone type", false],
  ],
  securityQuestion: [
    ["question", "security question", false],
    ["answer", "security answer", true],
  ],
};

/**
 * Keeper record types as Opengeni types and categories. Records Opengeni
 * creates use the first record type of their pair that has a template (see
 * `RECORD_TEMPLATES`); any other pair is stored as its type's own record
 * type with the `opengeni.type` marker. A record type this table does not
 * name is a note with its record type as the category.
 */
const RECORD_KINDS: ReadonlyArray<readonly [string, VaultItemType, string | null]> = [
  ["login", "login", null],
  ["encryptedNotes", "note", null],
  ["file", "file", null],
  ["bankCard", "card", null],
  ["contact", "identity", null],
  ["sshKeys", "ssh_key", null],
  ["address", "identity", "address"],
  ["serverCredentials", "api_key", "server"],
  ["databaseCredentials", "api_key", "database"],
  ["softwareLicense", "api_key", "software_license"],
  ["wifiCredentials", "api_key", "wifi"],
  ["pamDatabase", "api_key", "pam_database"],
  ["pamMachine", "api_key", "pam_machine"],
  ["pamDirectory", "api_key", "pam_directory"],
  ["pamUser", "login", "pam_user"],
  ["general", "login", "general"],
  ["bankAccount", "note", "bank_account"],
  ["membership", "note", "membership"],
  ["passport", "note", "passport"],
  ["driverLicense", "note", "driver_license"],
  ["healthInsurance", "note", "health_insurance"],
  ["birthCertificate", "note", "birth_certificate"],
  ["ssnCard", "note", "national_id"],
  ["photo", "file", "photo"],
];

/** The record type each Opengeni type is stored as when no exact pair has a template. */
const BASE_RECORD_TYPES: Partial<Record<VaultItemType, string>> = {
  login: "login",
  note: "encryptedNotes",
  api_key: "encryptedNotes",
  card: "bankCard",
  identity: "contact",
  ssh_key: "sshKeys",
};

/** The standard fields of the record types Opengeni creates, in Keeper's own order. */
const RECORD_TEMPLATES: Record<string, () => KeeperFieldEntry[]> = {
  login: () => [
    { type: "login", value: [] },
    { type: "password", value: [] },
    { type: "url", value: [] },
    { type: "fileRef", value: [] },
    { type: "oneTimeCode", value: [] },
  ],
  encryptedNotes: () => [
    { type: "note", value: [] },
    { type: "date", value: [] },
  ],
  bankCard: () => [
    { type: "paymentCard", value: [] },
    { type: "text", label: "cardholderName", value: [] },
    { type: "pinCode", value: [] },
    { type: "addressRef", value: [] },
  ],
  contact: () => [
    { type: "name", value: [] },
    { type: "text", label: "company", value: [] },
    { type: "email", value: [] },
    { type: "phone", value: [] },
    { type: "addressRef", value: [] },
  ],
  address: () => [{ type: "address", value: [] }],
  sshKeys: () => [
    { type: "login", value: [] },
    { type: "keyPair", value: [] },
    { type: "host", value: [] },
    { type: "password", value: [] },
    { type: "fileRef", value: [] },
  ],
  serverCredentials: () => [
    { type: "host", value: [] },
    { type: "login", value: [] },
    { type: "password", value: [] },
    { type: "fileRef", value: [] },
  ],
  databaseCredentials: () => [
    { type: "text", label: "type", value: [] },
    { type: "host", value: [] },
    { type: "login", value: [] },
    { type: "password", value: [] },
    { type: "fileRef", value: [] },
  ],
};

/** The Opengeni type and category of a Keeper record type. */
export function itemKindForRecordType(type: string | undefined): {
  type: VaultItemType;
  category: string | null;
} {
  const known = RECORD_KINDS.find(([recordType]) => recordType === type);
  if (known) return { type: known[1], category: known[2] };
  return { type: "note", category: type ? vaultItemCategoryToken(type) : null };
}

export function itemTypeForRecordType(type: string | undefined): VaultItemType {
  return itemKindForRecordType(type).type;
}

/**
 * The record type an item is created as, and the `opengeni.type` marker it
 * needs when that record type does not already say its type and category.
 * Null when Keeper cannot hold the type from here.
 */
export function recordTypeForItem(
  type: VaultItemType,
  category: string | null | undefined,
): { recordType: string; marker: string | null } | null {
  const exact = RECORD_KINDS.find(
    ([recordType, kindType, kindCategory]) =>
      kindType === type && kindCategory === (category ?? null) && RECORD_TEMPLATES[recordType],
  );
  if (exact) return { recordType: exact[0], marker: null };
  const base = BASE_RECORD_TYPES[type];
  if (!base) return null;
  return { recordType: base, marker: encodeItemTypeMarker({ type, category: category ?? null }) };
}

/** A marker may say more than the record type, never something else, except a note may hold an API key. */
function markerFits(native: VaultItemType, marked: VaultItemType): boolean {
  return native === marked || (native === "note" && marked === "api_key");
}

function isMarkerEntry(entry: KeeperFieldEntry): boolean {
  return typeof entry.label === "string" && isItemTypeMarkerName(entry.label);
}

function markerOf(data: KeeperRecordData): string | null {
  const entry = (Array.isArray(data.custom) ? data.custom : []).find(isMarkerEntry);
  const value = Array.isArray(entry?.value) ? entry.value[0] : undefined;
  return typeof value === "string" ? value : null;
}

/** The record's Opengeni type and category, its marker included. */
export function itemKindForRecord(data: KeeperRecordData): {
  type: VaultItemType;
  category: string | null;
} {
  const native = itemKindForRecordType(typeof data.type === "string" ? data.type : undefined);
  const marker = decodeItemTypeMarker(markerOf(data));
  return marker && markerFits(native.type, marker.type) ? marker : native;
}

function setMarker(data: KeeperRecordData, marker: string | null): void {
  const custom = (Array.isArray(data.custom) ? data.custom : []).filter(
    (entry) => !isMarkerEntry(entry),
  );
  if (marker) custom.push({ type: "text", label: VAULT_TYPE_MARKER_FIELD, value: [marker] });
  data.custom = custom;
}

interface StructuredPart {
  prop: string;
  name: string;
  concealed: boolean;
  part?: "month" | "year";
  value: string;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const part of Object.values(record)) {
    if (part !== undefined && part !== null && typeof part !== "string" && typeof part !== "number")
      return null;
  }
  return record;
}

function expiryParts(value: string): { month: string; year: string } {
  // Keeper's own "MM/YYYY", also with one part still empty.
  const own = /^\s*(\d{0,2})\s*\/\s*(\d{0,4})\s*$/.exec(value);
  if (own) {
    const year = own[2] ?? "";
    return {
      month: own[1] ? String(Number(own[1])) : "",
      year: year.length === 2 ? `20${year}` : year,
    };
  }
  const parsed = value ? parseCardExpiry(value) : null;
  return parsed ?? { month: "", year: "" };
}

/**
 * The parts of a structured field with at most one value, or null when the
 * field is a scalar or holds several values.
 */
function structuredParts(entry: KeeperFieldEntry): StructuredPart[] | null {
  const known = STRUCTURED_PARTS[entry.type];
  if (!known) return null;
  const values = Array.isArray(entry.value) ? entry.value : [];
  if (values.length > 1) return null;
  const object = values.length === 1 ? plainObject(values[0]) : {};
  if (!object) return null;
  const out: StructuredPart[] = [];
  const text = (prop: string) => {
    const value = object[prop];
    return value === undefined || value === null ? "" : String(value);
  };
  for (const [prop, name, concealed] of known) {
    if (entry.type === "paymentCard" && prop === "cardExpirationDate") {
      const expiry = expiryParts(text(prop));
      out.push({ prop, name: "expiry month", concealed, part: "month", value: expiry.month });
      out.push({ prop, name: "expiry year", concealed, part: "year", value: expiry.year });
      continue;
    }
    out.push({ prop, name, concealed, value: text(prop) });
  }
  for (const prop of Object.keys(object)) {
    if (known.some(([knownProp]) => knownProp === prop)) continue;
    const name = (vaultItemCategoryToken(prop) ?? prop).replace(/_/g, " ");
    out.push({ prop, name, concealed: CONCEALED_COMPLEX.has(entry.type), value: text(prop) });
  }
  return out;
}

function cardExpiry(month: string, year: string): string {
  if (!month && !year) return "";
  return `${month ? month.padStart(2, "0") : ""}/${year}`;
}

/** Sets one part of a structured field, keeping the others. */
function setStructuredPart(
  entry: KeeperFieldEntry,
  prop: string,
  part: "month" | "year" | undefined,
  value: string,
): void {
  const values = Array.isArray(entry.value) ? entry.value : [];
  const object: Record<string, unknown> = { ...(plainObject(values[0]) ?? {}) };
  if (Object.keys(object).length === 0) {
    for (const [knownProp] of STRUCTURED_PARTS[entry.type] ?? []) object[knownProp] = "";
  }
  if (part) {
    const current = expiryParts(typeof object[prop] === "string" ? (object[prop] as string) : "");
    const month = part === "month" ? value : current.month;
    const year = part === "year" ? value : current.year;
    object[prop] = cardExpiry(month, year);
  } else {
    object[prop] = value;
  }
  entry.value = [object];
}

function kindFor(entry: KeeperFieldEntry): VaultFieldKind | null {
  if (SKIPPED_TYPES.has(entry.type)) return null;
  if (TOTP_TYPES.has(entry.type)) return "totp";
  if (CONCEALED_TYPES.has(entry.type) || CONCEALED_COMPLEX.has(entry.type)) return "concealed";
  return "text";
}

function valueText(entry: KeeperFieldEntry): string {
  const values = Array.isArray(entry.value) ? entry.value : [];
  if (values.length === 0) return "";
  if (DATE_TYPES.has(entry.type) && typeof values[0] === "number") {
    const date = new Date(values[0]);
    return Number.isNaN(date.getTime()) ? String(values[0]) : date.toISOString();
  }
  if (
    values.length === 1 &&
    (typeof values[0] === "string" ||
      typeof values[0] === "number" ||
      typeof values[0] === "boolean")
  ) {
    return String(values[0]);
  }
  return JSON.stringify(values.length === 1 ? values[0] : values);
}

class Collector {
  readonly fields: MappedKeeperField[] = [];
  private readonly names = new Set<string>();
  private readonly ids = new Map<string, number>();
  /** The next positional id for a base id: the first is the base id itself, then `#2`, `#3`. */
  nextId(baseId: string): string {
    const seen = (this.ids.get(baseId) ?? 0) + 1;
    this.ids.set(baseId, seen);
    return seen === 1 ? baseId : `${baseId}#${seen}`;
  }
  add(baseId: string, rawName: string, kind: VaultFieldKind, source: MappedSource, value: string) {
    this.push(this.nextId(baseId), rawName, kind, source, value);
  }
  push(
    externalFieldId: string,
    rawName: string,
    kind: VaultFieldKind,
    source: MappedSource,
    value: string,
  ) {
    this.fields.push({
      externalFieldId,
      name: uniqueName(safeFieldName(rawName, "field"), this.names),
      kind,
      source,
      value,
    });
  }
}

export interface MappedKeeperRecord {
  meta: ProviderItemMeta;
  fields: MappedKeeperField[];
}

export function recordData(record: KeeperRecord): KeeperRecordData {
  const data = record.data as unknown;
  return data && typeof data === "object" ? (data as KeeperRecordData) : {};
}

export function mapRecord(record: KeeperRecord): MappedKeeperRecord {
  const data = recordData(record);
  const collector = new Collector();
  const websites: string[] = [];
  const itemKind = itemKindForRecord(data);
  // A note record holding an API key shows only the key's own fields.
  const retyped =
    itemKind.type !==
    itemKindForRecordType(typeof data.type === "string" ? data.type : undefined).type;
  const lists: Array<["fields" | "custom", KeeperFieldEntry[]]> = [
    ["fields", Array.isArray(data.fields) ? data.fields : []],
    ["custom", Array.isArray(data.custom) ? data.custom : []],
  ];
  for (const [list, entries] of lists) {
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || typeof entry.type !== "string") return;
      if (list === "custom" && isMarkerEntry(entry)) return;
      if (retyped && list === "fields" && valueText(entry) === "") return;
      const kind = kindFor(entry);
      if (!kind) return;
      if (entry.type === "url") {
        for (const url of Array.isArray(entry.value) ? entry.value : []) {
          if (typeof url === "string" && url.trim()) websites.push(url);
        }
      }
      const label = typeof entry.label === "string" && entry.label.trim() ? entry.label : "";
      const baseId = list === "fields" ? `f:${entry.type}` : `c:${label || entry.type}`;
      const parts = structuredParts(entry);
      if (parts) {
        // A labelled custom field names its parts after itself: "home city".
        const prefix = list === "custom" && label ? `${label} ` : "";
        const entryId = collector.nextId(baseId);
        for (const part of parts) {
          collector.push(
            `${entryId}.${part.prop}${part.part ? `:${part.part}` : ""}`,
            `${prefix}${part.name}`,
            part.concealed ? "concealed" : "text",
            {
              kind: "field",
              list,
              index,
              prop: part.prop,
              ...(part.part ? { part: part.part } : {}),
            },
            part.value,
          );
        }
        return;
      }
      const value = valueText(entry);
      // A one-time code field without a seed has nothing to compute.
      if (kind === "totp" && !value) return;
      const name =
        list === "fields"
          ? LABEL_NAMES[label] || label || STANDARD_NAMES[entry.type] || entry.type
          : label || entry.type;
      collector.add(baseId, name, kind, { kind: "field", list, index }, value);
    });
  }
  if (typeof data.notes === "string" && data.notes) {
    collector.add(NOTES_FIELD_ID, "notes", "concealed", { kind: "notes" }, data.notes);
  }
  for (const file of record.files ?? []) {
    const fileData = (file.data ?? {}) as { title?: unknown; name?: unknown };
    const name =
      (typeof fileData.title === "string" && fileData.title) ||
      (typeof fileData.name === "string" && fileData.name) ||
      "file";
    collector.add(`${FILE_FIELD_PREFIX}${file.fileUid}`, name, "file", { kind: "file", file }, "");
  }
  return {
    meta: {
      externalItemId: record.recordUid,
      name: safeSecretName(typeof data.title === "string" ? data.title : "", record.recordUid),
      type: itemKind.type,
      ...(itemKind.category ? { category: itemKind.category } : {}),
      username: providerUsernameHint(
        collector.fields.find(
          (field) => field.externalFieldId === "f:login" && field.kind === "text",
        )?.value,
      ),
      websites,
      fields: collector.fields.map(({ externalFieldId, name, kind }) => ({
        externalFieldId,
        name,
        kind,
      })),
      version: Number.isFinite(record.revision) ? String(record.revision) : null,
      updatedAt: null,
      passkeys: keeperPasskeyMetas(record),
    },
    fields: collector.fields,
  };
}

/** The record's file size as Keeper reports it, if any. */
export function fileSize(file: KeeperFile): number | null {
  const size = (file.data as { size?: unknown } | undefined)?.size;
  return typeof size === "number" && size >= 0 ? size : null;
}

export function totpParamsFor(value: string): TotpParams | null {
  try {
    return parseTotpInput(value);
  } catch {
    return null;
  }
}

function unavailable(message: string): never {
  throw new VaultProviderError("provider_unavailable", message);
}

function textValue(field: ProviderWriteField): string {
  const value = field.value ?? "";
  if (Buffer.byteLength(value, "utf8") > VAULT_LIMITS.textValueMaxBytes) {
    unavailable(`The value of "${field.name}" is larger than can be stored`);
  }
  return value;
}

function totpValue(field: ProviderWriteField, label: string): string {
  const params = totpParamsFor(textValue(field));
  if (!params) unavailable(`"${field.name}" is not a TOTP seed or otpauth:// URI`);
  return totpUri(params, label);
}

function customEntry(field: ProviderWriteField, title: string): KeeperFieldEntry {
  if (field.kind === "file") unavailable("Keeper files cannot be written from here");
  if (field.kind === "totp")
    return { type: "oneTimeCode", label: field.name, value: [totpValue(field, title)] };
  return {
    type: field.kind === "concealed" ? "secret" : "text",
    label: field.name,
    value: [textValue(field)],
  };
}

/** Where a write field goes in a record template. */
interface TemplateSlot {
  entry: number;
  prop?: string;
  part?: "month" | "year";
}

/** The template's standard slots by Opengeni field name (lower-cased). */
function templateSlots(fields: KeeperFieldEntry[]): Map<string, TemplateSlot> {
  const slots = new Map<string, TemplateSlot>();
  fields.forEach((entry, index) => {
    if (SKIPPED_TYPES.has(entry.type)) return;
    const parts = structuredParts(entry);
    if (parts) {
      for (const part of parts) {
        slots.set(nameKey(part.name), {
          entry: index,
          prop: part.prop,
          ...(part.part ? { part: part.part } : {}),
        });
      }
      return;
    }
    const label = typeof entry.label === "string" ? entry.label : "";
    const name = LABEL_NAMES[label] || label || STANDARD_NAMES[entry.type] || entry.type;
    slots.set(nameKey(name), { entry: index });
  });
  return slots;
}

const EXPIRY_NAMES = new Set(["expiry date", "expiration date", "expiry", "expires"]);

/**
 * Record data for a create, as the record type `recordTypeForItem` picks:
 * standard fields fill the template's own slots, everything else becomes a
 * custom field.
 */
export function buildCreateData(item: ProviderWriteItem): KeeperRecordData {
  for (const field of item.fields) {
    if (field.remove) unavailable("A new Keeper record has no fields to remove");
  }
  const target = recordTypeForItem(item.type, item.category);
  if (!target) {
    // Core refuses these first (`createItemTypes`); kept for direct callers.
    unavailable(
      item.type === "passkey"
        ? "Passkeys live only in workspace-hosted vaults"
        : "Keeper file records cannot be created from here",
    );
  }
  const data =
    target.recordType === "login" && item.type === "login"
      ? buildLoginData(item)
      : target.recordType === "encryptedNotes" && item.type === "note"
        ? buildNoteData(item)
        : buildTemplateData(item, target.recordType);
  setMarker(data, target.marker);
  return data;
}

function buildTemplateData(item: ProviderWriteItem, recordType: string): KeeperRecordData {
  const title = item.name;
  const fields = RECORD_TEMPLATES[recordType]!();
  const slots = templateSlots(fields);
  const filled = new Set<string>();
  const custom: KeeperFieldEntry[] = [];
  for (const field of item.fields) {
    if (field.kind === "file") unavailable("Keeper files cannot be written from here");
    const standard = standardVaultFieldName(item.type, field.name) ?? field.name;
    const key = nameKey(standard);
    if (item.type === "card" && EXPIRY_NAMES.has(key)) {
      const expiry = parseCardExpiry(textValue(field));
      const month = slots.get("expiry month");
      if (expiry && month && !filled.has("expiry month") && !filled.has("expiry year")) {
        setStructuredPart(fields[month.entry]!, month.prop!, "month", expiry.month);
        setStructuredPart(fields[month.entry]!, month.prop!, "year", expiry.year);
        filled.add("expiry month").add("expiry year");
        continue;
      }
    }
    const slot = slots.get(key);
    if (!slot || filled.has(key)) {
      custom.push(customEntry(field, title));
      continue;
    }
    filled.add(key);
    const entry = fields[slot.entry]!;
    if (slot.prop) setStructuredPart(entry, slot.prop, slot.part, textValue(field));
    else if (TOTP_TYPES.has(entry.type) || field.kind === "totp")
      entry.value = [totpValue(field, title)];
    else entry.value = [textValue(field)];
  }
  for (const url of item.websites.filter((candidate) => candidate.trim().length > 0)) {
    custom.push({ type: "url", label: "website", value: [url] });
  }
  return { type: recordType, title, notes: "", fields, custom };
}

function buildLoginData(item: ProviderWriteItem): KeeperRecordData {
  const title = item.name;
  let login: string | null = null;
  let password: string | null = null;
  let otp: string | null = null;
  const custom: KeeperFieldEntry[] = [];
  const concealed = item.fields.filter((field) => field.kind === "concealed");
  for (const field of item.fields) {
    const key = nameKey(field.name);
    if (field.kind === "text" && key === "username" && login === null) login = textValue(field);
    else if (
      field.kind === "concealed" &&
      password === null &&
      (key === "password" || concealed.length === 1)
    ) {
      password = textValue(field);
    } else if (field.kind === "totp" && otp === null) otp = totpValue(field, title);
    else custom.push(customEntry(field, title));
  }
  const [first, ...rest] = item.websites.filter((url) => url.trim().length > 0);
  for (const url of rest) custom.push({ type: "url", label: "website", value: [url] });
  return {
    type: "login",
    title,
    notes: "",
    fields: [
      { type: "login", value: login === null ? [] : [login] },
      { type: "password", value: password === null ? [] : [password] },
      { type: "url", value: first ? [first] : [] },
      { type: "fileRef", value: [] },
      { type: "oneTimeCode", value: otp === null ? [] : [otp] },
    ],
    custom,
  };
}

function buildNoteData(item: ProviderWriteItem): KeeperRecordData {
  const title = item.name;
  let note: string | null = null;
  const custom: KeeperFieldEntry[] = [];
  for (const field of item.fields) {
    if (note === null && (field.kind === "text" || field.kind === "concealed"))
      note = textValue(field);
    else custom.push(customEntry(field, title));
  }
  return {
    type: "encryptedNotes",
    title,
    notes: "",
    fields: [
      { type: "note", value: note === null ? [] : [note] },
      { type: "date", value: [] },
    ],
    custom,
  };
}

function setEntryValue(
  entry: KeeperFieldEntry,
  source: Extract<MappedSource, { kind: "field" }>,
  field: ProviderWriteField,
  title: string,
) {
  if (field.kind === "file") unavailable("Keeper files cannot be written from here");
  if (source.prop) {
    setStructuredPart(entry, source.prop, source.part, textValue(field));
    return;
  }
  if (TOTP_TYPES.has(entry.type)) {
    entry.value = [totpValue(field, title)];
    return;
  }
  const current = Array.isArray(entry.value) ? entry.value : [];
  const scalar = current.length <= 1 && (current.length === 0 || typeof current[0] === "string");
  if (!scalar || CONCEALED_COMPLEX.has(entry.type) || DATE_TYPES.has(entry.type)) {
    unavailable(`"${field.name}" is a structured Keeper field; edit it in Keeper`);
  }
  entry.value = [field.kind === "totp" ? totpValue(field, title) : textValue(field)];
}

/**
 * Applies a field patch to a fetched record in place. Untouched fields are
 * preserved; custom fields can be removed, standard fields are emptied.
 */
export function applyPatch(record: KeeperRecord, item: ProviderWriteItem): void {
  const data = recordData(record);
  data.fields = Array.isArray(data.fields) ? data.fields : [];
  data.custom = Array.isArray(data.custom) ? data.custom : [];
  const title = item.name;
  const marker = markerForPatch(data, item);
  const mapped = mapRecord(record).fields;
  const removals: number[] = [];
  for (const field of item.fields) {
    const standard = standardVaultFieldName(item.type, field.name);
    const target = field.externalFieldId
      ? mapped.find((candidate) => candidate.externalFieldId === field.externalFieldId)
      : (mapped.find((candidate) => nameKey(candidate.name) === nameKey(field.name)) ??
        (standard
          ? mapped.find((candidate) => nameKey(candidate.name) === nameKey(standard))
          : undefined));
    if (field.externalFieldId && !target) {
      throw new VaultProviderError(
        "provider_not_found",
        `The Keeper record has no field ${field.externalFieldId}`,
      );
    }
    if (!target) {
      if (field.remove) continue;
      data.custom.push(customEntry(field, title));
      continue;
    }
    const source = target.source;
    if (source.kind === "file") unavailable("Keeper files cannot be changed from here");
    if (source.kind === "notes") {
      data.notes = field.remove ? "" : textValue(field);
      continue;
    }
    const entry = data[source.list]![source.index]!;
    if (field.remove) {
      if (source.prop) setStructuredPart(entry, source.prop, source.part, "");
      else if (source.list === "custom") removals.push(source.index);
      else entry.value = [];
      continue;
    }
    setEntryValue(entry, source, field, title);
  }
  for (const index of removals.sort((a, b) => b - a)) data.custom.splice(index, 1);
  setMarker(data, marker);
  data.title = title;
  const websites = item.websites.filter((url) => url.trim().length > 0);
  const current = mapRecord(record).meta.websites;
  if (JSON.stringify(websites) !== JSON.stringify(current)) {
    const standard = data.fields.find((entry) => entry.type === "url");
    data.custom = data.custom.filter(
      (entry) => !(entry.type === "url" && entry.label === "website"),
    );
    const [first, ...rest] = websites;
    if (standard) standard.value = first ? [first] : [];
    else if (first) rest.unshift(first);
    for (const url of rest) data.custom.push({ type: "url", label: "website", value: [url] });
  }
}

/**
 * The marker a patched record keeps. A record keeps its record type: a write
 * that needs another one is refused, so nothing is silently re-typed.
 */
function markerForPatch(data: KeeperRecordData, item: ProviderWriteItem): string | null {
  const own = itemKindForRecord(data);
  if (own.type === item.type && own.category === (item.category ?? null)) return markerOf(data);
  const native = itemKindForRecordType(typeof data.type === "string" ? data.type : undefined);
  if (native.type === item.type && native.category === (item.category ?? null)) return null;
  const target = recordTypeForItem(item.type, item.category);
  if (!target || target.recordType !== data.type) {
    throw new VaultProviderError(
      "provider_conflict",
      `Keeper cannot change a ${String(data.type)} record into ${target ? `a ${target.recordType} record` : `a ${item.type} item`}; save it as a new item instead`,
    );
  }
  return target.marker;
}
