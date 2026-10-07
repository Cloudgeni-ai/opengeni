import type {
  EffectiveSubscriptionSettings,
  KeyedSettingKey,
  ProviderId,
  ProviderSwitches,
  RotationSetting,
  ScalarSettingKey,
  SettingSource,
  SubscriptionSettingKey,
  SubscriptionSettingsPolicy,
  SubscriptionSettingValues,
} from "./types";

export const SCALAR_SETTING_KEYS: readonly ScalarSettingKey[] = Object.freeze([
  "crossProviderFailover",
  "personalConnectionsAllowed",
  "personalFallbackAllowed",
]);

export const KEYED_SETTING_KEYS: readonly KeyedSettingKey[] = Object.freeze([
  "rotation",
  "providers",
  "fallbackOrder",
]);

export const SUBSCRIPTION_SETTING_KEYS: readonly SubscriptionSettingKey[] = Object.freeze([
  ...SCALAR_SETTING_KEYS,
  ...KEYED_SETTING_KEYS,
]);

/** Default when a provider has no rotation entry: spread work (design 3.3). */
export const DEFAULT_ROTATION: RotationSetting = Object.freeze({ mode: "spread" });

export const DEFAULT_PROVIDER_SWITCHES: ProviderSwitches = Object.freeze({
  useOrganizationAccounts: true,
  enabled: true,
});

/**
 * Resolve one workspace's effective settings (SUB-SET-01..03).
 *
 * Every setting resolves to exactly one value with its source: the
 * organization default, or the workspace override when the setting is not
 * locked. For map-valued settings (`rotation`, `providers`, `fallbackOrder`) a
 * workspace row overrides individual entries, so overriding one provider's
 * rotation does not reset another provider's, and a provider's switches
 * override field by field (D-25). Locking a map-valued setting locks every
 * entry.
 */
export function effectiveSettings(
  policy: SubscriptionSettingsPolicy,
  workspaceId: string,
): EffectiveSubscriptionSettings {
  const override = policy.workspaces[workspaceId] ?? {};
  const locked = new Set<SubscriptionSettingKey>(policy.locked);
  const organization = policy.organization;

  const scalar = <K extends ScalarSettingKey>(key: K) => {
    const value = override[key];
    const overridden = value !== undefined && !locked.has(key);
    return {
      value: (overridden ? value : organization[key]) as SubscriptionSettingValues[K],
      source: (overridden ? "workspace" : "organization") as SettingSource,
    };
  };
  const keyed = <K extends KeyedSettingKey>(key: K) => {
    const base = organization[key] as Readonly<Record<string, unknown>>;
    const entries = locked.has(key)
      ? undefined
      : (override[key] as Readonly<Record<string, unknown>> | undefined);
    const value: Record<string, unknown> = { ...base };
    const sources: Record<string, SettingSource> = {};
    for (const [entryKey, entry] of Object.entries(base)) {
      if (key === "providers") {
        value[entryKey] = mergeProviderSwitches(undefined, entry as ProviderSwitches);
      }
      sources[entryKey] = "organization";
    }
    for (const [entryKey, entry] of Object.entries(entries ?? {})) {
      if (entry === undefined) continue;
      // A provider's switches override field by field (D-25).
      value[entryKey] =
        key === "providers"
          ? mergeProviderSwitches(
              base[entryKey] as ProviderSwitches | undefined,
              entry as Partial<ProviderSwitches>,
            )
          : entry;
      sources[entryKey] = "workspace";
    }
    return { value: value as SubscriptionSettingValues[K], sources };
  };

  const crossProviderFailover = scalar("crossProviderFailover");
  const personalConnectionsAllowed = scalar("personalConnectionsAllowed");
  const personalFallbackAllowed = scalar("personalFallbackAllowed");
  const rotation = keyed("rotation");
  const providers = keyed("providers");
  const fallbackOrder = keyed("fallbackOrder");
  return {
    values: {
      rotation: rotation.value,
      providers: providers.value,
      crossProviderFailover: crossProviderFailover.value,
      fallbackOrder: fallbackOrder.value,
      personalConnectionsAllowed: personalConnectionsAllowed.value,
      personalFallbackAllowed: personalFallbackAllowed.value,
    },
    sources: {
      crossProviderFailover: crossProviderFailover.source,
      personalConnectionsAllowed: personalConnectionsAllowed.source,
      personalFallbackAllowed: personalFallbackAllowed.source,
      rotation: rotation.sources,
      providers: providers.sources,
      fallbackOrder: fallbackOrder.sources,
    },
  };
}

export function rotationFor(
  settings: SubscriptionSettingValues,
  provider: ProviderId,
): RotationSetting {
  return settings.rotation[provider] ?? DEFAULT_ROTATION;
}

export function providerSwitchesFor(
  settings: SubscriptionSettingValues,
  provider: ProviderId,
): ProviderSwitches {
  return settings.providers[provider] ?? DEFAULT_PROVIDER_SWITCHES;
}

/** Legacy boolean rows remain readable; all effective values expose one source. */
export function resolveProviderSwitches(switches: ProviderSwitches): ProviderSwitches & {
  inferenceSource: NonNullable<ProviderSwitches["inferenceSource"]>;
} {
  const inferenceSource =
    switches.inferenceSource ?? (switches.useOrganizationAccounts ? "automatic" : "workspace");
  return {
    ...switches,
    inferenceSource,
    useOrganizationAccounts: inferenceSource !== "workspace",
  };
}

export function inferenceSourceFor(
  settings: SubscriptionSettingValues,
  provider: ProviderId,
): NonNullable<ProviderSwitches["inferenceSource"]> {
  return resolveProviderSwitches(providerSwitchesFor(settings, provider)).inferenceSource;
}

function mergeProviderSwitches(
  base: ProviderSwitches | undefined,
  override: Partial<ProviderSwitches>,
): ProviderSwitches & { inferenceSource: NonNullable<ProviderSwitches["inferenceSource"]> } {
  const inherited = resolveProviderSwitches({ ...DEFAULT_PROVIDER_SWITCHES, ...base });
  const inferenceSource =
    override.inferenceSource ??
    (override.useOrganizationAccounts === undefined
      ? inherited.inferenceSource
      : override.useOrganizationAccounts
        ? "automatic"
        : "workspace");
  return {
    ...inherited,
    ...override,
    inferenceSource,
    useOrganizationAccounts: inferenceSource !== "workspace",
  };
}
