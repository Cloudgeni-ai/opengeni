import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Where a model route processes prompts and outputs, and how we know.
 *
 * EU status is derived only from this record, never from a model name, label
 * or provider id. A route without a record is `unknown`, and unknown is never
 * EU. `eu` follows GDPR: EEA processing counts the same as EU processing, so a
 * provider's EU data zone (Azure Data Zone EU, Bedrock `eu.` inference
 * profiles) qualifies even when it can include Norway or Switzerland.
 */
export const MODEL_PROCESSING_GEOGRAPHIES = ["eu", "us", "global", "other", "unknown"] as const;
export const ModelProcessingGeography = /* @__PURE__ */ defineSchema(() =>
  z.enum(MODEL_PROCESSING_GEOGRAPHIES),
);
export type ModelProcessingGeography = z.infer<typeof ModelProcessingGeography>;

/** How the provider places the request. Global routing types can never be EU. */
export const MODEL_DEPLOYMENT_TYPES = [
  "azure_regional",
  "azure_data_zone",
  "azure_global",
  "bedrock_regional",
  "bedrock_geo_profile",
  "bedrock_global_profile",
  "gateway",
  "subscription",
  "provider_default",
  "self_hosted",
  "unknown",
] as const;
export const ModelDeploymentType = /* @__PURE__ */ defineSchema(() =>
  z.enum(MODEL_DEPLOYMENT_TYPES),
);
export type ModelDeploymentType = z.infer<typeof ModelDeploymentType>;

/**
 * The only deployment types that can be EU. Anything else, including gateways,
 * subscriptions, global routing, unknown and any type added later, can never
 * be EU, whatever a declaration says.
 */
export const EU_CAPABLE_DEPLOYMENT_TYPES: readonly ModelDeploymentType[] = Object.freeze([
  "azure_regional",
  "azure_data_zone",
  "bedrock_regional",
  "bedrock_geo_profile",
  "provider_default",
  "self_hosted",
]);

/**
 * Cloud regions an EU claim may name, by deployment family: EEA regions plus
 * Switzerland, which provider EU data zones can include. A region outside
 * these lists rejects the claim (names only ever reject, never grant). The
 * United Kingdom is not in the EEA and is not listed.
 */
export const EU_AZURE_REGIONS: readonly string[] = Object.freeze([
  "austriaeast",
  "belgiumcentral",
  "denmarkeast",
  "francecentral",
  "francesouth",
  "germanynorth",
  "germanywestcentral",
  "italynorth",
  "northeurope",
  "norwayeast",
  "norwaywest",
  "polandcentral",
  "spaincentral",
  "swedencentral",
  "swedensouth",
  "switzerlandnorth",
  "switzerlandwest",
  "westeurope",
]);
export const EU_AWS_REGIONS: readonly string[] = Object.freeze([
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-3",
]);

function euRegionsFor(deploymentType: ModelDeploymentType): readonly string[] | null {
  if (deploymentType === "azure_regional" || deploymentType === "azure_data_zone") {
    return EU_AZURE_REGIONS;
  }
  if (deploymentType === "bedrock_regional" || deploymentType === "bedrock_geo_profile") {
    return EU_AWS_REGIONS;
  }
  return null;
}

export const MODEL_RESIDENCY_EVIDENCE_SOURCES = [
  /** The deployment operator declared it in the reviewed catalog or environment. */
  "operator_declaration",
  /** Published provider documentation for this exact route type. */
  "provider_documentation",
  /** A provider API reported it (for example an Azure deployment SKU lookup). */
  "provider_api",
  /** A code-owned rule for a provider kind, reviewed with the code. */
  "built_in_rule",
  /** An organization admin declared it for their own connection. */
  "admin_declaration",
  /** Nothing establishes where this route processes data. */
  "none",
] as const;
export const ModelResidencyEvidenceSource = /* @__PURE__ */ defineSchema(() =>
  z.enum(MODEL_RESIDENCY_EVIDENCE_SOURCES),
);
export type ModelResidencyEvidenceSource = z.infer<typeof ModelResidencyEvidenceSource>;

