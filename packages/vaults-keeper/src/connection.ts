import { VaultProviderError, type VaultProviderOperations } from "./contract";
import { bootstrapKeeperConfiguration } from "./bootstrap";
import { keeperConfigurationRecord } from "./config";
import {
  type KeeperRuntimeOptions,
  type KeeperVaultProvider,
  createKeeperVaultProvider,
} from "./provider";

/** What a server stores for a Keeper connection: setup input, or the bound configuration. */
export type KeeperConnectionCredentials =
  | { oneTimeToken: string; hostname?: string }
  | { configuration: string | Readonly<Record<string, string>> };

/**
 * Durable, encrypted storage for the bound configuration. Called with
 * `reason: "bind"` when a one-time token is redeemed (before anything else
 * runs) and `reason: "rotation"` when Keeper rotates its key.
 */
export type PersistKeeperConfigurationRecord = (
  configuration: Record<string, string>,
  context: { reason: "bind" | "rotation" },
) => Promise<void>;

export interface OpenKeeperConnectionOptions extends KeeperRuntimeOptions {
  credentials: KeeperConnectionCredentials;
  /** Required: without durable storage a redeemed token or a rotated key would be lost. */
  persistConfiguration?: PersistKeeperConfigurationRecord;
  /** Operations verified at setup; the provider narrows to them. */
  operations?: VaultProviderOperations;
  valueCacheMs?: number;
  signal?: AbortSignal;
}

/**
 * One Keeper connection for a server: redeems a one-time token or opens a
 * stored configuration, and returns the provider with the bound configuration
 * as a string record. The one-time token is never part of the result. Each
 * call has its own provider; SDK state is per operation, so connections never
 * share keys.
 */
export async function openKeeperConnection(
  options: OpenKeeperConnectionOptions,
): Promise<{ provider: KeeperVaultProvider; configuration: Record<string, string> }> {
  const persist = options.persistConfiguration;
  if (!persist) {
    throw new VaultProviderError(
      "provider_unavailable",
      "Keeper connections need durable configuration storage on this server",
    );
  }
  const { credentials, persistConfiguration: _persist, operations, signal, ...runtime } = options;
  let configuration: Record<string, string>;
  if ("oneTimeToken" in credentials) {
    const bound = await bootstrapKeeperConfiguration({
      ...runtime,
      oneTimeToken: credentials.oneTimeToken,
      ...(credentials.hostname ? { hostname: credentials.hostname } : {}),
      ...(signal ? { signal } : {}),
      persistConfiguration: (next, context) =>
        persist(keeperConfigurationRecord(next), { reason: context.reason }),
    });
    configuration = keeperConfigurationRecord(bound.configuration);
  } else {
    configuration = keeperConfigurationRecord(credentials.configuration);
  }
  const provider = createKeeperVaultProvider({
    ...runtime,
    configuration,
    ...(operations ? { operations } : {}),
    persistConfiguration: (next, context) =>
      persist(keeperConfigurationRecord(next), { reason: context.reason }),
  });
  return { provider, configuration };
}
