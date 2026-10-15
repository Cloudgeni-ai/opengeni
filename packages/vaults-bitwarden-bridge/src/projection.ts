/**
 * Bitwarden item <-> `opengeni.vault.v1` mapping. Item shapes follow
 * `CipherResponse`/`CipherExport` at bitwarden/clients 57e52fcc: type
 * 1=Login, 2=SecureNote (others are shown read-only as notes); custom field
 * type 0=Text, 1=Hidden, 2=Boolean, 3=Linked.
 *
 * Listing responses from `bw serve` contain decrypted values. `projectItem`
 * copies only names, kinds, websites and versions; values never enter the
 * projection. Fields whose value the CLI redacts to null (no view-password
 * permission) are omitted from metadata and refused on read.
 */
import { createHash } from "node:crypto";
import { isValidTotpInput } from "@opengeni/contracts";
import {
  safeExternalVaultName,
  uniqueExternalVaultFieldName,
  type VaultProviderWireFieldValue,
  type VaultProviderWireItemMeta,
  type VaultProviderWireWriteItem,
} from "@opengeni/sdk/external-vault-receiver";
import type { BitwardenItem } from "./bw-serve";

export const BW_CIPHER_LOGIN = 1;
export const BW_CIPHER_SECURE_NOTE = 2;
export const BW_FIELD_TEXT = 0;
export const BW_FIELD_HIDDEN = 1;
export const BW_FIELD_BOOLEAN = 2;

const MAX_FIELDS = 50;
const MAX_WEBSITES = 20;
const MAX_WEBSITE_CHARS = 2_048;
const MAX_TEXT_BYTES = 65_536;

export const FIELD_USERNAME = "login.username";
export const FIELD_PASSWORD = "login.password";
export const FIELD_TOTP = "login.totp";
export const FIELD_NOTES = "notes";

type Kind = "text" | "concealed" | "totp";

export interface MappedField {
  externalFieldId: string;
  name: string;
  kind: Kind;
  value: string;
  /** Position in `fields[]` for custom fields. */
  index?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Stable custom-field id from its name and occurrence; never the value. */
export function customFieldId(name: string, occurrence: number): string {
  const digest = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 32);
  return `field:${digest}:${occurrence}`;
}

function customFields(
  item: BitwardenItem,
): Array<{ name: string; type: number; value: unknown; index: number; id: string }> {
  const fields = Array.isArray(item.fields) ? item.fields : [];
  const seen = new Map<string, number>();
  const out: Array<{ name: string; type: number; value: unknown; index: number; id: string }> = [];
  fields.forEach((raw, index) => {
    const field = record(raw);
    if (!field) return;
    const name = typeof field.name === "string" ? field.name : "";
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    out.push({
      name,
      type: typeof field.type === "number" ? field.type : -1,
      value: field.value,
      index,
      id: customFieldId(name, occurrence),
    });
  });
  return out;
}

/**
 * Every readable field with its value, in a stable order. Built-in login
 * fields claim their names first. Values stay inside the bridge.
 */
export function mapFields(item: BitwardenItem): MappedField[] {
  const taken = new Set<string>();
  const mapped: MappedField[] = [];
  const add = (field: Omit<MappedField, "name">, name: string) => {
    if (mapped.length >= MAX_FIELDS || bytes(field.value) > MAX_TEXT_BYTES) return;
    mapped.push({ ...field, name: uniqueExternalVaultFieldName(name, taken) });
  };
  const login = item.type === BW_CIPHER_LOGIN ? record(item.login) : null;
  if (login) {
    if (typeof login.username === "string") {
      add({ externalFieldId: FIELD_USERNAME, kind: "text", value: login.username }, "username");
    }
    if (typeof login.password === "string") {
      add(
        { externalFieldId: FIELD_PASSWORD, kind: "concealed", value: login.password },
        "password",
      );
    }
    if (typeof login.totp === "string" && isValidTotpInput(login.totp)) {
      add({ externalFieldId: FIELD_TOTP, kind: "totp", value: login.totp }, "totp");
    }
  }
  if (typeof item.notes === "string") {
    add({ externalFieldId: FIELD_NOTES, kind: "text", value: item.notes }, "note");
  }
  for (const field of customFields(item)) {
    if (typeof field.value !== "string") continue; // Linked or redacted.
    if (field.type === BW_FIELD_HIDDEN) {
      add(
        { externalFieldId: field.id, kind: "concealed", value: field.value, index: field.index },
        field.name,
      );
    } else if (field.type === BW_FIELD_TEXT || field.type === BW_FIELD_BOOLEAN) {
      add(
        { externalFieldId: field.id, kind: "text", value: field.value, index: field.index },
        field.name,
      );
    }
  }
  return mapped;
}

