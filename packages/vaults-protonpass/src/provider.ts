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
  type VaultProviderOperations,
  parseTotpInput,
} from "./contract";
import { type MappedField, type MappedItem, mapItem } from "./mapping";
import { nameKey, safeSecretName, totpUri } from "./naming";
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
  createItemTypes: ["login", "note", "api_key"],
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

export type ProtonPassVaultProviderOptions = ProtonCliOptions & {
  /** Personal access token `pst_…::…`, scoped by the customer to vaults or items. */
  token: string;
  valueCacheMs?: number;
  maxItemViewsPerList?: number;
};

export type ProtonPassVaultProvider = VaultProvider & {
  readonly id: "protonpass";
  /** Logs the CLI session out and wipes its private state directory. */
  close(): Promise<void>;
};

/** Proton share and item ids are URL-safe base64; anything else cannot exist. */
const PROTON_ID = /^[A-Za-z0-9_=+/][A-Za-z0-9_=+/-]{0,255}$/;
function assertIds(...ids: string[]) {
  for (const id of ids) {
    if (!PROTON_ID.test(id)) {
      throw new VaultProviderError("provider_not_found", "No such Proton Pass vault or item");
    }
  }
}

const TOKEN_SHAPE = /^[\x21-\x7e]{8,4096}$/;

type CachedDetails = { at: number; details: Promise<ItemDetails> };
const attemptCaches = new WeakMap<ProviderCallBudget, Map<string, CachedDetails>>();

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
  if (field.remove) refuse("Proton Pass items cannot have fields removed from Opengeni");
  const value = field.value ?? "";
  if (utf8Bytes(value) > VAULT_LIMITS.textValueMaxBytes) {
    refuse(`The value of "${field.name}" is larger than Opengeni stores`);
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
  kind: "login" | "note" | "custom";
  template: Record<string, unknown>;
  /** The same content as an Item, for metadata when the follow-up read fails. */
  synthetic: Item["content"]["content"];
  note: string;
  extraSections: Array<{ section_name: string; section_fields: Item["content"]["extra_fields"] }>;
};

/** Builds the `--from-template -` JSON for a create; values travel only on stdin. */
export function planCreate(item: ProviderWriteItem): CreatePlan {
  const title = item.name;
  if (item.type === "login") {
    let username: string | null = null;
    let email: string | null = null;
    let password: string | null = null;
    let totp: string | null = null;
    const concealed = item.fields.filter((field) => field.kind === "concealed");
    for (const field of item.fields) {
      const key = nameKey(field.name);
      if (field.kind === "totp") {
        if (totp !== null) refuse("Proton Pass logins hold one one-time password");
        totp = totpValue(field, title);
      } else if (field.kind === "text" && key === "username" && username === null) {
        username = fieldValue(field);
      } else if (field.kind === "text" && key === "email" && email === null) {
        email = fieldValue(field);
      } else if (
        field.kind === "concealed" &&
        password === null &&
        (key === "password" || concealed.length === 1)
      ) {
        password = fieldValue(field);
      } else {
        refuse(
          `Proton Pass logins created from Opengeni hold a username, email, password and one one-time password; "${field.name}" needs an API key (custom) item`,
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
    return {
      kind: "note",
      template: { title, note },
      synthetic: { Note: null },
      note,
      extraSections: [],
    };
  }
  if (item.type === "api_key") {
    const fields = item.fields.map((field) => {
      if (field.kind === "file") refuse("Proton Pass files cannot be written from Opengeni");
      const fieldType =
        field.kind === "totp" ? "totp" : field.kind === "concealed" ? "hidden" : "text";
      const value = field.kind === "totp" ? totpValue(field, title) : fieldValue(field);
      return { field_name: field.name, field_type: fieldType, value };
    });
    const sections = fields.length ? [{ section_name: "Fields", fields }] : [];
    return {
      kind: "custom",
      template: { title, note: null, sections },
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
      note: "",
      extraSections: [],
    };
  }
  return refuse(
    item.type === "passkey"
      ? "Passkeys live only in Opengeni vaults"
      : "Proton Pass file items cannot be created from Opengeni",
  );
}

const CREATE_CONTEXT = {
  login: /Error creating login item/,
  note: /Error creating note item/,
  custom: /Error creating custom item/,
} as const;

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
        "pass-cli returned output this Opengeni release does not understand",
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
      refuse(`"${field.name}" is larger than Opengeni reads from Proton Pass`);
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
        refuse(`"${field.name}" is larger than Opengeni reads from Proton Pass`);
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

    capabilities(): VaultProviderCapabilities {
      return {
        write: true,
        createVault: false,
        totp: true,
        // Legacy flag means file writes; reads are declared in operations.readFiles.
        files: false,
        groupGrants: false,
        passkeys: false,
        operations: {
          ...PROTON_PASS_OPERATIONS,
          createItemTypes: [...PROTON_PASS_OPERATIONS.createItemTypes],
        },
      };
    },

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
        const withFiles = list.items.filter((item) => item.flags.includes(ITEM_HAS_FILES));
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

    async writeItem(ctx, externalVaultId, item): Promise<ProviderItemMeta> {
      assertIds(externalVaultId);
      if (item.externalItemId !== undefined) {
        throw new VaultProviderError(
          "provider_unavailable",
          "Proton Pass items cannot be updated from Opengeni: pass-cli 2.4.2 takes new values only as command-line arguments and cannot edit one-time passwords",
        );
      }
      if (shareAccess.get(externalVaultId) === "read_only") {
        throw new VaultProviderError(
          "provider_permission_denied",
          "The Proton Pass token can only read this vault",
        );
      }
      const plan = planCreate(item);
      const stdout = await cli(ctx, "write", {
        args: [
          "item",
          "create",
          plan.kind,
          `--share-id=${externalVaultId}`,
          "--from-template",
          "-",
        ],
        stdin: JSON.stringify(plan.template),
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
  return provider;
}

function incomplete(): never {
  throw new VaultProviderError(
    "provider_inventory_incomplete",
    "The Proton Pass vault has more items than Opengeni mirrors at once",
  );
}
