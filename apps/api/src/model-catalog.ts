import {
  OPENROUTER_PROVIDER_ID,
  WORKSPACE_OPENROUTER_PROVIDER_ID,
  type ConfiguredModel,
} from "@opengeni/config";
import {
  ClientModel,
  WorkspaceModelCatalogResponse,
  type WorkspaceModelCatalogResponse as WorkspaceModelCatalogResponseType,
} from "@opengeni/contracts";
import { resolveWorkspaceModelSelection, type WorkspaceModelSelectionInput } from "@opengeni/core";

export {
  MODEL_CREDENTIAL_READINESS_OBSERVATION_MAX_AGE_MS,
  type ModelAvailabilityObservation,
  type ModelCredentialReadinessObservation,
} from "@opengeni/core";

/** Static, client-safe definition projection. No provider secret is reachable. */
export function projectClientModel(model: ConfiguredModel): ClientModel {
  const anonymousProvider =
    model.credentialSource.kind === "deployment" && model.credentialSource.mechanism === "none";
  // Keep the established closed `source` enum compatible for older same-major
  // clients. OpenRouter remains truthfully identified by its public provider
  // id/label and billing metadata; omitting this optional legacy grouping field
  // lets tolerant older contracts parse the additive provider.
  const source =
    model.providerId === OPENROUTER_PROVIDER_ID ||
    model.providerId === WORKSPACE_OPENROUTER_PROVIDER_ID
      ? undefined
      : model.credentialSource.kind === "connected_subscription"
        ? model.credentialSource.provider === "xai"
          ? "supergrok"
          : "codex"
        : model.credentialSource.kind === "workspace_connection"
          ? "workspace_gateway"
          : anonymousProvider
            ? undefined
            : "opengeni";
  const publicProvider = anonymousProvider
    ? { provider: model.providerId, providerLabel: model.providerLabel }
    : model.providerId === OPENROUTER_PROVIDER_ID
      ? { provider: "openrouter", providerLabel: "OpenRouter" }
      : model.providerId === WORKSPACE_OPENROUTER_PROVIDER_ID
        ? { provider: "workspace-openrouter", providerLabel: "Your OpenRouter" }
        : source === "codex"
          ? { provider: "codex", providerLabel: "Codex" }
          : source === "supergrok"
            ? { provider: "supergrok", providerLabel: "SuperGrok" }
            : source === "workspace_gateway"
              ? { provider: "workspace-gateway", providerLabel: "Your Gateway" }
              : { provider: "opengeni", providerLabel: "OpenGeni" };
  return ClientModel.parse({
    id: model.id,
    label: model.label,
    ...(model.shortLabel ? { shortLabel: model.shortLabel } : {}),
    ...publicProvider,
    ...(source === undefined ? {} : { source }),
    api: model.api,
    ...(model.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: model.contextWindowTokens }),
    schemaVersion: model.schemaVersion,
    aliases: model.aliases,
    executionLimits: model.executionLimits,
    billing: model.billing,
    cost: model.cost,
    capabilities: model.capabilities,
    ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    definitionVersion: model.definitionVersion,
  });
}

/**
 * Authenticated workspace catalog. Codex definitions are included only when
 * the deployment enables that connection type; concrete readiness is supplied
 * by the existing metadata-only DB seam. API-key presence establishes only
 * local configuration readiness. Federated/token credentials require a fresh,
 * successful typed resolver observation; credential health and provider health
 * are separate inputs and neither is fabricated.
 */
export function buildWorkspaceModelCatalog(
  input: WorkspaceModelSelectionInput,
): WorkspaceModelCatalogResponseType {
  const models = resolveWorkspaceModelSelection(input).map((selection) => ({
    ...projectClientModel(selection.model),
    credentialReadiness: selection.credentialReadiness,
    policyAllowed: selection.policyAllowed,
    availability: selection.availability,
  }));
  return WorkspaceModelCatalogResponse.parse({ models });
}
