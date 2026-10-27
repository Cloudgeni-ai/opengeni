import {
  decisionModelConfiguration,
  type DecisionModelSettings,
  type Settings,
} from "@opengeni/config";
import { createHttpDecisionModel, type DecisionModel } from "@opengeni/decisions";
import { createJevDecisionModel, JevClient } from "@opengeni/jev";
import { sideFeatureRouteFetch, sideFeatureRouteRunnable } from "@opengeni/runtime";

export type WorkerDecisionSettings = DecisionModelSettings &
  Partial<Pick<Settings, "jevApiKey" | "jevBaseUrl" | "jevModel" | "jevRequestTimeoutMs">>;

/**
 * One deployment-owned category, consumed by code search and tool discovery.
 * Under EU-only inference (the settings or the run's context) a decision
 * model whose route is not EU is unavailable, and its transport checks the
 * route again before every request.
 */
export function configuredDecisionModel(
  settings: WorkerDecisionSettings,
  options: {
    allowLegacyCodeSearch?: boolean;
    fetch?: typeof fetch;
  } = {},
): { id: string; model: DecisionModel } | undefined {
  const config = decisionModelConfiguration(settings, options.allowLegacyCodeSearch);
  if (!config) return undefined;
  const route = `decision_model.${config.provider}` as const;
  if (!sideFeatureRouteRunnable(settings, route)) return undefined;
  const fetch = sideFeatureRouteFetch(settings, route, options.fetch ?? globalThis.fetch);
  const model =
    config.provider === "jev"
      ? createJevDecisionModel(
          new JevClient({
            apiKey: config.apiKey,
            model: config.model,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            ...(settings.jevRequestTimeoutMs !== undefined
              ? { timeoutMs: settings.jevRequestTimeoutMs }
              : {}),
            fetch,
          }),
        )
      : createHttpDecisionModel({
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          ...(config.baseUrl ? { endpoint: `${config.baseUrl.replace(/\/$/, "")}/decisions` } : {}),
          fetch,
        });
  return { id: `${config.provider}/${config.model}`, model };
}