const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export const ModelResidencyEvidenceV1 = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      source: ModelResidencyEvidenceSource,
      /** Where to check it: a document URL, resource and SKU, or rule description. */
      reference: z.string().trim().min(1).max(1000).nullable(),
      /** Date (or date-time) the evidence was last checked. */
      verifiedAt: z.union([z.iso.date(), z.iso.datetime()]).nullable(),
    })
    .strict(),
);
export type ModelResidencyEvidenceV1 = z.infer<typeof ModelResidencyEvidenceV1>;

/** Problems that make a residency record unable to claim its geography. */
export function modelResidencyProblems(residency: {
  geography: ModelProcessingGeography;
  deploymentType: ModelDeploymentType;
  regions: readonly string[];
  evidence: { source: ModelResidencyEvidenceSource; reference: string | null };
}): { path: string[]; message: string }[] {
  const problems: { path: string[]; message: string }[] = [];
  if (residency.geography === "unknown") {
    return problems;
  }
  if (residency.evidence.source === "none" || residency.evidence.reference === null) {
    problems.push({
      path: ["evidence"],
      message: "a known processing geography needs an evidence source and reference",
    });
  }
  if (residency.geography !== "eu") return problems;
  if (!EU_CAPABLE_DEPLOYMENT_TYPES.includes(residency.deploymentType)) {
    problems.push({
      path: ["deploymentType"],
      message: `${residency.deploymentType} routing can leave the EU, so it cannot be declared eu`,
    });
    return problems;
  }
  const allowedRegions = euRegionsFor(residency.deploymentType);
  if (allowedRegions) {
    if (residency.regions.length === 0) {
      problems.push({ path: ["regions"], message: "an eu claim needs the route's regions" });
    }
    for (const region of residency.regions) {
      if (!allowedRegions.includes(region)) {
        problems.push({
          path: ["regions"],
          message: `${region} is not an EU region for ${residency.deploymentType}`,
        });
      }
    }
  }
  return problems;
}

/** Bedrock inference profile prefixes that route outside the EU. */
export const NON_EU_BEDROCK_PROFILE_PREFIXES: readonly string[] = Object.freeze([
  "us.",
  "us-gov.",
  "apac.",
  "jp.",
  "au.",
  "ca.",
  "global.",
]);

/**
 * Hosts that route globally or process outside the EU. An EU claim on a route
 * whose endpoint is one of these exact hosts is wrong. Exact match only:
 * `eu.api.openai.com`, for example, is a different endpoint.
 */
export const NON_EU_MODEL_HOSTS: readonly string[] = Object.freeze([
  "ai-gateway.vercel.sh",
  "api.anthropic.com",
  "api.openai.com",
  "api.x.ai",
  "chatgpt.com",
  "openrouter.ai",
]);

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Problems that make an EU claim wrong for the route it is declared on: a
 * Bedrock upstream id with a non-EU inference profile prefix, a Bedrock
 * geographic profile that is not `eu.`, or an endpoint on a known global host.
 * Every resolver applies it. Names only ever reject a claim, never grant one.
 */
export function modelResidencyRouteProblems(
  residency: { geography: ModelProcessingGeography; deploymentType: ModelDeploymentType },
  route: { upstreamModelId?: string | null | undefined; baseUrl?: string | null | undefined },
): { path: string[]; message: string }[] {
  if (residency.geography !== "eu") return [];
  const problems: { path: string[]; message: string }[] = [];
  const upstreamModelId = route.upstreamModelId ?? "";
  if (residency.deploymentType.startsWith("bedrock_")) {
    const prefix = NON_EU_BEDROCK_PROFILE_PREFIXES.find((candidate) =>
      upstreamModelId.startsWith(candidate),
    );
    if (prefix) {
      problems.push({
        path: ["upstreamModelId"],
        message: `${upstreamModelId} is a ${prefix} inference profile, which routes outside the EU`,
      });
    } else if (
      residency.deploymentType === "bedrock_geo_profile" &&
      !upstreamModelId.startsWith("eu.")
    ) {
      problems.push({
        path: ["upstreamModelId"],
        message: `an eu bedrock_geo_profile needs an eu. inference profile, not ${upstreamModelId}`,
      });
    }
  }
  const host = route.baseUrl ? hostOf(route.baseUrl) : null;
  if (host && NON_EU_MODEL_HOSTS.includes(host)) {
    problems.push({
      path: ["baseUrl"],
      message: `${host} routes outside the EU, so a route on it cannot be declared eu`,
    });
  }
  return problems;
}

