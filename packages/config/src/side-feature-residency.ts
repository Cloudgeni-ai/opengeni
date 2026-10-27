import {
  isEuResidency,
  ModelResidencyDeclaration,
  ModelResidencyV1,
  UNKNOWN_MODEL_RESIDENCY,
  type InferenceFeatureId,
} from "@opengeni/contracts";
import { z } from "zod";

/**
 * EU-only inference for side features: every model-backed feature besides
 * the chat model (web search, media, voice, transcription, Knowledge
 * embeddings, decision models) sends content over a named
 * route, and each route has a residency record from the same contracts types
 * as chat models. A route's EU status comes only from that record: a
 * code-owned rule where the provider has no EU option, or an operator
 * declaration in `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON` where a deployment
 * could be EU. Undeclared is unknown, and unknown is never EU. Route ids name
 * the integration, never a region, and are never read for EU status. See
 * docs/eu-only-inference.md#side-features.
 */

type Rule = {
  geography: ModelResidencyV1["geography"];
  deploymentType: ModelResidencyV1["deploymentType"];
  reference: string;
};

type RouteSpec = {
  /** The user-facing features this route serves. */
  features: readonly InferenceFeatureId[];
  /** Operators may declare its residency (the deployment could be EU). */
  declarable: boolean;
  /** Code-owned record for routes operators cannot declare. */
  rule?: Rule;
};

const saas = (label: string): Rule => ({
  geography: "unknown",
  deploymentType: "provider_default",
  reference: `${label} API: no EU processing option Opengeni can select.`,
});
const gateway = (label: string): Rule => ({
  geography: "global",
  deploymentType: "gateway",
  reference: `${label} runs through Vercel AI Gateway, which can process in any region.`,
});
const subscription = (label: string): Rule => ({
  geography: "us",
  deploymentType: "subscription",
  reference: `${label} subscription offers no regional processing control.`,
});

const WEB = ["web_search"] as const;
const TRANSCRIPTION = ["voice_input", "meeting_transcription"] as const;
// A live transcript's client connects to the provider itself with a secret
// the server mints, so these routes describe where that connection lands.
const LIVE = ["live_transcription"] as const;
// Tool routing also uses the decision model, and falls back to local ranking
// (no model call) when the route may not run, so only code search switches off.
const DECISIONS = ["code_search"] as const;

