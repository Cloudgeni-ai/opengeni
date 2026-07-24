/**
 * Server-only Codex subscription realtime boundary.
 *
 * The verified subscription protocol currently covers Responses, model
 * catalog/usage, and connector MCP. It does not establish an audio WebRTC or
 * WebSocket endpoint. The default evidence therefore fails closed before a
 * credential resolver can run.
 */

export const CODEX_REALTIME_PROTOCOL_EVIDENCE = Object.freeze({
  status: "unverified" as const,
  endpoint: null,
  transport: null,
  reason: "codex_realtime_protocol_unverified" as const,
});

export const CODEX_REALTIME_VOICE_LIMITS = Object.freeze({
  grantTtlSeconds: 60,
  maxSessionSeconds: 15 * 60,
  maxInputAudioBytes: 32 * 1024 * 1024,
});

export type CodexRealtimeProtocolEvidence =
  | typeof CODEX_REALTIME_PROTOCOL_EVIDENCE
  | {
      status: "verified";
      endpoint: string;
      transport: "websocket" | "webrtc";
      reason: null;
    };

export type CodexRealtimeAvailabilityInput = {
  featureEnabled: boolean;
  subscriptionEnabled: boolean;
  workspacePolicyAccepted: boolean;
  /** A separately implemented OpenGeni media gateway must be explicitly ready. */
  gatewayAvailable?: boolean;
  protocol?: CodexRealtimeProtocolEvidence;
};

export type CodexRealtimeAvailability = {
  status: "available" | "disabled" | "unavailable";
  reason:
    | "feature_disabled"
    | "codex_subscription_disabled"
    | "codex_realtime_protocol_unverified"
    | "realtime_voice_policy_unaccepted"
    | "gateway_unavailable"
    | null;
  feature: "enabled" | "disabled";
  subscription: "enabled" | "disabled";
  workspacePolicy: "accepted" | "unaccepted";
  protocol: "verified" | "unverified";
  gateway: "available" | "unavailable";
};

export function codexRealtimeAvailability(
  input: CodexRealtimeAvailabilityInput,
): CodexRealtimeAvailability {
  const protocol = input.protocol ?? CODEX_REALTIME_PROTOCOL_EVIDENCE;
  const checks = {
    feature: input.featureEnabled ? ("enabled" as const) : ("disabled" as const),
    subscription: input.subscriptionEnabled ? ("enabled" as const) : ("disabled" as const),
    workspacePolicy: input.workspacePolicyAccepted
      ? ("accepted" as const)
      : ("unaccepted" as const),
    protocol: protocol.status,
    gateway: input.gatewayAvailable ? ("available" as const) : ("unavailable" as const),
  };
  if (!input.featureEnabled) return { ...checks, status: "disabled", reason: "feature_disabled" };
  if (!input.subscriptionEnabled) {
    return { ...checks, status: "unavailable", reason: "codex_subscription_disabled" };
  }
  // Protocol proof deliberately precedes credential and media work. A feature
  // flag can never turn an assumed public Platform endpoint into entitlement.
  if (protocol.status !== "verified") {
    return {
      ...checks,
      status: "unavailable",
      reason: "codex_realtime_protocol_unverified",
    };
  }
  if (!input.workspacePolicyAccepted) {
    return { ...checks, status: "unavailable", reason: "realtime_voice_policy_unaccepted" };
  }
  // Protocol evidence and an implemented OpenGeni gateway are independent
  // prerequisites. Updating the evidence constant alone must never expose a
  // provider endpoint or make an unimplemented production path appear live.
  if (!input.gatewayAvailable) {
    return { ...checks, status: "unavailable", reason: "gateway_unavailable" };
  }
  return { ...checks, status: "available", reason: null };
}

export type CodexRealtimeCredentialSnapshot = {
  accessToken: string;
  chatgptAccountId?: string | null;
};

export type CodexRealtimeGatewayGrant = {
  id: string;
  gatewayUrl: string;
  expiresAt: string;
};

export async function createCodexRealtimeGatewayGrant(input: {
  availability: CodexRealtimeAvailabilityInput;
  target: { workspaceId: string; sessionId: string };
  resolveCredential: () => Promise<CodexRealtimeCredentialSnapshot>;
  openServerGateway: (input: {
    credential: CodexRealtimeCredentialSnapshot;
    endpoint: string;
    transport: "websocket" | "webrtc";
    target: { workspaceId: string; sessionId: string };
    limits: typeof CODEX_REALTIME_VOICE_LIMITS;
  }) => Promise<CodexRealtimeGatewayGrant>;
}): Promise<
  | { availability: CodexRealtimeAvailability; grant: null }
  | { availability: CodexRealtimeAvailability; grant: CodexRealtimeGatewayGrant }
> {
  const availability = codexRealtimeAvailability(input.availability);
  const protocol = input.availability.protocol ?? CODEX_REALTIME_PROTOCOL_EVIDENCE;
  if (availability.status !== "available" || protocol.status !== "verified") {
    return { availability, grant: null };
  }

  // The credential crosses only this server-side call. The returned public
  // grant is constructed solely from the gateway's opaque id/url/expiry.
  const credential = await input.resolveCredential();
  const grant = await input.openServerGateway({
    credential,
    endpoint: protocol.endpoint,
    transport: protocol.transport,
    target: input.target,
    limits: CODEX_REALTIME_VOICE_LIMITS,
  });
  return { availability, grant };
}
