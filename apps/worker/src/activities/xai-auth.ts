import {
  XAI_CLIENT_VERSION,
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  type XaiSubscriptionRequestContext,
} from "@opengeni/xai-subscription";

/** The request-context options of a core SuperGrok turn. */
export type XaiTurnRequestContextOptions = {
  sessionId: string;
  turnId: string;
  hostedSearch?: XaiSubscriptionRequestContext["hostedSearch"];
  onFinalContextUsage?: XaiSubscriptionRequestContext["onFinalContextUsage"];
  nextRequestId?: XaiSubscriptionRequestContext["nextRequestId"];
  streamIdleTimeoutMs?: XaiSubscriptionRequestContext["streamIdleTimeoutMs"];
  onModelRequestDiagnostic?: XaiSubscriptionRequestContext["onModelRequestDiagnostic"];
  onModelRequestEvent?: XaiSubscriptionRequestContext["onModelRequestEvent"];
};

/** One turn's SuperGrok request context from its core bearer source and custody. */
export function xaiTurnRequestContext(
  input: XaiTurnRequestContextOptions,
  credentials: Pick<
    XaiSubscriptionRequestContext,
    "getToken" | "refresh" | "beforeProviderDispatch" | "onProviderRequestSettled"
  >,
): XaiSubscriptionRequestContext {
  return {
    clientVersion: XAI_CLIENT_VERSION,
    sessionId: input.sessionId,
    turnId: input.turnId,
    getToken: credentials.getToken,
    refresh: credentials.refresh,
    resolveModel: (model) =>
      model.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)
        ? model.slice(XAI_SUBSCRIPTION_MODEL_ID_PREFIX.length)
        : model,
    ...(input.hostedSearch ? { hostedSearch: input.hostedSearch } : {}),
    ...(input.onFinalContextUsage ? { onFinalContextUsage: input.onFinalContextUsage } : {}),
    ...(input.nextRequestId ? { nextRequestId: input.nextRequestId } : {}),
    ...(input.streamIdleTimeoutMs ? { streamIdleTimeoutMs: input.streamIdleTimeoutMs } : {}),
    ...(input.onModelRequestDiagnostic
      ? { onModelRequestDiagnostic: input.onModelRequestDiagnostic }
      : {}),
    ...(input.onModelRequestEvent ? { onModelRequestEvent: input.onModelRequestEvent } : {}),
    ...(credentials.beforeProviderDispatch
      ? { beforeProviderDispatch: credentials.beforeProviderDispatch }
      : {}),
    ...(credentials.onProviderRequestSettled
      ? { onProviderRequestSettled: credentials.onProviderRequestSettled }
      : {}),
  };
}
