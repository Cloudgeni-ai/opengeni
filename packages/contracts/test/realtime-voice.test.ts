import { describe, expect, test } from "bun:test";
import {
  CreateSessionVoiceGrantResponse,
  SessionVoiceCapability,
  SessionVoiceGrant,
  UpdateWorkspaceSettingsRequest,
  WorkspaceRealtimeVoicePolicy,
  resolveWorkspaceMainSessionId,
} from "../src";

const target = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
};

const checks = {
  feature: "enabled" as const,
  subscription: "enabled" as const,
  workspacePolicy: "accepted" as const,
  protocol: "verified" as const,
  gateway: "available" as const,
  credential: "available" as const,
  capacity: "available" as const,
};

const limits = {
  grantTtlSeconds: 60,
  maxSessionSeconds: 900,
  maxInputAudioBytes: 32 * 1024 * 1024,
  maxConcurrentSessions: 1,
  workspaceAudioBudgetSeconds: null,
};

const retention = {
  inputAudio: "ephemeral" as const,
  partialTranscripts: "ephemeral" as const,
  acceptedTranscripts: "ordinary-session" as const,
  providerState: "ephemeral" as const,
};

const policyLimits = {
  maxSessionSeconds: 900,
  maxInputAudioBytes: 32 * 1024 * 1024,
  maxConcurrentSessions: 1,
  workspaceAudioBudgetSeconds: null,
};

describe("realtime voice contracts", () => {
  test("keeps realtime voice consent distinct from composer transcription", () => {
    expect(
      WorkspaceRealtimeVoicePolicy.safeParse({
        enabled: true,
        acceptanceId: null,
        provider: "codex-subscription",
        credentialMode: "managed",
        retention,
        limits: policyLimits,
      }).success,
    ).toBe(false);
    const policy = {
      enabled: true,
      acceptanceId: "33333333-3333-4333-8333-333333333333",
      provider: "codex-subscription" as const,
      credentialMode: "managed" as const,
      retention,
      limits: policyLimits,
    };
    expect(WorkspaceRealtimeVoicePolicy.parse(policy)).toEqual(policy);
    expect(UpdateWorkspaceSettingsRequest.safeParse({ realtimeVoice: policy }).success).toBe(true);
  });

  test("requires controlled reasons and grants only for available capabilities", () => {
    const unavailable = SessionVoiceCapability.parse({
      target,
      provider: "codex-subscription",
      mode: "full-duplex",
      experimental: true,
      status: "unavailable",
      reason: "gateway_unavailable",
      retryAt: null,
      retention,
      checks: { ...checks, gateway: "unavailable" },
      limits,
    });
    expect(CreateSessionVoiceGrantResponse.parse({ capability: unavailable, grant: null })).toEqual(
      { capability: unavailable, grant: null },
    );
    expect(() =>
      CreateSessionVoiceGrantResponse.parse({
        capability: unavailable,
        grant: {
          id: "44444444-4444-4444-8444-444444444444",
          target,
          provider: "codex-subscription",
          mode: "full-duplex",
          experimental: true,
          protocol: "opengeni.realtime.v1",
          gatewayUrl: "wss://api.example.test/voice/4444",
          expiresAt: "2026-07-25T01:00:00.000Z",
        },
      }),
    ).toThrow();
  });

  test("accepts only WSS gateway grants bound to the exact session", () => {
    const grant = SessionVoiceGrant.parse({
      id: "44444444-4444-4444-8444-444444444444",
      target,
      provider: "codex-subscription",
      mode: "full-duplex",
      experimental: true,
      protocol: "opengeni.realtime.v1",
      gatewayUrl: "wss://api.example.test/voice/4444",
      expiresAt: "2026-07-25T01:00:00.000Z",
    });
    const capability = SessionVoiceCapability.parse({
      target,
      provider: "codex-subscription",
      mode: "full-duplex",
      experimental: true,
      status: "available",
      reason: null,
      retryAt: null,
      retention,
      checks,
      limits,
    });
    expect(CreateSessionVoiceGrantResponse.parse({ capability, grant }).grant).toEqual(grant);
    expect(() =>
      SessionVoiceGrant.parse({ ...grant, gatewayUrl: "https://api.example.test" }),
    ).toThrow("voice gateway URL must use wss");
    expect(() =>
      CreateSessionVoiceGrantResponse.parse({
        capability,
        grant: { ...grant, target: { ...target, sessionId: crypto.randomUUID() } },
      }),
    ).toThrow("voice grant target must match its capability target");
  });

  test("parses, resolves, and clears a general workspace main-session designation", () => {
    const mainSessionId = "55555555-5555-4555-8555-555555555555";
    expect(UpdateWorkspaceSettingsRequest.parse({ mainSessionId })).toEqual({ mainSessionId });
    expect(resolveWorkspaceMainSessionId({ mainSessionId })).toBe(mainSessionId);
    expect(UpdateWorkspaceSettingsRequest.parse({ mainSessionId: null })).toEqual({
      mainSessionId: null,
    });
    expect(resolveWorkspaceMainSessionId({ mainSessionId: null })).toBeNull();
    expect(resolveWorkspaceMainSessionId({})).toBeNull();
    expect(UpdateWorkspaceSettingsRequest.safeParse({ mainSessionId: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});