export const SIDE_FEATURE_ROUTES = {
  // Hosted search runs inside the model provider's request, on the provider's
  // own search backend, not on the model deployment.
  "web_search.hosted": {
    features: WEB,
    declarable: false,
    rule: {
      geography: "global",
      deploymentType: "provider_default",
      reference:
        "Hosted provider web search (OpenAI, Azure OpenAI, Anthropic, SuperGrok) runs on the provider's search backend outside the model deployment's region.",
    },
  },
  "web_search.tinyfish": { features: WEB, declarable: false, rule: saas("TinyFish") },
  "web_search.parallel": { features: WEB, declarable: false, rule: saas("Parallel") },
  "web_search.perplexity": { features: WEB, declarable: false, rule: saas("Perplexity") },
  "web_search.exa": { features: WEB, declarable: false, rule: saas("Exa") },
  "web_search.tavily": { features: WEB, declarable: false, rule: saas("Tavily") },
  "web_search.brave": { features: WEB, declarable: false, rule: saas("Brave Search") },
  // These run at an operator base URL and can be self-hosted.
  "web_search.firecrawl": { features: WEB, declarable: true },
  "web_search.jina": { features: WEB, declarable: true },
  "web_search.searxng": { features: WEB, declarable: true },
  "image_generation.openai_hosted": {
    features: ["image_generation"],
    declarable: false,
    rule: {
      geography: "us",
      deploymentType: "provider_default",
      reference: "OpenAI hosted image generation on api.openai.com processes in the US.",
    },
  },
  "image_generation.ai_gateway": {
    features: ["image_generation"],
    declarable: false,
    rule: gateway("Image generation"),
  },
  "image_generation.codex_subscription": {
    features: ["image_generation"],
    declarable: false,
    rule: subscription("ChatGPT Codex"),
  },
  "image_generation.supergrok_subscription": {
    features: ["image_generation"],
    declarable: false,
    rule: subscription("SuperGrok"),
  },
  "video_generation.ai_gateway": {
    features: ["video_generation"],
    declarable: false,
    rule: gateway("Video generation"),
  },
  "video_generation.supergrok_subscription": {
    features: ["video_generation"],
    declarable: false,
    rule: subscription("SuperGrok"),
  },
  // The deployment's own Azure resource.
  "realtime_voice.azure_live": { features: ["realtime_voice"], declarable: true },
  "realtime_voice.ai_gateway": {
    features: ["realtime_voice"],
    declarable: false,
    rule: gateway("Live voice"),
  },
  "realtime_voice.codex_subscription": {
    features: ["realtime_voice"],
    declarable: false,
    rule: subscription("ChatGPT Codex"),
  },
  "realtime_voice.supergrok_subscription": {
    features: ["realtime_voice"],
    declarable: false,
    rule: subscription("SuperGrok"),
  },
  "realtime_voice.elevenlabs": {
    features: ["realtime_voice"],
    declarable: false,
    rule: saas("ElevenLabs (workspace key)"),
  },
  "transcription.openai": {
    features: TRANSCRIPTION,
    declarable: false,
    rule: {
      geography: "us",
      deploymentType: "provider_default",
      reference: "OpenAI transcription on api.openai.com processes in the US.",
    },
  },
  // The deployment's own Azure OpenAI and Azure Speech resources.
  "transcription.azure-openai": { features: TRANSCRIPTION, declarable: true },
  "transcription.azure-speech": { features: TRANSCRIPTION, declarable: true },
  "transcription.openai-realtime": {
    features: LIVE,
    declarable: false,
    rule: {
      geography: "us",
      deploymentType: "provider_default",
      reference: "OpenAI Realtime on api.openai.com processes in the US.",
    },
  },
  // The Realtime API on the deployment's Azure OpenAI resource; its own
  // declaration, since a batch deployment's region says nothing about it.
  "transcription.azure-openai-realtime": { features: LIVE, declarable: true },
  "transcription.elevenlabs": {
    features: TRANSCRIPTION,
    declarable: false,
    rule: saas("ElevenLabs (workspace key)"),
  },
  "transcription.codex-subscription": {
    features: TRANSCRIPTION,
    declarable: false,
    rule: subscription("ChatGPT Codex"),
  },
  "transcription.supergrok-subscription": {
    features: TRANSCRIPTION,
    declarable: false,
    rule: subscription("SuperGrok"),
  },
  // The deployment's embedding endpoint (OpenAI or Azure OpenAI). The local
  // deterministic embedder sends nothing and needs no route.
  "knowledge.embeddings": { features: ["knowledge_embeddings"], declarable: true },
  "decision_model.jev": { features: DECISIONS, declarable: false, rule: gateway("Jev") },
  "decision_model.openrouter": {
    features: DECISIONS,
    declarable: false,
    rule: {
      geography: "global",
      deploymentType: "gateway",
      reference: "OpenRouter routes requests to upstream providers in any region.",
    },
  },
  // An OpenAI-compatible endpoint the operator chooses.
  "decision_model.openai": { features: DECISIONS, declarable: true },
} as const satisfies Record<string, RouteSpec>;

export type SideFeatureRouteId = keyof typeof SIDE_FEATURE_ROUTES;
export const SIDE_FEATURE_ROUTE_IDS = Object.keys(SIDE_FEATURE_ROUTES) as SideFeatureRouteId[];

export function isSideFeatureRouteId(value: string): value is SideFeatureRouteId {
  return Object.hasOwn(SIDE_FEATURE_ROUTES, value);
}

/** The features a route serves. */
export function sideFeatureRouteFeatures(route: SideFeatureRouteId): readonly InferenceFeatureId[] {
  return SIDE_FEATURE_ROUTES[route].features;
}

