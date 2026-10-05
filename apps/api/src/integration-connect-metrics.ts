import { CORE_INTEGRATION_DEFINITIONS } from "@opengeni/capabilities";
import type { ConnectAttemptTransition } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

/**
 * Low-cardinality product telemetry for connecting capabilities, integrations,
 * and MCP servers. Labels are closed sets: a caller-chosen provider id, MCP
 * URL, provider domain, workspace, or user never becomes a label value.
 *
 * Three signals cover the whole connect surface:
 * - `opengeni_connect_attempts_total` — every unified Connect attempt (the
 *   popup flow behind every provider card), counted on each committed state
 *   transition, so `started` minus terminal states is abandonment.
 * - `opengeni_integration_oauth_callbacks_total` — every provider redirect back
 *   to Opengeni, including the legacy settings-page flows whose failure is only
 *   visible in a `?<flow>=error&reason=` redirect, never in an HTTP status.
 * - `opengeni_integration_oauth_starts_total` — MCP OAuth discovery/registration
 *   at the start of a connection, where remote servers most often fail.
 */

const FIXED_CONNECT_PROVIDERS = [
  "x",
  "reddit",
  "mcp-install",
  "openapi",
  "graphql",
  "slack-bot",
  "gmail",
  "slack-personal",
  "github-personal",
  "github-app",
  "github-lens",
  "google-drive-knowledge",
  "google-drive-publish",
  "fiken-token",
  "fiken-oauth",
  "mcp-oauth",
  "mcp-headers",
  "mcp-bearer",
] as const;

const CONNECT_PROVIDERS: ReadonlySet<string> = new Set([
  ...FIXED_CONNECT_PROVIDERS,
  ...CORE_INTEGRATION_DEFINITIONS.map((definition) => definition.id),
]);

const CONNECT_STATES: ReadonlySet<string> = new Set([
  "requires_user_action",
  "credential_input",
  "provider_wait",
  "account_selection",
  "resource_selection",
  "preview",
  "installing",
  "connected_but_incomplete",
  "complete",
  "cancelled",
  "expired",
  "failed",
  "uncertain",
]);

const BOUNDED_CODE = /^[a-z][a-z0-9_]{0,47}$/;

export function connectMetricProvider(providerId: string): string {
  return CONNECT_PROVIDERS.has(providerId) ? providerId : "other";
}

/** `http_404`/`upstream_http_502` collapse to a status class; other codes keep a closed grammar. */
export function boundedConnectReason(value: string | null | undefined): string {
  if (!value) return "none";
  const http = /^(upstream_)?http_([1-5])\d\d$/.exec(value);
  if (http) return `${http[1] ?? ""}http_${http[2]}xx`;
  return BOUNDED_CODE.test(value) ? value : "other";
}

export function observeConnectAttemptTransition(
  observability: Observability | null | undefined,
  transition: ConnectAttemptTransition,
): void {
  if (!observability) return;
  try {
    observability.incrementCounter({
      name: "opengeni_connect_attempts_total",
      help: "Connect (capability/integration/MCP setup) attempt transitions by bounded provider, resulting state, and error code. state=started counts new attempts.",
      labels: {
        provider: connectMetricProvider(transition.providerId),
        state:
          transition.previousState === null
            ? "started"
            : CONNECT_STATES.has(transition.state)
              ? transition.state
              : "other",
        error: boundedConnectReason(transition.errorCode),
      },
    });
  } catch {
    // Telemetry never changes a committed setup outcome.
  }
}

/** Provider redirect routes, keyed by route label, with the flow they complete. */
const OAUTH_CALLBACK_FLOWS = new Map<string, string>([
  ["/v1/integrations/oauth/callback", "mcp_oauth"],
  ["/v1/integrations/provider-oauth/callback", "provider_oauth"],
  ["/v1/integrations/slack/callback", "slack_bot"],
  ["/v1/integrations/fiken/callback", "fiken"],
  ["/v1/integrations/atlassian/callback", "atlassian"],
  ["/v1/integrations/google-drive/callback", "google_drive"],
  ["/v1/integrations/github-personal/oauth/callback", "github_personal"],
  ["/v1/social/oauth/callback", "social"],
  ["/v1/github/setup", "github_app"],
  ["/v1/github/install/callback", "github_app"],
  ["/v1/github/oauth/callback", "github_app"],
  ["/v1/github/app-manifest/callback", "github_app"],
  ["/v1/pr-review/github/install/callback", "github_lens"],
  ["/v1/pr-review/github/oauth/callback", "github_lens"],
]);

