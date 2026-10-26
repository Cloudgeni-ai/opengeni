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

/** Deployment types whose routing may leave any single geography. */
export const GLOBAL_ROUTING_DEPLOYMENT_TYPES: readonly ModelDeploymentType[] = [
  "azure_global",
  "bedrock_global_profile",
  "unknown",
];

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
      verifiedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z)?$/u)
        .nullable(),
    })
    .strict(),
);
export type ModelResidencyEvidenceV1 = z.infer<typeof ModelResidencyEvidenceV1>;

/** Problems that make a residency record unable to claim its geography. */
export function modelResidencyProblems(residency: {
  geography: ModelProcessingGeography;
  deploymentType: ModelDeploymentType;
  evidence: ModelResidencyEvidenceV1;
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
  if (
    residency.geography === "eu" &&
    GLOBAL_ROUTING_DEPLOYMENT_TYPES.includes(residency.deploymentType)
  ) {
    problems.push({
      path: ["deploymentType"],
      message: `${residency.deploymentType} routing can leave the EU, so it cannot be declared eu`,
    });
  }
  return problems;
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
          source: ModelResidencyEvidenceSource.exclude(["built_in_rule", "none"]),
          reference: z.string().trim().min(1).max(1000),
          verifiedAt: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z)?$/u)
            .nullable()
            .default(null),
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
