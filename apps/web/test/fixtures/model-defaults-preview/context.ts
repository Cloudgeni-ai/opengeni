// Synthetic organization "Acme" with one workspace. `own=1` gives the
// workspace its own default model, Allowed models and a compaction limit;
// otherwise it follows Acme's defaults.
// Voice: `orgKey=1` gives Acme an ElevenLabs key, `wsKey=1` gives the
// workspace its own, and `own=1` gives the workspace its own voice settings.
// `orgVoice=1` makes Eleven Realtime Acme's default voice model.
const params = new URLSearchParams(window.location.search);
const own = params.get("own") === "1";
const organizationKey = params.get("orgKey") === "1";
const workspaceKey = params.get("wsKey") === "1";
const organizationVoiceDefault = params.get("orgVoice") === "1";

const definitions = [
  ["claude-sub/haiku", "Claude Haiku 5.5", "Claude subscription", 95_000],
  ["claude-sub/opus", "Claude Opus 5.5", "Claude subscription", 300_000],
  ["claude-sub/sonnet", "Claude Sonnet 5.5", "Claude subscription", 800_000],
  ["codex/sol", "GPT-6.1 Sol", "Codex", 850_000],
] as const;

type Defaults = {
  sessionDefaults: {
    model: string;
    reasoningEffort: "high" | "medium" | "low";
  } | null;
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
  modelCompactionThresholds: Record<string, number>;
  realtimeVoice: Record<string, Record<string, string>>;
  realtimeDefaultModel: string | null;
  updatedAt: string | null;
};
const organization: Defaults = {
  sessionDefaults: { model: "claude-sub/opus", reasoningEffort: "high" },
  allowedProviders: null,
  allowedModels: ["claude-sub/haiku", "claude-sub/opus", "claude-sub/sonnet"],
  modelCompactionThresholds: { "claude-sub/sonnet": 400_000 },
  realtimeVoice: {
    "workspace-elevenlabs/eleven_realtime_v1_max": {
      voice: "aria",
      language: "no",
    },
  },
  realtimeDefaultModel: organizationVoiceDefault
    ? "workspace-elevenlabs/eleven_realtime_v1_max"
    : null,
  updatedAt: "2026-10-09T12:00:00.000Z",
};
const workspacePolicy = own
  ? { allowedProviders: null, allowedModels: null }
  : null;
const workspaceLimits: Record<string, number> = own
  ? { "claude-sub/haiku": 60_000 }
  : {};
const workspaceSettings: Record<string, unknown> = own
  ? { sessionDefaults: { model: "codex/sol", reasoningEffort: "medium" } }
  : {};
const workspaceVoice: Record<string, Record<string, string>> = own
  ? { "workspace-elevenlabs/eleven_realtime_v1_max": { voice: "roger" } }
  : {};
let workspaceDefaultModel: string | null = null;

const ELEVEN = "workspace-elevenlabs/eleven_realtime_v1_max";
function realtimeCatalog() {
  const elevenAvailable = organizationKey || workspaceKey;
  const models = [
    {
      id: "openai/gpt-realtime",
      label: "GPT Realtime",
      provider: "OpenGeni",
      description: "Fast, natural voice conversations.",
      available: true,
      unavailableReason: null,
      recommended: true,
      voices: [
        { id: "marin", label: "Marin" },
        { id: "cedar", label: "Cedar" },
      ],
      voiceDefaults: { voice: "marin" },
      workspaceVoiceSettings: undefined,
      organizationVoiceSettings:
        organization.realtimeVoice["openai/gpt-realtime"],
    },
    {
      id: ELEVEN,
      label: "Eleven Realtime",
      provider: "Your ElevenLabs",
      description: "Expressive ElevenLabs voices.",
      available: elevenAvailable,
      unavailableReason: elevenAvailable ? null : "Connect an ElevenLabs key",
      recommended: false,
      voices: [
        { id: "aria", label: "Aria" },
        { id: "roger", label: "Roger" },
      ],
      customVoice: true,
      languages: ["en", "no", "sv"],
      turnEagerness: ["low", "medium", "high"],
      voiceDefaults: { voice: "aria", turnEagerness: "medium" },
      workspaceVoiceSettings: workspaceVoice[ELEVEN],
      organizationVoiceSettings: organization.realtimeVoice[ELEVEN],
    },
  ];
  return models.map((model) => ({
    ...model,
    ...(model.id === workspaceDefaultModel ? { workspaceDefault: true } : {}),
    ...(model.id === organization.realtimeDefaultModel
      ? { organizationDefault: true }
      : {}),
  }));
}
const organizationElevenLabs = organizationKey
  ? { providerKind: "elevenlabs", status: "active", version: 1 }
  : null;
