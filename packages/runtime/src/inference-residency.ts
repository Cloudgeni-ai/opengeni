import { AsyncLocalStorage } from "node:async_hooks";

import { euModelRoutes, type Settings } from "@opengeni/config";

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

const inferenceResidencyStorage = new AsyncLocalStorage<InferenceResidencyContext>();

/**
 * Run `fn` with a residency context. Pass the run's settings when known, or
 * `null` to install an unresolved context and resolve it later with
 * `resolveInferenceResidency` (for example after a turn claim). While a
 * context is unresolved, model requests are refused.
 */
export function withInferenceResidency<T>(settings: Settings | null, fn: () => T): T {
  const context: InferenceResidencyContext = { requirement: null, resolved: false };
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
  const requirement = inferenceResidencyRequirement(settings);
  if (requirement) {
    context.requirement = requirement;
  } else if (context.requirement) {
    // A later, wider settings snapshot never relaxes an EU requirement.
    return;
  }
  context.resolved = true;
}

export function currentInferenceResidency(): InferenceResidencyContext | undefined {
  return inferenceResidencyStorage.getStore();
}

function modelFromJsonText(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { model?: unknown }).model === "string"
      ? (parsed as { model: string }).model
      : null;
  } catch {
    return null;
  }
}

/** The request body's `model`, reading a stream body without consuming what is sent. */
async function requestBodyModel(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): Promise<{ model: string | null; init: RequestInit | undefined }> {
  const body = init?.body;
  if (typeof body === "string") return { model: modelFromJsonText(body), init };
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

/**
 * Refuse a model request that may not run here, before it is sent. Two
 * requirements apply, and both must allow it:
 * - `bound`: the requirement of the settings the client was built from. A
 *   client built for an EU-only run refuses non-EU requests wherever it is
 *   used.
 * - the run's context. Outside any context it adds nothing; an unresolved
 *   context refuses; an EU context requires an EU route.
 * A request is allowed under EU only when its provider and request-body model
 * are an EU route. Returns the init to send (a stream body is re-teed).
 */
export async function assertInferenceResidencyForRequest(
  providerId: string,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  bound: InferenceResidencyRequirement | null = null,
): Promise<RequestInit | undefined> {
  const context = inferenceResidencyStorage.getStore();
  const contextAllowsAll = !context || (context.resolved && !context.requirement);
  if (contextAllowsAll && !bound) return init;
  const read = await requestBodyModel(input, init);
  const requirements = [bound, contextAllowsAll ? null : (context?.requirement ?? null)];
  if (!contextAllowsAll && !context?.requirement) {
    throw new InferenceRegionRestrictedError(read.model ?? providerId);
  }
  for (const requirement of requirements) {
    if (!requirement) continue;
    if (read.model === null || !requirement.routes.get(providerId)?.has(read.model)) {
      throw new InferenceRegionRestrictedError(read.model ?? providerId);
    }
  }
  return read.init;
}

/**
 * A provider request that is not a model call (images, audio, files, model
 * lists). Under an EU requirement, bound or from the run's context, only
 * bodiless reads pass; the side features that send content check their own
 * routes before calling.
 */
export function assertInferenceResidencyForOtherRequest(
  providerId: string,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  bound: InferenceResidencyRequirement | null = null,
): void {
  const context = inferenceResidencyStorage.getStore();
  if (!bound && (!context || (context.resolved && !context.requirement))) return;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new InferenceRegionRestrictedError(providerId);
  }
}
