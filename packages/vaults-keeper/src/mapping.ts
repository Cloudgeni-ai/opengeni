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
import type { KeeperFile, KeeperRecord } from "./sdk";

/**
 * External field ids are positional, because Keeper record fields have no
 * ids of their own: `f:<type>` for standard fields, `c:<label or type>` for
 * custom fields, `#n` for repeats, `@notes` for the record notes and
 * `@file:<fileUid>` for attachments.
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
  | { kind: "field"; list: "fields" | "custom"; index: number }
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
const API_KEY_TYPES = new Set([
  "serverCredentials",
  "databaseCredentials",
  "sshKeys",
  "softwareLicense",
  "pamDatabase",
  "pamMachine",
]);

export function itemTypeForRecordType(type: string | undefined): VaultItemType {
  if (type === "login") return "login";
  if (type === "encryptedNotes") return "note";
  if (type === "file") return "file";
  if (type && API_KEY_TYPES.has(type)) return "api_key";
  return "note";
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
  add(baseId: string, rawName: string, kind: VaultFieldKind, source: MappedSource, value: string) {
    const seen = (this.ids.get(baseId) ?? 0) + 1;
    this.ids.set(baseId, seen);
    this.fields.push({
      externalFieldId: seen === 1 ? baseId : `${baseId}#${seen}`,
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
  const lists: Array<["fields" | "custom", KeeperFieldEntry[]]> = [
    ["fields", Array.isArray(data.fields) ? data.fields : []],
    ["custom", Array.isArray(data.custom) ? data.custom : []],
  ];
  for (const [list, entries] of lists) {
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || typeof entry.type !== "string") return;
      const kind = kindFor(entry);
      if (!kind) return;
      const value = valueText(entry);
      if (entry.type === "url") {
        for (const url of Array.isArray(entry.value) ? entry.value : []) {
          if (typeof url === "string" && url.trim()) websites.push(url);
        }
      }
      // A one-time code field without a seed has nothing to compute.
      if (kind === "totp" && !value) return;
      const label = typeof entry.label === "string" && entry.label.trim() ? entry.label : "";
      const name =
        list === "fields" ? label || STANDARD_NAMES[entry.type] || entry.type : label || entry.type;
      const baseId = list === "fields" ? `f:${entry.type}` : `c:${label || entry.type}`;
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
      type: itemTypeForRecordType(typeof data.type === "string" ? data.type : undefined),
      websites,
      fields: collector.fields.map(({ externalFieldId, name, kind }) => ({
        externalFieldId,
        name,
        kind,
      })),
      version: Number.isFinite(record.revision) ? String(record.revision) : null,
      updatedAt: null,
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
    unavailable(`The value of "${field.name}" is larger than Opengeni stores`);
  }
  return value;
}

function totpValue(field: ProviderWriteField, label: string): string {
  const params = totpParamsFor(textValue(field));
  if (!params) unavailable(`"${field.name}" is not a TOTP seed or otpauth:// URI`);
  return totpUri(params, label);
}

function customEntry(field: ProviderWriteField, title: string): KeeperFieldEntry {
  if (field.kind === "file") unavailable("Keeper files cannot be written from Opengeni");
  if (field.kind === "totp")
    return { type: "oneTimeCode", label: field.name, value: [totpValue(field, title)] };
  return {
    type: field.kind === "concealed" ? "secret" : "text",
    label: field.name,
    value: [textValue(field)],
  };
}

/** Record data for a create; Keeper `login` and `encryptedNotes` record types only. */
export function buildCreateData(item: ProviderWriteItem): KeeperRecordData {
  const title = item.name;
  for (const field of item.fields) {
    if (field.remove) unavailable("A new Keeper record has no fields to remove");
  }
  if (item.type === "login") {
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
  if (item.type === "note") {
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
  return unavailable(
    item.type === "passkey"
      ? "Passkeys live only in Opengeni vaults"
      : item.type === "api_key"
        ? "Keeper has no API key record type; create a login or a secure note"
        : "Keeper file records cannot be created from Opengeni",
  );
}

function setEntryValue(entry: KeeperFieldEntry, field: ProviderWriteField, title: string) {
  if (field.kind === "file") unavailable("Keeper files cannot be written from Opengeni");
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
  const mapped = mapRecord(record).fields;
  const removals: number[] = [];
  for (const field of item.fields) {
    const target = field.externalFieldId
      ? mapped.find((candidate) => candidate.externalFieldId === field.externalFieldId)
      : mapped.find((candidate) => nameKey(candidate.name) === nameKey(field.name));
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
    if (source.kind === "file") unavailable("Keeper files cannot be changed from Opengeni");
    if (source.kind === "notes") {
      data.notes = field.remove ? "" : textValue(field);
      continue;
    }
    const entry = data[source.list]![source.index]!;
    if (field.remove) {
      if (source.list === "custom") removals.push(source.index);
      else entry.value = [];
      continue;
    }
    setEntryValue(entry, field, title);
  }
  for (const index of removals.sort((a, b) => b - a)) data.custom.splice(index, 1);
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
