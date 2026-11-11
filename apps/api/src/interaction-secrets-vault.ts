/**
 * The vault-backed `InteractionSecretsPort` (design §10B.4, Q-32, D20): the
 * real secret resolver for agent Browser and Computer actions, and passkey
 * items for the session's virtual authenticators: hosted passkey items, and
 * logins in connected password managers that hold a passkey (read live from
 * the provider, never stored here).
 */
import {
  createProviderCallBudget,
  type ProviderPasskey,
  type VaultProviderRegistry,
} from "@opengeni/vaults";
import {
  type BrowserPasskeyCredential,
  type BrowserPasskeyCredentialMaterial,
  PASSKEY_FIELD_NAMES,
  type SecretPrincipal,
  type SecretResolver,
  secretNameKey,
} from "@opengeni/contracts";
import { createSecretResolver, createVaultService, type VaultService } from "@opengeni/core";
import {
  type Database,
  decryptEnvironmentValue,
  getProviderVaultItemRef,
  getProviderVaultSyncTarget,
  getSession,
  getVaultItem,
  isVaultError,
  leaseVaultPasskeys,
  listSecretApprovalRules,
  readVaultFieldCiphertext,
  releaseVaultPasskeyLeases,
  resolveSecretReferenceCandidates,
  updatePasskeySignCount,
  type VaultItemRow,
} from "@opengeni/db";
import type {
  AttemptSecretPrincipal,
  InteractionPasskeyStore,
  InteractionSecretsPort,
} from "./interaction-secrets";
import { errorMessage } from "@opengeni/contracts/values";

const CAPABILITY_CACHE_MS = 30_000;
const CAPABILITY_CACHE_LIMIT = 512;
const HOLDER_PRINCIPALS_LIMIT = 1_024;
/** Provider reads one lease may make: one per connected login with a passkey. */
const PROVIDER_PASSKEY_READS_PER_LEASE = 32;

type PasskeyFieldName = (typeof PASSKEY_FIELD_NAMES)[number];

const PASSKEY_FIELD_KEYS: ReadonlySet<string> = new Set(PASSKEY_FIELD_NAMES.map(secretNameKey));

/** Why a leased item's passkey was not loaded into the browser. */
export type PasskeyLeaseSkipReason =
  /** A person must approve each use of the whole item (or of the passkey's own fields). */
  | "approval_required"
  /** Secrets are turned off for this chat. */
  | "secrets_disabled"
  /** No connected password manager is reachable from here. */
  | "provider_unavailable"
  /** The item's password manager cannot read passkeys. */
  | "provider_cannot_read_passkeys"
  /** Reading the passkey from the password manager failed. */
  | "provider_read_failed"
  /** The password manager no longer returns a passkey for the item. */
  | "provider_returned_no_passkeys"
  /** A hosted passkey item lacks its rpId, credentialId or privateKey. */
  | "incomplete_passkey";

/**
 * Whether approval rules keep an item's passkey out of the browser. A rule on
 * the whole item does. A rule on one field does only when the passkey uses
 * that field: a hosted passkey item is made of its passkey fields, while a
 * connected login's passkey is read from its password manager and uses none
 * of the login's fields, so asking before its password is used leaves the
 * passkey usable.
 */
function passkeyNeedsApproval(ruleFieldKeys: readonly string[], connected: boolean): boolean {
  return ruleFieldKeys.some((key) => key === "" || (!connected && PASSKEY_FIELD_KEYS.has(key)));
}

function fieldKey(name: string): string {
  return name.toLowerCase();
}