/** Routes whose residency an operator declares for one endpoint. */
export type DeclarableSideFeatureRouteId = {
  [K in SideFeatureRouteId]: (typeof SIDE_FEATURE_ROUTES)[K]["declarable"] extends true ? K : never;
}[SideFeatureRouteId];
/** Routes with a code-owned rule, the same wherever they are called. */
export type CodeOwnedSideFeatureRouteId = Exclude<SideFeatureRouteId, DeclarableSideFeatureRouteId>;

/**
 * What a side-feature call names: a code-owned route, or a route with the
 * endpoint the call actually sends to. A declaration describes one endpoint,
 * so a declarable route without its resolved endpoint is unknown.
 */
export type SideFeatureTarget =
  | CodeOwnedSideFeatureRouteId
  | { route: SideFeatureRouteId; endpoint: string | null | undefined };

export function sideFeatureTargetRoute(target: SideFeatureTarget): SideFeatureRouteId {
  return typeof target === "string" ? target : target.route;
}

export type SideFeatureResidencySettings = {
  /** `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON`: declarable route id to residency declaration. */
  sideFeatureResidencyJson?: string | undefined;
  /** Per run: set when the workspace is EU-only (see `settingsWithInferenceResidency`). */
  requiredModelGeography?: "eu" | undefined;
};

const SIDE_FEATURE_RULES_REVIEWED_AT = "2026-10-26";

/**
 * Vendor default hosts of declarable routes: no deployment there is the
 * operator's own, so they carry a code-owned non-EU rule and cannot be
 * declared.
 */
const VENDOR_DEFAULT_HOSTS: Record<string, Rule> = {
  "api.openai.com": {
    geography: "us",
    deploymentType: "provider_default",
    reference: "OpenAI's default API host api.openai.com processes in the US.",
  },
  "s.jina.ai": saas("Jina Search"),
  "r.jina.ai": saas("Jina Reader"),
  "api.firecrawl.dev": saas("Firecrawl"),
};

/** The origin a URL sends to, or null when it is not an http(s) URL. */
export function sideFeatureEndpointOrigin(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** One operator declaration: the residency of the deployment at `endpoint`. */
const SideFeatureResidencyDeclaration = z.object({
  endpoint: z.string().trim().min(1),
  residency: ModelResidencyDeclaration,
});

const SideFeatureResidencyDeclarations = z
  .record(z.string(), SideFeatureResidencyDeclaration)
  .superRefine((value, context) => {
    for (const [key, declaration] of Object.entries(value)) {
      if (!isSideFeatureRouteId(key)) {
        context.addIssue({ code: "custom", path: [key], message: "unknown side-feature route" });
      } else if (!(SIDE_FEATURE_ROUTES[key] as RouteSpec).declarable) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "this route's residency is a code-owned rule and cannot be declared",
        });
      }
      const origin = sideFeatureEndpointOrigin(declaration.endpoint);
      if (!origin) {
        context.addIssue({
          code: "custom",
          path: [key, "endpoint"],
          message: "must be the http(s) URL this route sends to",
        });
      } else if (Object.hasOwn(VENDOR_DEFAULT_HOSTS, new URL(origin).hostname)) {
        context.addIssue({
          code: "custom",
          path: [key, "endpoint"],
          message: "a vendor default host has a code-owned rule and cannot be declared",
        });
      }
    }
  });

/** A parsed declaration: the endpoint origin it describes and its residency. */
export type SideFeatureResidencyDeclarationV1 = { endpoint: string; residency: ModelResidencyV1 };

/** Parse `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON`; throws a readable error when invalid. */
export function parseSideFeatureResidencyJson(
  value: string,
): Partial<Record<SideFeatureRouteId, SideFeatureResidencyDeclarationV1>> {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("OPENGENI_SIDE_FEATURE_RESIDENCY_JSON must be a JSON object");
  }
  const parsed = SideFeatureResidencyDeclarations.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const declarations: Partial<Record<SideFeatureRouteId, SideFeatureResidencyDeclarationV1>> = {};
  for (const [route, { endpoint, residency }] of Object.entries(parsed.data)) {
    declarations[route as SideFeatureRouteId] = {
      endpoint: sideFeatureEndpointOrigin(endpoint)!,
      residency: ModelResidencyV1.parse({
        geography: residency.geography,
        deploymentType: residency.deploymentType,
        // Sorted and deduplicated, like chat model declarations.
        regions: [...new Set(residency.regions)].sort(),
        evidence: residency.evidence,
      }),
    };
  }
  return declarations;
}

