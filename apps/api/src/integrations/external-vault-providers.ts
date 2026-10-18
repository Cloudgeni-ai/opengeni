import type { Settings } from "@opengeni/config";
import type {
  ExternalVaultProviderFactories,
  ExternalVaultProviderFactory,
  StoredVaultProviderCredentials,
} from "@opengeni/core";
import { pinnedFetch, type PinnedFetchOptions } from "@opengeni/network";
import { VaultProviderError } from "@opengeni/vaults";
import type { KeeperRuntimeOptions } from "@opengeni/vaults-keeper";
import type { ProtonPassProviderPool } from "@opengeni/vaults-protonpass";

/** Test seams only; production passes nothing. */
export type NativeExternalVaultOptions = {
  keeper?: Pick<KeeperRuntimeOptions, "queryFunction" | "fetchFile" | "sdk">;
  /** Applies when this call creates the pool for its CLI path. */
  protonpass?: { stateRoot?: string; hostEnv?: Readonly<Record<string, string | undefined>> };
};

/**
 * Native external vault adapters that run inside this server: Keeper Secrets
 * Manager always, Proton Pass only when the operator installed `pass-cli`
 * (`OPENGENI_PROTON_PASS_CLI_PATH`). Both packages load through `import()`
 * on first use (packages/vaults-keeper/test/import-guard.test.ts). Keep this
 * file identical to apps/worker/src/external-vault-providers.ts.
 */
export function createNativeExternalVaultFactories(
  settings: Settings,
  options: NativeExternalVaultOptions = {},
): ExternalVaultProviderFactories {
  const factories: ExternalVaultProviderFactories = {
    keeper: keeperFactory(settings, options.keeper ?? {}),
  };
  const cliPath = settings.protonPassCliPath;
  if (cliPath) factories.protonpass = protonPassFactory(cliPath, options.protonpass ?? {});
  return factories;
}

/** Logs out every pooled Proton Pass CLI session and wipes its state (graceful shutdown). */
export async function closeNativeExternalVaultProviders(): Promise<void> {
  const pools = [...protonPools.values()];
  protonPools.clear();
  await Promise.all(pools.map(async (pool) => (await pool.catch(() => null))?.close()));
}

function mismatch(): never {
  throw new VaultProviderError(
    "provider_unavailable",
    "The configured adapter does not match this connection.",
  );
}

/**
 * The fetch every Keeper request and file download uses: DNS-pinned and
 * policy-checked (no private or special-use targets). The adapter adds
 * HTTPS-only, no redirects, deadlines, size bounds and the caller's abort.
 */
export function nativeKeeperFetch(
  settings: Settings,
  pinned: Pick<PinnedFetchOptions, "dnsLookup" | "fetchImpl" | "agentFactory"> = {},
) {
  return (input: string | URL, init: RequestInit) =>
    pinnedFetch(input, init, settings, {
      ...pinned,
      label: "Keeper Secrets Manager",
      requireHttpsOutsideLocalTest: true,
    });
}

function keeperFactory(
  settings: Settings,
  seams: NonNullable<NativeExternalVaultOptions["keeper"]>,
): ExternalVaultProviderFactory {
  const fetch = nativeKeeperFetch(settings);
  return async (input) => {
    const credentials = input.credentials;
    if (credentials.provider !== "keeper") mismatch();
    const persist = input.persistCredentials;
    const { openKeeperConnection } = await import("@opengeni/vaults-keeper");
    const opened = await openKeeperConnection({
      credentials:
        "oneTimeToken" in credentials
          ? {
              oneTimeToken: credentials.oneTimeToken,
              ...(credentials.hostname ? { hostname: credentials.hostname } : {}),
            }
          : { configuration: credentials.configuration },
      // Without it openKeeperConnection refuses: a redeemed token or rotated
      // key must never live only in memory.
      ...(persist
        ? {
            persistConfiguration: (configuration: Record<string, string>) =>
              persist({ provider: "keeper", configuration }),
          }
        : {}),
      ...(input.operations ? { operations: input.operations } : {}),
      // Cancels a pending bootstrap; a stored configuration opens without a request.
      ...(input.signal ? { signal: input.signal } : {}),
      fetch,
      ...seams,
    });
    const stored: StoredVaultProviderCredentials = {
      provider: "keeper",
      configuration: opened.configuration,
    };
    return { provider: opened.provider, credentials: stored };
  };
}

/** One pool per CLI path per process, so repeated factory creation never leaks sessions. */
const protonPools = new Map<string, Promise<ProtonPassProviderPool>>();

function protonPassFactory(
  binaryPath: string,
  seams: NonNullable<NativeExternalVaultOptions["protonpass"]>,
): ExternalVaultProviderFactory {
  return async (input) => {
    const credentials = input.credentials;
    if (credentials.provider !== "protonpass") mismatch();
    let pool = protonPools.get(binaryPath);
    if (!pool) {
      pool = import("@opengeni/vaults-protonpass").then(({ createProtonPassProviderPool }) =>
        createProtonPassProviderPool({ ...seams, binaryPath }),
      );
      protonPools.set(binaryPath, pool);
      pool.catch(() => protonPools.delete(binaryPath));
    }
    // Sessions are scoped to the connection, so two connections never share
    // CLI state even with the same token. Without a connection id (a setup
    // probe) the provider gets an isolated session of its own.
    const provider = (await pool).provider(credentials.token, {
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.operations ? { operations: input.operations } : {}),
    });
    return { provider, credentials: { provider: "protonpass", token: credentials.token } };
  };
}