/** Redirect query markers written by each flow's `callbackReturnPath`. */
const OAUTH_RESULT_MARKERS = [
  "integration_oauth",
  "slack",
  "google_drive",
  "fiken",
  "atlassian",
  "github_personal_oauth",
  "social_oauth",
  "github",
] as const;
const SUCCESS_MARKER_VALUES = new Set(["success", "connected", "complete"]);

export function isOAuthCallbackRoute(route: string): boolean {
  return OAUTH_CALLBACK_FLOWS.has(route);
}

/**
 * Classify one provider callback response from its status and redirect only.
 * A popup (Connect attempt) callback returns to its exact opener URL without
 * a result marker; its outcome is counted by `opengeni_connect_attempts_total`
 * and here as `handoff`.
 */
export function classifyOAuthCallback(input: {
  route: string;
  status: number;
  location: string | null;
}): { flow: string; provider: string; outcome: string; stage: string; reason: string } | null {
  const flow = OAUTH_CALLBACK_FLOWS.get(input.route);
  if (!flow) return null;
  if (input.status >= 400) {
    return {
      flow,
      provider: flow,
      outcome: "failure",
      stage: "none",
      reason: `http_${String(input.status)[0]}xx`,
    };
  }
  let params: URLSearchParams | null = null;
  if (input.location) {
    try {
      params = new URL(input.location, "https://opengeni.invalid").searchParams;
    } catch {
      params = null;
    }
  }
  const marker = params
    ? OAUTH_RESULT_MARKERS.map((name) => params!.get(name)).find((value) => value !== null)
    : undefined;
  const definitionId = params?.get("definitionId") ?? null;
  const provider =
    flow === "provider_oauth" && definitionId && CONNECT_PROVIDERS.has(definitionId)
      ? definitionId
      : flow;
  if (marker === undefined || marker === null) {
    return { flow, provider, outcome: "handoff", stage: "none", reason: "none" };
  }
  if (SUCCESS_MARKER_VALUES.has(marker)) {
    return { flow, provider, outcome: "success", stage: "none", reason: "none" };
  }
  const reason = boundedConnectReason(params?.get("reason"));
  return {
    flow,
    provider,
    outcome: reason === "access_denied" || reason === "cancelled" ? "cancelled" : "failure",
    stage: boundedConnectReason(params?.get("stage")),
    reason,
  };
}

export function observeOAuthCallback(
  observability: Observability | null | undefined,
  input: { route: string; status: number; location: string | null },
): void {
  if (!observability) return;
  const classified = classifyOAuthCallback(input);
  if (!classified) return;
  try {
    observability.incrementCounter({
      name: "opengeni_integration_oauth_callbacks_total",
      help: "Provider OAuth/install callbacks by bounded flow, provider, outcome, stage, and reason.",
      labels: classified,
    });
  } catch {
    // Telemetry never changes the callback redirect.
  }
}

export function observeOAuthStart(
  observability: Observability | null | undefined,
  input: { flow: string; outcome: "success" | "failure"; stage?: string; reason?: string },
): void {
  if (!observability) return;
  try {
    observability.incrementCounter({
      name: "opengeni_integration_oauth_starts_total",
      help: "Integration OAuth starts (discovery, registration, state) by bounded flow, outcome, stage, and reason.",
      labels: {
        flow: BOUNDED_CODE.test(input.flow) ? input.flow : "other",
        outcome: input.outcome,
        stage: boundedConnectReason(input.stage),
        reason: boundedConnectReason(input.reason),
      },
    });
  } catch {
    // Telemetry never changes the start response.
  }
}
