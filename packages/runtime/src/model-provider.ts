import type { Settings } from "@opengeni/config";
import {
  setDefaultModelProvider,
  setDefaultOpenAIClient,
  setDefaultOpenAIKey,
  setOpenAIResponsesTransport,
  setTracingDisabled,
} from "@openai/agents";

import { buildOpenAIClientFromSettings } from "./model-provider-client";
import { MultiProviderModelProvider } from "./model-provider-routing";

export {
  CodexSubscriptionUnavailableError,
  WorkspaceGatewayUnavailableError,
  WorkspaceModelPolicyBlockedError,
  XaiSubscriptionUnavailableError,
} from "./model-provider-errors";
export {
  azureOpenAIDefaultQuery,
  buildOpenAIClientFromSettings,
  buildProviderClient,
  configureRuntimeMetricsHooks,
  recordRuntimeMcpToolCallMetric,
} from "./model-provider-client";
export {
  modelRequestPolicyForProvider,
  normalizeVercelGatewayRequestBody,
} from "./model-provider-request-policy";
export { vercelGatewayRoutingFetch } from "./model-provider-transport";
export {
  MultiProviderModelProvider,
  OpenGeniResponsesModel,
  buildModelInstance,
  resolveTurnModel,
} from "./model-provider-routing";

/** Configure the process-global SDK defaults from one immutable settings snapshot. */
export function configureOpenAI(settings: Settings): void {
  setOpenAIResponsesTransport(settings.openaiResponsesTransport);
  setTracingDisabled(settings.disableOpenaiTracing || !settings.observabilityOtlpEndpoint);
  // Install the registry-aware router as the process default model provider so a
  // model name re-resolved on the SandboxAgent/Modal path (where a Model instance
  // does not survive) routes to its provider instead of the built-in client.
  // Built before the default-client calls below so it captures the same settings.
  const router = new MultiProviderModelProvider(settings);
  if (settings.openaiProvider === "azure") {
    setDefaultOpenAIClient(buildOpenAIClientFromSettings(settings));
    setDefaultModelProvider(router);
    return;
  }
  if (settings.openaiApiKey) {
    setDefaultOpenAIKey(settings.openaiApiKey);
  }
  if (settings.openaiBaseUrl) {
    setDefaultOpenAIClient(buildOpenAIClientFromSettings(settings));
  }
  setDefaultModelProvider(router);
}
