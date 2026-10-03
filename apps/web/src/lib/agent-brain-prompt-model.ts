import { modelDisplayName } from "@opengeni/sdk/model-display";
import type { LatencyMode, ReasoningEffort, WorkspaceModelCatalogModel } from "@opengeni/sdk";

export type AgentBrainPromptModelPreference = {
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
};

export type AgentBrainPromptModelSelection = {
  model: string;
  label: string;
  paymentSource: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
};

function paymentSourceFor(model: WorkspaceModelCatalogModel): string {
  // Scope-free payer words; who connected a key is a Models-settings fact.
  if (model.cost === "free") return "Free in this deployment";
  if (model.cost === "credits") return "Opengeni credits";
  if (
    model.provider === "organization-claude-subscription" ||
    model.provider === "workspace-claude-subscription"
  ) {
    return "Claude plan";
  }
  if (model.cost === "workspace" || model.cost === "organization") return "API key";
  if (model.source === "supergrok") return "SuperGrok plan";
  if (model.cost === "subscription" || model.source === "codex") return "ChatGPT plan";
  if (model.source === "workspace_gateway") return "API key";
  if (model.source === "opengeni" || model.billing?.metering === "opengeni_credits") {
    return "Opengeni credits";
  }
  if (model.billing?.upstreamPayer === "connected_subscription") {
    return model.credentialSource?.kind === "connected_subscription" &&
      model.credentialSource.provider === "xai"
      ? "SuperGrok plan"
      : "ChatGPT plan";
  }
  if (
    model.billing?.upstreamPayer === "workspace" ||
    model.billing?.upstreamPayer === "organization"
  ) {
    return "API key";
  }
  return "Provider account";
}

/**
 * Pick a workspace-selectable model for the Company Brain "Create with OpenGeni"
 * prompt from the raw workspace model catalog. The preferred (app-context)
 * model wins when the catalog marks it selectable; otherwise the first
 * selectable catalog model (catalog order) is used. Returns `null` when the
 * catalog has no selectable model, so the caller can keep the form disabled
 * instead of submitting a model the workspace policy would reject.
 *
 * `availability.selectable` is the API's combined verdict (runnable definition,
 * ready credential, workspace policy, provider health), so no further
 * readiness check is needed here. The reasoning-effort and latency coercion
 * mirror the shared picker helpers in `@opengeni/react/model-policy`; this
 * module deliberately does not import them: the Company Brain route is the
 * only lazy route outside the session/composer surfaces that would reach them,
 * and that extra edge re-buckets rolldown's entry-aware session chunks and
 * pushes the composer stack into the startup graph.
 */
export function resolveAgentBrainPromptModel(
  models: WorkspaceModelCatalogModel[],
  preferred: AgentBrainPromptModelPreference,
): AgentBrainPromptModelSelection | null {
  const preferredModel = models.find((model) => model.id === preferred.model);
  const model = preferredModel?.availability.selectable
    ? preferredModel
    : models.find((candidate) => candidate.availability.selectable);
  if (!model) {
    return null;
  }
  const efforts = model.capabilities?.reasoning.efforts;
  const effortOptions: ReasoningEffort[] = efforts && efforts.length > 0 ? efforts : ["low"];
  const configuredDefault = model.capabilities?.reasoning.defaultEffort;
  const reasoningEffort: ReasoningEffort = effortOptions.includes(preferred.reasoningEffort)
    ? preferred.reasoningEffort
    : configuredDefault && effortOptions.includes(configuredDefault)
      ? configuredDefault
      : (effortOptions[0] ?? "low");
  const latencyMode: LatencyMode =
    preferred.latencyMode !== "standard" &&
    (model.capabilities?.latencyModes ?? []).some(
      (mode) => mode.id === preferred.latencyMode && mode.runnable,
    )
      ? preferred.latencyMode
      : "standard";
  return {
    model: model.id,
    label: modelDisplayName(model),
    paymentSource: paymentSourceFor(model),
    reasoningEffort,
    latencyMode,
  };
}
