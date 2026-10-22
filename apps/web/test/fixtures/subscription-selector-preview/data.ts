import type {
  CodexAccount,
  CodexUsageMap,
  ModelAccountChoiceOption,
  SessionModelAccountChoiceResponse,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";

// Synthetic readings only; nothing here is a live provider measurement. Both
// providers get the same three accounts and the same usage so any difference
// on screen comes from the UI, not the data.
export type PreviewProvider = "codex" | "claude";

const HOUR = 3_600_000;
const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();

type Seed = {
  key: string;
  label: (brand: string) => string;
  plan: string;
  source: "workspace" | "organization";
  status: "active" | "needs_relogin";
  fiveHourUsed: number | null;
  weekUsed: number | null;
};

const SEEDS: Seed[] = [
  {
    key: "a",
    label: (brand) => `Acme ${brand} 1`,
    plan: "Pro",
    source: "organization",
    status: "active",
    fiveHourUsed: 36,
    weekUsed: 62,
  },
  {
    key: "b",
    label: (brand) => `Acme ${brand} 2`,
    plan: "Pro",
    source: "workspace",
    status: "active",
    fiveHourUsed: 74,
    weekUsed: 21,
  },
  {
    key: "c",
    label: () => "Backup",
    plan: "Plus",
    source: "workspace",
    status: "needs_relogin",
    fiveHourUsed: null,
    weekUsed: null,
  },
];

export const BRAND: Record<PreviewProvider, string> = { codex: "Codex", claude: "Claude" };
export const connectionId = (provider: PreviewProvider, key: string) =>
  `00000000-0000-4000-8000-${provider === "codex" ? "c0de" : "c1a0"}0000000${key}`.slice(0, 36);

const codexWindow = (used: number, resetIn: number) => ({
  used,
  limit: 100,
  percent: used,
  remaining: 100 - used,
  resetAt: iso(resetIn),
  resetAfterSeconds: resetIn / 1000,
  limitWindowSeconds: null,
});

export function codexAccounts(): CodexAccount[] {
  return SEEDS.map((seed) => ({
    id: connectionId("codex", seed.key),
    source: seed.source,
    label: seed.label("Codex"),
    email: `${seed.key === "c" ? "backup" : `acme-${seed.key}`}@example.test`,
    plan: seed.plan,
    status: seed.status,
    active: seed.key === "a",
    allocatorEnabled: true,
    allocatorVersion: 1,
    appsDesignated: false,
    canEnableApps: false,
    ...(seed.fiveHourUsed === null
      ? {}
      : {
          fiveHour: codexWindow(seed.fiveHourUsed, 2 * HOUR),
          weekly: codexWindow(seed.weekUsed!, 50 * HOUR),
          usageCheckedAt: iso(-2 * 60_000),
        }),
  }));
}

export function codexLiveUsage(): CodexUsageMap {
  return Object.fromEntries(
    codexAccounts().map((account) => [
      account.id,
      account.fiveHour
        ? {
            status: "ok" as const,
            usage: {
              status: "ok",
              planType: account.plan ?? null,
              fiveHour: account.fiveHour,
              weekly: account.weekly ?? null,
              limitReached: false,
              fetchedAt: iso(0),
            },
          }
        : { status: "no-data" as const, usage: null },
    ]),
  ) as CodexUsageMap;
}

function option(provider: PreviewProvider, seed: Seed): ModelAccountChoiceOption {
  return {
    provider,
    connectionId: connectionId(provider, seed.key),
    label: seed.label(BRAND[provider]),
    accountEmail: `${seed.key === "c" ? "backup" : `acme-${seed.key}`}@example.test`,
    planType: seed.plan,
    status: seed.status,
    personal: false,
    source: seed.source,
    allowedModelIds: null,
    choosable: seed.status === "active",
    refusal: seed.status === "active" ? null : "inactive",
    usage:
      seed.fiveHourUsed === null
        ? null
        : {
            observedAt: iso(-2 * 60_000),
            source: "usage_endpoint",
            windows: [
              {
                id: provider === "codex" ? "primary" : "five_hour",
                usedPercent: seed.fiveHourUsed,
                resetsAt: iso(2 * HOUR),
                status: seed.fiveHourUsed >= 90 ? "warning" : "ok",
              },
              {
                id: provider === "codex" ? "secondary" : "seven_day",
                usedPercent: seed.weekUsed,
                resetsAt: iso(50 * HOUR),
                status: "ok",
              },
            ],
            exhaustedUntil: null,
            exhaustedKind: null,
          },
  };
}

/** The provider-neutral session account read, for every provider. */
export function modelAccountChoice(): SessionModelAccountChoiceResponse {
  const providers: PreviewProvider[] = ["codex", "claude"];
  const bindings = providers.map((provider) => ({
    provider,
    connectionId: connectionId(provider, "a"),
    choice: "automatic" as const,
  }));
  return {
    binding: null,
    bindings,
    serving: null,
    accounts: providers.flatMap((provider) => SEEDS.map((seed) => option(provider, seed))),
    personal: { connectionsAllowed: true, fallbackAllowed: false, fallbackOptIn: false },
  };
}

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">,
): WorkspaceModelCatalogModel {
  return {
    cost: "subscription",
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
    policyAllowed: true,
    availability: { status: "available", selectable: true, reason: null, checkedAt: null },
    billing: { upstreamPayer: "connected_subscription", metering: "external" },
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
    },
    ...overrides,
  } as WorkspaceModelCatalogModel;
}

const codexModel = (id: string, label: string) =>
  catalogModel({
    id,
    label,
    provider: "codex",
    providerLabel: "Codex",
    source: "codex",
    credentialSource: { kind: "connected_subscription", provider: "codex" },
  } as Partial<WorkspaceModelCatalogModel> & { id: string; label: string });

const claudeModel = (id: string, label: string) =>
  catalogModel({
    id,
    label,
    provider: "organization-claude-subscription",
    providerLabel: "Claude subscription",
    api: "anthropic_messages",
    credentialSource: { kind: "connected_subscription", provider: "claude" },
  } as Partial<WorkspaceModelCatalogModel> & { id: string; label: string });

export const MODEL: Record<PreviewProvider, { id: string; label: string }> = {
  codex: { id: "codex/gpt-6-astra", label: "GPT-6 Astra" },
  claude: { id: "organization-claude-subscription/claude-opus-5-5", label: "Opus 5.5" },
};

export const catalog: WorkspaceModelCatalogModel[] = [
  codexModel(MODEL.codex.id, MODEL.codex.label),
  codexModel("codex/gpt-5.6-sol", "GPT-5.6 Sol"),
  claudeModel(MODEL.claude.id, MODEL.claude.label),
  claudeModel("organization-claude-subscription/claude-sonnet-5", "Sonnet 5"),
];
