import type { AttemptToolDefinition } from "@opengeni/codemode";
import type { ConfiguredModel, ResolvedModelProvider, Settings } from "@opengeni/config";
import type { ModelResidencyV1 } from "@opengeni/contracts";
import {
  getOrganizationRetentionPolicy,
  isWorkspaceEuOnly,
  nestedPostgresSqlState,
  type Database,
} from "@opengeni/db";
import {
  PROVIDER_DATA_POLICIES,
  type ProviderDataPolicy,
  type ProviderDataPolicyFamily,
} from "./provider-data-policy";

export const PRIVACY_FACTS_TOOL_NAME = "privacy_facts";

export const PRIVACY_FACTS_TOOL_DESCRIPTION =
  "Facts about privacy and data handling for this chat, from this deployment's configuration: the model and provider serving it, where it runs, whether the workspace is EU-only, whether the provider trains on or keeps the data (with sources), this workspace's retention settings, and the privacy policy links. Call it before answering any question about privacy, data retention, training on data, which model or provider is used, or where data is processed.";

/** The route serving this turn, as the worker resolved it. */
export type PrivacyFactsRoute = {
  modelId: string | null;
  modelLabel: string | null;
  provider: {
    id: string;
    label: string;
    kind: string;
    wireProfile: string | null;
    builtin: boolean;
    baseUrl: string | null;
  } | null;
  upstreamModelId: string | null;
  /** Null when the route has no residency record (the legacy fallback). */
  residency: ModelResidencyV1 | null;
  /** Vercel AI Gateway providers this route is pinned to, when it is. */
  gatewayOnly: readonly string[] | null;
  credentialSource: { kind: string; provider?: string } | null;
};

/** Values read when the tool runs, so a changed setting shows at once. */
export type PrivacyFactsLive = {
  /** True when the deployment or this workspace requires EU-only inference. */
  euOnly: boolean | null;
  /** The organization's rule for a departing member's content; null when unreadable. */
  memberRetention:
    | { mode: "retain" }
    | { mode: "delete_after"; days: number }
    | { mode: "not_visible" }
    | null;
};

export type PrivacyFactsDeployment = {
  privacyPolicyUrl: string | null;
  termsOfServiceUrl: string | null;
  supportEmail: string | null;
  /** Idle chats move to read-only long-term storage after this many days. */
  sessionArchiveIdleDays: number | null;
};

const AZURE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
] as const;

const EXACT_HOST_FAMILIES: Readonly<Record<string, ProviderDataPolicyFamily>> = {
  "api.openai.com": "openai_api",
  "chatgpt.com": "codex_subscription",
  "api.anthropic.com": "anthropic_api",
  "api.x.ai": "xai_api",
  "ai-gateway.vercel.sh": "vercel_ai_gateway",
  "openrouter.ai": "openrouter",
  "api.opper.ai": "opper",
};

/** Bedrock model ids: an optional cross-region profile, then `vendor.model`. */
const BEDROCK_MODEL_ID =
  /^(?:(?:global|us|us-gov|eu|apac|jp|au|ca)\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|writer)\.[a-z0-9]/iu;

/** Fireworks models offered through Azure AI Foundry are named `FW-…`. */
const AZURE_FIREWORKS_MODEL_ID = /^fw-/iu;

/** Vercel AI Gateway provider slugs whose terms this table describes. */
const GATEWAY_UPSTREAM_FAMILIES: Readonly<Record<string, ProviderDataPolicyFamily>> = {
  vertex: "google_vertex",
  anthropic: "anthropic_api",
  bedrock: "amazon_bedrock",
  openai: "openai_api",
  azure: "azure_openai",
  xai: "xai_api",
};

function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/u, "");
  } catch {
    return null;
  }
}