const declarationsCache = new Map<
  string,
  Partial<Record<SideFeatureRouteId, SideFeatureResidencyDeclarationV1>>
>();

function declaredSideFeatureResidency(
  settings: SideFeatureResidencySettings,
): Partial<Record<SideFeatureRouteId, SideFeatureResidencyDeclarationV1>> {
  const raw = settings.sideFeatureResidencyJson?.trim();
  if (!raw) return {};
  let declarations = declarationsCache.get(raw);
  if (!declarations) {
    try {
      declarations = parseSideFeatureResidencyJson(raw);
    } catch {
      // Boot validation rejects this; anything that still reaches here
      // declares nothing, so every declarable route stays unknown.
      declarations = {};
    }
    declarationsCache.set(raw, declarations);
  }
  return declarations;
}

function ruleResidency(rule: Rule): ModelResidencyV1 {
  return {
    geography: rule.geography,
    deploymentType: rule.deploymentType,
    regions: [],
    evidence: {
      source: "built_in_rule",
      reference: rule.reference,
      verifiedAt: SIDE_FEATURE_RULES_REVIEWED_AT,
    },
  };
}

/**
 * Where a side-feature call processes data. A code-owned route has its rule.
 * A declarable route is resolved from the endpoint the call sends to: a
 * vendor default host has its code-owned rule; otherwise the operator's
 * declaration applies only when it names that same endpoint origin. An
 * undeclared route, a missing endpoint or a different endpoint is unknown.
 */
export function sideFeatureRouteResidency(
  settings: SideFeatureResidencySettings,
  target: SideFeatureTarget,
): ModelResidencyV1 {
  const route = sideFeatureTargetRoute(target);
  const spec: RouteSpec = SIDE_FEATURE_ROUTES[route];
  if (!spec.declarable) return spec.rule ? ruleResidency(spec.rule) : UNKNOWN_MODEL_RESIDENCY;
  const origin = sideFeatureEndpointOrigin(typeof target === "string" ? null : target.endpoint);
  if (!origin) return UNKNOWN_MODEL_RESIDENCY;
  const vendor = VENDOR_DEFAULT_HOSTS[new URL(origin).hostname];
  if (vendor) return ruleResidency(vendor);
  const declaration = declaredSideFeatureResidency(settings)[route];
  return declaration?.endpoint === origin ? declaration.residency : UNKNOWN_MODEL_RESIDENCY;
}

/** Whether the route is EU by its residency record. */
export function sideFeatureRouteIsEu(
  settings: SideFeatureResidencySettings,
  target: SideFeatureTarget,
): boolean {
  return isEuResidency(sideFeatureRouteResidency(settings, target));
}

/**
 * Whether a side-feature call may use this route under the settings'
 * residency requirement. Without a requirement every route may run; under
 * `eu` only a route whose record is EU may. There is no other route to fall
 * back to.
 */
export function sideFeatureRouteAllowed(
  settings: SideFeatureResidencySettings,
  target: SideFeatureTarget,
): boolean {
  return settings.requiredModelGeography !== "eu" || sideFeatureRouteIsEu(settings, target);
}

/**
 * What a side-feature call records about where it ran: its route's residency
 * claim (geography, deployment type, regions), never the evidence, whose
 * reference text may name internal resources. The same shape model call
 * facts record.
 */
export type SideFeatureProcessingResidency = {
  geography: ModelResidencyV1["geography"];
  deploymentType: ModelResidencyV1["deploymentType"];
  regions: string[];
};

export function sideFeatureProcessingResidency(
  settings: SideFeatureResidencySettings,
  target: SideFeatureTarget,
): SideFeatureProcessingResidency {
  const residency = sideFeatureRouteResidency(settings, target);
  return {
    geography: residency.geography,
    deploymentType: residency.deploymentType,
    regions: [...residency.regions],
  };
}
