import { z } from "zod";

/**
 * JSON shapes printed by pass-cli 2.4.2 with `--output json` (serde of the
 * pass crate and proton-pass-common 2.1.1 types). Unknown keys are dropped;
 * only what the adapter maps is validated, so additive upstream fields do not
 * break parsing while a changed shape fails closed.
 */

const Id = z.string().min(1).max(512);
/** jiff civil date-time; pass-cli runs with TZ=UTC so it is UTC wall time. */
const CivilDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/);

const ShareRole = z.union([
  z.enum(["Owner", "Manager", "Editor", "Viewer"]),
  z.object({
    Custom: z.object({ name: z.string().optional(), permission: z.number().int().min(0) }),
  }),
]);
export type ShareRole = z.infer<typeof ShareRole>;

/** `share list --only-vaults=true --output json` */
export const ShareListOutput = z.object({
  shares: z.array(
    z.object({
      id: Id,
      name: z.string(),
      share_type: z.string(),
      share_role: ShareRole,
    }),
  ),
});
export type ShareListOutput = z.infer<typeof ShareListOutput>;

/** `vault list --output json` (fallback when share roles are unavailable). */
export const VaultListOutput = z.object({
  vaults: z.array(z.object({ name: z.string(), vault_id: Id, share_id: Id })),
});

export const ExtraFieldContent = z.union([
  z.object({ Text: z.string() }),
  z.object({ Hidden: z.string() }),
  z.object({ Totp: z.string() }),
  z.object({ Timestamp: z.number().int() }),
]);
export const ExtraField = z.object({ name: z.string(), content: ExtraFieldContent });
export type ExtraField = z.infer<typeof ExtraField>;

const Section = z.object({ section_name: z.string(), section_fields: z.array(ExtraField) });
export type Section = z.infer<typeof Section>;

const OptionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? "");

const LoginContent = z.object({
  email: OptionalString,
  username: OptionalString,
  password: OptionalString,
  urls: z.array(z.string()).default([]),
  totp_uri: OptionalString,
});
const SshKeyContent = z.object({
  private_key: OptionalString,
  public_key: OptionalString,
  sections: z.array(Section).default([]),
});
const WifiContent = z.object({
  ssid: OptionalString,
  password: OptionalString,
  sections: z.array(Section).default([]),
});
const CreditCardContent = z.object({
  cardholder_name: OptionalString,
  number: OptionalString,
  verification_number: OptionalString,
  expiration_date: OptionalString,
  pin: OptionalString,
});
/** Identity carries many scalar strings plus extra field groups; kept loose. */
const IdentityContent = z.record(z.string(), z.unknown());
const CustomContent = z.object({ sections: z.array(Section).default([]) });

export const ItemContentVariant = z.union([
  z.object({ Note: z.null() }).strict(),
  z.object({ Alias: z.null() }).strict(),
  z.object({ Login: LoginContent }),
  z.object({ SshKey: SshKeyContent }),
  z.object({ Wifi: WifiContent }),
  z.object({ CreditCard: CreditCardContent }),
  z.object({ Identity: IdentityContent }),
  z.object({ Custom: CustomContent }),
  z.literal("Note"),
  z.literal("Alias"),
]);
export type ItemContentVariant = z.infer<typeof ItemContentVariant>;

export const Item = z.object({
  id: Id,
  share_id: Id,
  vault_id: z.string().optional(),
  content: z.object({
    title: z.string(),
    note: OptionalString,
    content: ItemContentVariant,
    extra_fields: z.array(ExtraField).default([]),
  }),
  state: z.string(),
  flags: z.array(z.string()).default([]),
  create_time: CivilDateTime,
  modify_time: CivilDateTime,
});
export type Item = z.infer<typeof Item>;

export const Attachment = z.object({
  id: Id,
  size: z.number().int().min(0),
  content: z.object({ name: z.string(), mime_type: z.string().optional() }),
});
export type Attachment = z.infer<typeof Attachment>;

/** `item view --output json`: `ItemDetails`. */
export const ItemDetails = z.object({
  item: Item,
  attachments: z.array(Attachment).default([]),
});
export type ItemDetails = z.infer<typeof ItemDetails>;

/** `item list --show-secrets --output json` (non-agent sessions only). */
export const FullItemList = z.object({ items: z.array(Item) });

/** `item list --output json`: secret-free summaries (the only form agent sessions get). */
export const ItemSummary = z.object({
  id: Id,
  share_id: Id,
  state: z.string(),
  flags: z.array(z.string()).default([]),
  create_time: CivilDateTime,
  modify_time: CivilDateTime,
  title: z.string(),
  item_type: z.string(),
});
export type ItemSummary = z.infer<typeof ItemSummary>;
export const ItemSummaryList = z.object({ items: z.array(ItemSummary) });

/** `info --output json` for a personal-access-token or agent session. */
export const InfoOutput = z.object({
  personal_access_token_name: z.string().optional(),
  username: z.string().optional(),
  session_has_lock: z.boolean().optional(),
});

export const ITEM_HAS_FILES = "ItemHasFiles";

/** Proton share permission flags (proton-pass-common ShareRole::Custom). */
export const SHARE_PERMISSION = {
  admin: 1,
  read: 2,
  create: 4,
  update: 8,
  trash: 16,
  delete: 32,
} as const;
