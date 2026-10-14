import {
  type ProviderFieldMeta,
  type ProviderItemMeta,
  type ProviderWriteItem,
  type VaultFieldKind,
  type VaultItemType,
  VaultProviderError,
} from "./contract";
import type { SdkItem, SdkItemCreateParams, SdkItemField, SdkWebsite } from "./sdk";

/** External field ids that do not name an SDK `fields[]` entry. */
export const NOTES_FIELD_ID = "@notes";
export const DOCUMENT_FIELD_ID = "@document";
export const FILE_FIELD_PREFIX = "@file:";
/** Section used for custom fields that Opengeni adds to 1Password items. */
export const OPENGENI_SECTION_ID = "opengeni";

const API_KEY_CATEGORIES = new Set([
  "ApiCredentials",
  "Password",
  "Server",
  "Database",
  "SshKey",
  "SoftwareLicense",
  "Router",
  "Email",
  "CryptoWallet",
]);

export function itemTypeForCategory(category: string): VaultItemType {
  if (category === "Login") return "login";
  if (category === "SecureNote") return "note";
  if (category === "Document") return "file";
  if (API_KEY_CATEGORIES.has(category)) return "api_key";
  // CreditCard, Identity, BankAccount, ...: generic fields, shown as notes.
  return "note";
}

export function categoryForItemType(type: VaultItemType): string {
  switch (type) {
    case "login":
      return "Login";
    case "api_key":
      return "ApiCredentials";
    case "note":
      return "SecureNote";
    case "file":
    case "passkey":
      throw new VaultProviderError(
        "provider_unavailable",
        type === "passkey"
          ? "1Password service accounts cannot store passkeys; keep passkeys in an Opengeni vault"
          : "Creating file items in 1Password from Opengeni is not supported yet",
      );
  }
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
    "Writing file fields to 1Password from Opengeni is not supported yet",
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
  | (ProviderFieldMeta & { source: "notes" })
  | (ProviderFieldMeta & {
      source: "file";
      file: { name: string; id: string; size: number };
    });

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
  for (const field of item.fields) {
    const kind = fieldKindForSdkType(field.fieldType);
    if (!kind) continue;
    mapped.push({
      source: "field",
      field,
      externalFieldId: fieldExternalId(field, duplicateIds),
      name: uniqueName(safeFieldName(field.title, field.id), taken),
      kind,
    });
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

export function toProviderItemMeta(item: SdkItem): ProviderItemMeta {
  return {
    externalItemId: item.id,
    name: safeSecretName(item.title, item.id),
    type: itemTypeForCategory(item.category),
    websites: (item.websites ?? []).map((website) => website.url).filter(Boolean),
    fields: mapItemFields(item).map(({ externalFieldId, name, kind }) => ({
      externalFieldId,
      name,
      kind,
    })),
    version: String(item.version),
    updatedAt: isoDate(item.updatedAt),
  };
}

function toWebsites(urls: readonly string[], previous: readonly SdkWebsite[] = []): SdkWebsite[] {
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
  return null;
}

function isNotesField(category: string, field: WriteField): boolean {
  if (field.externalFieldId === NOTES_FIELD_ID) return true;
  const key = nameKey(field.name);
  return category === "SecureNote" ? key === "note" || key === "notes" : key === "notes";
}

function customFieldId(name: string, item: { fields: SdkItemField[] }): string {
  const slug =
    nameKey(name)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field";
  const ids = new Set(item.fields.map((field) => field.id));
  let id = `opengeni_${slug}`.slice(0, 64);
  for (let n = 2; ids.has(id); n += 1) id = `opengeni_${slug}`.slice(0, 60) + `_${n}`;
  return id;
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
  const category = categoryForItemType(write.type);
  const params: SdkItemCreateParams & {
    fields: SdkItemField[];
    sections: Array<{ id: string; title: string }>;
  } = {
    category,
    vaultId: externalVaultId,
    title: write.name,
    fields: [],
    sections: [],
    websites: toWebsites(write.websites),
  };
  for (const field of write.fields) {
    if (field.remove) continue;
    if (isNotesField(category, field)) {
      params.notes = requireValue(field);
      continue;
    }
    addField(params, category, field);
  }
  return params;
}

/** Applies a field patch to a freshly read item (get → patch → put). */
export function applyWrite(item: SdkItem, write: ProviderWriteItem): SdkItem {
  const next: SdkItem = {
    ...item,
    title: write.name,
    fields: item.fields.map((field) => ({ ...field })),
    sections: [...(item.sections ?? [])],
    websites: toWebsites(write.websites, item.websites),
  };
  for (const field of write.fields) {
    const mapped = mapItemFields(next);
    const target =
      (field.externalFieldId
        ? mapped.find((candidate) => candidate.externalFieldId === field.externalFieldId)
        : undefined) ?? mapped.find((candidate) => nameKey(candidate.name) === nameKey(field.name));
    if (target?.source === "file" || (!target && field.kind === "file")) {
      throw new VaultProviderError(
        "provider_unavailable",
        "Writing file fields to 1Password from Opengeni is not supported yet",
      );
    }
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
      if (field.kind !== target.kind && field.kind !== "file") {
        target.field.fieldType = sdkTypeForKind(field.kind);
      }
      continue;
    }
    addField(next, next.category, field);
  }
  return next;
}
