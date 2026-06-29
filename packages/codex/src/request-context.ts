// Per-request Codex context, carried via AsyncLocalStorage.
//
// The runtime caches one OpenAI client per provider id (process-wide), so the
// per-workspace token must NOT be baked into the client. Instead the worker sets
// this context around the model run, and codexSubscriptionFetch reads it at call
// time — one cached client, correct per-workspace token, no cross-tenant leak.

import { AsyncLocalStorage } from "node:async_hooks";

export type CodexTokenSnapshot = {
  accessToken: string;
  chatgptAccountId: string | null;
  isFedramp: boolean;
};

export type CodexRequestContext = {
  clientVersion: string;
  /** Worker-supplied: proactive refresh + single-flight + db persist. */
  getToken: () => Promise<CodexTokenSnapshot>;
  /** Forced refresh used for the 401 retry. */
  refresh: () => Promise<CodexTokenSnapshot>;
  /** Model-slug resolver (longest-prefix against the live catalog). */
  resolveModel: (slug: string) => string;
};

export const codexRequestStorage = new AsyncLocalStorage<CodexRequestContext>();
