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

export type XaiModelRequestEvent = {
  requestId: string;
  transportAttempt: number;
  phase: "started" | "headers" | "first_event" | "progress" | "completed" | "failed" | "timed_out";
  model?: string;
  durationMs: number;
  responseObserved: boolean;
  streamIdleTimeoutMs: number;
  status?: number;
  providerRequestId?: string;
  eventCount: number;
  lastEventType?: string;
  lastProgressDurationMs?: number;
  interEventGapMs?: number;
  silenceDurationMs?: number;
  willRetry?: boolean;
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
  /** Maximum silence between complete, valid SSE data events. */
  streamIdleTimeoutMs?: number;
  /** @deprecated Use streamIdleTimeoutMs. Retained as a compatibility alias. */
  hostedToolContinuationTimeoutMs?: number;
  /** Synchronous, best-effort diagnostics; never receives bodies, auth, or output. */
  onModelRequestDiagnostic?: (event: XaiModelRequestEvent) => void;
  /** Worker-owned durable lifecycle audit; never receives bodies, auth, or output. */
  onModelRequestEvent?: (event: XaiModelRequestEvent) => Promise<void> | void;
};

export const xaiSubscriptionRequestStorage = new AsyncLocalStorage<XaiSubscriptionRequestContext>();
