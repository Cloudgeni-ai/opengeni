import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildSessionVoiceCapability } from "../src/routes/sessions";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const acceptedVoicePolicy = {
  realtimeVoice: {
    enabled: true,
    acceptanceId: "33333333-3333-4333-8333-333333333333",
    provider: "codex-subscription",
    credentialMode: "managed",
  },
};

describe("session realtime voice API capability", () => {
  test("returns a typed disabled response by default", () => {
    expect(buildSessionVoiceCapability(testSettings(), {}, workspaceId, sessionId)).toMatchObject({
      target: { workspaceId, sessionId },
      provider: "codex-subscription",
      mode: "full-duplex",
      experimental: true,
      status: "disabled",
      reason: "feature_disabled",
      checks: {
        feature: "disabled",
        protocol: "unverified",
        gateway: "unavailable",
        credential: "not_evaluated",
        capacity: "not_evaluated",
      },
    });
  });

  test("fails on unverified protocol before credential or capacity evaluation", () => {
    expect(
      buildSessionVoiceCapability(
        testSettings({ codexRealtimeVoiceEnabled: true, codexSubscriptionEnabled: true }),
        acceptedVoicePolicy,
        workspaceId,
        sessionId,
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "codex_realtime_protocol_unverified",
      checks: {
        workspacePolicy: "accepted",
        protocol: "unverified",
        gateway: "unavailable",
        credential: "not_evaluated",
        capacity: "not_evaluated",
      },
    });
  });

  test("does not treat an accepted transcription policy as realtime voice consent", () => {
    const transcriptionOnly = {
      transcription: {
        enabled: true,
        acceptanceId: "33333333-3333-4333-8333-333333333333",
        primary: {
          provider: "codex-subscription",
          model: null,
          credentialMode: "managed",
          credentialConnectionId: null,
          region: null,
        },
        language: "en-US",
        autoDetectLanguage: false,
        diarization: { enabled: false, maxSpeakers: null },
        retention: { mode: "none", maxDays: null },
        privacy: { allowProviderLogging: false, allowProviderTraining: false },
        fallback: { mode: "disabled", targets: [] },
        cost: { currency: "USD", maxPerHour: null, maxPerMonth: null },
      },
    };
    expect(
      buildSessionVoiceCapability(
        testSettings({ codexRealtimeVoiceEnabled: true, codexSubscriptionEnabled: true }),
        transcriptionOnly,
        workspaceId,
        sessionId,
      ).checks.workspacePolicy,
    ).toBe("unaccepted");
  });
});
