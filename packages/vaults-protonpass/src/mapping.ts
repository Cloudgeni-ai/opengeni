import { providerUsernameHint } from "@opengeni/vaults";
import {
  type ProviderFieldMeta,
  type ProviderItemMeta,
  type ProviderPasskeyMeta,
  type VaultFieldKind,
} from "./contract";
import { protonPasskeyMeta } from "./passkeys";
import {
  type ItemTypeMarker,
  decodeItemTypeMarker,
  isItemTypeMarkerName,
  sshPublicKeyFingerprint,
  sshPublicKeyFromPrivateKey,
} from "@opengeni/vaults";
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
export const CARD_FIELD_IDS = {
  cardholderName: "card.cardholder_name",
  brand: "card.card_type",
  number: "card.number",
  securityCode: "card.verification_number",
  expiryMonth: "card.expiration_date:month",
  expiryYear: "card.expiration_date:year",
  expiration: "card.expiration_date",
  pin: "card.pin",
} as const;
export const SSH_FIELD_IDS = {
  privateKey: "ssh.private_key",
  publicKey: "ssh.public_key",
  /** Not stored by Proton: derived from the public key on every read. */
  fingerprint: "ssh.fingerprint",
} as const;

/**
 * Proton identity keys that are a standard Opengeni identity field, by that
 * field's name. Every other key keeps its own name with spaces ("full name",
 * "work email"), and the Opengeni fields with no Proton slot ("title",
 * "username", "address 2", "address 3") cannot be stored.
 */
export const IDENTITY_STANDARD_KEYS: Readonly<Record<string, string>> = {
  "first name": "first_name",
  "middle name": "middle_name",
  "last name": "last_name",
  company: "company",
  email: "email",
  phone: "phone_number",
  "address 1": "street_address",
  city: "city",
  state: "state_or_province",
  "postal code": "zip_or_postal_code",
  country: "country_or_region",
  "national ID number": "social_security_number",
  "passport number": "passport_number",
  "license number": "license_number",
};
const IDENTITY_NAME_FOR_KEY = new Map(
  Object.entries(IDENTITY_STANDARD_KEYS).map(([name, key]) => [key, name]),
);
/** Every scalar key `item create identity` takes (pass-cli 2.4.2 IdentityTemplate). */
export const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "full_name",
  "email",
  "phone_number",
  "first_name",
  "middle_name",
  "last_name",
  "birthdate",
  "gender",
  "organization",
  "street_address",
  "zip_or_postal_code",
  "city",
  "state_or_province",
  "country_or_region",
  "floor",
  "county",
  "social_security_number",
  "passport_number",
  "license_number",
  "website",
  "x_handle",
  "second_phone_number",
  "linkedin",
  "reddit",
  "facebook",
  "yahoo",
  "instagram",
  "company",
  "job_title",
  "personal_website",
  "work_phone_number",
  "work_email",
]);

/** The Opengeni field name of a Proton identity key. */
export function identityFieldName(key: string): string {
  return IDENTITY_NAME_FOR_KEY.get(key) ?? key.replace(/_/g, " ");
}

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
  /** The `opengeni.type` marker seen in the item's custom fields, if any. */
  marker: ItemTypeMarker | null = null;
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
    if (isItemTypeMarkerName(field.name)) {
      // The marker carries the type and category; it is never a field itself.
      if ("Text" in content) this.marker ??= decodeItemTypeMarker(content.Text);
      return;
    }
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

