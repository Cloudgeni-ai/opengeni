import { AsyncLocalStorage } from "node:async_hooks";

import {
  euModelRoutes,
  sideFeatureRouteFeatures,
  sideFeatureRouteIsEu,
  type SideFeatureResidencySettings,
  type SideFeatureRouteId,
  type Settings,
} from "@opengeni/config";
import { modelEndpointDeployment, type InferenceFeatureId } from "@opengeni/contracts";

import { replayableJsonBodySource } from "./replayable-json-body";

/**
 * EU-only inference, enforced in the shared model transport. Every provider
 * adapter (OpenAI and Azure Responses and Chat, Anthropic Messages, Codex,
 * SuperGrok, gateways) sends through `instrumentedModelFetch`, which calls
 * `assertInferenceResidencyForRequest` before any byte leaves the process.
 * Under an EU requirement a request is allowed only when its provider and
 * request-body model are an EU route of the run's settings. Resolution
 * (`resolveTurnModel`, the model router) applies the same rule earlier from
 * `settings.requiredModelGeography`. See docs/eu-only-inference.md.
 */

export class InferenceRegionRestrictedError extends Error {
  readonly code = "region_restricted";
  constructor(
    readonly modelName: string,
    message?: string,
  ) {
    super(
      message ??
        `Model "${modelName}" is not supported in EU. This workspace only uses models that process data in the EU; pick an EU model.`,
    );
    this.name = "InferenceRegionRestrictedError";
  }
}

const INFERENCE_FEATURE_LABELS: Record<InferenceFeatureId, string> = {
  web_search: "Web search",
  image_generation: "Image generation",
  video_generation: "Video generation",
  realtime_voice: "Live voice",
  voice_input: "Voice input",
  meeting_transcription: "Transcription",
  knowledge_embeddings: "Semantic Knowledge search",
  code_search: "Code search",
};

/** The refusal for a side feature that has no EU route. */
export function sideFeatureRegionRestrictedError(
  feature: InferenceFeatureId,
): InferenceRegionRestrictedError {
  return new InferenceRegionRestrictedError(
    feature,
    `${INFERENCE_FEATURE_LABELS[feature]} is not supported in EU.`,
  );
}

/**
 * Whether a side-feature call must run on an EU route: the settings carry the
 * EU requirement, or the run's context is EU or not yet resolved.
 */
export function sideFeatureRequiresEu(settings: SideFeatureResidencySettings): boolean {
  if (settings.requiredModelGeography === "eu") return true;
  // Every enclosing context counts: unresolved anywhere, or EU anywhere.
  const context = currentInferenceResidency();
  return context !== undefined && (!context.resolved || context.requirement !== null);
}

/**
 * Refuse a side-feature call on a route that may not run here, before any
 * byte is sent. Under EU only a route whose residency record is EU passes;
 * nothing falls back to another route.
 */
export function assertSideFeatureRoute(
  settings: SideFeatureResidencySettings,
  route: SideFeatureRouteId,
  feature: InferenceFeatureId = sideFeatureRouteFeatures(route)[0]!,
): void {
  if (sideFeatureRequiresEu(settings) && !sideFeatureRouteIsEu(settings, route)) {
    throw sideFeatureRegionRestrictedError(feature);
  }
}

/**
 * A transport for a side-feature provider adapter that checks the route
 * before every request, so nothing is sent on a route that may not run here
 * even when the adapter was built earlier.
 */
export function sideFeatureRouteFetch(
  settings: SideFeatureResidencySettings,
  route: SideFeatureRouteId,
  inner: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assertSideFeatureRoute(settings, route);
    return await inner(input, init);
  }) as typeof fetch;
}

/** Whether a side-feature call may use this route now (the non-throwing form). */
export function sideFeatureRouteRunnable(
  settings: SideFeatureResidencySettings,
  route: SideFeatureRouteId,
): boolean {
  return !sideFeatureRequiresEu(settings) || sideFeatureRouteIsEu(settings, route);
}

/**
 * The region refusal on an error or its `cause` chain. SDKs and runners can
 * wrap it (an OpenAI `APIConnectionError`, for example); it stays terminal.
 */
