import { standardVaultFieldName, vaultItemCategoryToken } from "@opengeni/contracts";
import {
  VAULT_TYPE_MARKER_FIELD,
  decodeItemTypeMarker,
  encodeItemTypeMarker,
  isItemTypeMarkerName,
  providerUsernameHint,
} from "@opengeni/vaults";
import {
  type ProviderFieldMeta,
  type ProviderItemMeta,
  type ProviderWriteItem,
  type VaultFieldKind,
  type VaultItemType,
  VaultProviderError,
} from "./contract";
import type { SdkItem, SdkItemCreateParams, SdkItemField, SdkWebsite } from "./sdk";
import type { SdkFileCreateParams } from "./sdk";

/** External field ids that do not name an SDK `fields[]` entry. */
export const NOTES_FIELD_ID = "@notes";
export const DOCUMENT_FIELD_ID = "@document";
export const FILE_FIELD_PREFIX = "@file:";
/** An SSH key field's public key or fingerprint, which 1Password derives itself. */
export const SSH_DETAIL_SEPARATOR = "#";
/** Section used for custom fields that Opengeni adds to 1Password items. */
export const OPENGENI_SECTION_ID = "opengeni";

/**
 * Every 1Password category as an Opengeni type and category. The first entry
 * of a type is its plain form; each pair is unique, so an item reads back as
 * the category it was written as.
 */
const CATEGORY_KINDS: ReadonlyArray<readonly [string, VaultItemType, string | null]> = [
  ["Login", "login", null],
  ["SecureNote", "note", null],
  ["Document", "file", null],
  ["ApiCredentials", "api_key", null],
  ["CreditCard", "card", null],
  ["Identity", "identity", null],
  ["SshKey", "ssh_key", null],
  ["Password", "api_key", "password"],
  ["Server", "api_key", "server"],
  ["Database", "api_key", "database"],
  ["Router", "api_key", "wifi"],
  ["Email", "api_key", "email_account"],
  ["SoftwareLicense", "api_key", "software_license"],
  ["CryptoWallet", "api_key", "crypto_wallet"],
  ["Person", "identity", "person"],
  ["BankAccount", "note", "bank_account"],
  ["DriverLicense", "note", "driver_license"],
  ["MedicalRecord", "note", "medical_record"],
  ["Membership", "note", "membership"],
  ["OutdoorLicense", "note", "outdoor_license"],
  ["Passport", "note", "passport"],
  ["Rewards", "note", "reward_program"],
  ["SocialSecurityNumber", "note", "national_id"],
];

/** The Opengeni type and category of a 1Password category. */
export function itemKindForCategory(category: string): {
  type: VaultItemType;
  category: string | null;
} {
  const known = CATEGORY_KINDS.find(([name]) => name === category);
  if (known) return { type: known[1], category: known[2] };
  // A category this SDK version does not name: generic fields, kept as a note.
  return { type: "note", category: vaultItemCategoryToken(category) };
}

export function itemTypeForCategory(category: string): VaultItemType {
  return itemKindForCategory(category).type;
}

/**
 * The 1Password category an item is stored as, and whether its Opengeni
 * category needs the `opengeni.type` marker field because 1Password has no
 * category for it (for example an `api_key` with category "health_insurance").
 */
export function categoryForItem(
  type: VaultItemType,
  category: string | null | undefined,
): { category: string; marker: string | null } {
  if (type === "passkey") {
    throw new VaultProviderError(
      "provider_unavailable",
      "1Password service accounts cannot store passkeys; keep passkeys in a workspace-hosted vault",
    );
  }
  const exact = CATEGORY_KINDS.find(
    ([, kindType, kindCategory]) => kindType === type && kindCategory === (category ?? null),
  );
  if (exact) return { category: exact[0], marker: null };
  const plain = CATEGORY_KINDS.find(([, kindType]) => kindType === type)!;
  return { category: plain[0], marker: encodeItemTypeMarker({ type, category: category ?? null }) };
}

