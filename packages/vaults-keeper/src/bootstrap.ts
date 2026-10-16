import { VaultProviderError } from "./contract";
import {
  KEEPER_DEFAULT_ALLOWED_HOSTS,
  KEEPER_REGION_HOSTS,
  assertAllowedHost,
  memoryKeeperStorage,
  parseKeeperConfiguration,
  serializeKeeperConfiguration,
} from "./config";
import { mapKeeperMutationError } from "./errors";
import {
  type KeeperRuntimeOptions,
  type KeeperVaultProvider,
  type PersistKeeperConfiguration,
  createKeeperVaultProvider,
  runKeeperOperation,
} from "./provider";
import { createKeeperSdkLoader } from "./sdk";

export interface KeeperBootstrapOptions extends KeeperRuntimeOptions {
  /** One-time access token, `REGION:key` (for example `US:…`), or a bare key with `hostname`. */
  oneTimeToken: string;
  /** Region host for a token without a region prefix. */
  hostname?: string;
  signal?: AbortSignal;
  /**
   * Awaited with the bound configuration (`previous: null`, `reason: "bind"`)
   * as soon as Keeper has accepted the token, before bootstrap returns or
   * reports a later failure. The token is spent at that point, so this is the
   * only copy of the credential.
   */
  persistConfiguration?: PersistKeeperConfiguration;
}

export interface KeeperBootstrapResult {
  /** Bound KSM configuration (JSON). Store it encrypted; it is the connection's credential. */
  configuration: string;
  /** The Secrets Manager application's title. */
  accountName: string | null;
}

const TOKEN_PART = /^[A-Za-z0-9_-]{16,128}$/;

function invalidToken(): never {
  throw new VaultProviderError(
    "provider_auth_invalid",
    "That is not a Keeper Secrets Manager one-time access token",
  );
}

/** The region host a token names, checked against the allowlist before any network call. */
export function keeperTokenHost(oneTimeToken: string, hostname?: string): string {
  const parts = oneTimeToken.trim().split(":");
  if (parts.length === 1) {
    if (!TOKEN_PART.test(parts[0]!)) invalidToken();
    if (!hostname) {
      throw new VaultProviderError(
        "provider_auth_invalid",
        "This one-time token has no region prefix; choose the Keeper region",
      );
    }
    return hostname;
  }
  if (parts.length !== 2 && !(parts.length === 4 && parts[0]!.toUpperCase() === "IL5"))
    invalidToken();
  if (!TOKEN_PART.test(parts[1]!)) invalidToken();
  const region = parts[0]!.toUpperCase() as keyof typeof KEEPER_REGION_HOSTS;
  return KEEPER_REGION_HOSTS[region] ?? parts[0]!;
}

/**
 * Redeems a one-time access token once: generates the client key pair in
 * memory, binds it with the first `get_secret` call, and returns the bound
 * configuration. The token is never retried; an ambiguous failure means the
 * customer must generate a new token.
 */
export async function bootstrapKeeperConfiguration(
  options: KeeperBootstrapOptions,
): Promise<KeeperBootstrapResult> {
  const token = options.oneTimeToken.trim();
  const allowed = (options.allowedHosts ?? KEEPER_DEFAULT_ALLOWED_HOSTS).map((host) =>
    host.toLowerCase(),
  );
  assertAllowedHost(keeperTokenHost(token, options.hostname), allowed);
  const loader = options.sdk ?? createKeeperSdkLoader();
  let tracker: { sent: number; lastStatus: number | null; mutating: boolean } | null = null;
  let bindStorage: ReturnType<typeof memoryKeeperStorage> | null = null;
  let accountName: string | null = null;
  let failure: unknown = null;
  try {
    await runKeeperOperation({
      runtime: options,
      loader,
      config: new Map(),
      hostInConfig: false,
      ...(options.signal ? { signal: options.signal } : {}),
      work: async (keeper, storage) => {
        tracker = keeper.tracker;
        bindStorage = storage;
        await keeper.sdk.initializeStorage(storage, token, options.hostname);
        assertAllowedHost(storage.values.get("hostname"), allowed);
        keeper.tracker.mutating = true;
        const secrets = await keeper.sdk.getSecrets2(keeper.options);
        keeper.tracker.mutating = false;
        const title = secrets.appData?.title;
        accountName = typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : null;
      },
    });
  } catch (error) {
    failure = error;
  }

  // Keeper binds the key pair when it answers the first request. Once the
  // SDK has unwrapped the app key the token is spent, so the configuration is
  // kept (and persisted) even if something after the bind failed.
  const bound = bindStorage as ReturnType<typeof memoryKeeperStorage> | null;
  if (bound?.values.get("appKey")) {
    bound.values.delete("clientKey");
    const configuration = serializeKeeperConfiguration(bound.values);
    parseKeeperConfiguration(configuration);
    if (options.persistConfiguration) {
      try {
        await options.persistConfiguration(configuration, { previous: null, reason: "bind" });
      } catch {
        throw new VaultProviderError(
          "provider_unavailable",
          "Keeper accepted the one-time token but Opengeni could not save the connection; generate a new token and connect again",
        );
      }
    }
    return { configuration, accountName };
  }

  try {
    if (failure === null) {
      throw new VaultProviderError(
        "provider_outcome_unknown",
        "Keeper did not complete binding; generate a new one-time token",
      );
    }
    throw failure;
  } catch (error) {
    if (error instanceof VaultProviderError && error.code === "provider_outcome_unknown")
      throw error;
    const used = tracker as { sent: number; lastStatus: number | null; mutating: boolean } | null;
    const mapped = used
      ? mapKeeperMutationError(error, "redeem the one-time token", used)
      : error instanceof VaultProviderError
        ? error
        : new VaultProviderError(
            "provider_auth_invalid",
            "Keeper could not use that one-time token",
          );
    if (mapped.code === "provider_outcome_unknown") {
      throw new VaultProviderError(
        "provider_outcome_unknown",
        "Keeper may have redeemed the one-time token; generate a new one and connect again",
      );
    }
    if (mapped.code === "provider_auth_invalid" || mapped.code === "provider_permission_denied") {
      throw new VaultProviderError(
        "provider_auth_invalid",
        "Keeper rejected the one-time token (expired, already used, or IP-locked); generate a new one",
      );
    }
    throw mapped;
  }
}

/**
 * Bootstrap, then a provider over the bound configuration. The configuration
 * is persisted through `persistConfiguration` (reason `"bind"`) before this
 * returns and before the provider makes any request.
 */
export async function bootstrapKeeperVaultProvider(
  options: KeeperBootstrapOptions & { persistConfiguration: PersistKeeperConfiguration },
): Promise<KeeperBootstrapResult & { provider: KeeperVaultProvider }> {
  const { oneTimeToken: _token, hostname: _hostname, signal: _signal, ...runtime } = options;
  const result = await bootstrapKeeperConfiguration(options);
  const provider = createKeeperVaultProvider({ ...runtime, configuration: result.configuration });
  return { ...result, provider };
}
