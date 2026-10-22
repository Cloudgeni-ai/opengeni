import {
  decisionModelConfiguration,
  type DecisionModelSettings,
  type Settings,
} from "@opengeni/config";
import { createHttpDecisionModel, type DecisionModel } from "@opengeni/decisions";
import { createJevDecisionModel, JevClient } from "@opengeni/jev";

export type WorkerDecisionSettings = DecisionModelSettings &
  Partial<Pick<Settings, "jevApiKey" | "jevBaseUrl" | "jevModel" | "jevRequestTimeoutMs">>;

/** One deployment-owned category, consumed by code search and tool discovery. */
export function configuredDecisionModel(
  settings: WorkerDecisionSettings,
  options: {
    allowLegacyCodeSearch?: boolean;
    fetch?: typeof fetch;
  } = {},
): { id: string; model: DecisionModel } | undefined {
  const config = decisionModelConfiguration(settings, options.allowLegacyCodeSearch);
  if (!config) return undefined;
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
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
        )
      : createHttpDecisionModel({
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          ...(config.baseUrl ? { endpoint: `${config.baseUrl.replace(/\/$/, "")}/decisions` } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
  return { id: `${config.provider}/${config.model}`, model };
}