export function categoryForItemType(type: VaultItemType): string {
  return categoryForItem(type, null).category;
}

export function fieldKindForSdkType(fieldType: string): VaultFieldKind | null {
  switch (fieldType) {
    case "Concealed":
    case "CreditCardNumber":
    case "SshKey":
      return "concealed";
    case "Totp":
      return "totp";
    case "Unsupported":
      // Passkeys and other fields the SDK cannot edit; `put` preserves them.
      return null;
    default:
      return "text";
  }
}

function sdkTypeForKind(kind: VaultFieldKind): string {
  if (kind === "text") return "Text";
  if (kind === "totp") return "Totp";
  if (kind === "concealed") return "Concealed";
  throw new VaultProviderError(
    "provider_unavailable",
    "Writing file fields to 1Password from here is not supported yet",
  );
}

// Mirrors contracts isValidSecretName (Q-10): no / { } # \ or control chars,
// trimmed, 1..120 chars, not "id:…"; field names additionally may not be "otp".
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[/{}#\\\u0000-\u001f\u007f]/g;

export function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

export function safeSecretName(raw: string, fallback: string): string {
  let name = raw.replace(FORBIDDEN_NAME_CHARS, "-").trim().slice(0, 120).trim();
  if (!name) name = fallback.replace(FORBIDDEN_NAME_CHARS, "-").trim().slice(0, 120) || "item";
  if (/^id:/i.test(name)) name = `id-${name.slice(3)}`;
  return name;
}

function safeFieldName(raw: string, fallback: string): string {
  const name = safeSecretName(raw, fallback);
  return nameKey(name) === "otp" ? "otp-code" : name;
}

/** Appends " (2)", " (3)" … so names are unique case-insensitively. */
export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(nameKey(candidate)); n += 1) {
    const suffix = ` (${n})`;
    candidate = `${name.slice(0, 120 - suffix.length)}${suffix}`;
  }
  taken.add(nameKey(candidate));
  return candidate;
}

export type MappedField =
  | (ProviderFieldMeta & { source: "field"; field: SdkItemField })
  | (ProviderFieldMeta & {
      source: "sshDetail";
      field: SdkItemField;
      part: "publicKey" | "fingerprint";
    })
  | (ProviderFieldMeta & { source: "notes" })
  | (ProviderFieldMeta & {
      source: "file";
      file: { name: string; id: string; size: number };
    });

/** The `opengeni.type` marker field Opengeni added, if the item has one. */
function markerField(item: Pick<SdkItem, "fields">): SdkItemField | undefined {
  return item.fields.find(
    (field) => field.sectionId === OPENGENI_SECTION_ID && isItemTypeMarkerName(field.title),
  );
}

function sshDetails(field: SdkItemField): { publicKey?: string; fingerprint?: string } | null {
  if (field.fieldType !== "SshKey" || field.details?.type !== "SshKey") return null;
  const content = field.details.content as { publicKey?: unknown; fingerprint?: unknown } | null;
  return {
    ...(typeof content?.publicKey === "string" && content.publicKey
      ? { publicKey: content.publicKey }
      : {}),
    ...(typeof content?.fingerprint === "string" && content.fingerprint
      ? { fingerprint: content.fingerprint }
      : {}),
  };
}

function fieldExternalId(field: SdkItemField, duplicateIds: Set<string>): string {
  return duplicateIds.has(field.id) && field.sectionId
    ? `${field.sectionId}.${field.id}`
    : field.id;
}

