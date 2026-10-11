import type {
  EffectiveSubscriptionSettings,
  EffectiveSettingSource,
  KeyedSettingKey,
  ProviderId,
  ProviderSwitches,
  RotationSetting,
  ScalarSettingKey,
  SettingSource,
  SubscriptionSettingOverrides,
  SubscriptionSettingKey,
  SubscriptionSettingsPolicy,
  SubscriptionSettingsView,
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
      if (key === "providers" && (entry as ProviderSwitches).inferenceSource !== undefined) {
        value[entryKey] = resolveProviderSwitches(entry as ProviderSwitches);
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

export function isSubscriptionSettingKey(value: unknown): value is SubscriptionSettingKey {
  return (
    typeof value === "string" && (SUBSCRIPTION_SETTING_KEYS as readonly string[]).includes(value)
  );
}

/**
 * One workspace's effective settings with one source per setting (SUB-SET-03,
 * SUB-SET-05): `locked` when the organization locked it (the organization
 * value applies and the workspace cannot override it), `workspace` when the
 * workspace overrides it (for a map-valued setting: at least one entry), and
 * `organization` otherwise. `entrySources` keeps the per-entry sources of the
 * map-valued settings.
 */
export function settingsView(
  policy: SubscriptionSettingsPolicy,
  workspaceId: string,
): SubscriptionSettingsView {
  return settingsViewFromEffective(effectiveSettings(policy, workspaceId), policy.locked);
}

/** The same view from an already resolved effective settings value (for example the SQL one). */
export function settingsViewFromEffective(
  effective: EffectiveSubscriptionSettings,
  locked: readonly SubscriptionSettingKey[],
): SubscriptionSettingsView {
  const lockedSet = new Set(locked);
  const sources = {} as Record<SubscriptionSettingKey, EffectiveSettingSource>;
  for (const key of SCALAR_SETTING_KEYS) {
    sources[key] = lockedSet.has(key) ? "locked" : effective.sources[key];
  }
  for (const key of KEYED_SETTING_KEYS) {
    sources[key] = lockedSet.has(key)
      ? "locked"
      : Object.values(effective.sources[key]).includes("workspace")
        ? "workspace"
        : "organization";
  }
  return {
    values: effective.values,
    sources,
    entrySources: {
      rotation: effective.sources.rotation,
      providers: effective.sources.providers,
      fallbackOrder: effective.sources.fallbackOrder,
    },
  };
}

const OVERRIDE_COLUMN_VALUE = (
  overrides: SubscriptionSettingOverrides | null | undefined,
  key: SubscriptionSettingKey,
): unknown => (overrides ? overrides[key] : undefined);

/**
 * The locked settings a workspace-row write would widen: the TypeScript
 * mirror of the database guard (migration 0723). A write widens a setting
 * when it sets a value that is not already stored unchanged; for a
 * map-valued setting, when it adds or changes an entry. Clearing an override,
 * or leaving it unchanged, never widens. A rotation lock also covers the
 * workspace's primary connections (`primaryConnectionIds`).
 */
export function lockedSettingsWidened(input: {
  locked: readonly SubscriptionSettingKey[];
  before: SubscriptionSettingOverrides | null;
  after: SubscriptionSettingOverrides | null;
  primaryConnectionIds?: {
    before: Readonly<Record<string, string | null>>;
    after: Readonly<Record<string, string | null>>;
  };
}): SubscriptionSettingKey[] {
  const widened: SubscriptionSettingKey[] = [];
  for (const key of SUBSCRIPTION_SETTING_KEYS) {
    if (!input.locked.includes(key)) continue;
    const next = OVERRIDE_COLUMN_VALUE(input.after, key);
    const previous = OVERRIDE_COLUMN_VALUE(input.before, key);
    if (overrideWidened(next, previous, (KEYED_SETTING_KEYS as readonly string[]).includes(key))) {
      widened.push(key);
      continue;
    }
    if (key === "rotation" && input.primaryConnectionIds) {
      const { before, after } = input.primaryConnectionIds;
      if (
        Object.entries(after).some(
          ([column, value]) => value !== null && value !== (before[column] ?? null),
        )
      ) {
        widened.push(key);
      }
    }
  }
  return widened;
}

function overrideWidened(next: unknown, previous: unknown, keyed: boolean): boolean {
  if (next === undefined || next === null) return false;
  if (!keyed) return !jsonEqual(next, previous ?? null);
  if (typeof next !== "object" || Array.isArray(next)) return true;
  const stored =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : null;
  return Object.entries(next as Record<string, unknown>).some(
    ([entry, value]) =>
      // JSON drops undefined members, as the stored jsonb does.
      value !== undefined &&
      (stored === null || !(entry in stored) || !jsonEqual(stored[entry], value)),
  );
}

/** Structural equality of JSON values (jsonb equality: object key order does not matter). */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const other = right as unknown[];
    return (
      left.length === other.length && left.every((value, index) => jsonEqual(value, other[index]))
    );
  }
  const leftEntries = Object.entries(left).filter(([, value]) => value !== undefined);
  const rightRecord = right as Record<string, unknown>;
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return (
    leftEntries.length === rightKeys.length &&
    leftEntries.every(([key, value]) => key in rightRecord && jsonEqual(value, rightRecord[key]))
  );
}