function isAzureHost(host: string | null): boolean {
  return host !== null && AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function azureFamily(upstreamModelId: string | null): ProviderDataPolicyFamily {
  return upstreamModelId && AZURE_FIREWORKS_MODEL_ID.test(upstreamModelId)
    ? "azure_foundry_fireworks"
    : "azure_openai";
}

/**
 * Which reviewed policy row describes a route. Explicit evidence wins: the
 * provider kind, then the route's residency record, then the model id and
 * endpoint host. A route nothing identifies is `unknown`, never a guess.
 */
export function providerDataPolicyFamily(route: PrivacyFactsRoute): ProviderDataPolicyFamily {
  const provider = route.provider;
  if (!provider) return "unknown";
  const kind = provider.kind;
  const upstream = route.upstreamModelId;
  const host = hostOf(provider.baseUrl);
  if (kind === "codex-subscription") return "codex_subscription";
  if (kind === "xai-subscription") return "xai_subscription";
  if (kind.startsWith("claude-subscription-")) return "claude_subscription";
  if (kind.startsWith("anthropic-")) return "anthropic_api";
  if (kind.startsWith("vercel-gateway-")) return "vercel_ai_gateway";
  if (kind.startsWith("openrouter-")) return "openrouter";
  if (kind.startsWith("opper-")) return "opper";
  if (kind.startsWith("direct-openai-")) return "openai_api";
  if (kind.startsWith("direct-azure-")) return azureFamily(upstream);
  const deploymentType = route.residency?.deploymentType;
  if (deploymentType?.startsWith("azure_")) return azureFamily(upstream);
  if (deploymentType?.startsWith("bedrock_")) return "amazon_bedrock";
  if (upstream && BEDROCK_MODEL_ID.test(upstream)) return "amazon_bedrock";
  if (provider.wireProfile === "azure-openai" || isAzureHost(host)) return azureFamily(upstream);
  if (host && EXACT_HOST_FAMILIES[host]) return EXACT_HOST_FAMILIES[host]!;
  // The built-in OpenAI provider without a base URL calls api.openai.com.
  if (provider.builtin && provider.wireProfile === "openai" && !host) return "openai_api";
  return "unknown";
}

/** The upstream row for a gateway route pinned to exactly one known provider. */
export function gatewayUpstreamFamily(route: PrivacyFactsRoute): ProviderDataPolicyFamily | null {
  const only = route.gatewayOnly;
  if (!only || only.length !== 1) return null;
  return GATEWAY_UPSTREAM_FAMILIES[only[0]!.toLowerCase()] ?? null;
}

function oneLine(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function credentialSourceText(route: PrivacyFactsRoute): string {
  const source = route.credentialSource;
  if (!source) return "Unknown.";
  switch (source.kind) {
    case "deployment":
      return "This Opengeni deployment's own account with the provider.";
    case "connected_subscription": {
      const name =
        source.provider === "codex"
          ? "ChatGPT"
          : source.provider === "xai"
            ? "SuperGrok"
            : source.provider === "claude"
              ? "Claude"
              : "a";
      return `A connected ${name} subscription; that account's own settings and terms with the provider apply.`;
    }
    case "workspace_connection":
      return "This workspace's own provider key; that account's own settings and terms with the provider apply.";
    case "organization_connection":
      return "The organization's own provider key; that account's own settings and terms with the provider apply.";
    default:
      return "Unknown.";
  }
}

const GEOGRAPHY_NAMES: Record<string, string> = {
  eu: "the EU",
  us: "the United States",
  global: "any region (global)",
  other: "a declared non-EU region",
};

function residencyText(residency: ModelResidencyV1 | null): string {
  if (!residency || residency.geography === "unknown") {
    return "Not declared for this route (unknown). Do not say it stays in any region.";
  }
  const where = GEOGRAPHY_NAMES[residency.geography] ?? "unknown";
  const regions = residency.regions.length > 0 ? ` (${residency.regions.join(", ")})` : "";
  return `Declared as processing in ${where}${regions}, deployment type ${residency.deploymentType}.`;
}

function policyLines(heading: string, policy: ProviderDataPolicy): string[] {
  return [
    `${heading}: ${policy.provider}`,
    `- Trains on the data: ${policy.training}`,
    `- Keeps the data: ${policy.retention}`,
    `- Where it processes: ${policy.location}`,
    policy.sources.length > 0
      ? `- Sources (checked ${policy.checkedOn}): ${policy.sources.join(" ; ")}`
      : "- Sources: none; this provider is not in Opengeni's reviewed table.",
  ];
}

function memberRetentionText(value: PrivacyFactsLive["memberRetention"]): string {
  if (!value) return "When a member leaves the organization: unknown (could not be read).";
  switch (value.mode) {
    case "retain":
      return "When a member leaves the organization: their content is kept (the organization's setting).";
    case "delete_after":
      return `When a member leaves the organization: their personal content is deleted ${value.days} days after they leave (the organization's setting).`;
    case "not_visible":
      return "When a member leaves the organization: set by an organization admin in organization settings; only admins can read it.";
  }
}

export function renderPrivacyFacts(input: {
  route: PrivacyFactsRoute;
  live: PrivacyFactsLive;
  deployment: PrivacyFactsDeployment;
}): string {
  const { route, live, deployment } = input;
  const family = providerDataPolicyFamily(route);
  const policy = PROVIDER_DATA_POLICIES[family];
  const upstreamFamily = family === "vercel_ai_gateway" ? gatewayUpstreamFamily(route) : null;
  const modelName = route.modelLabel
    ? `${oneLine(route.modelLabel)} (${oneLine(route.modelId ?? "unknown id")})`
    : oneLine(route.modelId ?? "unknown");
  const lines: string[] = [
    "Privacy facts for this chat, from this Opengeni deployment's configuration. Answer only from these facts, say plainly what is unknown, and link the policies below.",
    "",
    `Model: ${modelName}`,
    // Like list_models, never upstream ids or URLs: they can name internal deployments.
    `Provider route: ${oneLine(route.provider?.label ?? "unknown")}`,
    `Paid through: ${credentialSourceText(route)}`,
    `Where this route runs: ${residencyText(route.residency)}`,
    live.euOnly === null
      ? "EU-only: unknown (could not be read)."
      : live.euOnly
        ? "EU-only: on. Every model route this workspace uses must be declared as processing in the EU."
        : "EU-only: off. Model routes may process outside the EU; only say data stays in the EU for a route declared EU above.",
    "",
    ...policyLines("Provider", policy),
  ];
  if (family === "vercel_ai_gateway") {
    lines.push(
      "",
      ...(upstreamFamily
        ? policyLines(
            "Upstream provider behind the gateway",
            PROVIDER_DATA_POLICIES[upstreamFamily],
          )
        : ["Upstream provider behind the gateway: not pinned by this route (unknown)."]),
    );
  }
  lines.push(
    "",
    "Opengeni (this workspace):",
    "- The Opengeni software does not train models on chat content.",
    "- Chats, files and Knowledge stay in the workspace until someone deletes them; Opengeni does not delete them by age. One exception: when a workspace's stored chat images (screenshots and viewed images) exceed its storage limit, the oldest images are removed.",
    deployment.sessionArchiveIdleDays !== null
      ? `- Chats idle for ${deployment.sessionArchiveIdleDays} days become read-only and move to long-term storage; they are not deleted.`
      : "- Idle chats are not moved to long-term storage on this deployment.",
    `- ${memberRetentionText(live.memberRetention)}`,
    `- Privacy policy: ${deployment.privacyPolicyUrl ?? "not configured on this deployment"}`,
    `- Terms of service: ${deployment.termsOfServiceUrl ?? "not configured on this deployment"}`,
    deployment.supportEmail
      ? `- Data processing agreement, subprocessors and other privacy questions: ${deployment.supportEmail}`
      : "- Data processing agreement and subprocessors: no contact configured on this deployment.",
    "",
    "Scope: these facts cover the chat model above. Other features (chat titles, voice, image generation, web search, and connected apps or tools) can send data to other providers and are not described here.",
  );
  return lines.join("\n");
}

/**
 * The route serving this turn. `resolved` is null on the legacy unlisted-model
 * fallback, which calls the built-in OpenAI or Azure OpenAI client.
 */
export function privacyFactsRouteForTurn(input: {
  settings: Pick<
    Settings,
    "openaiProvider" | "openaiBaseUrl" | "azureOpenaiBaseUrl" | "azureOpenaiEndpoint"
  >;
  policy: {
    productModelId: string;
    upstreamModelId: string;
    credentialSource: { kind: string; provider?: string };
  };
  resolved: { provider: ResolvedModelProvider; configured: ConfiguredModel } | null;
}): PrivacyFactsRoute {
  const { settings, policy, resolved } = input;
  if (resolved) {
    const { provider, configured } = resolved;
    return {
      modelId: configured.id,
      modelLabel: configured.label,
      provider: {
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        wireProfile: provider.wireProfile,
        builtin: provider.builtin,
        baseUrl: provider.baseUrl ?? null,
      },
      upstreamModelId: configured.upstreamModelId,
      residency: configured.residency,
      gatewayOnly: configured.requestPolicy?.gateway.only ?? null,
      credentialSource: policy.credentialSource,
    };
  }
  const azure = settings.openaiProvider === "azure";
  return {
    modelId: policy.productModelId,
    modelLabel: null,
    provider: {
      id: azure ? "azure" : "openai",
      label: azure ? "Azure OpenAI" : "OpenAI",
      kind: "api-key",
      wireProfile: azure ? "azure-openai" : "openai",
      builtin: true,
      baseUrl:
        (azure
          ? (settings.azureOpenaiBaseUrl ?? settings.azureOpenaiEndpoint)
          : settings.openaiBaseUrl) ?? null,
    },
    upstreamModelId: policy.upstreamModelId,
    residency: null,
    gatewayOnly: null,
    credentialSource: policy.credentialSource,
  };
}

/**
 * Reads the live settings. A failed read becomes unknown in the answer rather
 * than failing the tool; a person who may not read the organization's rule
 * is told where it lives.
 */
export async function loadPrivacyFactsLive(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  actorSubjectId: string | null;
  deploymentEuOnly: boolean;
  isEuOnly?: typeof isWorkspaceEuOnly;
  getRetentionPolicy?: typeof getOrganizationRetentionPolicy;
}): Promise<PrivacyFactsLive> {
  const readEuOnly = input.isEuOnly ?? isWorkspaceEuOnly;
  const readRetention = input.getRetentionPolicy ?? getOrganizationRetentionPolicy;
  const euOnly = input.deploymentEuOnly
    ? true
    : await readEuOnly(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
      }).catch(() => null);
  let memberRetention: PrivacyFactsLive["memberRetention"] = null;
  if (input.actorSubjectId) {
    try {
      const policy = await readRetention(input.db, {
        organizationId: input.accountId,
        actorSubjectId: input.actorSubjectId,
      });
      memberRetention =
        policy.mode === "delete_after" && policy.retentionDays !== null
          ? { mode: "delete_after", days: policy.retentionDays }
          : { mode: "retain" };
    } catch (error) {
      memberRetention = nestedPostgresSqlState(error) === "42501" ? { mode: "not_visible" } : null;
    }
  } else {
    memberRetention = { mode: "not_visible" };
  }
  return { euOnly, memberRetention };
}

export function createPrivacyFactsAttemptToolDefinition(input: {
  route: PrivacyFactsRoute;
  deployment: PrivacyFactsDeployment;
  loadLive: () => Promise<PrivacyFactsLive>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: PRIVACY_FACTS_TOOL_NAME },
    modelName: PRIVACY_FACTS_TOOL_NAME,
    codemodePath: ["opengeni", PRIVACY_FACTS_TOOL_NAME],
    title: "Privacy facts",
    description: PRIVACY_FACTS_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: "Privacy facts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      if (Object.keys(args).length !== 0) {
        throw new Error("privacy_facts accepts no arguments");
      }
      const live = await input.loadLive();
      return {
        isError: false,
        content: [
          {
            type: "text",
            text: renderPrivacyFacts({ route: input.route, live, deployment: input.deployment }),
          },
        ],
      };
    },
  };
}
