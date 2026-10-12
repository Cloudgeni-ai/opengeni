import type { AccessGrant, SecretClock } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { VaultProviderRegistry } from "@opengeni/vaults";

export interface VaultServiceDeps {
  db: Database;
  /**
   * The variable-set envelope key (`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`);
   * null when unconfigured, which fails value reads and writes with
   * `encryption_key_missing`.
   */
  encryptionKey: Uint8Array | null;
  /** Provider vaults (1Password, host); none configured by default. */
  providers?: VaultProviderRegistry;
  clock?: SecretClock;
}

/**
 * A person or API key calling the vault API. Routes check the permission each
 * operation needs; the actor carries what the service needs on top of that.
 */
export interface VaultRequestActor {
  grant: AccessGrant;
  /** The caller holds `account:admin` on the organization (organization vaults). */
  accountAdmin: boolean;
}