/** Bounds on a stored fallback order (also enforced by the API contract). */
export const FALLBACK_ORDER_LIMITS = Object.freeze({
  preferredModels: 64,
  fallbacksPerModel: 8,
  modelIdLength: 200,
});

/**
 * Why a fallback order is invalid, or null when it is valid: each preferred
 * model maps to distinct model ids, never itself, within the bounds above.
 * Model ids are not required to be in a catalog: placement skips a fallback
 * model it does not know (`failoverCandidateModels`).
 */
export function fallbackOrderProblem(order: unknown): string | null {
  if (order === null || typeof order !== "object" || Array.isArray(order)) {
    return "fallback order must be an object";
  }
  const entries = Object.entries(order as Record<string, unknown>);
  if (entries.length > FALLBACK_ORDER_LIMITS.preferredModels) {
    return `fallback order has more than ${FALLBACK_ORDER_LIMITS.preferredModels} models`;
  }
  const validId = (id: unknown): id is string =>
    typeof id === "string" &&
    id.trim() === id &&
    id.length > 0 &&
    id.length <= FALLBACK_ORDER_LIMITS.modelIdLength;
  for (const [preferred, fallbacks] of entries) {
    if (!validId(preferred)) return "fallback order has an invalid model id";
    if (!Array.isArray(fallbacks)) return `fallback order for ${preferred} must be a list`;
    if (fallbacks.length > FALLBACK_ORDER_LIMITS.fallbacksPerModel) {
      return `fallback order for ${preferred} has more than ${FALLBACK_ORDER_LIMITS.fallbacksPerModel} models`;
    }
    if (!fallbacks.every(validId)) return `fallback order for ${preferred} has an invalid model id`;
    if (new Set(fallbacks).size !== fallbacks.length) {
      return `fallback order for ${preferred} repeats a model`;
    }
    if (fallbacks.includes(preferred)) {
      return `fallback order for ${preferred} names the model itself`;
    }
  }
  return null;
}

/**
 * The fallback models the effective settings name for a preferred model, in
 * order, before the placement-time filters (catalog, cross-provider switch,
 * restrictions; see `failoverCandidateModels`). The read the core uses for
 * the organization's fallback order.
 */
export function fallbackOrderFor(
  settings: SubscriptionSettingValues,
  preferredModelId: string,
): readonly string[] {
  return settings.fallbackOrder[preferredModelId] ?? [];
}

function mergeProviderSwitches(
  base: ProviderSwitches | undefined,
  override: Partial<ProviderSwitches>,
): ProviderSwitches {
  const inherited = resolveProviderSwitches({ ...DEFAULT_PROVIDER_SWITCHES, ...base });
  const inferenceSource =
    override.inferenceSource ??
    (override.useOrganizationAccounts === undefined
      ? inherited.inferenceSource
      : override.useOrganizationAccounts
        ? "automatic"
        : "workspace");
  const hasAuthoritativeSource =
    override.inferenceSource !== undefined || base?.inferenceSource !== undefined;
  const { inferenceSource: _inheritedSource, ...inheritedValues } = inherited;
  const { inferenceSource: _overrideSource, ...overrideValues } = override;
  return {
    ...inheritedValues,
    ...overrideValues,
    ...(hasAuthoritativeSource ? { inferenceSource } : {}),
    useOrganizationAccounts: inferenceSource !== "workspace",
  };
}
