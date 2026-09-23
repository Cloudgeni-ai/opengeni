/** Callback reasons are display hints only. Never grant authority or echo arbitrary query text. */
export function slackSettingsSearch(search: Record<string, unknown>): {
  integration?: "slack";
  slack?: "connected" | "error";
  reason?: string;
  connectionId?: string;
} {
  const slack = search.slack === "connected" || search.slack === "error" ? search.slack : undefined;
  return {
    ...(search.integration === "slack" ? { integration: "slack" as const } : {}),
    ...(slack ? { slack } : {}),
    ...(slack === "error"
      ? {
          reason:
            typeof search.reason === "string" &&
            [
              "provider_denied",
              "http_400",
              "http_403",
              "http_404",
              "http_409",
              "http_422",
              "installation_failed",
            ].includes(search.reason)
              ? search.reason
              : "installation_failed",
        }
      : {}),
    ...(slack === "connected" &&
    typeof search.connectionId === "string" &&
    /^[0-9a-f-]{36}$/i.test(search.connectionId)
      ? { connectionId: search.connectionId }
      : {}),
  };
}
