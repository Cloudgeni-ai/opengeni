const params = new URLSearchParams(window.location.search);
const state = params.get("state");
// Representative workspace: two Claude routes, Codex and an API-key gateway.
// "override" saves a custom Haiku limit and a stale Opus limit above its maximum.
const definitions = [
  ["claude-sub/haiku", "Claude Haiku 5.5", "Claude subscription", 95_000],
  ["claude-sub/opus", "Claude Opus 5.5", "Claude subscription", 300_000],
  ["claude-sub/sonnet", "Claude Sonnet 5.5", "Claude subscription", 800_000],
  ["anthropic/opus", "Claude Opus 5.5", "Anthropic API", 300_000],
  ["codex/astra", "GPT-6 Astra", "Codex", 850_000],
  ["codex/sol", "GPT-6.1 Sol", "Codex", 850_000],
  ["codex/luna", "GPT-6 Luna", "Codex", 850_000],
  ["gateway/gemini", "Gemini 3.8 Flash", "Vercel AI Gateway", 220_000],
  ["gateway/kimi", "Kimi K3", "Vercel AI Gateway", 150_000],
] as const;
const overrides: Record<string, number> =
  state === "override" ? { "claude-sub/haiku": 90_000, "claude-sub/opus": 900_000 } : {};
const models = definitions.map(([id, label, providerLabel, threshold]) => ({
  id,
  label,
  api: "anthropic-messages",
  provider: providerLabel.toLowerCase(),
  providerLabel,
  reasoningEffort: true,
  hostedWebSearch: false,
  billing: { upstreamPayer: "workspace", metering: "external" },
  credentialReadiness: { status: "ready", reason: null, basis: "connection", checkedAt: null },
  availability: { status: "available", reason: null, checkedAt: null },
  ...(state === "unsupported"
    ? {}
    : {
        compactionPolicy: {
          defaultTokens: threshold,
          overrideTokens: overrides[id] ?? null,
          effectiveTokens: Math.min(overrides[id] ?? threshold, 872_000),
          minimumTokens: 16_000,
          maximumTokens: 872_000,
        },
      }),
}));
export const receipts: unknown[] = [];
Object.assign(window, { compactionReceipts: receipts });
const client = {
  getWorkspaceModelCatalog: async () => {
    if (state === "error") throw new Error("Synthetic catalog failure");
    return {
      models: state === "empty" ? [] : models,
      defaultSelection: { model: models[0]!.id },
    };
  },
};
export function useAppContext() {
  return {
    client,
    captureWorkspaceInvocation: () => "sample-transition",
    ownsWorkspaceInvocation: () => state !== "stale",
    updateWorkspaceSettings: async (_id: string, patch: unknown) => {
      receipts.push(patch);
      if (state === "save-error") return null;
      return { settings: patch };
    },
  };
}
