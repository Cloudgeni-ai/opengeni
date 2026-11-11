import type { ModelProviderApi, ModelProviderWireProfile } from "@opengeni/config";

/**
 * Documented ceiling on the images one model request may carry. Providers
 * count every image the request resends, including earlier turns and images
 * inside tool results, so a long screenshot-heavy session reaches it without
 * any single large step.
 *
 * - Azure OpenAI Responses: 50 images per request.
 * - Anthropic Messages: 100 per request for models with a 200k-token context
 *   window, 600 for the others.
 * - OpenAI Responses: 1,500 per request.
 *
 * Chat Completions endpoints front arbitrary upstream models whose ceiling is
 * not knowable from the wire API, so they return null (no image trigger).
 */
export function providerRequestImageLimit(
  provider: { api: ModelProviderApi; wireProfile?: ModelProviderWireProfile | undefined },
  contextWindowTokens: number,
): number | null {
  if (provider.api === "anthropic-messages") return contextWindowTokens <= 200_000 ? 100 : 600;
  if (provider.api === "responses") return provider.wireProfile === "azure-openai" ? 50 : 1_500;
  return null;
}
