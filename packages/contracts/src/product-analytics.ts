import { z } from "zod";

// Content-free product-analytics dimensions carried on durable facts and the
// optional host export. Every value comes from a fixed list or from OpenGeni's
// own code-defined names. None of them is an authorization input, and none
// may carry prompt text, tool arguments, customer names, tenant domains, or
// operator-configured identifiers.

/**
 * The product surface through which a turn's request entered OpenGeni.
 *
 * - `web`: the OpenGeni web app (managed cookie or the local browser context).
 * - `slack`: a Slack mention, command, DM, shortcut, thread reply, or reaction.
 * - `api_key`: an API key or configured key, including the SDK and scripts.
 * - `embedded`: a host that embeds OpenGeni through signed delegation or an
 *   organization key acting for an external user.
 * - `scheduled`: a scheduled-task occurrence.
 * - `agent`: another agent (a child session, an agent message, or Agent Steer).
 * - `voice`: a realtime voice delegation or its end-of-call handoff.
 * - `site`: a published workspace Site.
 * - `automation`: an event-triggered automation run.
 * - `mcp`: an external MCP client connected through workspace MCP OAuth.
 * - `system`: OpenGeni's own maintenance work with no human entry.
 *
 * Turns that no new request entered (goal continuations, child results,
 * command results, wait timeouts, compaction) inherit the surface of the
 * session's latest started turn. Null means no surface was captured: rows
 * written before capture existed, or machine work in a session that has
 * never started a turn with one.
 */
export const SESSION_TURN_SURFACES = [
  "web",
  "slack",
  "api_key",
  "embedded",
  "scheduled",
  "agent",
  "voice",
  "site",
  "automation",
  "mcp",
  "system",
] as const;
export const SessionTurnSurface = z.enum(SESSION_TURN_SURFACES);
export type SessionTurnSurface = z.infer<typeof SessionTurnSurface>;

/**
 * Request header the first-party web console sends while its tab is visible
 * and the person interacted with it in the last few minutes. The API records
 * server-side presence (`opengeni_active_users`, `user.active`) only for
 * canonical managed browser sessions carrying this exact value, so an idle open
 * tab, background polling and stream re-authorization never count as activity.
 * Analytics only: it never grants or narrows access.
 */
export const OPENGENI_USER_ACTIVITY_HEADER = "x-opengeni-user-activity";
export const OPENGENI_USER_ACTIVITY_ACTIVE = "active";
/** Interaction recency, in milliseconds, behind the activity header. */
export const OPENGENI_USER_ACTIVITY_WINDOW_MS = 5 * 60_000;

