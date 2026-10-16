import { VaultProviderError } from "./contract";
import type { KeyValueStorage } from "./sdk";

/** Region prefixes of a one-time token (`US:…`), as mapped by SDK 17.6.0 `initializeStorage`. */
export const KEEPER_REGION_HOSTS = {
  US: "keepersecurity.com",
  EU: "keepersecurity.eu",
  AU: "keepersecurity.com.au",
  GOV: "govcloud.keepersecurity.us",
  JP: "keepersecurity.jp",
  CA: "keepersecurity.ca",
  IL5: "il5.keepersecurity.us",
} as const;

/**
 * Hosts a configuration may talk to. The SDK treats an unknown token prefix
 * as a host name, so without this list a crafted token or configuration could
 * point Opengeni's server at an arbitrary host.
 */
export const KEEPER_DEFAULT_ALLOWED_HOSTS: readonly string[] = Object.values(KEEPER_REGION_HOSTS);

/** Keys of the standard KSM JSON configuration. Bytes are standard base64. */
export const KEEPER_CONFIG_KEYS = [
  "hostname",
  "clientId",
  "clientKey",
  "privateKey",
  "appKey",
  "appOwnerPublicKey",
  "serverPublicKeyId",
  "serverPublicKey",
] as const;
export type KeeperConfigKey = (typeof KEEPER_CONFIG_KEYS)[number];
const KNOWN = new Set<string>(KEEPER_CONFIG_KEYS);

export type KeeperConfigValues = Map<KeeperConfigKey, string>;

function invalid(message: string): never {
  throw new VaultProviderError("provider_auth_invalid", message);
}

/**
 * Parses a bound KSM configuration (JSON, or base64 of JSON as Keeper tools
 * export it, or the already parsed string record). Unknown keys are dropped;
 * the client must already be bound (appKey present).
 */
export function parseKeeperConfiguration(
  input: string | Readonly<Record<string, string>>,
): KeeperConfigValues {
  if (typeof input !== "string") {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return invalid("The Keeper configuration is not KSM JSON");
    }
    return valuesOf(input);
  }
  let text = input.trim();
  if (!text.startsWith("{")) {
    try {
      text = Buffer.from(text, "base64").toString("utf8").trim();
    } catch {
      invalid("The Keeper configuration is not KSM JSON");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("The Keeper configuration is not KSM JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("The Keeper configuration is not KSM JSON");
  }
  return valuesOf(parsed as Record<string, unknown>);
}

function valuesOf(parsed: Readonly<Record<string, unknown>>): KeeperConfigValues {
  const values: KeeperConfigValues = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN.has(key)) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
      invalid(`The Keeper configuration has an invalid ${key}`);
    }
    values.set(key as KeeperConfigKey, value);
  }
  for (const key of ["hostname", "clientId", "privateKey", "appKey"] as const) {
    if (!values.get(key)) {
      invalid(
        key === "appKey"
          ? "The Keeper configuration is not bound yet; connect with a one-time token"
          : `The Keeper configuration has no ${key}`,
      );
    }
  }
  return values;
}

/** The canonical JSON form (sorted known keys) handed to the persistence callback. */
export function serializeKeeperConfiguration(values: KeeperConfigValues): string {
  const out: Record<string, string> = {};
  for (const key of KEEPER_CONFIG_KEYS) {
    const value = values.get(key);
    if (value !== undefined) out[key] = value;
  }
  return JSON.stringify(out);
}

/** The canonical string record of a bound configuration, for structured storage. */
export function keeperConfigurationRecord(
  configuration: string | Readonly<Record<string, string>>,
): Record<string, string> {
  return JSON.parse(
    serializeKeeperConfiguration(parseKeeperConfiguration(configuration)),
  ) as Record<string, string>;
}

export function assertAllowedHost(
  hostname: string | undefined,
  allowed: readonly string[],
): string {
  const host = (hostname ?? "").trim().toLowerCase();
  if (!host || !allowed.includes(host)) {
    throw new VaultProviderError(
      "provider_auth_invalid",
      "The Keeper region host is not one Opengeni connects to",
    );
  }
  return host;
}

/**
 * In-memory KSM storage over a copy of the configuration. Nothing reaches
 * disk; `changed` reports whether the SDK rewrote any persisted key (binding,
 * server key rotation) so the caller can persist the new configuration.
 */
export function memoryKeeperStorage(initial: KeeperConfigValues = new Map()): KeyValueStorage & {
  readonly values: KeeperConfigValues;
  changed(): boolean;
} {
  const values: KeeperConfigValues = new Map(initial);
  const before = serializeKeeperConfiguration(initial);
  const set = (key: string, value: string) => {
    // Session keys (folder, record and file keys) are never persisted by the
    // SDK; only configuration keys arrive here.
    if (!KNOWN.has(key)) throw new Error(`unexpected Keeper storage key ${key}`);
    values.set(key as KeeperConfigKey, value);
  };
  return {
    values,
    changed: () => serializeKeeperConfiguration(values) !== before,
    getString: async (key) => values.get(key as KeeperConfigKey),
    saveString: async (key, value) => set(key, value),
    getBytes: async (key) => {
      const value = values.get(key as KeeperConfigKey);
      return value === undefined ? undefined : new Uint8Array(Buffer.from(value, "base64"));
    },
    saveBytes: async (key, value) => set(key, Buffer.from(value).toString("base64")),
    delete: async (key) => {
      values.delete(key as KeeperConfigKey);
    },
  };
}
