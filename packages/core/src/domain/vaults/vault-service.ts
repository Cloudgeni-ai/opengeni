/**
 * Vault service for people and API keys (routes) and for agents (secret
 * tools). Routes check the permission each operation needs; the database
 * routines decide reach (who sees which vault) and integrity. This layer
 * encrypts values before writes, decrypts display values after reads, and
 * maps rows to the contract shapes.
 */
import {
  generatePassword,
  isValidTotpInput,
  parseSecretReference,
  parseTotpInput,
  secretNameKey,
  SecretReferenceError,
  totpCodeSync,
  totpRemainingMs,
  systemSecretClock,
  VAULT_LIMITS,
  type CreateVaultItemRequest,
  type CreateVaultRequest,
  type ListVaultItemsQuery,
  type MoveVaultItemRequest,
  type RevealVaultFieldRequest,
  type RevealVaultFieldResponse,
  type SecretDeleteInput,
  type SecretDeleteOutput,
  type SecretGetInput,
  type SecretMoveInput,
  type SecretMoveOutput,
  type SecretPrincipal,
  type SecretSaveInput,
  type SecretSaveOutput,
  type SecretSearchInput,
  type SecretSearchOutput,
  type SessionSecretsView,
  type UpdateVaultItemRequest,
  type UpdateVaultRequest,
  type VaultFieldInput,
  type VaultFieldKind,
  type VaultFieldVersionMeta,
  type VaultItem,
  type VaultItemSummary,
  type VaultPolicy,
  type VaultSummary,
  type VaultVersionCreatedByKind,
} from "@opengeni/contracts";
import {
  archiveVaultItem,
  createVault,
  decryptEnvironmentValue,
  deleteVault,
  deleteVaultItemPermanently,
  encryptEnvironmentValue,
  ensureDefaultVault,
  ensureTaskVault,
  getSession,
  getSessionSecretsView,
  getVault,
  getVaultItem,
  listVaultFieldVersions,
  listVaultItems,
  listVaultsForSubject,
  moveVaultItem,
  readVaultFieldCiphertext,
  resolveSecretReferenceCandidates,
  restoreVaultItem,
  setSessionVaultPolicy,
  updateVault,
  upsertVaultItem,
  VaultError,
  type SessionSecretsViewRow,
  type VaultDbContext,
  type VaultFieldCiphertext,
  type VaultFieldWrite,
  type VaultItemRow,
  type VaultItemWrite,
  type VaultRow,
} from "@opengeni/db";
import {
  createProviderCallBudget,
  EMPTY_VAULT_PROVIDER_REGISTRY,
  isVaultProviderError,
} from "@opengeni/vaults";
import { hasPermission } from "../../access";
import {
  toVaultItem,
  toVaultItemSummary,
  toVaultSummary,
  vaultItemReferences,
  type VaultCallerAuthority,
} from "./mapping";
import { vaultErrorCodeForProvider } from "./provider-registry";
import {
  archiveProviderVaultItem,
  writeProviderVaultItem,
  type ProviderWriteDeps,
} from "./provider-writes";
import { chooseSecretCandidate, createSecretResolver } from "./secret-resolver";
import type { VaultRequestActor, VaultServiceDeps } from "./types";

