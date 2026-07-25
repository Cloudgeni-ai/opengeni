/** Public, provider-neutral realtime voice wire and adapter contracts. */

export type RealtimeVoiceProvider = "codex-subscription";
export type RealtimeVoiceMode = "full-duplex";
export type RealtimeVoiceCapabilityStatus = "available" | "disabled" | "unavailable";
export type RealtimeVoiceUnavailableReason =
  | "feature_disabled"
  | "codex_subscription_disabled"
  | "codex_realtime_protocol_unverified"
  | "realtime_voice_policy_unaccepted"
  | "credential_unavailable"
  | "capacity_exhausted"
  | "policy_blocked"
  | "gateway_unavailable";

export type RealtimeVoiceTarget = {
  workspaceId: string;
  sessionId: string;
};

export type RealtimeVoiceRetentionPolicy = {
  inputAudio: "ephemeral";
  partialTranscripts: "ephemeral";
  acceptedTranscripts: "ordinary-session";
  providerState: "ephemeral";
};

export type RealtimeVoiceLimitsPolicy = {
  maxSessionSeconds: number;
  maxInputAudioBytes: number;
  maxConcurrentSessions: number;
  workspaceAudioBudgetSeconds: number | null;
};

export type WorkspaceRealtimeVoicePolicy = {
  enabled: boolean;
  acceptanceId: string | null;
  provider: RealtimeVoiceProvider;
  credentialMode: "managed";
  retention: RealtimeVoiceRetentionPolicy;
  limits: RealtimeVoiceLimitsPolicy;
};

export type SessionVoiceCapability = {
  target: RealtimeVoiceTarget;
  provider: RealtimeVoiceProvider;
  mode: RealtimeVoiceMode;
  experimental: true;
  status: RealtimeVoiceCapabilityStatus;
  reason: RealtimeVoiceUnavailableReason | null;
  retryAt: string | null;
  retention: RealtimeVoiceRetentionPolicy;
  checks: {
    feature: "enabled" | "disabled";
    subscription: "enabled" | "disabled";
    workspacePolicy: "accepted" | "unaccepted";
    protocol: "verified" | "unverified";
    gateway: "available" | "unavailable";
    credential: "available" | "unavailable" | "not_evaluated";
    capacity: "available" | "exhausted" | "not_evaluated";
  };
  limits: {
    grantTtlSeconds: number;
    maxSessionSeconds: number;
    maxInputAudioBytes: number;
    maxConcurrentSessions: number;
    workspaceAudioBudgetSeconds: number | null;
  };
};

export type SessionVoiceGrant = {
  id: string;
  target: RealtimeVoiceTarget;
  provider: RealtimeVoiceProvider;
  mode: RealtimeVoiceMode;
  experimental: true;
  protocol: "opengeni.realtime.v1";
  gatewayUrl: string;
  expiresAt: string;
};

export type CreateSessionVoiceGrantResponse = {
  capability: SessionVoiceCapability;
  grant: SessionVoiceGrant | null;
};

export type RealtimeVoiceAdapterEvent =
  | { type: "connected" }
  | { type: "listening" }
  | { type: "transcript.partial"; text: string }
  | {
      type: "transcript.final";
      text: string;
      providerAcceptanceId: string;
    }
  | { type: "speaking.started"; messageId: string }
  | { type: "speaking.stopped"; messageId: string | null }
  | { type: "reconnecting"; attempt: number }
  | {
      type: "error";
      code: "permission_denied" | "not_supported" | "network" | "provider" | "unknown";
      recoverable: boolean;
    }
  | { type: "closed"; reason: "completed" | "cancelled" | "error" | "expired" };

export type RealtimeVoiceAdapterSession = {
  /** Stops only local/provider playback; it never cancels an accepted durable turn. */
  interrupt: () => Promise<void>;
  /** Speaks one completed durable assistant message. */
  speak: (input: { messageId: string; text: string }) => Promise<void>;
  close: () => Promise<void>;
};

export type RealtimeVoiceAdapter = {
  connect: (
    grant: SessionVoiceGrant,
    listener: (event: RealtimeVoiceAdapterEvent) => void,
    context: { signal: AbortSignal },
  ) => Promise<RealtimeVoiceAdapterSession>;
};