/** The Opengeni type and category of a Proton item content variant. */
export function itemKindForVariant(variant: string): ItemTypeMarker {
  switch (variant) {
    case "Login":
      return { type: "login", category: null };
    case "Note":
      return { type: "note", category: null };
    case "CreditCard":
      return { type: "card", category: null };
    case "Identity":
      return { type: "identity", category: null };
    case "SshKey":
      return { type: "ssh_key", category: null };
    case "Wifi":
      return { type: "api_key", category: "wifi" };
    case "Alias":
      return { type: "note", category: "email_alias" };
    case "Custom":
    default:
      return { type: "api_key", category: null };
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
      const name = identityFieldName(key);
      if (IDENTITY_CONCEALED.has(key)) concealedText(collector, `identity.${key}`, name, value);
      else plainText(collector, `identity.${key}`, name, value);
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
  const passkeys: ProviderPasskeyMeta[] = [];

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
      for (const passkey of login.passkeys) {
        const meta = protonPasskeyMeta(passkey);
        if (meta) passkeys.push(meta);
      }
    } else if ("SshKey" in content) {
      const ssh = content.SshKey;
      concealedText(collector, SSH_FIELD_IDS.privateKey, "private key", ssh.private_key);
      const publicKey =
        ssh.public_key || sshPublicKeyFromPrivateKey(ssh.private_key)?.publicKey || "";
      plainText(collector, SSH_FIELD_IDS.publicKey, "public key", publicKey);
      const fingerprint = publicKey ? sshPublicKeyFingerprint(publicKey) : null;
      if (fingerprint) plainText(collector, SSH_FIELD_IDS.fingerprint, "fingerprint", fingerprint);
      collector.sections(ssh.sections);
    } else if ("Wifi" in content) {
      plainText(collector, "wifi.ssid", "ssid", content.Wifi.ssid);
      concealedText(collector, "wifi.password", "password", content.Wifi.password);
      collector.sections(content.Wifi.sections);
    } else if ("CreditCard" in content) {
      const card = content.CreditCard;
      plainText(collector, CARD_FIELD_IDS.cardholderName, "cardholder name", card.cardholder_name);
      if (
        typeof card.card_type === "string" &&
        card.card_type &&
        card.card_type !== "Unspecified"
      ) {
        plainText(collector, CARD_FIELD_IDS.brand, "brand", card.card_type);
      }
      concealedText(collector, CARD_FIELD_IDS.number, "number", card.number);
      // Proton keeps the expiry as one "YYYY-MM" value; it reads as the two
      // standard fields, or as one field when it is in another shape.
      const expiry = /^(\d{4})-(\d{1,2})$/.exec(card.expiration_date.trim());
      if (expiry) {
        plainText(collector, CARD_FIELD_IDS.expiryMonth, "expiry month", String(Number(expiry[2])));
        plainText(collector, CARD_FIELD_IDS.expiryYear, "expiry year", expiry[1]!);
      } else if (card.expiration_date) {
        plainText(collector, CARD_FIELD_IDS.expiration, "expiration date", card.expiration_date);
      }
      concealedText(
        collector,
        CARD_FIELD_IDS.securityCode,
        "security code",
        card.verification_number,
      );
      if (card.pin) concealedText(collector, CARD_FIELD_IDS.pin, "PIN", card.pin);
    } else if ("Identity" in content) {
      identityFields(collector, content.Identity);
    } else if ("Custom" in content) {
      collector.sections(content.Custom.sections);
    }
  }

  const note = item.content.note;
  // A custom item marked as a note (a note with a category) shows its note
  // even when empty, like a plain note.
  if (variant === "Note" || note || collector.marker?.type === "note") {
    collector.add(NOTE_FIELD_ID, "note", "concealed", { type: "text", value: note });
  }
  for (const field of item.content.extra_fields) collector.extra("x:", field);
  for (const attachment of attachments) {
    collector.add(`${FILE_FIELD_PREFIX}${attachment.id}`, attachment.content.name, "file", {
      type: "file",
      attachment,
    });
  }

  // Only a custom item carries a marker (see `planCreate`); on other kinds
  // Proton's own type decides.
  const itemKind =
    variant === "Custom" && collector.marker ? collector.marker : itemKindForVariant(variant);
  const meta: ProviderItemMeta = {
    externalItemId: item.id,
    name: safeSecretName(item.content.title, item.id),
    type: itemKind.type,
    category: itemKind.category,
    username: providerUsernameHint(
      typeof content === "object" && "Login" in content ? content.Login.username : null,
    ),
    websites,
    fields: collector.fields.map(({ externalFieldId, name, kind }) => ({
      externalFieldId,
      name,
      kind,
    })),
    version: item.modify_time,
    updatedAt: civilToIso(item.modify_time),
    passkeys,
  };
  return { meta, fields: collector.fields };
}
