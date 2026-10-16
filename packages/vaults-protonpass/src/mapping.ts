import {
  type ProviderFieldMeta,
  type ProviderItemMeta,
  type VaultFieldKind,
  type VaultItemType,
} from "./contract";
import { safeFieldName, safeSecretName, uniqueName } from "./naming";
import type { Attachment, ExtraField, Item, ItemContentVariant, Section } from "./schema";

/**
 * External field ids. They are positional names, not upstream ids: Proton
 * items have no per-field identifiers, so ids are derived from the field's
 * place in the item (`login.password`, `x:<extra field name>`,
 * `s:<section>/<field>`, `@file:<attachment id>`), with `#n` for repeats.
 */
export const NOTE_FIELD_ID = "@note";
export const FILE_FIELD_PREFIX = "@file:";
export const LOGIN_FIELD_IDS = {
  username: "login.username",
  email: "login.email",
  password: "login.password",
  totp: "login.totp",
} as const;
export const TOTP_FIELD_NAME = "one-time password";

export type MappedValue =
  | { type: "text"; value: string }
  | { type: "totp"; uri: string }
  | { type: "file"; attachment: Attachment };

export interface MappedField extends ProviderFieldMeta {
  value: MappedValue;
}

export interface MappedItem {
  meta: ProviderItemMeta;
  fields: MappedField[];
}

const IDENTITY_CONCEALED = new Set(["social_security_number", "passport_number", "license_number"]);

class FieldCollector {
  readonly fields: MappedField[] = [];
  private readonly names = new Set<string>();
  private readonly ids = new Map<string, number>();

  add(baseId: string, rawName: string, kind: VaultFieldKind, value: MappedValue) {
    const seen = (this.ids.get(baseId) ?? 0) + 1;
    this.ids.set(baseId, seen);
    const externalFieldId = seen === 1 ? baseId : `${baseId}#${seen}`;
    const name = uniqueName(safeFieldName(rawName, "field"), this.names);
    this.fields.push({ externalFieldId, name, kind, value });
  }

  extra(prefix: string, field: ExtraField) {
    const content = field.content;
    const id = `${prefix}${field.name}`;
    if ("Text" in content) this.add(id, field.name, "text", { type: "text", value: content.Text });
    else if ("Hidden" in content) {
      this.add(id, field.name, "concealed", { type: "text", value: content.Hidden });
    } else if ("Totp" in content) {
      // An empty TOTP field holds no seed; it reads as empty text.
      if (content.Totp) this.add(id, field.name, "totp", { type: "totp", uri: content.Totp });
      else this.add(id, field.name, "text", { type: "text", value: "" });
    } else {
      this.add(id, field.name, "text", { type: "text", value: timestampText(content.Timestamp) });
    }
  }

  sections(sections: readonly Section[]) {
    for (const section of sections) {
      for (const field of section.section_fields) this.extra(`s:${section.section_name}/`, field);
    }
  }
}

function timestampText(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? String(seconds) : date.toISOString();
}

function variantName(content: ItemContentVariant): string {
  if (typeof content === "string") return content;
  return Object.keys(content)[0] ?? "Note";
}

export function itemTypeForVariant(variant: string): VaultItemType {
  switch (variant) {
    case "Login":
      return "login";
    case "Note":
      return "note";
    case "Custom":
    case "SshKey":
      return "api_key";
    default:
      // Alias, CreditCard, Identity, Wifi: generic fields, shown as notes.
      return "note";
  }
}

/** Proton summary `item_type` (snake case) to an Opengeni item type. */
export function itemTypeForSummary(itemType: string): VaultItemType {
  switch (itemType) {
    case "login":
      return "login";
    case "custom":
    case "ssh_key":
      return "api_key";
    default:
      return "note";
  }
}

