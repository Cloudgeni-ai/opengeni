// Synthetic organization "Acme" with three shared workspaces. Acme locks
// personal fallback; Design turns personal accounts off for itself and
// Research uses primary-only rotation. `readonly=1` views Design as a member.
const params = new URLSearchParams(window.location.search);
const readonly = params.get("readonly") === "1";

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
    rotation: { codex: { mode: "spread" } },
    providers: {},
    crossProviderFailover: true,
    fallbackOrder: { "claude-sub/opus": ["claude-sub/sonnet", "codex/sol"] },
    personalConnectionsAllowed: true,
    personalFallbackAllowed: false,
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
    entrySources: { rotation: {}, providers: {}, fallbackOrder: {} },
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
  getModelAccountSettingsOverview: async () => ({
    organization: { ...organization, locked: [...organization.locked] },
    workspaces: workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      ...view(workspace.overrides),
    })),
    nextCursor: null,
  }),
  updateOrganizationModelAccountSettings: async (_id: string, request: Record<string, unknown>) => {
    receipts.push({ organization: request });
    const { locked, expectedVersion: _version, ...values } = request;
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
      if (key !== "expectedVersion") (workspace.overrides as Record<string, unknown>)[key] = value;
    }
    return workspaceSettings(id);
  },
};

export function useAppContext() {
  return { client };
}