/** The fields that move processing; evidence text and dates do not. */
export function modelResidencyClaim(residency: {
  geography: ModelProcessingGeography;
  deploymentType: ModelDeploymentType;
  regions: readonly string[];
}): {
  geography: ModelProcessingGeography;
  deploymentType: ModelDeploymentType;
  regions: string[];
} {
  return {
    geography: residency.geography,
    deploymentType: residency.deploymentType,
    regions: [...new Set(residency.regions)].sort(),
  };
}

export const ModelResidencyV1 = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      geography: ModelProcessingGeography,
      deploymentType: ModelDeploymentType,
      /** Provider regions where the endpoint or processing lives, when known. */
      regions: z.array(z.string().regex(REGION_PATTERN)).max(32),
      evidence: ModelResidencyEvidenceV1,
    })
    .strict()
    .superRefine((residency, context) => {
      for (const problem of modelResidencyProblems(residency)) {
        context.addIssue({ code: "custom", path: problem.path, message: problem.message });
      }
    }),
);
export type ModelResidencyV1 = z.infer<typeof ModelResidencyV1>;

/** Operator-facing declaration: the same record, with optional regions and dates. */
export const ModelResidencyDeclaration = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      geography: ModelProcessingGeography,
      deploymentType: ModelDeploymentType,
      regions: z.array(z.string().regex(REGION_PATTERN)).max(32).default([]),
      evidence: z
        .object({
          // Operator configuration states its own declaration or the provider
          // documentation it relies on; other sources come from code or admins.
          source: z.enum(["operator_declaration", "provider_documentation"]),
          reference: z.string().trim().min(1).max(1000),
          verifiedAt: z.union([z.iso.date(), z.iso.datetime()]).nullable().default(null),
        })
        .strict(),
    })
    .strict()
    .superRefine((residency, context) => {
      for (const problem of modelResidencyProblems(residency)) {
        context.addIssue({ code: "custom", path: problem.path, message: problem.message });
      }
    }),
);
export type ModelResidencyDeclaration = z.input<typeof ModelResidencyDeclaration>;

/** The record for a route nothing describes. Unknown is never EU. */
export const UNKNOWN_MODEL_RESIDENCY: ModelResidencyV1 = Object.freeze({
  geography: "unknown",
  deploymentType: "unknown",
  regions: Object.freeze([]) as unknown as string[],
  evidence: Object.freeze({ source: "none", reference: null, verifiedAt: null }),
}) as ModelResidencyV1;

/**
 * The single EU predicate. Anything malformed, missing, unknown, globally
 * routed or without evidence is not EU.
 */
export function isEuResidency(residency: unknown): boolean {
  const parsed = ModelResidencyV1.safeParse(residency);
  if (!parsed.success) return false;
  return (
    parsed.data.geography === "eu" &&
    parsed.data.evidence.source !== "none" &&
    parsed.data.evidence.reference !== null
  );
}

/** Client-safe projection: no evidence reference text, which may name internal resources. */
export const ClientModelResidencyV1 = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      geography: ModelProcessingGeography,
      deploymentType: ModelDeploymentType,
      regions: z.array(z.string()).max(32),
      evidenceSource: ModelResidencyEvidenceSource,
      eu: z.boolean(),
    })
    .strict(),
);
export type ClientModelResidencyV1 = z.infer<typeof ClientModelResidencyV1>;

export function projectClientModelResidency(residency: ModelResidencyV1): ClientModelResidencyV1 {
  return {
    geography: residency.geography,
    deploymentType: residency.deploymentType,
    regions: [...residency.regions],
    evidenceSource: residency.evidence.source,
    eu: isEuResidency(residency),
  };
}
