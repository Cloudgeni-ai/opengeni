/**
 * Amazon Bedrock model identity (docs/amazon-bedrock.md): inference profile
 * ids, inference-profile ARNs and the base Claude model each one serves.
 * Pure helpers plus the process-local discovery cache the runtime fills.
 */

export const BEDROCK_PROVIDER_ID = "bedrock" as const;
export const BEDROCK_MODEL_ID_PREFIX = "bedrock/" as const;

/** Cross-region inference profile prefixes; `global.` routes worldwide. */
const BEDROCK_GEO_PREFIX = /^(global|us-gov|us|eu|apac|au|jp|ca)\./u;
const BEDROCK_ARN =
  /^arn:aws[a-z-]*:bedrock:([a-z0-9-]+):(\d{12})?:(foundation-model|inference-profile|application-inference-profile)\/(.+)$/u;

/** How Bedrock places a route: worldwide, inside one geography, in the region, or an application profile. */
export type BedrockRouteScope = "global" | "geo" | "regional" | "application";

/** A model the account can use, as discovery found it. */
export interface BedrockDiscoveredModel {
  /** What the request body's `model` names: a profile id, model id or ARN. */
  upstreamModelId: string;
  /** For an application profile: the system profile or model id it copies. */
  baseUpstreamModelId?: string;
  /** Application profile name, when it has one. */
  name?: string;
}

function arnParts(id: string) {
  const match = BEDROCK_ARN.exec(id);
  return match ? { region: match[1]!, type: match[3]!, resource: match[4]! } : null;
}

let discovered: readonly BedrockDiscoveredModel[] = [];
const applicationProfileBases = new Map<string, string>();
const configuredApplicationProfileBases = new Map<string, string>();

/** Replace the discovered model list (runtime discovery, see docs/amazon-bedrock.md). */
export function setBedrockDiscoveredModels(models: readonly BedrockDiscoveredModel[]): void {
  discovered = [...models];
  applicationProfileBases.clear();
  for (const model of models)
    if (model.baseUpstreamModelId)
      applicationProfileBases.set(model.upstreamModelId, model.baseUpstreamModelId);
}

export function bedrockDiscoveredModels(): readonly BedrockDiscoveredModel[] {
  return discovered;
}

/**
 * Record application profile bases named in OPENGENI_BEDROCK_MODELS
 * (`<arn>=<profile id>`), for when discovery is off or cannot read them.
 */
export function setBedrockConfiguredApplicationProfiles(bases: ReadonlyMap<string, string>): void {
  for (const [arn, base] of bases) configuredApplicationProfileBases.set(arn, base);
}

/** The system profile or model id an application profile copies, when known. */
export function bedrockApplicationProfileBase(id: string): string | undefined {
  return applicationProfileBases.get(id) ?? configuredApplicationProfileBases.get(id);
}

export function bedrockRouteScope(id: string): BedrockRouteScope {
  const arn = arnParts(id);
  if (arn?.type === "application-inference-profile") return "application";
  const tail = arn ? arn.resource : id;
  const geo = BEDROCK_GEO_PREFIX.exec(tail)?.[1];
  return geo === "global" ? "global" : geo ? "geo" : "regional";
}

/** `eu`, `us`, … for a cross-region geographic profile. */
export function bedrockProfileGeo(id: string): string | undefined {
  const arn = arnParts(id);
  const geo = BEDROCK_GEO_PREFIX.exec(arn ? arn.resource : id)?.[1];
  return geo && geo !== "global" ? geo : undefined;
}

/**
 * The Anthropic model id (`claude-opus-5-5`) a Bedrock id serves: a profile
 * id (`eu.anthropic.claude-opus-5-5`), a model id
 * (`anthropic.claude-haiku-4-5-20251001-v1:0`), or an ARN. An application
 * profile resolves only once discovery has read its base model. Undefined
 * for anything that is not Claude.
 */
export function bedrockClaudeBaseModelId(id: string): string | undefined {
  const base = bedrockApplicationProfileBase(id);
  if (base !== undefined) return bedrockClaudeBaseModelId(base);
  const arn = arnParts(id);
  if (arn?.type === "application-inference-profile") return undefined;
  const tail = (arn ? arn.resource : id).replace(BEDROCK_GEO_PREFIX, "");
  if (!tail.startsWith("anthropic.claude-")) return undefined;
  return tail.slice("anthropic.".length).replace(/-v\d+(?::\d+)*(?::\d+k)?$/u, "");
}

/**
 * The product model id: `bedrock/<profile or model id>`, or for an ARN
 * `bedrock/<resource type>/<resource id>` (no account or region in the id).
 */
export function bedrockProductModelId(upstreamModelId: string): string {
  const arn = arnParts(upstreamModelId);
  return BEDROCK_MODEL_ID_PREFIX + (arn ? `${arn.type}/${arn.resource}` : upstreamModelId);
}

/**
 * Bedrock's price relative to Anthropic's list price: global profiles match
 * it, geographic profiles and in-Region endpoints cost 10% more.
 * https://aws.amazon.com/bedrock/pricing/ (Anthropic, 2026-11-22).
 */
export function bedrockPriceMultiplier(upstreamModelId: string): number | undefined {
  const scope = bedrockRouteScope(upstreamModelId);
  if (scope === "application") {
    const base = bedrockApplicationProfileBase(upstreamModelId);
    return base === undefined ? undefined : bedrockPriceMultiplier(base);
  }
  return scope === "global" ? 1 : 1.1;
}
