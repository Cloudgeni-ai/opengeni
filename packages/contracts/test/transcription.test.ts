import { describe, expect, test } from "bun:test";
import {
  ClientConfig,
  ClientResumableVoiceInputConfig,
  ClientVoiceInputConfig,
  FinalizeTranscriptionRecordingRequest,
  OPENGENI_API_CONTRACT_REVISION,
  resolveWorkspaceVoiceInputEnabled,
  TranscribeAudioResponse,
  TranscriptionRecordingListResponse,
  TranscriptionRecordingResponse,
  TranscriptionEvent,
  TranscriptionResultMetadata,
  UpdateWorkspaceSettingsRequest,
  VOICE_INPUT_MAX_DURATION_SECONDS,
  WorkspaceTranscriptionPolicy,
  WorkspaceVoiceInputSettings,
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

describe("native voice input contracts", () => {
  test("accepts a simple workspace voiceInput toggle", () => {
    expect(WorkspaceVoiceInputSettings.safeParse({ enabled: true }).success).toBe(true);
    expect(WorkspaceVoiceInputSettings.safeParse({ enabled: false }).success).toBe(true);
    expect(
      WorkspaceVoiceInputSettings.safeParse({ enabled: true, provider: "openai" }).success,
    ).toBe(false);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({ voiceInput: { enabled: false } }).success,
    ).toBe(true);
  });

  test("maps legacy transcription.enabled when voiceInput is absent", () => {
    expect(resolveWorkspaceVoiceInputEnabled({ voiceInput: { enabled: false } })).toBe(false);
    expect(resolveWorkspaceVoiceInputEnabled({ voiceInput: { enabled: true } })).toBe(true);
    expect(resolveWorkspaceVoiceInputEnabled({ transcription: acceptedPolicy })).toBe(true);
    expect(
      resolveWorkspaceVoiceInputEnabled({
        transcription: { ...acceptedPolicy, enabled: false },
      }),
    ).toBe(false);
    expect(resolveWorkspaceVoiceInputEnabled({})).toBeNull();
    expect(
      resolveWorkspaceVoiceInputEnabled({
        voiceInput: { enabled: false },
        transcription: acceptedPolicy,
      }),
    ).toBe(false);
  });

  test("projects client-safe voiceInput capability without provider secrets", () => {
    const capability = ClientVoiceInputConfig.parse({
      available: true,
      maxDurationSeconds: VOICE_INPUT_MAX_DURATION_SECONDS,
      maxSizeBytes: 25 * 1024 * 1024,
      acceptedMimeTypes: ["audio/webm", "audio/mp4"],
    });
    expect(capability.available).toBe(true);
    expect(capability.maxDurationSeconds).toBe(60);
    expect(
      ClientVoiceInputConfig.safeParse({
        ...capability,
        maxDurationSeconds: 601,
      }).success,
    ).toBe(false);
    expect(
      ClientVoiceInputConfig.safeParse({
        ...capability,
        maxSizeBytes: 25 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
    expect(
      ClientVoiceInputConfig.safeParse({
        available: true,
        maxDurationSeconds: 60,
        maxSizeBytes: 1,
        acceptedMimeTypes: ["audio/webm"],
        apiKey: "secret",
      }).success,
    ).toBe(false);

    const config = ClientConfig.parse({
      deploymentRevision: "dev",
      apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
      defaultReasoningEffort: "low",
      allowedReasoningEfforts: ["low"],
      fileUploads: { enabled: false, maxSizeBytes: 1 },
      productAccessMode: "local",
      voiceInput: capability,
    });
    expect(config.voiceInput.available).toBe(true);
  });

  test("projects strict resumable limits and accepts 30+ minute finalization metadata", () => {
    const resumable = ClientResumableVoiceInputConfig.parse({
      maxDurationSeconds: 2 * 60 * 60,
      maxSizeBytes: 512 * 1024 * 1024,
      maxChunkSizeBytes: 8 * 1024 * 1024,
      providerSegmentSeconds: 50,
    });
    expect(
      ClientVoiceInputConfig.parse({
        available: true,
        maxDurationSeconds: 60,
        maxSizeBytes: 25 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
        resumable,
      }).resumable,
    ).toEqual(resumable);
    expect(
      ClientResumableVoiceInputConfig.safeParse({
        ...resumable,
        maxDurationSeconds: 8 * 60 * 60 + 1,
      }).success,
    ).toBe(false);
    expect(
      FinalizeTranscriptionRecordingRequest.parse({
        chunkCount: 361,
        totalBytes: 361,
        totalDurationMilliseconds: 1_805_000,
      }),
    ).toEqual({
      chunkCount: 361,
      totalBytes: 361,
      totalDurationMilliseconds: 1_805_000,
    });
  });

  test("keeps recording and list responses strict and bounded", () => {
    const recording = {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      mimeType: "audio/webm",
      state: "ready",
      nextChunkNumber: 1,
      chunkCount: 1,
      totalBytes: 3,
      totalDurationMilliseconds: 1_805_000,
      segmentCount: 37,
      completedSegmentCount: 0,
      transcriptText: null,
      languages: [],
      errorCode: null,
      retryable: false,
      objectsCleaned: false,
      createdAt: "2026-08-04T07:00:00.000Z",
      updatedAt: "2026-08-04T07:00:00.000Z",
      expiresAt: "2026-08-05T07:00:00.000Z",
    } as const;
    expect(TranscriptionRecordingResponse.safeParse({ recording, segments: [] }).success).toBe(
      true,
    );
    expect(
      TranscriptionRecordingResponse.safeParse({
        recording,
        segments: [],
        retryAfterMilliseconds: 5_000,
      }).success,
    ).toBe(true);
    expect(
      TranscriptionRecordingResponse.safeParse({
        recording,
        segments: [],
        retryAfterMilliseconds: 60_001,
      }).success,
    ).toBe(false);
    expect(TranscriptionRecordingListResponse.safeParse({ recordings: [recording] }).success).toBe(
      true,
    );
    expect(
      TranscriptionRecordingListResponse.safeParse({
        recordings: [recording],
        provider: "openai",
      }).success,
    ).toBe(false);
    expect(
      TranscriptionRecordingListResponse.safeParse({
        recordings: Array.from({ length: 51 }, () => recording),
      }).success,
    ).toBe(false);
  });

  test("keeps transcription response text-only", () => {
    expect(TranscribeAudioResponse.parse({ text: "hello", languages: ["en"] })).toEqual({
      text: "hello",
      languages: ["en"],
    });
    expect(TranscribeAudioResponse.parse({ text: "hello" })).toEqual({
      text: "hello",
      languages: [],
    });
    expect(
      TranscribeAudioResponse.safeParse({
        text: "hello",
        languages: [],
        provider: "openai",
      }).success,
    ).toBe(false);
  });
});