export interface VaultService {
  list(actor: VaultRequestActor, workspaceId: string): Promise<VaultSummary[]>;
  get(actor: VaultRequestActor, workspaceId: string, vaultId: string): Promise<VaultSummary>;
  create(
    actor: VaultRequestActor,
    workspaceId: string,
    req: CreateVaultRequest,
  ): Promise<VaultSummary>;
  update(
    actor: VaultRequestActor,
    workspaceId: string,
    vaultId: string,
    req: UpdateVaultRequest,
  ): Promise<VaultSummary>;
  remove(
    actor: VaultRequestActor,
    workspaceId: string,
    vaultId: string,
    confirmName: string,
  ): Promise<void>;
  listItems(
    actor: VaultRequestActor,
    workspaceId: string,
    vaultId: string,
    q: ListVaultItemsQuery,
  ): Promise<{ items: VaultItemSummary[]; nextCursor: string | null }>;
  getItem(actor: VaultRequestActor, workspaceId: string, itemId: string): Promise<VaultItem>;
  createItem(
    actor: VaultRequestActor,
    workspaceId: string,
    vaultId: string,
    req: CreateVaultItemRequest,
  ): Promise<VaultItem>;
  updateItem(
    actor: VaultRequestActor,
    workspaceId: string,
    itemId: string,
    req: UpdateVaultItemRequest,
  ): Promise<VaultItem>;
  archiveItem(actor: VaultRequestActor, workspaceId: string, itemId: string): Promise<void>;
  restoreItem(actor: VaultRequestActor, workspaceId: string, itemId: string): Promise<VaultItem>;
  deleteItemPermanently(
    actor: VaultRequestActor,
    workspaceId: string,
    itemId: string,
  ): Promise<void>;
  moveItem(
    actor: VaultRequestActor,
    workspaceId: string,
    itemId: string,
    req: MoveVaultItemRequest,
  ): Promise<VaultItem>;
  revealField(
    actor: VaultRequestActor,
    workspaceId: string,
    fieldId: string,
    req: RevealVaultFieldRequest & { itemId?: string },
  ): Promise<RevealVaultFieldResponse>;
  listFieldVersions(
    actor: VaultRequestActor,
    workspaceId: string,
    fieldId: string,
  ): Promise<VaultFieldVersionMeta[]>;
  restoreFieldVersion(
    actor: VaultRequestActor,
    workspaceId: string,
    itemId: string,
    fieldId: string,
    version: number,
  ): Promise<VaultItem>;
  sessionSecrets(
    actor: VaultRequestActor,
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionSecretsView>;
  setSessionPolicy(
    actor: VaultRequestActor,
    workspaceId: string,
    sessionId: string,
    policy: VaultPolicy,
  ): Promise<SessionSecretsView>;
  // Agent paths (the secret_* tools).
  searchForAgent(principal: SecretPrincipal, input: SecretSearchInput): Promise<SecretSearchOutput>;
  saveForAgent(principal: SecretPrincipal, input: SecretSaveInput): Promise<SecretSaveOutput>;
  moveForAgent(principal: SecretPrincipal, input: SecretMoveInput): Promise<SecretMoveOutput>;
  archiveForAgent(
    principal: SecretPrincipal,
    input: SecretDeleteInput,
  ): Promise<SecretDeleteOutput>;
  readForAgent(
    principal: SecretPrincipal,
    input: SecretGetInput,
    permissions: readonly string[],
  ): Promise<RevealVaultFieldResponse>;
}

function subjectContext(actor: VaultRequestActor, workspaceId: string): VaultDbContext {
  return {
    kind: "subject",
    accountId: actor.grant.accountId,
    workspaceId,
    subjectId: actor.grant.subjectId,
  };
}

function principalContext(principal: SecretPrincipal): VaultDbContext {
  return { kind: "principal", principal };
}

function authorityOf(actor: VaultRequestActor): VaultCallerAuthority {
  return {
    write: hasPermission(actor.grant.permissions, "secrets:write", actor.grant.permissionMode),
    accountAdmin: actor.accountAdmin,
  };
}

/** API keys and configured keys are not people. */
export function vaultActorIsApiKey(actor: VaultRequestActor): boolean {
  return actor.grant.principalKind === "api_key" || actor.grant.principalKind === "configured_key";
}

function createdByKind(actor: VaultRequestActor): VaultVersionCreatedByKind {
  return vaultActorIsApiKey(actor) ? "api_key" : "human";
}

function utf8Size(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function requireKey(deps: VaultServiceDeps): Uint8Array {
  if (deps.encryptionKey === null) {
    throw new VaultError(
      "encryption_key_missing",
      "vaults require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    );
  }
  return deps.encryptionKey;
}

function defaultFieldKind(name: string): VaultFieldKind {
  return ["username", "user", "email", "login", "account", "rpid"].includes(secretNameKey(name))
    ? "text"
    : "concealed";
}

type FieldSource = {
  fieldId?: string | undefined;
  name: string;
  kind?: VaultFieldKind | undefined;
  value?: string | undefined;
  generate?: VaultFieldInput["generate"] | undefined;
  fromReference?: string | undefined;
  fileBase64?: string | undefined;
  fileName?: string | undefined;
  restoreVersion?: number | undefined;
  remove?: true | undefined;
};

type ItemSource = {
  type?: CreateVaultItemRequest["type"] | undefined;
  name?: string | undefined;
  websites?: string[] | undefined;
  expiresAt?: string | null | undefined;
  primaryFieldName?: string | undefined;
  fields?: FieldSource[] | undefined;
};

export function createVaultService(deps: VaultServiceDeps): VaultService {
  const clock = deps.clock ?? systemSecretClock;

  /** Encrypt one field input into the routine's write shape. */
  async function fieldWrite(
    input: FieldSource,
    existing: VaultItemRow | null,
    resolveReference: (raw: string) => Promise<string>,
    generated: string[],
  ): Promise<VaultFieldWrite> {
    const current = existing?.fields.find(
      (field) =>
        (input.fieldId !== undefined && field.id === input.fieldId) ||
        secretNameKey(field.name) === secretNameKey(input.name),
    );
    const name = current?.name ?? input.name;
    const write: VaultFieldWrite = { name };
    if (current) write.fieldId = current.id;
    if (current && current.name !== input.name) write.newName = input.name;
    if (input.remove) return { ...write, remove: true };
    if (input.restoreVersion !== undefined)
      return { ...write, restoreVersion: input.restoreVersion };
    let kind: VaultFieldKind = input.kind ?? current?.kind ?? defaultFieldKind(input.name);
    let plaintext: string;
    let size: number;
    if (input.fileBase64 !== undefined) {
      kind = "file";
      const bytes = Buffer.from(input.fileBase64, "base64");
      plaintext = bytes.toString("base64");
      size = bytes.byteLength;
      if (input.fileName !== undefined) write.fileName = input.fileName;
    } else if (input.generate !== undefined) {
      plaintext = generatePassword(input.generate);
      size = utf8Size(plaintext);
      generated.push(input.name);
    } else if (input.fromReference !== undefined) {
      plaintext = await resolveReference(input.fromReference);
      size = utf8Size(plaintext);
    } else {
      plaintext = input.value ?? "";
      size = utf8Size(plaintext);
    }
    if (kind === "totp") {
      if (!isValidTotpInput(plaintext)) {
        throw new VaultError(
          "invalid_secret_name",
          `${input.name} is not a valid two-factor setup key or otpauth:// link`,
          { field: input.name },
        );
      }
      plaintext = plaintext.trim();
    }
    const limit = kind === "file" ? VAULT_LIMITS.fileValueMaxBytes : VAULT_LIMITS.textValueMaxBytes;
    if (size > limit) {
      throw new VaultError(
        "secret_value_too_large",
        `${input.name} is larger than ${limit} bytes`,
        {
          field: input.name,
          limit,
        },
      );
    }
    return {
      ...write,
      kind,
      valueEncrypted: encryptEnvironmentValue(requireKey(deps), plaintext),
      valueSize: size,
    };
  }

  /** `fromReference` for people: resolve with their reach, audited as a use. */
  function humanReferenceResolver(actor: VaultRequestActor, workspaceId: string) {
    return async (raw: string): Promise<string> =>
      await resolveTextReference(
        {
          kind: "human",
          accountId: actor.grant.accountId,
          workspaceId,
          subjectId: actor.grant.subjectId,
          verifiedHuman: !vaultActorIsApiKey(actor),
          viaApiKey: vaultActorIsApiKey(actor),
        },
        raw,
        "vault_item_copy",
      );
  }

  async function resolveTextReference(
    principal: SecretPrincipal,
    raw: string,
    toolName: string,
  ): Promise<string> {
    let reference;
    try {
      reference = parseSecretReference(raw);
    } catch (error) {
      throw new VaultError(
        "invalid_secret_name",
        `fromReference is not a valid reference: ${raw}`,
        {
          reason: error instanceof Error ? error.message : "invalid",
        },
      );
    }
    const resolver = createSecretResolver(deps, principal, { capabilityEnabled: true });
    const values = await resolver.resolve([reference], {
      surface: principal.kind === "attempt" ? "mcp" : "human_reveal",
      toolName,
    });
    const value = [...values.values()][0]!;
    if (value.material.type === "text") return value.material.value;
    if (value.material.type === "bytes") return Buffer.from(value.material.value).toString("utf8");
    return totpCodeSync(value.material.params, clock.now());
  }

  async function itemWrite(
    req: ItemSource,
    existing: VaultItemRow | null,
    resolveReference: (raw: string) => Promise<string>,
    createdBy: VaultVersionCreatedByKind,
    generated: string[] = [],
  ): Promise<VaultItemWrite> {
    const write: VaultItemWrite = { createdByKind: createdBy };
    if (req.name !== undefined) write.name = req.name;
    if (req.type !== undefined) write.type = req.type;
    if (req.websites !== undefined) write.websites = req.websites;
    if (req.expiresAt !== undefined) write.expiresAt = req.expiresAt;
    if (req.primaryFieldName !== undefined) write.primaryFieldName = req.primaryFieldName;
    if (req.fields !== undefined) {
      write.fields = [];
      for (const field of req.fields) {
        write.fields.push(await fieldWrite(field, existing, resolveReference, generated));
      }
    }
    return write;
  }

  function providerWriteDeps(actor: VaultRequestActor, workspaceId: string): ProviderWriteDeps {
    return {
      db: deps.db,
      context: subjectContext(actor, workspaceId),
      providers: deps.providers ?? EMPTY_VAULT_PROVIDER_REGISTRY,
      resolveReference: humanReferenceResolver(actor, workspaceId),
    };
  }

  function key(): Uint8Array | null {
    return deps.encryptionKey;
  }

  function toItem(row: VaultItemRow): VaultItem {
    return toVaultItem(row, key());
  }

  async function revealFromCiphertext(
    read: VaultFieldCiphertext,
  ): Promise<RevealVaultFieldResponse> {
    let plaintext: string;
    let encoding: "utf8" | "base64" = read.kind === "file" ? "base64" : "utf8";
    if (read.source === "opengeni") {
      if (read.valueEncrypted === null) {
        throw new VaultError("vault_field_not_found", "the field has no value at that version");
      }
      plaintext = decryptEnvironmentValue(requireKey(deps), read.valueEncrypted);
    } else {
      try {
        const provider = await (deps.providers ?? EMPTY_VAULT_PROVIDER_REGISTRY).forVault({
          source: read.source,
          providerConnectionId: read.providerConnectionId,
        });
        // Providers charge the budget per call themselves.
        const budget = createProviderCallBudget(VAULT_LIMITS.providerReadsPerAttempt);
        const [value] = await provider.readFields(
          { connectionId: read.providerConnectionId, budget },
          read.providerVaultRef ?? "",
          read.providerItemRef ?? "",
          [read.providerFieldRef ?? ""],
        );
        if (!value)
          throw new VaultError("vault_field_not_found", "the connected vault has no value");
        if (value.material.type === "bytes") {
          plaintext = Buffer.from(value.material.value).toString("base64");
          encoding = "base64";
        } else if (value.material.type === "text") {
          plaintext = value.material.value;
        } else {
          plaintext = value.material.params.secretBase32;
        }
      } catch (error) {
        if (isVaultProviderError(error)) {
          throw new VaultError(vaultErrorCodeForProvider(error.code, "read"), error.message);
        }
        throw error;
      }
    }
    let totp: RevealVaultFieldResponse["totp"] = null;
    if (read.kind === "totp" && isValidTotpInput(plaintext)) {
      const params = parseTotpInput(plaintext);
      const now = clock.now();
      totp = {
        code: totpCodeSync(params, now),
        periodSeconds: params.periodSeconds,
        expiresAt: new Date(now + totpRemainingMs(params, now)).toISOString(),
      };
    }
    return { value: plaintext, encoding, version: read.version, totp };
  }

  function toSessionView(
    row: SessionSecretsViewRow,
    actor: VaultCallerAuthority,
    capabilityEnabled: boolean,
  ): SessionSecretsView {
    return {
      capabilityEnabled,
      policy: row.policy,
      effectiveVaultIds: row.effectiveVaultIds,
      narrowedBySessionId: row.narrowedBySessionId,
      taskVault: row.taskVault ? toVaultSummary(row.taskVault, actor) : null,
      taskItems: row.taskItems.map((item) => toVaultItemSummary(item, key())),
      reachableVaults: row.reachableVaults.map((vault) => ({
        ...toVaultSummary(vault, actor),
        selected: vault.selected,
        selectable: vault.selectable,
      })),
    };
  }

  async function sessionCapabilityEnabled(
    workspaceId: string,
    sessionId: string,
  ): Promise<boolean> {
    const session = await getSession(deps.db, workspaceId, sessionId);
    return session?.agent?.capabilities.secrets ?? true;
  }

  /** A reachable vault by ID or name for an agent (names: current names first). */
  async function agentVault(principal: SecretPrincipal, nameOrId: string): Promise<VaultRow> {
    const vaults = await listVaultsForSubject(deps.db, principalContext(principal), {
      workspaceId: principal.workspaceId,
    });
    const byId = vaults.find((vault) => vault.id === nameOrId.toLowerCase());
    if (byId) return byId;
    const matches = vaults.filter((vault) => secretNameKey(vault.name) === secretNameKey(nameOrId));
    if (matches.length === 0) {
      throw new VaultError("vault_not_found", `no reachable vault is named ${nameOrId}`);
    }
    const lowest = Math.min(...matches.map((vault) => vault.tier));
    const best = matches.filter((vault) => vault.tier === lowest);
    if (best.length > 1) {
      throw new VaultError(
        "vault_name_conflict",
        `${best.length} vaults are named ${nameOrId}; use the vault ID`,
        {
          vaultIds: best.map((vault) => vault.id),
        },
      );
    }
    return best[0]!;
  }

  /** The one item a reference names, for agent tools that act on items. */
  async function agentItemByReference(
    principal: SecretPrincipal,
    raw: string,
  ): Promise<{ itemId: string; fieldId: string | null; version: number | null }> {
    let reference;
    try {
      reference = parseSecretReference(raw.startsWith("{{") ? raw : `{{secret:${raw}}}`);
    } catch {
      throw new SecretReferenceError(
        [{ raw, code: "invalid_reference", message: "not a valid secret reference" }],
        null,
      );
    }
    const { meta, candidates } = await resolveSecretReferenceCandidates(
      deps.db,
      principalContext(principal),
      {
        refs: [
          reference.target.form === "id"
            ? {
                index: 0,
                form: "id",
                itemId: reference.target.itemId,
                field: reference.target.field,
                otp: reference.otp,
                previous: reference.previous,
              }
            : {
                index: 0,
                form: "path",
                segments: [...reference.target.segments],
                otp: reference.otp,
                previous: reference.previous,
              },
        ],
      },
    );
    const outcome = chooseSecretCandidate(reference, candidates, meta);
    if ("failure" in outcome) throw new SecretReferenceError([outcome.failure], null);
    return {
      itemId: outcome.candidate.itemId,
      fieldId: outcome.candidate.fieldId,
      version: outcome.candidate.version,
    };
  }

  async function agentSaveVault(
    principal: SecretPrincipal,
    input: SecretSaveInput,
  ): Promise<VaultRow> {
    const context = principalContext(principal);
    if (input.vault !== undefined) return await agentVault(principal, input.vault);
    const saveTo = input.saveTo ?? "user";
    if (saveTo === "task") {
      if (principal.kind !== "attempt") {
        throw new VaultError("secret_save_forbidden", "only agent runs have a task vault");
      }
      return await ensureTaskVault(deps.db, context, {
        workspaceId: principal.workspaceId,
        sessionId: principal.sessionId,
      });
    }
    try {
      return await ensureDefaultVault(deps.db, context, {
        workspaceId: principal.workspaceId,
        ownerKind: saveTo,
      });
    } catch (error) {
      // No acting person: "Only me" falls back to the workspace vault.
      if (input.saveTo === undefined && error instanceof VaultError) {
        return await ensureDefaultVault(deps.db, context, {
          workspaceId: principal.workspaceId,
          ownerKind: "workspace",
        });
      }
      throw error;
    }
  }

  return {
    async list(actor, workspaceId) {
      const rows = await listVaultsForSubject(deps.db, subjectContext(actor, workspaceId), {
        workspaceId,
      });
      const authority = authorityOf(actor);
      return rows.map((row) => toVaultSummary(row, authority));
    },

    async get(actor, workspaceId, vaultId) {
      const rows = await listVaultsForSubject(deps.db, subjectContext(actor, workspaceId), {
        workspaceId,
      });
      const row = rows.find((candidate) => candidate.id === vaultId);
      if (!row) throw new VaultError("vault_not_found", "vault not found", { vaultId });
      return toVaultSummary(row, authorityOf(actor));
    },

    async create(actor, workspaceId, req) {
      if (req.ownerKind === "organization" && !actor.accountAdmin) {
        throw new VaultError("vault_permission_denied", "organization vaults need account:admin");
      }
      const row = await createVault(deps.db, subjectContext(actor, workspaceId), {
        name: req.name,
        description: req.description ?? null,
        ownerKind: req.ownerKind,
        ...(req.availability ? { availability: req.availability } : {}),
        allowOrganization: actor.accountAdmin,
      });
      return toVaultSummary(row, authorityOf(actor));
    },

    async update(actor, workspaceId, vaultId, req) {
      const row = await updateVault(deps.db, subjectContext(actor, workspaceId), {
        vaultId,
        expectedGeneration: req.expectedGeneration,
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.description !== undefined ? { description: req.description } : {}),
        ...(req.availability !== undefined ? { availability: req.availability } : {}),
        allowOrganization: actor.accountAdmin,
      });
      return toVaultSummary(row, authorityOf(actor));
    },

    async remove(actor, workspaceId, vaultId, confirmName) {
      await deleteVault(deps.db, subjectContext(actor, workspaceId), {
        vaultId,
        confirmName,
        allowOrganization: actor.accountAdmin,
      });
    },

    async listItems(actor, workspaceId, vaultId, q) {
      const result = await listVaultItems(deps.db, subjectContext(actor, workspaceId), {
        vaultId,
        ...(q.q !== undefined ? { q: q.q } : {}),
        ...(q.type !== undefined ? { type: q.type } : {}),
        ...(q.includeArchived !== undefined ? { includeArchived: q.includeArchived } : {}),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      return {
        items: result.items.map((item) => toVaultItemSummary(item, key())),
        nextCursor: result.nextCursor,
      };
    },

    async getItem(actor, workspaceId, itemId) {
      return toItem(await getVaultItem(deps.db, subjectContext(actor, workspaceId), { itemId }));
    },

    async createItem(actor, workspaceId, vaultId, req) {
      const context = subjectContext(actor, workspaceId);
      const vault = await getVault(deps.db, context, { vaultId });
      if (vault.source !== "opengeni") {
        // W5: connected read-write vaults change through their provider.
        const itemId = await writeProviderVaultItem(providerWriteDeps(actor, workspaceId), {
          vault,
          existing: null,
          change: req,
        });
        return toItem(await getVaultItem(deps.db, context, { itemId }));
      }
      const write = await itemWrite(
        req,
        null,
        humanReferenceResolver(actor, workspaceId),
        createdByKind(actor),
      );
      return toItem(
        await upsertVaultItem(deps.db, subjectContext(actor, workspaceId), {
          ...write,
          vaultId,
          mode: "create",
        }),
      );
    },

    async updateItem(actor, workspaceId, itemId, req) {
      const context = subjectContext(actor, workspaceId);
      const existing = await getVaultItem(deps.db, context, { itemId });
      const { expectedGeneration, ...changes } = req;
      if (existing.vaultSource !== "opengeni") {
        const vault = await getVault(deps.db, context, { vaultId: existing.vaultId });
        const updatedId = await writeProviderVaultItem(providerWriteDeps(actor, workspaceId), {
          vault,
          existing: {
            itemId,
            name: existing.name,
            type: existing.type,
            websites: existing.websites,
            fields: existing.fields,
            expectedGeneration,
          },
          change: changes,
        });
        return toItem(await getVaultItem(deps.db, context, { itemId: updatedId }));
      }
      const write = await itemWrite(
        changes,
        existing,
        humanReferenceResolver(actor, workspaceId),
        createdByKind(actor),
      );
      return toItem(
        await upsertVaultItem(deps.db, context, { ...write, itemId, expectedGeneration }),
      );
    },

    async archiveItem(actor, workspaceId, itemId) {
      const context = subjectContext(actor, workspaceId);
      const existing = await getVaultItem(deps.db, context, { itemId });
      if (existing.vaultSource !== "opengeni") {
        const vault = await getVault(deps.db, context, { vaultId: existing.vaultId });
        await archiveProviderVaultItem(providerWriteDeps(actor, workspaceId), { vault, itemId });
        return;
      }
      await archiveVaultItem(deps.db, context, { itemId });
    },

    async restoreItem(actor, workspaceId, itemId) {
      return toItem(
        await restoreVaultItem(deps.db, subjectContext(actor, workspaceId), { itemId }),
      );
    },

    async deleteItemPermanently(actor, workspaceId, itemId) {
      await deleteVaultItemPermanently(deps.db, subjectContext(actor, workspaceId), { itemId });
    },

    async moveItem(actor, workspaceId, itemId, req) {
      return toItem(
        await moveVaultItem(deps.db, subjectContext(actor, workspaceId), {
          itemId,
          targetVaultId: req.targetVaultId,
          mode: req.mode,
          ...(req.newName !== undefined ? { newName: req.newName } : {}),
        }),
      );
    },

    async revealField(actor, workspaceId, fieldId, req) {
      const read = await readVaultFieldCiphertext(deps.db, subjectContext(actor, workspaceId), {
        fieldId,
        ...(req.version !== undefined ? { version: req.version } : {}),
        purpose: "reveal",
        metadata: { viaApiKey: vaultActorIsApiKey(actor) },
      });
      if (req.itemId !== undefined && read.itemId !== req.itemId) {
        throw new VaultError("vault_field_not_found", "field not found", { fieldId });
      }
      return await revealFromCiphertext(read);
    },

    async listFieldVersions(actor, workspaceId, fieldId) {
      return await listVaultFieldVersions(deps.db, subjectContext(actor, workspaceId), { fieldId });
    },

    async restoreFieldVersion(actor, workspaceId, itemId, fieldId, version) {
      const context = subjectContext(actor, workspaceId);
      const existing = await getVaultItem(deps.db, context, { itemId });
      const field = existing.fields.find((candidate) => candidate.id === fieldId);
      if (!field) throw new VaultError("vault_field_not_found", "field not found", { fieldId });
      return toItem(
        await upsertVaultItem(deps.db, context, {
          itemId,
          createdByKind: createdByKind(actor),
          fields: [{ fieldId, name: field.name, restoreVersion: version }],
        }),
      );
    },

    async sessionSecrets(actor, workspaceId, sessionId) {
      const row = await getSessionSecretsView(deps.db, subjectContext(actor, workspaceId), {
        sessionId,
      });
      return toSessionView(
        row,
        authorityOf(actor),
        await sessionCapabilityEnabled(workspaceId, sessionId),
      );
    },

    async setSessionPolicy(actor, workspaceId, sessionId, policy) {
      const row = await setSessionVaultPolicy(deps.db, subjectContext(actor, workspaceId), {
        sessionId,
        policy,
      });
      return toSessionView(
        row,
        authorityOf(actor),
        await sessionCapabilityEnabled(workspaceId, sessionId),
      );
    },

    async searchForAgent(principal, input) {
      const context = principalContext(principal);
      let vaults = await listVaultsForSubject(deps.db, context, {
        workspaceId: principal.workspaceId,
      });
      if (input.vault !== undefined) vaults = [await agentVault(principal, input.vault)];
      vaults.sort((left, right) => left.tier - right.tier || left.name.localeCompare(right.name));
      const limit = input.limit ?? 20;
      const website = input.website?.trim().toLowerCase();
      const hostOf = (value: string) => {
        try {
          return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(
            /^www\./,
            "",
          );
        } catch {
          return value.toLowerCase();
        }
      };
      const wantedHost = website ? hostOf(website) : null;
      const items: SecretSearchOutput["items"] = [];
      let truncated = false;
      for (const vault of vaults) {
        const page = await listVaultItems(deps.db, context, {
          vaultId: vault.id,
          ...(input.query !== undefined ? { q: input.query } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          limit: VAULT_LIMITS.searchResultsMax,
        });
        if (page.nextCursor !== null) truncated = true;
        for (const row of page.items) {
          if (
            wantedHost !== null &&
            !row.websites.some((site) => {
              const host = hostOf(site);
              return (
                host === wantedHost ||
                wantedHost.endsWith(`.${host}`) ||
                host.endsWith(`.${wantedHost}`)
              );
            })
          ) {
            continue;
          }
          if (items.length >= limit) {
            truncated = true;
            break;
          }
          const summary = toVaultItemSummary(row, key());
          items.push({
            vault: {
              id: vault.id,
              name: vault.name,
              ownerKind: vault.ownerKind,
              source: vault.source,
              mode: vault.mode,
            },
            item: {
              id: row.id,
              name: row.name,
              type: row.type,
              websites: row.websites,
              username: summary.username,
              hasTotp: summary.hasTotp,
              hasPasskey: summary.hasPasskey,
              expiresAt: row.expiresAt,
            },
            fields: row.fields.map((field) => ({ name: field.name, kind: field.kind })),
            references: summary.references,
          });
        }
        if (items.length >= limit && truncated) break;
      }
      return { items, truncated };
    },

    async saveForAgent(principal, input) {
      const context = principalContext(principal);
      const vault = await agentSaveVault(principal, input);
      const existingPage = await listVaultItems(deps.db, context, {
        vaultId: vault.id,
        q: input.item,
        limit: VAULT_LIMITS.searchResultsMax,
      });
      const existing =
        existingPage.items.find((item) => secretNameKey(item.name) === secretNameKey(input.item)) ??
        null;
      if (input.mode === "create" && existing) {
        throw new VaultError(
          "vault_item_name_conflict",
          `${vault.name} already has an item named ${input.item}`,
        );
      }
      if (input.mode === "update" && !existing) {
        throw new VaultError(
          "vault_item_not_found",
          `${vault.name} has no item named ${input.item}`,
        );
      }
      const fullExisting = existing
        ? await getVaultItem(deps.db, context, { itemId: existing.id })
        : null;
      const fields: FieldSource[] = [...(input.fields ?? [])];
      if (input.username !== undefined) {
        fields.unshift({ name: "username", kind: "text", value: input.username });
      }
      const generated: string[] = [];
      const write = await itemWrite(
        {
          ...(existing ? {} : { type: input.type, name: input.item }),
          ...(input.websites !== undefined ? { websites: input.websites } : {}),
          fields,
        },
        fullExisting,
        (raw) => resolveTextReference(principal, raw, "secret_save"),
        "agent",
        generated,
      );
      const row = await upsertVaultItem(
        deps.db,
        context,
        fullExisting
          ? { ...write, itemId: fullExisting.id }
          : { ...write, vaultId: vault.id, mode: "create" },
      );
      const summary = toVaultItemSummary(row, key());
      return { item: summary, references: vaultItemReferences(row), generatedFields: generated };
    },

    async moveForAgent(principal, input) {
      const context = principalContext(principal);
      const target = await agentItemByReference(principal, input.reference);
      const vault = await agentVault(principal, input.toVault);
      const row = await moveVaultItem(deps.db, context, {
        itemId: target.itemId,
        targetVaultId: vault.id,
        mode: input.mode ?? "move",
        ...(input.newName !== undefined ? { newName: input.newName } : {}),
      });
      return { item: toVaultItemSummary(row, key()), references: vaultItemReferences(row) };
    },

    async archiveForAgent(principal, input) {
      const target = await agentItemByReference(principal, input.reference);
      const row = await archiveVaultItem(deps.db, principalContext(principal), {
        itemId: target.itemId,
      });
      return {
        archived: true,
        restoreHint: `A person can restore ${row.name} from the vault's archived items.`,
      };
    },

    async readForAgent(principal, input, permissions) {
      if (!permissions.includes("secrets:read")) {
        throw new VaultError(
          "vault_permission_denied",
          "reading plaintext needs the secrets:read permission; use references instead",
        );
      }
      const target = await agentItemByReference(principal, input.reference);
      if (target.fieldId === null) {
        throw new VaultError("vault_field_not_found", "the reference names no field");
      }
      const read = await readVaultFieldCiphertext(deps.db, principalContext(principal), {
        fieldId: target.fieldId,
        ...(input.version !== undefined
          ? { version: input.version }
          : target.version !== null
            ? { version: target.version }
            : {}),
        purpose: "agent_read",
        metadata: { reference: input.reference },
      });
      return await revealFromCiphertext(read);
    },
  };
}
