import { AsyncLocalStorage } from "node:async_hooks";

type Observer = (
  providerId: string,
  response: Response,
  upstreamModelId?: string,
  requestToken?: string | null,
) => void;
type PreparedUsageRequest = { headers: Headers; observe: Observer };
type Prepare = (providerId: string, headers: Headers) => Promise<Headers | PreparedUsageRequest>;
const observers = new AsyncLocalStorage<{
  observe: Observer;
  prepare?: Prepare;
}>();
const modelRequests = new AsyncLocalStorage<string>();

/** The native adapter knows the exact model without reading or cloning the wire body. */
export function withClaudeModelRequest<T>(
  upstreamModelId: string,
  run: () => Promise<T>,
): Promise<T> {
  return modelRequests.run(upstreamModelId, run);
}

/** Like Codex usage headers: free observations within this turn's provider context. */
export function withClaudeUsageObserver<T>(
  observer: Observer,
  run: () => Promise<T>,
  prepare?: Prepare,
): Promise<T> {
  return observers.run({ observe: observer, ...(prepare ? { prepare } : {}) }, run);
}
export async function prepareClaudeSubscriptionRequest(
  providerId: string,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  const context = observers.getStore();
  const upstreamModelId = modelRequests.getStore();
  let observe = context?.observe;
  if (context?.prepare) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const prepared = await context.prepare(providerId, headers);
    init = { ...init, headers: prepared instanceof Headers ? prepared : prepared.headers };
    if (!(prepared instanceof Headers)) observe = prepared.observe;
  }
  return {
    init,
    observe(response: Response, requestToken?: string | null) {
      try {
        observe?.(providerId, response, upstreamModelId, requestToken);
      } catch {
        // Telemetry must neither consume nor change the model response.
      }
    },
  };
}
export function captureClaudeRequestToken(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  if (!observers.getStore()) return undefined;
  const headers = new Headers(
    init?.headers !== undefined
      ? init.headers
      : input instanceof Request
        ? input.headers
        : undefined,
  );
  return headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? null;
}

export function observeClaudeUsageResponse(
  providerId: string,
  response: Response,
  requestToken?: string | null,
): void {
  try {
    observers.getStore()?.observe(providerId, response, modelRequests.getStore(), requestToken);
  } catch {
    // Usage telemetry must never change or consume a model response.
  }
}