const workspaceConnections = workspaceKey
  ? [
      {
        id: "eleven-connection",
        version: 1,
        subjectId: null,
        kind: "api_key",
        status: "active",
        providerDomain: "api.elevenlabs.io",
        metadata: {
          credentialRole: "elevenlabs",
          credentialLabel: "ElevenLabs",
        },
      },
    ]
  : [];

function catalog() {
  return definitions.map(([id, label, providerLabel, threshold]) => {
    const organizationTokens =
      organization.modelCompactionThresholds[id] ?? null;
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
      credentialReadiness: {
        status: "ready",
        reason: null,
        basis: "connection",
        checkedAt: null,
      },
      availability: {
        status: "available",
        selectable: true,
        reason: null,
        checkedAt: null,
      },
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
      : {
          model: "claude-sub/opus",
          reasoningEffort: "high",
          source: "organization",
        },
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
  updateOrganizationModelDefaults: async (
    _id: string,
    request: Record<string, unknown>,
  ) => {
    receipts.push({ organization: request });
    if (request.sessionDefaults !== undefined)
      organization.sessionDefaults =
        request.sessionDefaults as Defaults["sessionDefaults"];
    if (request.realtimeVoice !== undefined) {
      for (const [model, settings] of Object.entries(
        request.realtimeVoice as Record<string, Record<string, string> | null>,
      )) {
        if (settings) organization.realtimeVoice[model] = settings;
        else delete organization.realtimeVoice[model];
      }
    }
    if (request.realtimeDefaultModel !== undefined)
      organization.realtimeDefaultModel = request.realtimeDefaultModel as
        string | null;
    organization.updatedAt = new Date().toISOString();
    return { ...organization };
  },
  getWorkspaceRealtimeModelCatalog: async () => ({ models: realtimeCatalog() }),
  updateWorkspaceSettings: async (_id: string, patch: unknown) => {
    receipts.push({ workspace: patch });
    const choice = (patch as { realtimeDefaultModel?: string | null })
      .realtimeDefaultModel;
    if (choice !== undefined) workspaceDefaultModel = choice;
    return { settings: patch };
  },
  listConnections: async () => workspaceConnections,
  getOrganizationModelProviderConnection: async () => organizationElevenLabs,
  upsertOrganizationModelProviderConnection: async (
    _id: string,
    kind: string,
    request: unknown,
  ) => {
    receipts.push({
      upsert: kind,
      request: { ...(request as object), apiKey: "redacted" },
    });
    return { providerKind: kind, status: "active", version: 1 };
  },
  revokeOrganizationModelProviderConnection: async (
    _id: string,
    kind: string,
  ) => {
    receipts.push({ revoke: kind });
    return { providerKind: kind, status: "revoked", version: 2 };
  },
};

export function useAppContext() {
  return {
    client,
    clientConfig: {
      defaultModel: "codex/sol",
      defaultReasoningEffort: "medium",
    },
    workspaces: [{ id: "sample", name: "Design", settings: workspaceSettings }],
    captureWorkspaceInvocation: () => "sample-transition",
    ownsWorkspaceInvocation: () => true,
    updateWorkspaceSettings: async (_id: string, patch: unknown) => {
      receipts.push({ workspace: patch });
      return { settings: patch };
    },
  };
}
