/** Notifications cannot change the result of an already accepted operation. */
export function notifyObserver<Args extends unknown[]>(
  observer: ((...args: Args) => unknown) | undefined,
  ...args: Args
): void {
  const report = (cause: unknown) => globalThis.reportError?.(cause);
  try {
    const result = observer?.(...args);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(report);
    }
  } catch (cause) {
    report(cause);
  }
}
