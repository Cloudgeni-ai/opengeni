/** Every inbound webhook URL: a random route id under one public path. */
export const EVENT_WEBHOOK_PATH_PREFIX = "/v1/webhooks/events/";

export function eventSourceWebhookUrl(baseUrl: string, routeId: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${EVENT_WEBHOOK_PATH_PREFIX}${routeId}`;
}
