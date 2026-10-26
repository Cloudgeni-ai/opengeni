import { AsyncLocalStorage } from "node:async_hooks";

import { euModelRoutes, type Settings } from "@opengeni/config";
import { modelEndpointDeployment } from "@opengeni/contracts";

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
  constructor(readonly modelName: string) {
    super(
      `Model "${modelName}" is not supported in EU. This workspace only uses models that process data in the EU; pick an EU model.`,
    );
    this.name = "InferenceRegionRestrictedError";
  }
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

function modelOf(value: unknown): string | null {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { model?: unknown }).model === "string"
    ? (value as { model: string }).model
    : null;
}

function modelFromJsonText(text: string): string | null {
  try {
    return modelOf(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * The request body's `model`. A replayable JSON body (every OpenAI SDK model
 * request) is read from the object it encodes, without consuming or buffering
 * it; any other stream is read from a tee without consuming what is sent.
 */
async function requestBodyModel(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<{ model: string | null; init: RequestInit | undefined }> {
  const body = init?.body;
  if (typeof body === "string") return { model: modelFromJsonText(body), init };
  const replayable = replayableJsonBodySource(body);
  if (replayable) return { model: modelOf(replayable.source), init };
  if (body instanceof Uint8Array) {
    return { model: modelFromJsonText(new TextDecoder().decode(body)), init };
  }
  if (body instanceof ArrayBuffer) {
    return { model: modelFromJsonText(new TextDecoder().decode(new Uint8Array(body))), init };
  }
  if (body instanceof ReadableStream) {
    const [sent, inspected] = body.tee();
    const text = await new Response(inspected).text();
    return { model: modelFromJsonText(text), init: { ...init, body: sent } };
  }
  if (body == null && input instanceof Request) {
    return { model: modelFromJsonText(await input.clone().text()), init };
  }
  return { model: null, init };
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
 * runs the deployment in the URL, not the model in the body. Returns the init
 * to send (a tee'd stream body is replaced).
 */
export async function assertInferenceResidencyForRequest(
  providerId: string,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  bound: InferenceResidencyRequirement | null = null,
): Promise<RequestInit | undefined> {
  const context = contextRequirement();
  if (!context && !bound) return init;
  const read = await requestBodyModel(input, init);
  if (context === "refuse") throw new InferenceRegionRestrictedError(read.model ?? providerId);
  const deployment = modelEndpointDeployment(requestUrl(input));
  for (const requirement of [bound, context]) {
    if (!requirement) continue;
    if (
      !allowsRoute(requirement, providerId, read.model) ||
      (deployment !== null && !allowsRoute(requirement, providerId, deployment))
    ) {
      throw new InferenceRegionRestrictedError(read.model ?? deployment ?? providerId);
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