/** Parse a stored value; anything outside the fixed list is treated as absent. */
export function sessionTurnSurfaceOrNull(value: unknown): SessionTurnSurface | null {
  const parsed = SessionTurnSurface.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Model provider families exported for analytics. Reserved OpenGeni provider
 * ids pass through unchanged; every operator-configured registry provider is
 * reported as `registry` so a deployment's own naming never leaves it.
 * `opengeni_private.analytics_model_provider` (migration 0533) mirrors this.
 */
export const ANALYTICS_MODEL_PROVIDERS = [
  "openai",
  "azure",
  "codex-subscription",
  "supergrok-subscription",
  "opengeni-gateway",
  "workspace-gateway",
  "organization-gateway",
  "openrouter",
  "workspace-openrouter",
  "organization-openrouter",
  "registry",
] as const;
export const AnalyticsModelProvider = z.enum(ANALYTICS_MODEL_PROVIDERS);
export type AnalyticsModelProvider = z.infer<typeof AnalyticsModelProvider>;

const RESERVED_ANALYTICS_MODEL_PROVIDERS: ReadonlySet<string> = new Set(
  ANALYTICS_MODEL_PROVIDERS.filter((provider) => provider !== "registry"),
);
const REGISTRY_PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Map an accepted turn's execution-policy provider id to its analytics family. */
export function analyticsModelProvider(
  providerId: string | null | undefined,
): AnalyticsModelProvider | null {
  if (typeof providerId !== "string") return null;
  if (RESERVED_ANALYTICS_MODEL_PROVIDERS.has(providerId)) {
    return providerId as AnalyticsModelProvider;
  }
  return REGISTRY_PROVIDER_ID.test(providerId) ? "registry" : null;
}

/**
 * Tool family on a tool-call fact: an OpenGeni first-party tool name,
 * `integration:<catalog domain>` for a reviewed catalog integration, or
 * `custom` for any other MCP server (a workspace's own server, a self-hosted
 * provider, or an unreviewed catalog entry). The domain part is limited to
 * {@link TOOL_FAMILY_INTEGRATION_DOMAINS}, so a tenant's own host name is
 * never exported.
 */
export const ToolFamily = z
  .string()
  .max(160)
  .regex(/^(?:custom|integration:[a-z0-9](?:[a-z0-9.-]{0,150}[a-z0-9])?|[a-z][a-z0-9_]{0,63})$/u);
export type ToolFamily = z.infer<typeof ToolFamily>;

/**
 * Reviewed integration domains that may appear as `integration:<domain>`:
 * OpenGeni's native provider domains plus the MCP host of every curated
 * catalog entry (`data/catalog/curated.json`). A test keeps the curated part
 * in sync. Any other domain is reported as `custom`.
 */
export const TOOL_FAMILY_INTEGRATION_DOMAINS = [
  // Native provider domains.
  "github.com",
  "gitlab.com",
  "dev.azure.com",
  "slack.com",
  "chatgpt.com",
  "x.com",
  "reddit.com",
  "fiken.no",
  "api.atlassian.com",
  "googleapis.com",
  // Curated catalog MCP hosts.
  "gmailmcp.googleapis.com",
  "mcp.slack.com",
  "api.mobbin.com",
  "mcp.linear.app",
  "mcp.asana.com",
  "mcp.stripe.com",
  "mcp.figma.com",
  "mcp.canva.com",
  "mcp.sentry.dev",
  "mcp.vercel.com",
  "bindings.mcp.cloudflare.com",
  "mcp.paypal.com",
  "mcp.monday.com",
  "mcp.airtable.com",
  "mcp.zapier.com",
  "mcp.webflow.com",
  "mcp.supabase.com",
  "mcp.clickup.com",
  "mcp.calendly.com",
  "mcp.box.com",
  "mcp.dropbox.com",
  "mcp.amplitude.com",
  "mcp.posthog.com",
  "mcp.pagerduty.com",
  "mcp.apollo.io",
  "api.ahrefs.com",
  "mcp.semrush.com",
  "mcp.frontapp.com",
  "mcp.otter.ai",
  "mcp.notion.com",
  "mcp.hubspot.com",
  "mcp.atlassian.com",
  "mcp.intercom.com",
] as const;

const TOOL_FAMILY_INTEGRATION_DOMAIN_SET: ReadonlySet<string> = new Set(
  TOOL_FAMILY_INTEGRATION_DOMAINS,
);

function normalizedDomain(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/u, "");
  return domain.length > 0 ? domain : null;
}

/**
 * Tool family for an MCP server that is not first-party. The first candidate
 * domain on the reviewed list wins; otherwise the server is `custom`.
 */
export function integrationToolFamily(
  candidateDomains: readonly (string | null | undefined)[],
): ToolFamily {
  for (const candidate of candidateDomains) {
    const domain = normalizedDomain(candidate);
    if (domain && TOOL_FAMILY_INTEGRATION_DOMAIN_SET.has(domain)) {
      return `integration:${domain}`;
    }
  }
  return "custom";
}

/**
 * First-party tools the runtime exposes outside any MCP server: base sandbox
 * and runtime tools, progressive-disclosure routers, media generation, and
 * provider-hosted tool calls as the event stream names them.
 */
export const FIRST_PARTY_FUNCTION_TOOL_FAMILY_NAMES = [
  "exec_command",
  "write_stdin",
  "view_image",
  "apply_patch",
  "skill_read",
  "repository_skill_read",
  "request_human_input",
  "list_models",
  "code_search",
  "tool_search",
  "tool_list",
  "tool_invoke",
  "generate_image",
  "generate_video",
  "get_video_generation_capabilities",
  "computer_screenshot",
  "web_search_call",
  "image_generation_call",
  "code_interpreter_call",
  "file_search_call",
  "computer_call",
  "local_shell_call",
  "shell_call",
  "apply_patch_call",
] as const;

/**
 * First-party tools served by in-process attempt definitions or the dedicated
 * `files` server rather than the public `opengeni` MCP catalog.
 */
export const FIRST_PARTY_ATTEMPT_TOOL_FAMILY_NAMES = [
  "skill_checkout",
  "skill_publish",
  "skill_install",
  "skill_remove",
  "skill_save",
  "skill_search",
  "operation_read",
  "knowledge_source_fetch",
  "knowledge_source_read",
  "files_get_download_url",
] as const;

/**
 * OpenGeni's in-process integration tools that are not registry MCP servers,
 * keyed by their catalog server id, with the provider domain they act on.
 */
export const IN_PROCESS_INTEGRATION_TOOL_FAMILY_DOMAINS: Readonly<Record<string, string>> = {
  "google-drive-publishing": "googleapis.com",
};
