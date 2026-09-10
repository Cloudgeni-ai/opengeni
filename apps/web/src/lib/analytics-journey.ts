/** Content-free product facts. Never derive a label from user text or request bodies. */
export type JourneyProperties = Record<string, string | number | boolean>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGES = new Set([
  "sessions",
  "priority",
  "plugins",
  "documents",
  "state",
  "memory",
  "schedules",
  "artifacts",
  "settings",
  "organization",
  "insights",
  "machines",
  "files",
]);
const SECTIONS = new Set([
  "general",
  "models",
  "members",
  "billing",
  "usage",
  "security",
  "integrations",
  "connections",
  "instructions",
  "skills",
  "memory",
  "preferences",
  "retention",
  "profile",
  "organization",
  "workspaces",
  "api-keys",
  "variables",
  "knowledge",
]);

export function journeyPage(pathname: string, search = ""): JourneyProperties {
  const parts = pathname.split("/").filter(Boolean);
  const workspace = parts[0] === "workspaces" && UUID.test(parts[1] ?? "");
  const page = workspace ? (parts[2] ?? "sessions") : "other";
  const query = new URLSearchParams(search);
  const section = query.get("section") ?? query.get("view");
  return {
    page: PAGES.has(page) ? page : "other",
    ...(workspace ? { workspace_id: parts[1]! } : {}),
    ...(page === "sessions" && UUID.test(parts[3] ?? "") ? { session_id: parts[3]! } : {}),
    ...(section && SECTIONS.has(section) ? { section } : {}),
  };
}

export type JourneyOperation = {
  operation: "session_create" | "session_command" | "model_connection";
  properties: JourneyProperties;
};

/** Only classify our finite mutation routes, never fetch URLs, payloads or credentials. */
export function journeyOperation(pathname: string, method: string): JourneyOperation | null {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return null;
  const parts = pathname.split("/").filter(Boolean);
  if (
    parts[0] !== "v1" ||
    !["workspaces", "organizations"].includes(parts[1] ?? "") ||
    !UUID.test(parts[2] ?? "")
  )
    return null;
  const properties: JourneyProperties = {
    [parts[1] === "workspaces" ? "workspace_id" : "account_id"]: parts[2]!,
    method: method.toUpperCase(),
  };
  if (parts[1] === "workspaces" && parts[3] === "sessions") {
    if (parts.length === 4 && method.toUpperCase() === "POST")
      return { operation: "session_create", properties };
    if (
      UUID.test(parts[4] ?? "") &&
      method.toUpperCase() === "POST" &&
      ((parts[5] === "events" && parts.length === 6) ||
        (parts[5] === "composer-draft" && parts[6] === "submit" && parts.length === 7))
    ) {
      return { operation: "session_command", properties: { ...properties, session_id: parts[4]! } };
    }
  }
  if (["codex", "supergrok", "ai-gateway", "openrouter"].includes(parts[3] ?? "")) {
    // Endpoint leaf names are closed vocabulary, not account IDs or provider responses.
    const action = parts.at(-1)!;
    if (
      [
        "connect",
        "disconnect",
        "credentials",
        "accounts",
        "subscriptions",
        "start",
        "complete",
        "import",
        "callback",
      ].includes(action)
    ) {
      return {
        operation: "model_connection",
        properties: { ...properties, provider: parts[3]!, action },
      };
    }
  }
  return null;
}

export function journeyOutcome(status: number): string {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 401) return "unauthenticated";
  if (status === 402) return "credits_required";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "invalid_request";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "server_error" : "rejected";
}

const ACTIONS = new Set([
  "connect_codex",
  "connect_supergrok",
  "connect_ai_gateway",
  "connect_openrouter",
]);
export function journeyAction(value: string | null): string | null {
  return value && ACTIONS.has(value) ? value : null;
}
