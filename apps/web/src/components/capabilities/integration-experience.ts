export type IntegrationExperienceIcon = "calendar" | "cloud" | "contacts" | "files" | "mail";

export type IntegrationExperienceCapability = {
  title: string;
  description: string;
};

export type IntegrationExperiencePermission = {
  label: string;
  description: string;
};

/**
 * Server-supplied consent copy: an API definition's `presentation` field or a
 * connector catalog row's `metadata.presentation`. Every field is optional and
 * presentation-only; anything missing keeps the generic fallback below.
 */
export type IntegrationPresentationCopy = {
  providerName?: string;
  icon?: IntegrationExperienceIcon;
  introduction?: string;
  capabilities?: IntegrationExperienceCapability[];
  permissionSummary?: string;
  scopeLabels?: Readonly<Record<string, { label: string; description: string }>>;
};

const COMMON_SCOPE_LABELS: Readonly<Record<string, { label: string; description: string }>> = {
  openid: {
    label: "Confirm your account",
    description: "Match the connection to the provider account you approve.",
  },
  email: {
    label: "See your account email",
    description: "Show which provider account is connected.",
  },
  profile: {
    label: "See your basic profile",
    description: "Use the provider's basic account identity for a clear account label.",
  },
  offline_access: {
    label: "Keep the connection working",
    description: "Refresh access when you are not actively using OpenGeni.",
  },
  "User.Read": {
    label: "Confirm your Microsoft account",
    description: "Show which Microsoft account is connected.",
  },
};

/**
 * Human labels for the scopes a connect will request: the provider-neutral
 * common labels plus the presentation's own scope labels; unlabeled scopes are
 * deliberately omitted so raw scope strings never become UX copy.
 */
export function presentationPermissions(
  scopes: readonly string[],
  presentation: IntegrationPresentationCopy | undefined,
): IntegrationExperiencePermission[] {
  const scopeLabels = { ...COMMON_SCOPE_LABELS, ...(presentation?.scopeLabels ?? {}) };
  return deduplicatePermissions(
    scopes.flatMap((scope) => {
      const copy = scopeLabels[scope];
      return copy ? [copy] : [];
    }),
  );
}

/**
 * Validated `metadata.presentation` from a catalog row, or undefined when
 * absent or malformed. Presentation is cosmetic, so a malformed object simply
 * degrades to the generic copy.
 */
export function capabilityPresentation(metadata: unknown): IntegrationPresentationCopy | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const raw = (metadata as Record<string, unknown>).presentation;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const copy: IntegrationPresentationCopy = {};
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const providerName = text(record.providerName);
  if (providerName) copy.providerName = providerName;
  const icon = text(record.icon);
  if (icon && ["calendar", "cloud", "contacts", "files", "mail"].includes(icon)) {
    copy.icon = icon as IntegrationExperienceIcon;
  }
  const introduction = text(record.introduction);
  if (introduction) copy.introduction = introduction;
  const permissionSummary = text(record.permissionSummary);
  if (permissionSummary) copy.permissionSummary = permissionSummary;
  if (Array.isArray(record.capabilities)) {
    const capabilities = record.capabilities.flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const pair = value as Record<string, unknown>;
      const title = text(pair.title);
      const description = text(pair.description);
      return title && description ? [{ title, description }] : [];
    });
    if (capabilities.length > 0) copy.capabilities = capabilities;
  }
  if (
    typeof record.scopeLabels === "object" &&
    record.scopeLabels !== null &&
    !Array.isArray(record.scopeLabels)
  ) {
    const scopeLabels: Record<string, { label: string; description: string }> = {};
    for (const [scope, value] of Object.entries(record.scopeLabels as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const pair = value as Record<string, unknown>;
      const label = text(pair.label);
      const description = text(pair.description);
      if (scope.trim() && label && description) scopeLabels[scope] = { label, description };
    }
    if (Object.keys(scopeLabels).length > 0) copy.scopeLabels = scopeLabels;
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}

function deduplicatePermissions(
  permissions: IntegrationExperiencePermission[],
): IntegrationExperiencePermission[] {
  const seen = new Set<string>();
  return permissions.filter((permission) => {
    const key = `${permission.label}\u0000${permission.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