/** Deterministic projection of an item's fields; values are never copied out. */
export function mapItemFields(item: SdkItem): MappedField[] {
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const field of item.fields) {
    if (seen.has(field.id)) duplicateIds.add(field.id);
    seen.add(field.id);
  }
  const taken = new Set<string>();
  const mapped: MappedField[] = [];
  const marker = markerField(item);
  for (const field of item.fields) {
    if (field === marker) continue;
    const kind = fieldKindForSdkType(field.fieldType);
    if (!kind) continue;
    const externalFieldId = fieldExternalId(field, duplicateIds);
    mapped.push({
      source: "field",
      field,
      externalFieldId,
      name: uniqueName(safeFieldName(field.title, field.id), taken),
      kind,
    });
    // 1Password derives an SSH key's public key and fingerprint; both read as text.
    const details = sshDetails(field);
    for (const part of ["publicKey", "fingerprint"] as const) {
      if (!details?.[part]) continue;
      mapped.push({
        source: "sshDetail",
        field,
        part,
        externalFieldId: `${externalFieldId}${SSH_DETAIL_SEPARATOR}${part}`,
        name: uniqueName(part === "publicKey" ? "public key" : "fingerprint", taken),
        kind: "text",
      });
    }
  }
  if (item.category === "SecureNote" || item.notes) {
    mapped.push({
      source: "notes",
      externalFieldId: NOTES_FIELD_ID,
      name: uniqueName(item.category === "SecureNote" ? "note" : "notes", taken),
      kind: "concealed",
    });
  }
  if (item.document) {
    mapped.push({
      source: "file",
      file: item.document,
      externalFieldId: DOCUMENT_FIELD_ID,
      name: uniqueName("file", taken),
      kind: "file",
    });
  }
  for (const file of item.files ?? []) {
    mapped.push({
      source: "file",
      file: file.attributes,
      externalFieldId: `${FILE_FIELD_PREFIX}${file.attributes.id}`,
      name: uniqueName(safeFieldName(file.attributes.name, file.attributes.id), taken),
      kind: "file",
    });
  }
  return mapped;
}

