import type { AttemptToolDefinition } from "@opengeni/codemode";
import {
  isDirectOpenAiApiBaseUrl,
  type ConfiguredModel,
  type ResolvedModelProvider,
  type Settings,
} from "@opengeni/config";
import { COMPUTER_SCREENSHOT_RETENTION_MS, type ModelResidencyV1 } from "@opengeni/contracts";
import { isWorkspaceEuOnly, type Database } from "@opengeni/db";
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
    /** The wire API: "responses", "chat" or "anthropic-messages". */
    api: string;
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
};

export type PrivacyFactsDeployment = {
  privacyPolicyUrl: string | null;
  termsOfServiceUrl: string | null;
  supportEmail: string | null;
  /** Operator-declared subprocessor list (`OPENGENI_LEGAL_SUBPROCESSORS_URL`). */
  subprocessorsUrl: string | null;
  /** Operator-declared app data hosting, in plain words (`OPENGENI_DATA_HOSTING_LOCATION`). */
  dataHostingLocation: string | null;
  /** This chat's sandbox backend (not necessarily the deployment default), and Modal placement regions. */
  sandboxes: { backend: string; regions: readonly string[] | null };
  /** Idle chats move to read-only long-term storage after this many days. */
  sessionArchiveIdleDays: number | null;
  /**
   * `OPENGENI_OPENAI_PROVIDER_ITEM_IDS=preserve`: chat turns then keep provider
   * ids and do not ask Azure or OpenAI to skip Responses storage.
   */
  preservesProviderItemIds?: boolean;
};

const SELF_HOSTED_SANDBOX_BACKENDS: ReadonlySet<string> = new Set(["docker", "local"]);

/** One sentence on where this chat's sandbox runs. */
function sandboxSentence(sandboxes: PrivacyFactsDeployment["sandboxes"]): string {
  const { backend, regions } = sandboxes;
  if (backend === "none") return "This chat has no cloud sandbox.";
  return `This chat's sandbox, where the agent runs commands, ${sandboxPlacement(backend, regions)}`;
}

function sandboxPlacement(backend: string, regions: readonly string[] | null): string {
  if (backend === "selfhosted") {
    return "is a Connected Machine (a machine its owner connected to the workspace; its location is not known here) or, when none is attached, the workspace's default sandbox.";
  }
  if (SELF_HOSTED_SANDBOX_BACKENDS.has(backend)) {
    return `runs on servers this deployment's operator runs (${backend}); their location is not declared (unknown).`;
  }
  if (backend === "compute") {
    return "runs on this deployment's own microVM sandboxes (compute); their region is not declared (unknown).";
  }
  if (backend === "modal") {
    return regions && regions.length > 0
      ? `runs on Modal; new sandboxes are placed in region ${regions.map(oneLine).join(", ")}. Where saved sandbox snapshots are stored is not stated here.`
      : "runs on Modal, not pinned to a region (unknown).";
  }
  return `runs on ${oneLine(backend)}; its region is not declared (unknown).`;
}

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

/**
 * A Bedrock endpoint or a bridge to it: a host with a `bedrock` label part,
 * such as `bedrock-runtime.eu-west-1.amazonaws.com` or an in-cluster bridge.
 */
const BEDROCK_HOST = /(?:^|[.-])bedrock(?:[.-]|$)/iu;

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

/**
 * An Azure route. Only the Responses API is certainly an Azure OpenAI model
 * sold by Azure; Fireworks models are named `FW-…`. Other Azure-hosted models
 * (Claude through Anthropic's Messages API, partner and community models) are
 * processed by others under other terms, so they stay unknown. A declared
 * `azure_*` deployment on the chat API still counts as Azure OpenAI, because
 * the operator declared it as one.
 */
