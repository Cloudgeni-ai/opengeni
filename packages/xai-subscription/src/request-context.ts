import { AsyncLocalStorage } from "node:async_hooks";

export type XaiSubscriptionTokenSnapshot = {
  accessToken: string;
  userId: string;
};

export type XaiHostedSearchOptions = {
  webSearch?: boolean | Record<string, unknown>;
  xSearch?: boolean | Record<string, unknown>;
};

export type XaiFinalContextUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type XaiSubscriptionRequestContext = {
  clientVersion: string;
  sessionId: string;
  turnId: string;
  getToken: () => Promise<XaiSubscriptionTokenSnapshot>;
  refresh: () => Promise<XaiSubscriptionTokenSnapshot>;
  resolveModel: (slug: string) => string;
  hostedSearch?: XaiHostedSearchOptions;
  onFinalContextUsage?: (usage: XaiFinalContextUsage) => void;
  nextRequestId?: () => string;
  /** Internal/test seam. Production uses the transport's bounded default. */
  hostedToolContinuationTimeoutMs?: number;
};

export const xaiSubscriptionRequestStorage = new AsyncLocalStorage<XaiSubscriptionRequestContext>();
