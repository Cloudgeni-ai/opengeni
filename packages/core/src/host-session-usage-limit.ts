import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A task usage limit the trusted server applies to a root session it creates
 * in this process, as the host actor `subjectId`. Published Site agents use
 * it: site-runtime creates each conversation as `site:<siteId>` through an
 * in-process dispatch, and the per-conversation budget must be in place in the
 * create transaction, before the first model call. Only code in this process
 * can set it; a request cannot.
 */
export type HostSessionUsageLimit = {
  /** The service principal the session is created as; other callers are ignored. */
  subjectId: string;
  limitMicros: number;
};

const limits = new AsyncLocalStorage<HostSessionUsageLimit>();

export function withHostSessionUsageLimit<T>(limit: HostSessionUsageLimit, run: () => T): T {
  return limits.run(limit, run);
}

export function currentHostSessionUsageLimit(): HostSessionUsageLimit | undefined {
  return limits.getStore();
}
