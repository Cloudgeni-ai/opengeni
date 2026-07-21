import { describe, expect, test } from "bun:test";
import {
  TranscriptionEvent,
  TranscriptionResultMetadata,
  UpdateWorkspaceSettingsRequest,
  WorkspaceTranscriptionPolicy,
  type WorkspaceTranscriptionTarget,
} from "../src";

const managedTarget: WorkspaceTranscriptionTarget = {
  provider: "fixture-speech",
  model: "fixture-v1",
  credentialMode: "managed",
  credentialConnectionId: null,
  region: null,
};

const acceptedPolicy = {
  enabled: true,
  acceptanceId: "11111111-1111-4111-8111-111111111111",
  primary: managedTarget,
  language: "en-US",
  autoDetectLanguage: false,
  diarization: { enabled: false, maxSpeakers: null },
  retention: { mode: "none", maxDays: null },
  privacy: { allowProviderLogging: false, allowProviderTraining: false },
  fallback: { mode: "disabled", targets: [] },
  cost: { currency: "USD", maxPerHour: 1, maxPerMonth: 10 },
} as const;

describe("workspace transcription contracts", () => {
  test("requires one complete accepted primary policy when enabled", () => {
    expect(
      WorkspaceTranscriptionPolicy.safeParse({ ...acceptedPolicy, acceptanceId: null }).success,
    ).toBe(false);
    expect(
      WorkspaceTranscriptionPolicy.safeParse({ ...acceptedPolicy, primary: null }).success,
    ).toBe(false);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        transcription: { enabled: true, acceptanceId: acceptedPolicy.acceptanceId },
      }).success,
    ).toBe(false);
  });

  test("rejects disabled fallback targets and empty explicit fallback", () => {
    expect(
      WorkspaceTranscriptionPolicy.safeParse({
        ...acceptedPolicy,
        fallback: { mode: "disabled", targets: [managedTarget] },
      }).success,
    ).toBe(false);
    expect(
      WorkspaceTranscriptionPolicy.safeParse({
        ...acceptedPolicy,
        fallback: { mode: "explicit", targets: [] },
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate accepted targets", () => {
    expect(
      WorkspaceTranscriptionPolicy.safeParse({
        ...acceptedPolicy,
        fallback: { mode: "explicit", targets: [{ ...managedTarget }] },
      }).success,
    ).toBe(false);
  });

  test("requires explicit accepted language detection and diarization settings", () => {
    expect(
      WorkspaceTranscriptionPolicy.safeParse({
        ...acceptedPolicy,
        language: null,
        autoDetectLanguage: false,
      }).success,
    ).toBe(false);
    expect(
      WorkspaceTranscriptionPolicy.safeParse({
        ...acceptedPolicy,
        language: null,
        autoDetectLanguage: true,
        diarization: { enabled: true, maxSpeakers: 4 },
      }).success,
    ).toBe(true);
    expect(
      WorkspaceTranscriptionPolicy.safeParse({
        ...acceptedPolicy,
        diarization: { enabled: false, maxSpeakers: 4 },
      }).success,
    ).toBe(false);
  });

  test("accepts strict provider-neutral result metadata and rejects malformed spans", () => {
    const metadata = {
      detectedLanguage: "en-US",
      span: { startMilliseconds: 100, endMilliseconds: 900 },
      confidence: 0.94,
      speaker: { id: "speaker-1", label: "Speaker 1" },
      words: [
        {
          text: "hello",
          span: { startMilliseconds: 100, endMilliseconds: 350 },
          confidence: 0.98,
          speaker: { id: "speaker-1" },
        },
        {
          text: "world",
          span: { startMilliseconds: 500, endMilliseconds: 900 },
        },
      ],
    } as const;
    expect(TranscriptionResultMetadata.safeParse(metadata).success).toBe(true);
    expect(
      TranscriptionEvent.safeParse({
        type: "transcript.final",
        localSessionId: "local-1",
        sequence: 3,
        occurredAt: "2026-07-21T12:00:00.000Z",
        segmentId: "segment-1",
        text: "hello world",
        providerAcceptanceId: "acceptance-1",
        metadata,
      }).success,
    ).toBe(true);
    expect(
      TranscriptionResultMetadata.safeParse({
        ...metadata,
        span: { startMilliseconds: 900, endMilliseconds: 100 },
      }).success,
    ).toBe(false);
    expect(TranscriptionResultMetadata.safeParse({ ...metadata, confidence: 1.1 }).success).toBe(
      false,
    );
    expect(
      TranscriptionResultMetadata.safeParse({ ...metadata, providerPayload: { secret: true } })
        .success,
    ).toBe(false);
  });

  test("keeps adapter errors controlled and rejects arbitrary display strings", () => {
    const event = {
      type: "session.error",
      localSessionId: "local-1",
      sequence: 4,
      occurredAt: "2026-07-21T12:00:00.000Z",
      code: "provider",
      recoverable: false,
    } as const;
    expect(TranscriptionEvent.safeParse(event).success).toBe(true);
    expect(
      TranscriptionEvent.safeParse({ ...event, message: "Bearer secret-provider-token" }).success,
    ).toBe(false);
    expect(TranscriptionEvent.safeParse({ ...event, code: "provider-secret-detail" }).success).toBe(
      false,
    );
  });

  test("accepts Azure Speech only through a non-secret BYOK connection reference", () => {
    expect(
      WorkspaceTranscriptionPolicy.safeParse({
        ...acceptedPolicy,
        primary: { ...managedTarget, provider: "azure-speech" },
      }).success,
    ).toBe(false);

    const azureByok = WorkspaceTranscriptionPolicy.parse({
      ...acceptedPolicy,
      primary: {
        provider: "azure-speech",
        model: null,
        credentialMode: "byok",
        credentialConnectionId: "22222222-2222-4222-8222-222222222222",
        region: "eastus",
      },
    });
    expect(azureByok.primary?.credentialMode).toBe("byok");
    expect(azureByok.primary?.credentialConnectionId).toBe("22222222-2222-4222-8222-222222222222");
  });
});
