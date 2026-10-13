// Synthetic organization "Acme" with three shared workspaces. Acme locks
// personal fallback; Design turns personal accounts off for itself and
// Research uses primary-only rotation. `readonly=1` views Design as a member.
const params = new URLSearchParams(window.location.search);
const readonly = params.get("readonly") === "1";
const personalAllowed = params.get("personal") === "allowed";

type Key =
  | "rotation"
  | "providers"
  | "crossProviderFailover"
  | "fallbackOrder"
  | "personalConnectionsAllowed"
  | "personalFallbackAllowed";
type Values = {
  rotation: Record<string, { mode: "spread" | "primary_first" }>;
  providers: Record<string, unknown>;
  crossProviderFailover: boolean;
  fallbackOrder: Record<string, string[]>;
  personalConnectionsAllowed: boolean;
  personalFallbackAllowed: boolean;
};
type Overrides = { [K in Key]: Values[K] | null };

const organization = {
  organizationId: "acme",
  values: {
    rotation: { codex: { mode: "spread" }, claude: { mode: "spread" }, xai: { mode: "spread" } },
    providers: {},
    crossProviderFailover: true,
    fallbackOrder: { "claude-sub/opus": ["claude-sub/sonnet", "codex/sol"] },
    personalConnectionsAllowed: true,
    personalFallbackAllowed: personalAllowed,
  } as Values,
  locked: ["personalFallbackAllowed"] as Key[],
  version: 4,
  updatedAt: "2026-10-10T09:00:00.000Z",
};

const none: Overrides = {
  rotation: null,
  providers: null,
  crossProviderFailover: null,
  fallbackOrder: null,
  personalConnectionsAllowed: null,
  personalFallbackAllowed: null,
};
const workspaces: { workspaceId: string; name: string; overrides: Overrides }[] = [
  { workspaceId: "design", name: "Design", overrides: { ...none, personalConnectionsAllowed: false } },
  { workspaceId: "platform", name: "Platform", overrides: { ...none } },
  {
    workspaceId: "research",
    name: "Research",
    overrides: { ...none, rotation: { codex: { mode: "primary_first" } }, crossProviderFailover: false },
  },
];

const KEYS: Key[] = [
  "rotation",
  "providers",
  "crossProviderFailover",
  "fallbackOrder",
  "personalConnectionsAllowed",
  "personalFallbackAllowed",
];

// The same rule as the server: a locked setting is the organization's value.
function view(overrides: Overrides) {
  const values = { ...organization.values } as Record<Key, unknown>;
  const sources = {} as Record<Key, "organization" | "workspace" | "locked">;
  for (const key of KEYS) {
    if (organization.locked.includes(key)) sources[key] = "locked";
    else if (overrides[key] !== null) {
      const own = overrides[key];
      values[key] =
        typeof own === "object" && own !== null
          ? { ...(organization.values[key] as object), ...own }
          : own;
      sources[key] = "workspace";
    } else sources[key] = "organization";
  }
  return {
    values: values as Values,
    sources,
    entrySources: Object.fromEntries((["rotation", "providers", "fallbackOrder"] as const).map((key) => [key,
      Object.fromEntries(Object.keys(values[key] as object).map((id) => [id, !organization.locked.includes(key) && Object.hasOwn(overrides[key] ?? {}, id) ? "workspace" : "organization"])),
    ])),
  };
}

function workspaceSettings(id: string) {
  const workspace = workspaces.find((candidate) => candidate.workspaceId === id)!;
  return {
    workspaceId: id,
    ...view(workspace.overrides),
    locked: organization.locked,
    overrides: workspace.overrides,
    version: 2,
    updatedAt: null,
    canEdit: !readonly,
  };
}

export const receipts: unknown[] = [];
Object.assign(window, { settingsReceipts: receipts });
const client = {
  getModelAccountSettingsOverview: async (_id: string, page?: { after?: string }) => ({
    organization: { ...organization, locked: [...organization.locked] },
    workspaces: workspaces.slice(page?.after ? 2 : 0, page?.after ? undefined : 2).map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      ...view(workspace.overrides),
    })),
    nextCursor: page?.after ? null : "research",
  }),
  updateOrganizationModelAccountSettings: async (_id: string, request: Record<string, unknown>) => {
    receipts.push({ organization: request });
    const { locked, expectedVersion: _version, ...values } = request;
    if (values.rotation) values.rotation = { ...organization.values.rotation, ...(values.rotation as object) };
    Object.assign(organization.values, values);
    if (Array.isArray(locked)) {
      organization.locked = locked as Key[];
      for (const workspace of workspaces) {
        for (const key of organization.locked) workspace.overrides[key] = null;
      }
    }
    organization.version += 1;
    return organization;
  },
  getWorkspaceModelAccountSettings: async (id: string) => workspaceSettings(id),
  updateWorkspaceModelAccountSettings: async (id: string, request: Record<string, unknown>) => {
    receipts.push({ workspace: request });
    const workspace = workspaces.find((candidate) => candidate.workspaceId === id)!;
    for (const [key, value] of Object.entries(request)) {
      if (key === "expectedVersion") continue;
      if ((key === "rotation" || key === "fallbackOrder") && value !== null) {
        const entries = { ...(workspace.overrides[key] as object ?? {}) } as Record<string, unknown>;
        for (const [entryId, entry] of Object.entries(value as object)) {
          if (entry === null) delete entries[entryId]; else entries[entryId] = entry;
        }
        (workspace.overrides as Record<string, unknown>)[key] = Object.keys(entries).length ? entries : null;
      } else (workspace.overrides as Record<string, unknown>)[key] = value;
    }
    return workspaceSettings(id);
  },
  getModelAccountPreferences: async () => ({ personalFallbackOptIn: false, version: 1 }),
  updateModelAccountPreferences: async (_id: string, request: { personalFallbackOptIn: boolean; expectedVersion: number }) => {
    receipts.push({ preference: request });
    return { personalFallbackOptIn: request.personalFallbackOptIn, version: request.expectedVersion + 1 };
  },
};

export function useAppContext() {
  return { client, authSession: { user: { id: "preview-owner" } }, clientConfig: { models: [
    { id: "claude-sub/opus", label: "Claude Opus 5.5", provider: "claude", providerLabel: "Anthropic", api: "anthropic-messages", credentialSource: { kind: "connected_subscription", provider: "claude" }, cost: "subscription" },
    { id: "claude-sub/sonnet", label: "Claude Sonnet 5.5", provider: "claude", providerLabel: "Anthropic", api: "anthropic-messages", credentialSource: { kind: "connected_subscription", provider: "claude" }, cost: "subscription" },
    { id: "codex/sol", label: "GPT-6.1 Sol", provider: "openai", providerLabel: "OpenAI", api: "responses", source: "codex", cost: "subscription" },
  ] } };
}
