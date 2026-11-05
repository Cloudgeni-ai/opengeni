import type { IntegrationId, IntegrationSpec } from "./types";

/**
 * Integrations under test. Families are the `integration:<domain>` values the
 * worker stamps on `agent.toolCall.created` events (see TOOL_FAMILY_INTEGRATION_DOMAINS
 * in packages/contracts/src/product-analytics.ts). Label words match connect cards
 * and the "Account: <label> — …" prefix of connection-backed tool descriptions.
 */
export const INTEGRATIONS: readonly IntegrationSpec[] = [
  {
    id: "gmail",
    label: "Gmail",
    families: ["integration:gmailmcp.googleapis.com"],
    labelWords: ["gmail"],
  },
  {
    id: "google_calendar",
    label: "Google Calendar",
    families: ["integration:calendarmcp.googleapis.com"],
    labelWords: ["google calendar"],
  },
  {
    id: "google_drive",
    label: "Google Drive",
    families: ["integration:drivemcp.googleapis.com"],
    labelWords: ["google drive"],
    skipReason: "Disabled in production until Google verification completes.",
  },
  {
    id: "linear",
    label: "Linear",
    families: ["integration:mcp.linear.app"],
    labelWords: ["linear"],
  },
  {
    id: "notion",
    label: "Notion",
    families: ["integration:mcp.notion.com"],
    labelWords: ["notion"],
    toolNamePatterns: [/^notion-/],
  },
  {
    id: "asana",
    label: "Asana",
    families: ["integration:mcp.asana.com"],
    labelWords: ["asana"],
  },
  {
    id: "stripe",
    label: "Stripe",
    families: ["integration:mcp.stripe.com"],
    labelWords: ["stripe"],
  },
  {
    id: "atlassian",
    label: "Atlassian",
    families: ["integration:mcp.atlassian.com", "integration:api.atlassian.com"],
    labelWords: ["atlassian", "jira", "confluence"],
    toolNamePatterns: [/jira/i, /confluence/i, /atlassian/i],
  },
  {
    id: "slack",
    label: "Slack",
    families: ["integration:mcp.slack.com", "integration:slack.com"],
    labelWords: ["slack"],
    toolNamePatterns: [/^slack_/],
  },
  {
    id: "github",
    label: "GitHub",
    families: ["integration:github.com"],
    labelWords: ["github"],
    toolNamePatterns: [/^github_/],
  },
  {
    id: "hubspot",
    label: "HubSpot",
    families: ["integration:mcp.hubspot.com"],
    labelWords: ["hubspot"],
  },
  {
    id: "sentry",
    label: "Sentry",
    families: ["integration:mcp.sentry.dev"],
    labelWords: ["sentry"],
  },
  {
    id: "airtable",
    label: "Airtable",
    families: ["integration:mcp.airtable.com"],
    labelWords: ["airtable"],
  },
  {
    id: "apollo",
    label: "Apollo.io",
    families: ["integration:mcp.apollo.io"],
    labelWords: ["apollo"],
  },
  {
    id: "posthog",
    label: "PostHog",
    families: ["integration:mcp.posthog.com"],
    labelWords: ["posthog"],
  },
  {
    id: "vercel",
    label: "Vercel",
    families: ["integration:mcp.vercel.com"],
    labelWords: ["vercel"],
  },
  {
    id: "supabase",
    label: "Supabase",
    families: ["integration:mcp.supabase.com"],
    labelWords: ["supabase"],
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    families: ["integration:bindings.mcp.cloudflare.com"],
    labelWords: ["cloudflare"],
  },
  {
    id: "dropbox",
    label: "Dropbox",
    families: ["integration:mcp.dropbox.com"],
    labelWords: ["dropbox"],
  },
  {
    id: "canva",
    label: "Canva",
    families: ["integration:mcp.canva.com"],
    labelWords: ["canva"],
  },
  {
    id: "front",
    label: "Front",
    families: ["integration:mcp.frontapp.com"],
    labelWords: ["front"],
  },
  {
    id: "outlook_mail",
    label: "Outlook Mail",
    families: [],
    labelWords: ["outlook mail", "outlook"],
    toolNamePatterns: [/^outlook_mail/, /^microsoft_outlook_mail/],
  },
  {
    id: "outlook_calendar",
    label: "Outlook Calendar",
    families: [],
    labelWords: ["outlook calendar"],
    toolNamePatterns: [/^outlook_calendar/, /^microsoft_outlook_calendar/],
  },
  {
    id: "onedrive",
    label: "OneDrive",
    families: [],
    labelWords: ["onedrive"],
    toolNamePatterns: [/onedrive/],
  },
  {
    id: "sharepoint",
    label: "SharePoint",
    families: [],
    labelWords: ["sharepoint"],
    toolNamePatterns: [/sharepoint/],
  },
  {
    // Never connected in either test workspace: only the strong-match card row uses it.
    id: "clickup",
    label: "ClickUp",
    families: ["integration:mcp.clickup.com"],
    labelWords: ["clickup"],
  },
];

const BY_ID = new Map(INTEGRATIONS.map((spec) => [spec.id, spec]));

export function integration(id: IntegrationId): IntegrationSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`unknown integration ${id}`);
  return spec;
}

const familyHost = (family: string) => family.replace(/^integration:/, "").toLowerCase();

/** Exact family first, then the same host one subdomain apart (`linear.app` vs `mcp.linear.app`). */
export function integrationForFamily(family: string | null | undefined): IntegrationId | null {
  if (!family) return null;
  for (const spec of INTEGRATIONS) if (spec.families.includes(family)) return spec.id;
  if (!family.startsWith("integration:")) return null;
  const host = familyHost(family);
  const matches = INTEGRATIONS.filter((spec) =>
    spec.families
      .map(familyHost)
      .some((known) => known.endsWith(`.${host}`) || host.endsWith(`.${known}`)),
  );
  // A shared parent such as `googleapis.com` names no single integration.
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * Integration named by free text such as a card's capability name or an
 * account label ("Linear — Halcyon · Shared"). Longer label words win so
 * "Outlook Calendar" is not read as "Outlook".
 */
export function integrationForLabel(text: string | null | undefined): IntegrationId | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let best: { id: IntegrationId; length: number } | null = null;
  for (const spec of INTEGRATIONS) {
    for (const word of spec.labelWords) {
      const pattern = new RegExp(
        `(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`,
      );
      if (pattern.test(lower) && (!best || word.length > best.length)) {
        best = { id: spec.id, length: word.length };
      }
    }
  }
  return best?.id ?? null;
}

/** The tool's own name after an `mcp_<id>__` style server prefix. */
export function shortToolName(name: string): string {
  const separator = name.indexOf("__");
  return separator >= 0 ? name.slice(separator + 2) : name;
}

export function integrationForToolName(name: string): IntegrationId | null {
  const short = shortToolName(name);
  for (const spec of INTEGRATIONS) {
    if (spec.toolNamePatterns?.some((pattern) => pattern.test(short))) return spec.id;
  }
  return null;
}
