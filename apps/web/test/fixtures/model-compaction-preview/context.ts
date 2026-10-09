const params = new URLSearchParams(window.location.search);
const models = [
  { id: "synthetic/fast", label: "Claude Haiku 5.5", threshold: 95_000 },
  { id: "synthetic/deep", label: "Claude Opus 5.5", threshold: 300_000 },
].map(({ threshold, ...model }) => ({
  ...model,
  api: "anthropic-messages",
  provider: "synthetic",
  providerLabel: "Anthropic API",
  reasoningEffort: true,
  hostedWebSearch: false,
  billing: { upstreamPayer: "workspace", metering: "external" },
  credentialReadiness: { status: "ready", reason: null, basis: "connection", checkedAt: null },
  availability: { status: "available", reason: null, checkedAt: null },
  compactionPolicy: {
    defaultTokens: threshold,
    overrideTokens: params.get("state") === "override" ? 90_000 : null,
    effectiveTokens: params.get("state") === "override" ? 90_000 : threshold,
    minimumTokens: 16_000,
    maximumTokens: 872_000,
  },
}));
export const receipts: unknown[] = [];
Object.assign(window, { compactionReceipts: receipts });
const client = {
  getWorkspaceModelCatalog: async () => {
    if (params.get("state") === "error") throw new Error("Synthetic catalog failure");
    return { models, defaultSelection: { model: models[0]!.id } };
  },
};
export function useAppContext() {
  return {
    client,
    captureWorkspaceInvocation: () => "sample-transition",
    ownsWorkspaceInvocation: () => params.get("state") !== "stale",
    updateWorkspaceSettings: async (_id: string, patch: unknown) => {
      receipts.push(patch);
      if (params.get("state") === "save-error") return null;
      return { settings: patch };
    },
  };
}
