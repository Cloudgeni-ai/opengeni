// Synthetic organization "Acme" with one workspace. `own=1` gives the
// workspace its own default model, Allowed models and a compaction limit;
// otherwise it follows Acme's defaults.
const params = new URLSearchParams(window.location.search);
const own = params.get("own") === "1";

const definitions = [
  ["claude-sub/haiku", "Claude Haiku 5.5", "Claude subscription", 95_000],
  ["claude-sub/opus", "Claude Opus 5.5", "Claude subscription", 300_000],
  ["claude-sub/sonnet", "Claude Sonnet 5.5", "Claude subscription", 800_000],
  ["codex/sol", "GPT-6.1 Sol", "Codex", 850_000],
] as const;

type Defaults = {
  sessionDefaults: { model: string; reasoningEffort: "high" | "medium" | "low" } | null;
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  modelCompactionThresholds: Record<string, number>;
  updatedAt: string | null;
};
const organization: Defaults = {
  sessionDefaults: { model: "claude-sub/opus", reasoningEffort: "high" },
  allowedProviders: null,
  allowedModels: ["claude-sub/haiku", "claude-sub/opus", "claude-sub/sonnet"],
  modelCompactionThresholds: { "claude-sub/sonnet": 400_000 },
  updatedAt: "2026-10-09T12:00:00.000Z",
};
const workspacePolicy = own ? { allowedProviders: null, allowedModels: null } : null;
const workspaceLimits: Record<string, number> = own ? { "claude-sub/haiku": 60_000 } : {};
const workspaceSettings: Record<string, unknown> = own
  ? { sessionDefaults: { model: "codex/sol", reasoningEffort: "medium" } }
  : {};

function catalog() {
  return definitions.map(([id, label, providerLabel, threshold]) => {
    const organizationTokens = organization.modelCompactionThresholds[id] ?? null;
    const overrideTokens = workspaceLimits[id] ?? null;
    return {
      id,
      label,
      api: "anthropic-messages",
      provider: providerLabel.toLowerCase(),
      providerLabel,
      reasoningEffort: true,
      reasoningEfforts: ["low", "medium", "high"],
      hostedWebSearch: false,
      cost: "subscription",
      billing: { upstreamPayer: "workspace", metering: "external" },
      credentialReadiness: { status: "ready", reason: null, basis: "connection", checkedAt: null },
      availability: { status: "available", selectable: true, reason: null, checkedAt: null },
      policyAllowed: true,
      compactionPolicy: {
        defaultTokens: threshold,
        overrideTokens,
        organizationTokens,
        effectiveTokens: overrideTokens ?? organizationTokens ?? threshold,
        minimumTokens: 16_000,
        maximumTokens: 872_000,
      },
    };
  });
}

export const receipts: unknown[] = [];
Object.assign(window, { defaultsReceipts: receipts });
const client = {
  getWorkspaceModelCatalog: async () => ({
    models: catalog(),
    defaultSelection: own
      ? { model: "codex/sol", reasoningEffort: "medium", source: "workspace" }
      : { model: "claude-sub/opus", reasoningEffort: "high", source: "organization" },
  }),
  getWorkspaceModelAccessPolicy: async () => {
    const organizationPolicy = {
      allowedProviders: organization.allowedProviders,
      allowedModels: organization.allowedModels,
    };
    const effective = workspacePolicy ?? organizationPolicy;
    return {
      ...effective,
      source: workspacePolicy ? "workspace" : "organization",
      organization: organizationPolicy,
    };
  },
  updateWorkspaceModelAccessPolicy: async (_id: string, request: unknown) => {
    receipts.push({ put: request });
    return request;
  },
  deleteWorkspaceModelAccessPolicy: async () => {
    receipts.push({ delete: true });
    return {};
  },
  getOrganizationModelDefaults: async () => organization,
  updateOrganizationModelDefaults: async (_id: string, request: Record<string, unknown>) => {
    receipts.push({ organization: request });
    if (request.sessionDefaults !== undefined)
      organization.sessionDefaults = request.sessionDefaults as Defaults["sessionDefaults"];
    organization.updatedAt = new Date().toISOString();
    return { ...organization };
  },
};

export function useAppContext() {
  return {
    client,
    clientConfig: { defaultModel: "codex/sol", defaultReasoningEffort: "medium" },
    workspaces: [{ id: "sample", name: "Design", settings: workspaceSettings }],
    captureWorkspaceInvocation: () => "sample-transition",
    ownsWorkspaceInvocation: () => true,
    updateWorkspaceSettings: async (_id: string, patch: unknown) => {
      receipts.push({ workspace: patch });
      return { settings: patch };
    },
  };
}