export function findInferenceRegionRestrictedError(
  error: unknown,
): InferenceRegionRestrictedError | null {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object";) {
    if (current instanceof InferenceRegionRestrictedError) return current;
    if (seen.has(current) || seen.size >= 16) return null;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The routes a request may use: provider id to its EU upstream model ids. */
export type InferenceResidencyRequirement = {
  geography: "eu";
  routes: ReadonlyMap<string, ReadonlySet<string>>;
};

/** The requirement the settings carry, or null when the run is not EU-only. */
export function inferenceResidencyRequirement(
  settings: Settings,
): InferenceResidencyRequirement | null {
  return settings.requiredModelGeography === "eu"
    ? { geography: "eu", routes: euModelRoutes(settings) }
    : null;
}

/** A stable cache-key fragment for a requirement bound into a client. */
export function inferenceResidencyCacheKey(
  requirement: InferenceResidencyRequirement | null,
): unknown {
  if (!requirement) return null;
  return [...requirement.routes]
    .map(([providerId, models]) => [providerId, [...models].sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

export type InferenceResidencyContext = {
  /** Set once the run's settings are known; until then nothing may be sent. */
  requirement: InferenceResidencyRequirement | null;
  /** True once the workspace's setting has been read for this run. */
  resolved: boolean;
};

type InferenceResidencyScope = InferenceResidencyContext & {
  /** The enclosing context. A nested context applies on top of it, never instead. */
  parent: InferenceResidencyScope | undefined;
};

const inferenceResidencyStorage = new AsyncLocalStorage<InferenceResidencyScope>();

/**
 * Run `fn` with a residency context. Pass the run's settings when known, or
 * `null` to install an unresolved context and resolve it later with
 * `resolveInferenceResidency` (for example after a turn claim). While a
 * context is unresolved, model requests are refused.
 *
 * A nested context never widens its parent: the parent's requirement still
 * applies inside it, and while the parent is unresolved requests stay
 * refused, so settings passed here can only narrow the enclosing run.
 */
export function withInferenceResidency<T>(settings: Settings | null, fn: () => T): T {
  const context: InferenceResidencyScope = {
    requirement: null,
    resolved: false,
    parent: inferenceResidencyStorage.getStore(),
  };
  if (settings) resolveInferenceResidencyContext(context, settings);
  return inferenceResidencyStorage.run(context, fn);
}

/** Bind the current context to the run's settings. Narrowing only: once EU, always EU. */
export function resolveInferenceResidency(settings: Settings): void {
  const context = inferenceResidencyStorage.getStore();
  if (context) resolveInferenceResidencyContext(context, settings);
}

function resolveInferenceResidencyContext(
  context: InferenceResidencyContext,
  settings: Settings,
): void {
  // A later, wider settings snapshot never relaxes an EU requirement: the
  // requirements combine, and a route must meet both.
  context.requirement = combinedRequirement(
    context.requirement,
    inferenceResidencyRequirement(settings),
  );
  context.resolved = true;
}

/** Both requirements at once: only the routes each allows. */
function combinedRequirement(
  left: InferenceResidencyRequirement | null,
  right: InferenceResidencyRequirement | null,
): InferenceResidencyRequirement | null {
  if (!left || !right || left.routes === right.routes) return left ?? right;
  const routes = new Map<string, ReadonlySet<string>>();
  for (const [providerId, models] of left.routes) {
    const other = right.routes.get(providerId);
    if (other) routes.set(providerId, new Set([...models].filter((model) => other.has(model))));
  }
  return { geography: "eu", routes };
}

/**
 * What the current context and every context enclosing it allow together:
 * unresolved while any of them is, and every EU requirement among them.
 */
export function currentInferenceResidency(): InferenceResidencyContext | undefined {
  let scope = inferenceResidencyStorage.getStore();
  if (!scope) return undefined;
  const effective: InferenceResidencyContext = { requirement: null, resolved: true };
  for (; scope; scope = scope.parent) {
    effective.resolved &&= scope.resolved;
    effective.requirement = combinedRequirement(effective.requirement, scope.requirement);
  }
  return effective;
}

/** What the guard reads from a model request body. */
type RequestBodyFacts = {
  model: string | null;
  /**
   * Provider-hosted tools the request asks the provider to run (search,
   * image generation, code execution): their side-feature route, or null for
   * a hosted tool with no residency record. Function tools run here and are
   * not listed.
   */
  hostedTools: { type: string; route: SideFeatureRouteId | null }[];
};

/** The side-feature route of a provider-hosted tool type, by the provider's wire type. */
function hostedToolRoute(type: string): SideFeatureRouteId | null | undefined {
  // OpenAI and Azure `web_search`/`web_search_preview*`, Anthropic
  // `web_search_*`/`web_fetch_*`, SuperGrok `x_search`.
  if (type.startsWith("web_search") || type.startsWith("web_fetch") || type === "x_search") {
    return "web_search.hosted";
  }
  if (type === "image_generation") return "image_generation.openai_hosted";
  // Hosted execution and retrieval run on the provider's own services.
  if (
    type === "code_interpreter" ||
    type.startsWith("code_execution") ||
    type === "file_search" ||
    type === "mcp"
  ) {
    return null;
  }
  // Function and client-executed tools run here.
  return undefined;
}

function bodyFacts(value: unknown): RequestBodyFacts {
  if (value === null || typeof value !== "object") return { model: null, hostedTools: [] };
  const body = value as { model?: unknown; tools?: unknown };
  const hostedTools: RequestBodyFacts["hostedTools"] = [];
  for (const tool of Array.isArray(body.tools) ? (body.tools as unknown[]) : []) {
    const type =
      tool !== null && typeof tool === "object" ? (tool as { type?: unknown }).type : undefined;
    if (typeof type !== "string") continue;
    const route = hostedToolRoute(type);
    if (route !== undefined) hostedTools.push({ type, route });
  }
  // Chat Completions search models and SuperGrok live search are hosted search too.
  if ("web_search_options" in body || "search_parameters" in body) {
    hostedTools.push({ type: "web_search_options", route: "web_search.hosted" });
  }
  return { model: typeof body.model === "string" ? body.model : null, hostedTools };
}

function factsFromJsonText(text: string): RequestBodyFacts {
  try {
    return bodyFacts(JSON.parse(text) as unknown);
  } catch {
    return { model: null, hostedTools: [] };
  }
}

/**
 * The request body's `model`. A replayable JSON body (every OpenAI SDK model
 * request) is read from the object it encodes, without consuming or buffering
 * it; any other stream is read from a tee without consuming what is sent.
 */
async function requestBodyFacts(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<RequestBodyFacts & { init: RequestInit | undefined }> {
  const body = init?.body;
  if (typeof body === "string") return { ...factsFromJsonText(body), init };
  const replayable = replayableJsonBodySource(body);
  if (replayable) return { ...bodyFacts(replayable.source), init };
  if (body instanceof Uint8Array) {
    return { ...factsFromJsonText(new TextDecoder().decode(body)), init };
  }
  if (body instanceof ArrayBuffer) {
    return { ...factsFromJsonText(new TextDecoder().decode(new Uint8Array(body))), init };
  }
  if (body instanceof ReadableStream) {
    const [sent, inspected] = body.tee();
    const text = await new Response(inspected).text();
    return { ...factsFromJsonText(text), init: { ...init, body: sent } };
  }
  if (body == null && input instanceof Request) {
    return { ...factsFromJsonText(await input.clone().text()), init };
  }
  return { model: null, hostedTools: [], init };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

/** Whether a requirement includes this route. */
function allowsRoute(
  requirement: InferenceResidencyRequirement,
  providerId: string,
  upstreamModelId: string | null,
): boolean {
  return (
    upstreamModelId !== null && requirement.routes.get(providerId)?.has(upstreamModelId) === true
  );
}

/** The context requirement, or "refuse" while any enclosing context is unresolved. */
function contextRequirement(): InferenceResidencyRequirement | null | "refuse" {
  const context = currentInferenceResidency();
  if (!context) return null;
  return context.resolved ? context.requirement : "refuse";
}

/**
 * Refuse a model request that may not run here, before it is sent. Two
 * requirements apply, and both must allow it:
 * - `bound`: the requirement of the settings the client was built from. A
 *   client built for an EU-only run refuses non-EU requests wherever it is
 *   used.
 * - the run's context, with every context enclosing it. Outside any context
 *   it adds nothing; an unresolved context refuses; an EU context requires
 *   an EU route.
 * A request is allowed under EU only when its provider and request-body model
 * are an EU route, and, when its URL calls a deployment by path (Azure's
 * `/openai/deployments/{name}/`), that deployment is one too: the provider
 * runs the deployment in the URL, not the model in the body. A deployment
 * path whose name can't be read is refused. Returns the init to send (a tee'd
 * stream body is replaced).
 */
export async function assertInferenceResidencyForRequest(
  providerId: string,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  bound: InferenceResidencyRequirement | null = null,
): Promise<RequestInit | undefined> {
  const context = contextRequirement();
  if (!context && !bound) return init;
  const read = await requestBodyFacts(input, init);
  if (context === "refuse") throw new InferenceRegionRestrictedError(read.model ?? providerId);
  const deployment = modelEndpointDeployment(requestUrl(input));
  for (const requirement of [bound, context]) {
    if (!requirement) continue;
    if (
      !allowsRoute(requirement, providerId, read.model) ||
      deployment === "" ||
      (deployment !== null && !allowsRoute(requirement, providerId, deployment))
    ) {
      throw new InferenceRegionRestrictedError(read.model ?? (deployment || providerId));
    }
  }
  // Under EU, a provider-hosted tool runs on the provider's own services (for
  // Azure web search, Grounding with Bing outside the geo boundary), not on
  // the model route: it needs its own EU record. Hosted-tool routes are
  // code-owned, so no deployment declaration applies.
  for (const tool of read.hostedTools) {
    if (!tool.route || !sideFeatureRouteIsEu({}, tool.route)) {
      throw tool.route
        ? sideFeatureRegionRestrictedError(sideFeatureRouteFeatures(tool.route)[0]!)
        : new InferenceRegionRestrictedError(
            tool.type,
            `Hosted tool "${tool.type}" is not supported in EU.`,
          );
    }
  }
  return read.init;
}

/**
 * A provider request that is not a model call (images, audio, files, model
 * lists). Under an EU requirement, bound or from the run's context, only
 * GET and HEAD reads pass: any other method is refused, with or without a
 * body. The side features that send content check their own routes before
 * calling.
 */
export function assertInferenceResidencyForOtherRequest(
  providerId: string,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  bound: InferenceResidencyRequirement | null = null,
): void {
  if (!bound && !contextRequirement()) return;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new InferenceRegionRestrictedError(providerId);
  }
}