function isoDate(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * `archivedAt` comes from the listing's item state: 1Password reports that an
 * item is archived, not when, so its last update time stands in.
 */
export function toProviderItemMeta(item: SdkItem, archived = false): ProviderItemMeta {
  const itemKind = itemKindForCategory(item.category);
  const marker = decodeItemTypeMarker(markerField(item)?.value);
  // The marker only adds what the 1Password category cannot say.
  const typed = marker && marker.type === itemKind.type ? marker : itemKind;
  return {
    externalItemId: item.id,
    name: safeSecretName(item.title, item.id),
    type: typed.type,
    ...(typed.category ? { category: typed.category } : {}),
    username: providerUsernameHint(
      item.fields.find((field) => field.id === "username" && field.fieldType === "Text")?.value,
    ),
    websites: (item.websites ?? []).map((website) => website.url).filter(Boolean),
    fields: mapItemFields(item).map(({ externalFieldId, name, kind }) => ({
      externalFieldId,
      name,
      kind,
    })),
    version: String(item.version),
    updatedAt: isoDate(item.updatedAt),
    ...(archived ? { archivedAt: isoDate(item.updatedAt) ?? new Date().toISOString() } : {}),
  };
}

/** 1Password keeps websites (URL fields) only on these categories. */
const WEBSITE_CATEGORIES = new Set(["Login", "Password", "ApiCredentials"]);

function toWebsites(
  category: string,
  urls: readonly string[],
  previous: readonly SdkWebsite[] = [],
): SdkWebsite[] {
  // 1Password refuses the whole item otherwise, so say so before sending it.
  if (urls.length && !WEBSITE_CATEGORIES.has(category)) {
    throw new VaultProviderError(
      "provider_unavailable",
      "1Password stores websites only on logins and API keys; save this item without websites, or as a login",
    );
  }
  return urls.map(
    (url) =>
      previous.find((website) => website.url === url) ?? {
        url,
        label: "website",
        autofillBehavior: "AnywhereOnWebsite",
      },
  );
}

type WriteField = ProviderWriteItem["fields"][number];

/** Built-in 1Password field that a named Opengeni field maps onto, if any. */
function builtInFieldFor(
  category: string,
  field: WriteField,
): { id: string; fieldType: string } | null {
  const key = nameKey(field.name);
  if (category === "Login" && key === "username") return { id: "username", fieldType: "Text" };
  if (category === "Login" && key === "password") return { id: "password", fieldType: "Concealed" };
  if (category === "ApiCredentials" && (key === "value" || key === "credential"))
    return { id: "credential", fieldType: "Concealed" };
  if (category === "ApiCredentials" && key === "username")
    return { id: "username", fieldType: "Text" };
  if (category === "CreditCard") {
    switch (standardVaultFieldName("card", field.name)) {
      case "cardholder name":
        return { id: "cardholder", fieldType: "Text" };
      case "brand":
        return { id: "type", fieldType: "CreditCardType" };
      case "number":
        return { id: "ccnum", fieldType: "CreditCardNumber" };
      case "security code":
        return { id: "cvv", fieldType: "Concealed" };
      default:
        return null;
    }
  }
  if (category === "SshKey" && standardVaultFieldName("ssh_key", field.name) === "private key")
    return { id: "private_key", fieldType: "SshKey" };
  return null;
}

/** 1Password derives an SSH key item's public key and fingerprint from its private key. */
function isDerivedSshField(category: string, field: WriteField): boolean {
  if (category !== "SshKey") return false;
  const standard = standardVaultFieldName("ssh_key", field.name);
  return standard === "public key" || standard === "fingerprint";
}

/** Sets, replaces or (null) removes the `opengeni.type` marker field. */
function setMarker(
  target: SdkItem | (SdkItemCreateParams & { fields: SdkItemField[] }),
  marker: string | null,
) {
  const existing = markerField(target);
  if (!marker) {
    if (existing) target.fields = target.fields.filter((field) => field !== existing);
    return;
  }
  if (existing) {
    existing.value = marker;
    return;
  }
  ensureOpengeniSection(target);
  target.fields.push({
    id: customFieldId(VAULT_TYPE_MARKER_FIELD, target),
    title: VAULT_TYPE_MARKER_FIELD,
    sectionId: OPENGENI_SECTION_ID,
    fieldType: "Text",
    value: marker,
  });
}

function isNotesField(category: string, field: WriteField): boolean {
  if (field.externalFieldId === NOTES_FIELD_ID) return true;
  const key = nameKey(field.name);
  return category === "SecureNote" ? key === "note" || key === "notes" : key === "notes";
}

function customFieldId(name: string, item: { fields: SdkItemField[] }): string {
  return uniqueFieldId(name, new Set(item.fields.map((field) => field.id)));
}

function uniqueFieldId(name: string, ids: Set<string>): string {
  const slug =
    nameKey(name)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field";
  let id = `opengeni_${slug}`.slice(0, 64);
  for (let n = 2; ids.has(id); n += 1) id = `opengeni_${slug}`.slice(0, 60) + `_${n}`;
  ids.add(id);
  return id;
}

function requireFile(field: WriteField): { name: string; bytes: Uint8Array } {
  if (!field.file) {
    throw new VaultProviderError("provider_conflict", `Field "${field.name}" has no file to write`);
  }
  return field.file;
}

function ensureOpengeniSection(target: { sections?: Array<{ id: string; title: string }> }) {
  const sections = (target.sections ??= []);
  if (!sections.some((section) => section.id === OPENGENI_SECTION_ID)) {
    sections.push({ id: OPENGENI_SECTION_ID, title: "" });
  }
}

/** Every field id an item already uses, including its file fields. */
function usedFieldIds(item: Pick<SdkItem, "fields"> & { files?: SdkItem["files"] }): Set<string> {
  return new Set([
    ...item.fields.map((field) => field.id),
    ...(item.files ?? []).map((file) => file.fieldId),
  ]);
}

function requireValue(field: WriteField): string {
  if (field.value === undefined) {
    throw new VaultProviderError(
      "provider_conflict",
      `Field "${field.name}" has no value to write`,
    );
  }
  return field.value;
}

function addField(
  target: SdkItem | (SdkItemCreateParams & { fields: SdkItemField[] }),
  category: string,
  field: WriteField,
) {
  if (isDerivedSshField(category, field)) return;
  const value = requireValue(field);
  const builtIn = builtInFieldFor(category, field);
  if (builtIn && !target.fields.some((existing) => existing.id === builtIn.id)) {
    target.fields.push({ id: builtIn.id, title: field.name, fieldType: builtIn.fieldType, value });
    return;
  }
  const sections = (target.sections ??= []);
  if (!sections.some((section) => section.id === OPENGENI_SECTION_ID)) {
    sections.push({ id: OPENGENI_SECTION_ID, title: "" });
  }
  target.fields.push({
    id: customFieldId(field.name, target),
    title: field.name,
    sectionId: OPENGENI_SECTION_ID,
    fieldType: sdkTypeForKind(field.kind),
    value,
  });
}

export function buildCreateParams(
  externalVaultId: string,
  write: ProviderWriteItem,
): SdkItemCreateParams {
  const { category, marker } = categoryForItem(write.type, write.category);
  const params: SdkItemCreateParams & {
    fields: SdkItemField[];
    sections: Array<{ id: string; title: string }>;
  } = {
    category,
    vaultId: externalVaultId,
    title: write.name,
    fields: [],
    sections: [],
    websites: toWebsites(category, write.websites),
  };
  const files: Array<{ field: WriteField; file: { name: string; bytes: Uint8Array } }> = [];
  for (const field of write.fields) {
    if (field.remove) continue;
    if (field.kind === "file") {
      const file = requireFile(field);
      // A Document item's first file is its document; any others are file fields.
      if (category === "Document" && !params.document) {
        params.document = { name: file.name, content: file.bytes };
        continue;
      }
      files.push({ field, file });
      continue;
    }
    if (isNotesField(category, field)) {
      params.notes = requireValue(field);
      continue;
    }
    addField(params, category, field);
  }
  setMarker(params, marker);
  if (files.length > 0) {
    ensureOpengeniSection(params);
    const ids = usedFieldIds({ fields: params.fields });
    // A file field is named by its file name, so it keeps the field's name.
    params.files = files.map(({ field, file }) => ({
      name: field.name,
      content: file.bytes,
      sectionId: OPENGENI_SECTION_ID,
      fieldId: uniqueFieldId(field.name, ids),
    }));
  }
  if (category === "Document" && !params.document) {
    throw new VaultProviderError(
      "provider_conflict",
      "A 1Password Document needs its file; add the file to the item",
    );
  }
  return params;
}

/**
 * The file changes of a write, applied after the item's other fields are
 * saved (the SDK changes files with their own calls, not with `put`).
 */
export type OnePasswordFileChange =
  | { kind: "attach"; file: SdkFileCreateParams }
  | { kind: "delete"; sectionId: string; fieldId: string }
  | { kind: "replaceDocument"; name: string; content: Uint8Array };

/** Plans a write's file changes against the current item, before anything is sent. */
export function planFileChanges(item: SdkItem, write: ProviderWriteItem): OnePasswordFileChange[] {
  const mapped = mapItemFields(item);
  const ids = usedFieldIds(item);
  const attach: OnePasswordFileChange[] = [];
  const remove: OnePasswordFileChange[] = [];
  for (const field of write.fields) {
    const target =
      (field.externalFieldId
        ? mapped.find((candidate) => candidate.externalFieldId === field.externalFieldId)
        : undefined) ??
      (field.kind === "file"
        ? mapped.find((candidate) => nameKey(candidate.name) === nameKey(field.name))
        : undefined);
    if (target && target.source !== "file") {
      if (field.kind === "file") {
        throw new VaultProviderError(
          "provider_conflict",
          `The item already has a field named "${field.name}"`,
        );
      }
      continue;
    }
    if (!target) {
      if (field.kind !== "file" || field.remove) continue;
      const file = requireFile(field);
      attach.push({
        kind: "attach",
        file: {
          name: field.name,
          content: file.bytes,
          sectionId: OPENGENI_SECTION_ID,
          fieldId: uniqueFieldId(field.name, ids),
        },
      });
      continue;
    }
    if (target.externalFieldId === DOCUMENT_FIELD_ID) {
      if (field.remove) {
        throw new VaultProviderError(
          "provider_conflict",
          "A 1Password Document keeps its file; replace it, or archive the item",
        );
      }
      const file = requireFile(field);
      attach.push({ kind: "replaceDocument", name: file.name, content: file.bytes });
      continue;
    }
    const stored = (item.files ?? []).find(
      (candidate) => `${FILE_FIELD_PREFIX}${candidate.attributes.id}` === target.externalFieldId,
    );
    if (!stored) {
      throw new VaultProviderError(
        "provider_not_found",
        `The item has no field ${target.externalFieldId}`,
      );
    }
    remove.push({ kind: "delete", sectionId: stored.sectionId, fieldId: stored.fieldId });
    if (field.remove) continue;
    const file = requireFile(field);
    attach.push({
      kind: "attach",
      file: {
        name: field.name,
        content: file.bytes,
        sectionId: stored.sectionId,
        fieldId: uniqueFieldId(field.name, ids),
      },
    });
  }
  // New files first, so a failed upload never loses the file it replaces.
  return [...attach, ...remove];
}

/**
 * Applies a field patch to a freshly read item (get → patch → put). File
 * fields are left to `planFileChanges`; a new file field's section is added
 * here so the file can be attached to it.
 */
export function applyWrite(item: SdkItem, write: ProviderWriteItem): SdkItem {
  const own = itemKindForCategory(item.category);
  // An item keeps its own category, also one this mapping does not name.
  const storedAs =
    own.type === write.type && own.category === (write.category ?? null)
      ? { category: item.category, marker: null }
      : categoryForItem(write.type, write.category);
  if (storedAs.category !== item.category) {
    throw new VaultProviderError(
      "provider_conflict",
      `1Password cannot change a ${item.category} item into a ${storedAs.category} item; save it as a new item instead`,
    );
  }
  const next: SdkItem = {
    ...item,
    title: write.name,
    fields: item.fields.map((field) => ({ ...field })),
    sections: [...(item.sections ?? [])],
    websites: toWebsites(item.category, write.websites, item.websites),
  };
  setMarker(next, storedAs.marker);
  for (const field of write.fields) {
    const mapped = mapItemFields(next);
    const target =
      (field.externalFieldId
        ? mapped.find((candidate) => candidate.externalFieldId === field.externalFieldId)
        : undefined) ?? mapped.find((candidate) => nameKey(candidate.name) === nameKey(field.name));
    if (target?.source === "file" || (!target && field.kind === "file")) {
      if (!target && !field.remove) ensureOpengeniSection(next);
      continue;
    }
    if (field.kind === "file") continue;
    // Derived from the private key by 1Password; never stored separately.
    if (target?.source === "sshDetail" || (!target && isDerivedSshField(next.category, field)))
      continue;
    if (field.remove) {
      if (!target) continue;
      if (target.source === "notes") next.notes = "";
      else next.fields = next.fields.filter((candidate) => candidate !== target.field);
      continue;
    }
    if (target?.source === "notes" || (!target && isNotesField(next.category, field))) {
      next.notes = requireValue(field);
      continue;
    }
    if (target?.source === "field") {
      target.field.value = requireValue(field);
      if (field.kind !== target.kind) {
        target.field.fieldType = sdkTypeForKind(field.kind);
      }
      continue;
    }
    addField(next, next.category, field);
  }
  return next;
}