function websites(item: BitwardenItem): string[] {
  const login = item.type === BW_CIPHER_LOGIN ? record(item.login) : null;
  const uris = Array.isArray(login?.uris) ? login.uris : [];
  const out: string[] = [];
  for (const raw of uris) {
    const uri = record(raw)?.uri;
    // oxlint-disable-next-line no-control-regex
    if (
      typeof uri !== "string" ||
      !uri ||
      uri.length > MAX_WEBSITE_CHARS ||
      /[\u0000-\u001f\u007f-\u009f]/.test(uri)
    )
      continue;
    if (out.length >= MAX_WEBSITES) break;
    out.push(uri);
  }
  return out;
}

export function itemRevision(item: BitwardenItem): string | null {
  const value = item.revisionDate;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

/** Metadata only: no value can reach the returned object. */
export function projectItem(item: BitwardenItem): VaultProviderWireItemMeta {
  const revision = itemRevision(item);
  return {
    externalItemId: item.id.toLowerCase(),
    name: safeExternalVaultName(typeof item.name === "string" ? item.name : "", "Untitled item"),
    type: item.type === BW_CIPHER_LOGIN ? "login" : "note",
    websites: websites(item),
    fields: mapFields(item).map(({ externalFieldId, name, kind }) => ({
      externalFieldId,
      name,
      kind,
    })),
    version: revision,
    updatedAt: revision ? new Date(revision).toISOString() : null,
  };
}

export class ProjectionError extends Error {
  readonly reason: "not_found" | "permission_denied" | "conflict" | "unsupported";
  constructor(reason: ProjectionError["reason"]) {
    super(reason);
    this.name = "ProjectionError";
    this.reason = reason;
  }
}

/** Values for exactly the requested ids. A redacted (null) value fails closed. */
export function readValues(
  item: BitwardenItem,
  externalFieldIds: readonly string[],
): VaultProviderWireFieldValue[] {
  const fields = new Map(mapFields(item).map((field) => [field.externalFieldId, field]));
  const login = item.type === BW_CIPHER_LOGIN ? record(item.login) : null;
  const custom = new Map(customFields(item).map((field) => [field.id, field]));
  return externalFieldIds.map((id) => {
    const field = fields.get(id);
    if (field) {
      return {
        externalFieldId: id,
        value:
          field.kind === "totp"
            ? { type: "totp", value: field.value }
            : { type: "text", value: field.value },
      };
    }
    // Present but redacted by the CLI: the caller lacks view-password permission.
    const redacted =
      (id === FIELD_PASSWORD && login && login.password === null) ||
      (id === FIELD_TOTP && login && login.totp === null) ||
      (custom.has(id) &&
        custom.get(id)!.value === null &&
        custom.get(id)!.type === BW_FIELD_HIDDEN);
    throw new ProjectionError(redacted ? "permission_denied" : "not_found");
  });
}

function customType(kind: string): number {
  if (kind === "text") return BW_FIELD_TEXT;
  if (kind === "concealed") return BW_FIELD_HIDDEN;
  throw new ProjectionError("unsupported");
}

function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

function mergeWebsites(current: unknown, wanted: readonly string[]): unknown[] {
  const existing = Array.isArray(current) ? current : [];
  const byUri = new Map<string, unknown>();
  for (const raw of existing) {
    const uri = record(raw)?.uri;
    if (typeof uri === "string" && !byUri.has(uri)) byUri.set(uri, raw);
  }
  // Keep unknown URI properties (match strategy, checksums) for retained URIs.
  return wanted.map((uri) => byUri.get(uri) ?? { uri, match: null });
}

/**
 * Apply an Opengeni write to the complete current item. Unmentioned fields,
 * unknown properties, password history and the revision precondition are
 * preserved; the result is sent whole to `PUT /object/item/{id}`.
 */
export function mergeUpdate(
  current: BitwardenItem,
  write: VaultProviderWireWriteItem,
): Record<string, unknown> {
  const expectedType =
    write.type === "login" ? BW_CIPHER_LOGIN : write.type === "note" ? BW_CIPHER_SECURE_NOTE : null;
  if (expectedType === null || current.type !== expectedType)
    throw new ProjectionError("unsupported");
  const next = structuredClone(current) as Record<string, unknown>;
  next.name = write.name;
  const login = current.type === BW_CIPHER_LOGIN ? (record(next.login) ?? {}) : null;
  if (login) {
    login.uris = mergeWebsites(login.uris, write.websites);
    next.login = login;
  } else if (write.websites.length > 0) {
    throw new ProjectionError("unsupported");
  }
  const fields = (Array.isArray(next.fields) ? next.fields : []).map((field) =>
    structuredClone(field),
  ) as Array<Record<string, unknown> | null>;
  const mapped = new Map(mapFields(current).map((field) => [field.externalFieldId, field]));
  const custom = new Map(customFields(current).map((field) => [field.id, field]));
  const removeIndexes = new Set<number>();
  const names = new Set(mapFields(current).map((field) => nameKey(field.name)));

  for (const field of write.fields) {
    const id = field.externalFieldId;
    if (id === undefined) {
      if (names.has(nameKey(field.name))) throw new ProjectionError("conflict");
      names.add(nameKey(field.name));
      if (field.kind === "totp") {
        if (!login || typeof login.totp === "string" || field.value === undefined) {
          throw new ProjectionError("unsupported");
        }
        if (!isValidTotpInput(field.value)) throw new ProjectionError("unsupported");
        login.totp = field.value;
        continue;
      }
      fields.push({
        name: field.name,
        value: field.value ?? null,
        type: customType(field.kind),
        linkedId: null,
      });
      continue;
    }
    if (id === FIELD_USERNAME || id === FIELD_PASSWORD || id === FIELD_TOTP) {
      if (!login) throw new ProjectionError("not_found");
      const key = id === FIELD_USERNAME ? "username" : id === FIELD_PASSWORD ? "password" : "totp";
      if (field.remove) login[key] = null;
      else if (field.value !== undefined) {
        if (key === "totp" && !isValidTotpInput(field.value))
          throw new ProjectionError("unsupported");
        login[key] = field.value;
      }
      continue;
    }
    if (id === FIELD_NOTES) {
      if (field.remove) next.notes = null;
      else if (field.value !== undefined) next.notes = field.value;
      continue;
    }
    const existing = custom.get(id);
    if (!existing) throw new ProjectionError("not_found");
    // Linked or redacted custom fields cannot be changed or removed from here.
    if (!mapped.has(id)) throw new ProjectionError("permission_denied");
    if (field.remove) {
      removeIndexes.add(existing.index);
      continue;
    }
    const target = fields[existing.index];
    if (!target) throw new ProjectionError("not_found");
    const currentName = mapped.get(id)!.name;
    if (nameKey(field.name) !== nameKey(currentName)) {
      if (names.has(nameKey(field.name))) throw new ProjectionError("conflict");
      names.delete(nameKey(currentName));
      names.add(nameKey(field.name));
      target.name = field.name;
    }
    if (field.kind !== mapped.get(id)!.kind) target.type = customType(field.kind);
    if (field.value !== undefined) target.value = field.value;
  }
  next.fields = fields.filter((_, index) => !removeIndexes.has(index));
  return next;
}

/** A new Bitwarden item body for `POST /object/item`. */
export function createBody(
  write: VaultProviderWireWriteItem,
  scope: { organizationId: string | null; collectionId: string | null },
): Record<string, unknown> {
  if (write.type !== "login" && write.type !== "note") throw new ProjectionError("unsupported");
  const login: Record<string, unknown> | null =
    write.type === "login"
      ? {
          uris: write.websites.map((uri) => ({ uri, match: null })),
          username: null,
          password: null,
          totp: null,
        }
      : null;
  if (!login && write.websites.length > 0) throw new ProjectionError("unsupported");
  let notes: string | null = null;
  const fields: Array<Record<string, unknown>> = [];
  for (const field of write.fields) {
    if (field.remove || field.externalFieldId !== undefined)
      throw new ProjectionError("unsupported");
    const key = nameKey(field.name);
    if (login && key === "username" && field.kind === "text" && login.username === null) {
      login.username = field.value ?? null;
    } else if (
      login &&
      key === "password" &&
      field.kind === "concealed" &&
      login.password === null
    ) {
      login.password = field.value ?? null;
    } else if (field.kind === "totp") {
      if (!login || login.totp !== null || !field.value || !isValidTotpInput(field.value)) {
        throw new ProjectionError("unsupported");
      }
      login.totp = field.value;
    } else if ((key === "note" || key === "notes") && field.kind === "text" && notes === null) {
      notes = field.value ?? null;
    } else {
      fields.push({
        name: field.name,
        value: field.value ?? null,
        type: customType(field.kind),
        linkedId: null,
      });
    }
  }
  return {
    type: login ? BW_CIPHER_LOGIN : BW_CIPHER_SECURE_NOTE,
    name: write.name,
    notes,
    favorite: false,
    reprompt: 0,
    folderId: null,
    organizationId: scope.organizationId,
    collectionIds: scope.collectionId ? [scope.collectionId] : [],
    fields,
    ...(login ? { login } : { secureNote: { type: 0 } }),
  };
}
