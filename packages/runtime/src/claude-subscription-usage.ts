import { AsyncLocalStorage } from "node:async_hooks";

type Observer = (providerId: string, response: Response) => void;
type Prepare = (providerId: string, headers: Headers) => Promise<Headers>;
const observers = new AsyncLocalStorage<{
  observe: Observer;
  prepare?: Prepare;
}>();

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
  const prepare = observers.getStore()?.prepare;
  if (!prepare) return init;
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return { ...init, headers: await prepare(providerId, headers) };
}
export function observeClaudeUsageResponse(providerId: string, response: Response): void {
  try {
    observers.getStore()?.observe(providerId, response);
  } catch {
    // Usage telemetry must never change or consume a model response.
  }
}