/** `/`, `{`, `}`, `#` and `\` are not allowed in vault names. */
function safeName(value: string): string {
  return value.replace(/[/{}#\\\p{Cc}]/gu, "-").trim();
}

export function passkeyItemName(credential: BrowserPasskeyCredentialMaterial): string {
  const user = credential.userName?.trim() || credential.userDisplayName?.trim() || null;
  return safeName(
    user ? `${credential.rpId} passkey for ${user}` : `${credential.rpId} passkey`,
  ).slice(0, 180);
}

/** base64url without padding, whichever base64 spelling came in. */
function base64url(value: string): string {
  return value.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function clampSignCount(value: number): number {
  return Math.max(0, Math.min(0xffff_ffff, Math.trunc(Number.isFinite(value) ? value : 0)));
}

export function createVaultInteractionSecretsPort(deps: {
  db: Database;
  /** The variable-set envelope key; null fails value reads like the vault API. */
  encryptionKey: Uint8Array | null;
  /** Defaults to a service over the same database and key. */
  vaultService?: VaultService;
  /** Connected vaults (1Password, host) for a workspace's acting subject. */
  providersFor?: (
    workspaceId: string,
    subjectId: string | null,
    principal?: AttemptSecretPrincipal,
  ) => VaultProviderRegistry;
  /** Diagnostics: each lease's outcome (passkeys loaded, items skipped and
   * why) and connected passkeys that could not be read or updated. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}): InteractionSecretsPort {
  const encryptionKey = deps.encryptionKey;
  let service = deps.vaultService ?? null;
  const vaults = (): VaultService =>
    (service ??= createVaultService({ db: deps.db, encryptionKey }));
  const capabilities = new Map<string, { enabled: boolean; at: number }>();
  /** Lease holders to the principal that leased, so a release can be scoped. */
  const holders = new Map<string, AttemptSecretPrincipal>();

  async function secretsEnabled(principal: AttemptSecretPrincipal): Promise<boolean> {
    const cached = capabilities.get(principal.sessionId);
    if (cached && Date.now() - cached.at < CAPABILITY_CACHE_MS) return cached.enabled;
    const session = await getSession(deps.db, principal.workspaceId, principal.sessionId);
    const enabled = session?.agent?.capabilities.secrets ?? true;
    capabilities.delete(principal.sessionId);
    capabilities.set(principal.sessionId, { enabled, at: Date.now() });
    while (capabilities.size > CAPABILITY_CACHE_LIMIT) {
      capabilities.delete(capabilities.keys().next().value!);
    }
    return enabled;
  }

  function context(principal: SecretPrincipal) {
    return { kind: "principal" as const, principal };
  }

  function requireKey(): Uint8Array {
    if (!encryptionKey) throw new Error("vault encryption key is not configured");
    return encryptionKey;
  }

  async function credentialFromItem(
    principal: AttemptSecretPrincipal,
    row: VaultItemRow,
  ): Promise<BrowserPasskeyCredential | null> {
    const values = new Map<PasskeyFieldName, string>();
    for (const name of PASSKEY_FIELD_NAMES) {
      const field = row.fields.find((candidate) => fieldKey(candidate.name) === fieldKey(name));
      if (!field) continue;
      let stored = field.valueEncrypted ?? null;
      if (stored === null) {
        stored = (
          await readVaultFieldCiphertext(deps.db, context(principal), {
            fieldId: field.id,
            purpose: "internal",
            metadata: { surface: "browser", use: "passkey_load" },
          })
        ).valueEncrypted;
      }
      if (stored !== null) values.set(name, decryptEnvironmentValue(requireKey(), stored));
    }
    const rpId = values.get("rpId");
    const credentialId = values.get("credentialId");
    const privateKey = values.get("privateKey");
    if (!rpId || !credentialId || !privateKey) return null;
    return {
      itemId: row.id,
      rpId,
      credentialId,
      userHandle: values.get("userHandle") || null,
      userName: values.get("userName") || null,
      userDisplayName: null,
      privateKey,
      signCount: clampSignCount(Number(row.passkeySignCount ?? 0)),
      ...(values.has("backupEligibility")
        ? { backupEligibility: values.get("backupEligibility") === "true" }
        : {}),
      ...(values.has("backupState") ? { backupState: values.get("backupState") === "true" } : {}),
    };
  }

  /**
   * The provider registry for the person this attempt acts for: a personal
   * password manager connection belongs to them.
   */
  async function providerRegistry(
    principal: AttemptSecretPrincipal,
  ): Promise<VaultProviderRegistry | null> {
    if (!deps.providersFor) return null;
    const { meta } = await resolveSecretReferenceCandidates(deps.db, context(principal), {
      refs: [],
    });
    return deps.providersFor(principal.workspaceId, meta.subjectId, principal);
  }

  /** The connected vault's provider and the item's provider refs. */
  async function providerItem(
    principal: AttemptSecretPrincipal,
    row: VaultItemRow,
    registry: VaultProviderRegistry,
  ) {
    const target = await getProviderVaultSyncTarget(deps.db, context(principal), row.vaultId);
    const ref = await getProviderVaultItemRef(deps.db, context(principal), {
      vaultId: row.vaultId,
      itemId: row.id,
    });
    const provider = await registry.forVault({
      source: target.source,
      providerConnectionId: target.providerConnectionId,
    });
    return { target, ref, provider };
  }

  /**
   * A connected login's passkeys, read live from its password manager. The
   * sign count is the higher of the provider's and the one recorded here, so
   * it keeps rising when the provider cannot store it.
   */
  async function providerCredentials(
    principal: AttemptSecretPrincipal,
    row: VaultItemRow,
    registry: VaultProviderRegistry,
    budget: ReturnType<typeof createProviderCallBudget>,
  ): Promise<BrowserPasskeyCredential[] | "provider_cannot_read_passkeys"> {
    const { target, ref, provider } = await providerItem(principal, row, registry);
    if (!provider.readPasskeys) return "provider_cannot_read_passkeys";
    const passkeys: ProviderPasskey[] = await provider.readPasskeys(
      {
        connectionId: target.providerConnectionId,
        budget,
        cacheEpoch: target.providerCacheEpoch ?? null,
      },
      target.providerVaultRef,
      ref.providerItemRef,
    );
    const recorded = Number(row.passkeySignCount ?? 0);
    return passkeys.map((passkey) => ({
      itemId: row.id,
      rpId: passkey.rpId,
      credentialId: passkey.credentialId,
      userHandle: passkey.userHandle,
      userName: passkey.userName,
      userDisplayName: passkey.userDisplayName,
      privateKey: passkey.privateKey,
      signCount: clampSignCount(Math.max(passkey.signCount, recorded)),
      ...(passkey.backupEligibility !== undefined
        ? { backupEligibility: passkey.backupEligibility }
        : {}),
      ...(passkey.backupState !== undefined ? { backupState: passkey.backupState } : {}),
    }));
  }

  function isConnectedPasskeyItem(row: VaultItemRow): boolean {
    return row.vaultSource !== "opengeni" && (row.providerPasskeys?.length ?? 0) > 0;
  }

  /** The last lease outcome logged per holder, so an unchanged one logs once. */
  const loggedLeases = new Map<string, string>();

  function logLease(
    holder: string,
    credentials: readonly BrowserPasskeyCredential[],
    skipped: ReadonlyArray<{ itemId: string; reason: PasskeyLeaseSkipReason }>,
  ): void {
    if (!deps.log) return;
    const fields = {
      holder,
      loaded: credentials.map(({ itemId, rpId }) => ({ itemId, rpId })),
      skipped,
    };
    const outcome = JSON.stringify(fields);
    if (loggedLeases.get(holder) === outcome) return;
    loggedLeases.delete(holder);
    loggedLeases.set(holder, outcome);
    while (loggedLeases.size > HOLDER_PRINCIPALS_LIMIT) {
      loggedLeases.delete(loggedLeases.keys().next().value!);
    }
    deps.log("browser.passkey.leased", fields);
  }

  const passkeys: InteractionPasskeyStore = {
    async lease(principal, holder, ttlSeconds) {
      holders.delete(holder);
      holders.set(holder, principal);
      while (holders.size > HOLDER_PRINCIPALS_LIMIT) holders.delete(holders.keys().next().value!);
      const itemIds = await leaseVaultPasskeys(deps.db, context(principal), {
        holder,
        ttlSeconds,
      });
      const ruleFieldKeys = new Map<string, string[]>();
      for (const rule of await listSecretApprovalRules(
        deps.db,
        { accountId: principal.accountId, workspaceId: principal.workspaceId },
        itemIds,
      )) {
        ruleFieldKeys.set(rule.itemId, [...(ruleFieldKeys.get(rule.itemId) ?? []), rule.fieldKey]);
      }
      const credentials: BrowserPasskeyCredential[] = [];
      const skipped: Array<{ itemId: string; reason: PasskeyLeaseSkipReason }> = [];
      const skip = (itemId: string, reason: PasskeyLeaseSkipReason) =>
        skipped.push({ itemId, reason });
      let registry: VaultProviderRegistry | null | undefined;
      const budget = createProviderCallBudget(PROVIDER_PASSKEY_READS_PER_LEASE);
      for (const itemId of itemIds) {
        const row = await getVaultItem(deps.db, context(principal), { itemId });
        const connected = isConnectedPasskeyItem(row);
        // A passkey that needs a person's approval for each use is never
        // loaded into a browser without one.
        if (passkeyNeedsApproval(ruleFieldKeys.get(itemId) ?? [], connected)) {
          skip(itemId, "approval_required");
          continue;
        }
        if (connected) {
          if (!(await secretsEnabled(principal))) {
            skip(itemId, "secrets_disabled");
            continue;
          }
          try {
            registry ??= await providerRegistry(principal);
            if (!registry) {
              skip(itemId, "provider_unavailable");
              continue;
            }
            const read = await providerCredentials(principal, row, registry, budget);
            if (typeof read === "string") skip(itemId, read);
            else if (read.length === 0) skip(itemId, "provider_returned_no_passkeys");
            else credentials.push(...read);
          } catch (error) {
            // One unreachable password manager never blocks the other passkeys.
            deps.log?.("browser.passkey.provider_read_failed", {
              itemId,
              message: errorMessage(error),
            });
            skip(itemId, "provider_read_failed");
          }
          continue;
        }
        const credential = await credentialFromItem(principal, row);
        if (credential) credentials.push(credential);
        else skip(itemId, "incomplete_passkey");
      }
      logLease(holder, credentials, skipped);
      return credentials;
    },
    async saveRegistered(principal, { credential, origin }) {
      const fields = [
        { name: "rpId", kind: "text" as const, value: credential.rpId },
        { name: "credentialId", kind: "text" as const, value: credential.credentialId },
        ...(credential.userHandle
          ? [{ name: "userHandle", kind: "text" as const, value: credential.userHandle }]
          : []),
        ...(credential.userName
          ? [{ name: "userName", kind: "text" as const, value: credential.userName }]
          : []),
        { name: "privateKey", kind: "concealed" as const, value: credential.privateKey },
        ...(["backupEligibility", "backupState"] as const).flatMap((name) =>
          credential[name] === undefined
            ? []
            : [{ name, kind: "text" as const, value: String(credential[name]) }],
        ),
      ];
      const base = passkeyItemName(credential);
      let saved: Awaited<ReturnType<VaultService["saveForAgent"]>> | null = null;
      for (const item of [base, `${base} ${credential.credentialId.slice(-6)}`]) {
        try {
          saved = await vaults().saveForAgent(principal, {
            item: safeName(item),
            type: "passkey",
            websites: origin ? [origin] : [`https://${credential.rpId}`],
            fields,
            mode: "create",
          });
          break;
        } catch (error) {
          if (isVaultError(error) && error.code === "vault_item_name_conflict") continue;
          throw error;
        }
      }
      if (!saved) throw new Error("could not name the new passkey item");
      if (credential.signCount > 0) {
        await updatePasskeySignCount(deps.db, context(principal), {
          itemId: saved.item.id,
          count: credential.signCount,
        });
      }
      return { itemId: saved.item.id };
    },
    async updateSignCount(principal, itemId, signCount, credentialId) {
      await updatePasskeySignCount(deps.db, context(principal), { itemId, count: signCount });
      if (credentialId === undefined || !deps.providersFor) return;
      // A connected login's passkey also counts on in its password manager,
      // where the person's own devices use it, unless the vault is linked
      // read-only. Best effort: the count recorded here keeps the next sign-in
      // valid when the provider cannot or may not store it.
      try {
        const row = await getVaultItem(deps.db, context(principal), { itemId });
        if (!isConnectedPasskeyItem(row)) return;
        const registry = await providerRegistry(principal);
        if (!registry) return;
        const { target, ref, provider } = await providerItem(principal, row, registry);
        if (target.mode !== "read_write" || !provider.updatePasskeySignCount) return;
        await provider.updatePasskeySignCount(
          {
            connectionId: target.providerConnectionId,
            budget: createProviderCallBudget(1),
            cacheEpoch: target.providerCacheEpoch ?? null,
          },
          target.providerVaultRef,
          ref.providerItemRef,
          { credentialId: base64url(credentialId), signCount: clampSignCount(signCount) },
        );
      } catch (error) {
        deps.log?.("browser.passkey.provider_sign_count_failed", {
          itemId,
          message: errorMessage(error),
        });
      }
    },
    async release(holder) {
      loggedLeases.delete(holder);
      const principal = holders.get(holder);
      // Without the leasing principal (another API replica or a restart) the
      // lease simply expires after its TTL.
      if (!principal) return;
      holders.delete(holder);
      await releaseVaultPasskeyLeases(deps.db, context(principal), { holder });
    },
  };

  return {
    async resolverFor(principal): Promise<SecretResolver | null> {
      const providersFor = deps.providersFor;
      return createSecretResolver({ db: deps.db, encryptionKey }, principal, {
        capabilityEnabled: await secretsEnabled(principal),
        ...(providersFor
          ? {
              providersForSubject: (subjectId: string | null) =>
                providersFor(principal.workspaceId, subjectId, principal),
            }
          : {}),
      });
    },
    passkeys,
  };
}