function azureFamily(route: PrivacyFactsRoute, declaredAzure: boolean): ProviderDataPolicyFamily {
  const upstream = route.upstreamModelId;
  if (upstream && AZURE_FIREWORKS_MODEL_ID.test(upstream)) return "azure_foundry_fireworks";
  const api = route.provider?.api;
  if (api === "responses" || (declaredAzure && api !== "anthropic-messages")) {
    return "azure_openai";
  }
  return "unknown";
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
  if (kind.startsWith("direct-azure-")) return azureFamily(route, false);
  // A workspace's own OpenAI-compatible server is described by nothing here.
  if (kind === "direct-compatible-workspace") return "unknown";
  const deploymentType = route.residency?.deploymentType;
  if (deploymentType?.startsWith("azure_")) return azureFamily(route, true);
  if (deploymentType?.startsWith("bedrock_")) return "amazon_bedrock";
  if (upstream && BEDROCK_MODEL_ID.test(upstream) && host && BEDROCK_HOST.test(host)) {
    return "amazon_bedrock";
  }
  if (provider.wireProfile === "azure-openai" || isAzureHost(host)) {
    return azureFamily(route, false);
  }
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

function policyLines(
  heading: string,
  policy: ProviderDataPolicy,
  opengeni: string | null,
): string[] {
  return [
    `${heading}: ${policy.provider}`,
    `- Trains on the data: ${policy.training}`,
    `- Keeps the data: ${policy.retention}`,
    `- Where it processes: ${policy.location}`,
    ...(opengeni ? [`- Opengeni's requests: ${opengeni}`] : []),
    policy.sources.length > 0
      ? `- Sources (checked ${policy.checkedOn}): ${policy.sources.join(" ; ")}`
      : "- Sources: none; this provider is not in Opengeni's reviewed table.",
  ];
}

const RESPONSES_STORAGE_KEPT =
  "Responses API storage is not turned off for every request on this route.";

/**
 * Whether this route's chat turns send `store: false`, mirroring the runtime:
 * every Azure OpenAI wire route, workspace and organization OpenAI keys, and
 * the built-in OpenAI client on api.openai.com. An operator's registry
 * provider pointing at api.openai.com is left alone, and preserve mode keeps
 * provider ids, so neither asks.
 */
export function routeSendsStorelessResponses(
  route: PrivacyFactsRoute,
  preservesProviderItemIds: boolean,
): boolean {
  const provider = route.provider;
  if (!provider || provider.api !== "responses" || preservesProviderItemIds) return false;
  if (provider.wireProfile === "azure-openai") return true;
  if (provider.wireProfile !== "openai") return false;
  if (
    provider.kind === "direct-openai-workspace" ||
    provider.kind === "direct-openai-organization"
  ) {
    return true;
  }
  return provider.builtin && isDirectOpenAiApiBaseUrl(provider.baseUrl ?? undefined);
}

/** The Opengeni-specific line for the provider Opengeni calls directly. */
function opengeniRequestLine(
  route: PrivacyFactsRoute,
  family: ProviderDataPolicyFamily,
  policy: ProviderDataPolicy,
  deployment: PrivacyFactsDeployment,
): string | null {
  if (family !== "azure_openai" && family !== "openai_api") return policy.opengeni ?? null;
  // A chat-completions route never creates Responses objects to keep.
  if (route.provider?.api !== "responses") return null;
  return routeSendsStorelessResponses(route, deployment.preservesProviderItemIds === true)
    ? (policy.opengeni ?? null)
    : RESPONSES_STORAGE_KEPT;
}

const RETAINED_IMAGE_DAYS = Math.round(COMPUTER_SCREENSHOT_RETENTION_MS / 86_400_000);

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
    ...policyLines("Provider", policy, opengeniRequestLine(route, family, policy, deployment)),
  ];
  if (family === "vercel_ai_gateway") {
    lines.push(
      "",
      ...(upstreamFamily
        ? policyLines(
            "Upstream provider behind the gateway (that provider's public default for its own API customers; Vercel's agreement with it may differ)",
            PROVIDER_DATA_POLICIES[upstreamFamily],
            null,
          )
        : ["Upstream provider behind the gateway: not pinned by this route (unknown)."]),
    );
  }
  lines.push(
    "",
    "Opengeni (this deployment and workspace):",
    "- The Opengeni software does not train models on chat content.",
    deployment.dataHostingLocation
      ? `- App data (database, files, backups) is hosted in: ${oneLine(deployment.dataHostingLocation)} (the operator's declaration).`
      : "- Where app data (database, files, backups) is hosted: not declared in this deployment's configuration (unknown).",
    `- ${sandboxSentence(deployment.sandboxes)} Other chats in the workspace may use a different sandbox.`,
    "- Chats, files and Knowledge stay in the workspace until someone deletes them; Opengeni does not delete them by age.",
    `- Exception: images kept from tool results in chats (screenshots and images the agent viewed) are deleted ${RETAINED_IMAGE_DAYS} days after they are stored, and the oldest go sooner when the workspace's storage limit for them is reached.`,
    deployment.sessionArchiveIdleDays !== null
      ? `- Chats idle for ${deployment.sessionArchiveIdleDays} days, unless marked to stay live, become read-only and move to long-term storage; they are not deleted.`
      : "- Idle chats are not moved to long-term storage on this deployment.",
    "- When a member leaves the organization, an organization admin's setting in organization settings decides whether their content is kept or deleted after a set number of days.",
    `- Privacy policy: ${deployment.privacyPolicyUrl ?? "not configured on this deployment"}`,
    `- Terms of service: ${deployment.termsOfServiceUrl ?? "not configured on this deployment"}`,
    `- Subprocessor list: ${
      deployment.subprocessorsUrl ??
      (deployment.privacyPolicyUrl
        ? "no separate list configured; check the privacy policy above"
        : "not published on this deployment")
    }`,
    deployment.supportEmail
      ? `- Data processing agreement and other privacy questions: ${deployment.supportEmail}`
      : "- Data processing agreement: no contact configured on this deployment.",
    ...(deployment.privacyPolicyUrl || deployment.subprocessorsUrl
      ? [
          "- Not covered here: the subprocessor list, a DPA, and hosting details beyond the lines above. For those, open the privacy policy (or subprocessor list) page now with web search or a page fetch and report what the page states, as the policy's statement. Only if the page can't be opened, give the link.",
        ]
      : []),
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
        api: provider.api,
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
      api: "responses",
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
 * than failing the tool. The organization's departing-member rule is
 * admin-only and the output can be seen by everyone in a shared chat, so the
 * tool names where that rule lives instead of reading it.
 */
export async function loadPrivacyFactsLive(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  deploymentEuOnly: boolean;
  isEuOnly?: typeof isWorkspaceEuOnly;
}): Promise<PrivacyFactsLive> {
  const readEuOnly = input.isEuOnly ?? isWorkspaceEuOnly;
  const euOnly = input.deploymentEuOnly
    ? true
    : await readEuOnly(input.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
      }).catch(() => null);
  return { euOnly };
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
