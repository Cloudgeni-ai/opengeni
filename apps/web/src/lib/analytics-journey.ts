import { isAnalyticsAction, type AnalyticsAction } from "./analytics-actions";

/** Content-free product facts. Never derive a label from user text or request bodies. */
export type JourneyProperties = Record<string, string | number | boolean>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Workspace pages: the first path segment after `/workspaces/<id>/`. Keep this in
// step with the workspace routes in App.tsx (a drift test enforces it).
const PAGES = new Set([
  "sessions",
  "inbox",
  "priority",
  "plugins",
  "capabilities",
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
  "agents",
  "variable-sets",
  "environments",
  "rigs",
  "playground",
  "read-only-chats",
]);
// Top-level routes outside a workspace, by exact path shape. A concrete id in
// the path is never reported for these; everything unlisted is "other".
const TOP_LEVEL_PAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/$/, "home"],
  [/^\/sessions\/[^/]+$/, "session-link"],
  [/^\/identity-links\/[^/]+$/, "identity-link"],
  [/^\/billing$/, "checkout-return"],
  [/^\/integrations$/, "integration-return"],
  [/^\/device$/, "device"],
  [/^\/connect-agent$/, "connect-agent"],
  [/^\/native-sign-in$/, "native-sign-in"],
  [/^\/reset-password$/, "reset-password"],
  [/^\/setup-account$/, "setup-account"],
  [/^\/account-auth$/, "account-auth"],
  [/^\/settings\/security$/, "personal-security"],
];
const SECTIONS = new Set([
  "general",
  "models",
  "members",
  "billing",
  "insights",
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
  "learning",
  "plugins",
  "danger",
  "overview",
  "people",
  "recovery",
  "developer",
  "files",
  "access",
  "identity",
  "capabilities",
]);

/** Every `page` value `journeyPage` can report. */
export function journeyPageLabels(): ReadonlySet<string> {
  return new Set([...PAGES, ...TOP_LEVEL_PAGES.map(([, page]) => page), "other"]);
}

export function journeyPage(pathname: string, search = ""): JourneyProperties {
  const parts = pathname.split("/").filter(Boolean);
  const workspace = parts[0] === "workspaces" && UUID.test(parts[1] ?? "");
  const page = workspace
    ? (parts[2] ?? "sessions")
    : (TOP_LEVEL_PAGES.find(([pattern]) => pattern.test(pathname))?.[1] ?? "other");
  const query = new URLSearchParams(search);
  const section = query.get("section") ?? query.get("view");
  return {
    page: !workspace || PAGES.has(page) ? page : "other",
    ...(workspace ? { workspace_id: parts[1]! } : {}),
    ...(page === "sessions" && UUID.test(parts[3] ?? "") ? { session_id: parts[3]! } : {}),
    ...(section && SECTIONS.has(section) ? { section } : {}),
  };
}

export type JourneyOperation = {
  operation: "session_create" | "session_command" | "model_connection" | "voice_call" | "dictation";
  properties: JourneyProperties;
};

export type JourneyMilestoneName =
  | "checkout_started"
  | "organization_setup_completed"
  | "api_key_created";
export type JourneyMilestone = { name: JourneyMilestoneName; properties: JourneyProperties };

/**
 * Accepted requests that complete a sign-up or embedding funnel step. Exact
 * product routes only; request and response bodies are never inspected.
 */
export function journeyMilestone(pathname: string, method: string): JourneyMilestone | null {
  if (method.toUpperCase() !== "POST") return null;
  if (pathname === "/v1/billing/checkout") return { name: "checkout_started", properties: {} };
  if (pathname === "/v1/auth/organization-onboarding")
    return { name: "organization_setup_completed", properties: {} };
  const parts = pathname.split("/").filter(Boolean);
  if (
    parts.length === 4 &&
    parts[0] === "v1" &&
    (parts[1] === "organizations" || parts[1] === "workspaces") &&
    UUID.test(parts[2] ?? "") &&
    parts[3] === "api-keys"
  ) {
    // The embedding funnel's first server-side step. Which key preset was
    // minted is in the request body, so it is deliberately not reported.
    return parts[1] === "organizations"
      ? { name: "api_key_created", properties: { scope: "organization", account_id: parts[2]! } }
      : { name: "api_key_created", properties: { scope: "workspace", workspace_id: parts[2]! } };
  }
  return null;
}

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
  if (
    parts[1] === "workspaces" &&
    parts[3] === "sessions" &&
    parts.length === 6 &&
    UUID.test(parts[4] ?? "") &&
    parts[5] === "realtime" &&
    method.toUpperCase() === "POST"
  ) {
    // Entering live voice for one session; heartbeats and negotiation are not new calls.
    return { operation: "voice_call", properties: { ...properties, session_id: parts[4]! } };
  }
  if (
    parts[1] === "workspaces" &&
    parts.length === 4 &&
    method.toUpperCase() === "POST" &&
    (parts[3] === "transcriptions" || parts[3] === "transcription-recordings")
  ) {
    // One dictation: a direct transcription or the start of a long recording.
    // Recording chunks, finalize, and processing are not new dictations.
    return {
      operation: "dictation",
      properties: { ...properties, mode: parts[3] === "transcriptions" ? "direct" : "recording" },
    };
  }
  if (["codex", "supergrok", "ai-gateway", "openrouter", "opper"].includes(parts[3] ?? "")) {
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

export function journeyAction(value: string | null): AnalyticsAction | null {
  return isAnalyticsAction(value) ? value : null;
}
