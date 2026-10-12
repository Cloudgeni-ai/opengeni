/**
 * The vault-backed `InteractionSecretsPort` (dossier §10B.4, Q-32, D20): the
 * real secret resolver for agent Browser and Computer actions, and passkey
 * items for the session's virtual authenticators.
 */
import {
  type BrowserPasskeyCredential,
  type BrowserPasskeyCredentialMaterial,
  PASSKEY_FIELD_NAMES,
  type SecretPrincipal,
  type SecretResolver,
} from "@opengeni/contracts";
import { createSecretResolver, createVaultService, type VaultService } from "@opengeni/core";
import {
  type Database,
  decryptEnvironmentValue,
  getSession,
  getVaultItem,
  isVaultError,
  leaseVaultPasskeys,
  readVaultFieldCiphertext,
  releaseVaultPasskeyLeases,
  updatePasskeySignCount,
  type VaultItemRow,
} from "@opengeni/db";
import type {
  AttemptSecretPrincipal,
  InteractionPasskeyStore,
  InteractionSecretsPort,
} from "./interaction-secrets";

const CAPABILITY_CACHE_MS = 30_000;
const CAPABILITY_CACHE_LIMIT = 512;
const HOLDER_PRINCIPALS_LIMIT = 1_024;

type PasskeyFieldName = (typeof PASSKEY_FIELD_NAMES)[number];

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

export function createVaultInteractionSecretsPort(deps: {
  db: Database;
  /** The variable-set envelope key; null fails value reads like the vault API. */
  encryptionKey: Uint8Array | null;
  /** Defaults to a service over the same database and key. */
  vaultService?: VaultService;
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
      signCount: Math.max(0, Math.min(0xffff_ffff, Number(row.passkeySignCount ?? 0))),
    };
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
      const credentials: BrowserPasskeyCredential[] = [];
      for (const itemId of itemIds) {
        const row = await getVaultItem(deps.db, context(principal), { itemId });
        const credential = await credentialFromItem(principal, row);
        if (credential) credentials.push(credential);
      }
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
    async updateSignCount(principal, itemId, signCount) {
      await updatePasskeySignCount(deps.db, context(principal), { itemId, count: signCount });
    },
    async release(holder) {
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
      return createSecretResolver({ db: deps.db, encryptionKey }, principal, {
        capabilityEnabled: await secretsEnabled(principal),
      });
    },
    passkeys,
  };
}
