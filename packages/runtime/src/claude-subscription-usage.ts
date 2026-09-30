import { AsyncLocalStorage } from "node:async_hooks";

type Observer = (providerId: string, response: Response) => void;
const observers = new AsyncLocalStorage<Observer>();

/** Like Codex usage headers: free observations within this turn's provider context. */
export function withClaudeUsageObserver<T>(observer: Observer, run: () => Promise<T>): Promise<T> {
  return observers.run(observer, run);
}
export function observeClaudeUsageResponse(providerId: string, response: Response): void {
  try {
    observers.getStore()?.(providerId, response);
  } catch {
    // Usage telemetry must never change or consume a model response.
  }
}
