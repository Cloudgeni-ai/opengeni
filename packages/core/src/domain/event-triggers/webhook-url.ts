import type { Settings } from "@opengeni/config";

/** Every inbound webhook URL: a random route id under one public path. */
export const EVENT_WEBHOOK_PATH_PREFIX = "/v1/webhooks/events/";

export function eventSourceWebhookUrl(baseUrl: string, routeId: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${EVENT_WEBHOOK_PATH_PREFIX}${routeId}`;
}

/**
 * The public address other services send webhooks to: the webhook address
 * when the deployment publishes its webhook paths somewhere other than its
 * console, else the console's public address.
 */
export function inboundWebhookBaseUrl(
  settings: Pick<Settings, "publicBaseUrl" | "webhookBaseUrl">,
): string | undefined {
  return settings.webhookBaseUrl ?? settings.publicBaseUrl;
}
