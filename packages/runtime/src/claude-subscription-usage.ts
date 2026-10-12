import { AsyncLocalStorage } from "node:async_hooks";

type Observer = (
  providerId: string,
  response: Response,
  upstreamModelId?: string,
  requestToken?: string | null,
) => void;
/**
 * Custody of one physical request whose bearer a subscription core leased
 * (design 5.3): `admit` is the last awaited step before the fetch (a refusal
 * sends nothing), and the request then settles exactly once, from its
 * response (and the end of its body) or from a failed fetch.
 */
export type ClaudeRequestCustody = {
  admit: () => Promise<void>;
  /** The response the SDK reads; its body may be tracked to its end. */
  responded: (response: Response) => Promise<Response>;
  /** The fetch failed after admission: the outcome is unknown. */
  failed: () => Promise<void>;
  /**
   * After a 401: renew the bearer and prepare the retry of the same request
   * (with its own custody), or null to surface the refusal as it is.
   */
  renew?: () => Promise<PreparedUsageRequest | null>;
};
export type PreparedUsageRequest = {
  headers: Headers;
  observe: Observer;
  custody?: ClaudeRequestCustody;
};
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
): Promise<PreparedClaudeRequest> {
  const context = observers.getStore();
  const upstreamModelId = modelRequests.getStore();
  let prepared: Headers | PreparedUsageRequest | undefined;
  if (context?.prepare) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    prepared = await context.prepare(providerId, headers);
  }
  return preparedRequest(providerId, init, upstreamModelId, context?.observe, prepared);
}

/** One physical request as prepared: its headers, observer and custody. */
export type PreparedClaudeRequest = {
  init: RequestInit | undefined;
  observe: (response: Response, requestToken?: string | null) => void;
  admit: () => Promise<void>;
  responded: (response: Response) => Promise<Response>;
  failed: () => Promise<void>;
  /** Present only for a custody that can renew its bearer after a 401. */
  renew: (() => Promise<PreparedClaudeRequest | null>) | undefined;
};

function preparedRequest(
  providerId: string,
  init: RequestInit | undefined,
  upstreamModelId: string | undefined,
  observer: Observer | undefined,
  prepared: Headers | PreparedUsageRequest | undefined,
): PreparedClaudeRequest {
  let observe = observer;
  let custody: ClaudeRequestCustody | undefined;
  const base = init;
  if (prepared) {
    init = { ...init, headers: prepared instanceof Headers ? prepared : prepared.headers };
    if (!(prepared instanceof Headers)) {
      observe = prepared.observe;
      custody = prepared.custody;
    }
  }
  const renew = custody?.renew;
  return {
    init,
    observe(response: Response, requestToken?: string | null) {
      try {
        observe?.(providerId, response, upstreamModelId, requestToken);
      } catch {
        // Telemetry must neither consume nor change the model response.
      }
    },
    admit: async () => await custody?.admit(),
    responded: async (response) => (custody ? await custody.responded(response) : response),
    failed: async () => await custody?.failed(),
    renew: renew
      ? async () => {
          const next = await renew();
          return next ? preparedRequest(providerId, base, upstreamModelId, observer, next) : null;
        }
      : undefined,
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