/** `YYYY-MM-DDTHH:MM:SS` (UTC under TZ=UTC) to an ISO instant. */
export function civilToIso(civil: string): string | null {
  const date = new Date(`${civil}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function concealedText(collector: FieldCollector, id: string, name: string, value: string) {
  collector.add(id, name, "concealed", { type: "text", value });
}

function plainText(collector: FieldCollector, id: string, name: string, value: string) {
  collector.add(id, name, "text", { type: "text", value });
}

function identityFields(collector: FieldCollector, identity: Record<string, unknown>) {
  for (const [key, value] of Object.entries(identity)) {
    if (typeof value === "string") {
      if (!value) continue;
      if (IDENTITY_CONCEALED.has(key)) concealedText(collector, `identity.${key}`, key, value);
      else plainText(collector, `identity.${key}`, key, value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.section_name === "string" && Array.isArray(record.section_fields)) {
        collector.sections([
          { section_name: record.section_name, section_fields: extraFields(record.section_fields) },
        ]);
      } else {
        for (const field of extraFields([record])) collector.extra(`s:${key}/`, field);
      }
    }
  }
}

function extraFields(values: readonly unknown[]): ExtraField[] {
  const out: ExtraField[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as { name?: unknown; content?: unknown };
    if (typeof record.name !== "string" || !record.content || typeof record.content !== "object") {
      continue;
    }
    const content = record.content as Record<string, unknown>;
    if (typeof content.Text === "string")
      out.push({ name: record.name, content: { Text: content.Text } });
    else if (typeof content.Hidden === "string") {
      out.push({ name: record.name, content: { Hidden: content.Hidden } });
    } else if (typeof content.Totp === "string") {
      out.push({ name: record.name, content: { Totp: content.Totp } });
    } else if (typeof content.Timestamp === "number") {
      out.push({ name: record.name, content: { Timestamp: content.Timestamp } });
    }
  }
  return out;
}

/** Maps an item (and, from `item view`, its attachments) to fields and metadata. */
export function mapItem(item: Item, attachments: readonly Attachment[] = []): MappedItem {
  const collector = new FieldCollector();
  const content = item.content.content;
  const variant = variantName(content);
  const websites: string[] = [];

  if (typeof content === "object") {
    if ("Login" in content) {
      const login = content.Login;
      plainText(collector, LOGIN_FIELD_IDS.username, "username", login.username);
      if (login.email) plainText(collector, LOGIN_FIELD_IDS.email, "email", login.email);
      concealedText(collector, LOGIN_FIELD_IDS.password, "password", login.password);
      if (login.totp_uri) {
        collector.add(LOGIN_FIELD_IDS.totp, TOTP_FIELD_NAME, "totp", {
          type: "totp",
          uri: login.totp_uri,
        });
      }
      websites.push(...login.urls.filter((url) => url.trim().length > 0));
    } else if ("SshKey" in content) {
      concealedText(collector, "ssh.private_key", "private key", content.SshKey.private_key);
      plainText(collector, "ssh.public_key", "public key", content.SshKey.public_key);
      collector.sections(content.SshKey.sections);
    } else if ("Wifi" in content) {
      plainText(collector, "wifi.ssid", "ssid", content.Wifi.ssid);
      concealedText(collector, "wifi.password", "password", content.Wifi.password);
      collector.sections(content.Wifi.sections);
    } else if ("CreditCard" in content) {
      const card = content.CreditCard;
      plainText(collector, "card.cardholder_name", "cardholder name", card.cardholder_name);
      concealedText(collector, "card.number", "number", card.number);
      concealedText(
        collector,
        "card.verification_number",
        "verification number",
        card.verification_number,
      );
      plainText(collector, "card.expiration_date", "expiration date", card.expiration_date);
      if (card.pin) concealedText(collector, "card.pin", "PIN", card.pin);
    } else if ("Identity" in content) {
      identityFields(collector, content.Identity);
    } else if ("Custom" in content) {
      collector.sections(content.Custom.sections);
    }
  }

  const note = item.content.note;
  if (variant === "Note" || note) {
    collector.add(NOTE_FIELD_ID, "note", "concealed", { type: "text", value: note });
  }
  for (const field of item.content.extra_fields) collector.extra("x:", field);
  for (const attachment of attachments) {
    collector.add(`${FILE_FIELD_PREFIX}${attachment.id}`, attachment.content.name, "file", {
      type: "file",
      attachment,
    });
  }

  const meta: ProviderItemMeta = {
    externalItemId: item.id,
    name: safeSecretName(item.content.title, item.id),
    type: itemTypeForVariant(variant),
    websites,
    fields: collector.fields.map(({ externalFieldId, name, kind }) => ({
      externalFieldId,
      name,
      kind,
    })),
    version: item.modify_time,
    updatedAt: civilToIso(item.modify_time),
  };
  return { meta, fields: collector.fields };
}
