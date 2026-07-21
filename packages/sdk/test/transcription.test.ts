import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY,
  authorizeTranscriptionAdapter,
  createTranscriptionSessionRequest,
  resolveWorkspaceTranscriptionPolicy,
  type TranscriptionAdapter,
  type WorkspaceTranscriptionPolicy,
} from "../src/transcription";

const acceptedPolicy: WorkspaceTranscriptionPolicy = {
  enabled: true,
  acceptanceId: "11111111-1111-4111-8111-111111111111",
  primary: {
    provider: "fixture-speech",
    model: "fixture-v1",
    credentialMode: "byok",
    credentialConnectionId: "22222222-2222-4222-8222-222222222222",
    region: "eu-test-1",
  },
  language: "en-US",
  retention: { mode: "none", maxDays: null },
  privacy: { allowProviderLogging: false, allowProviderTraining: false },
  fallback: {
    mode: "explicit",
    targets: [
      {
        provider: "fixture-fallback",
        model: null,
        credentialMode: "managed",
        credentialConnectionId: null,
        region: null,
      },
    ],
  },
  cost: { currency: "USD", maxPerHour: 1, maxPerMonth: 10 },
};

const primaryAdapter: TranscriptionAdapter = {
  descriptor: {
    provider: "fixture-speech",
    model: "fixture-v1",
    credentialMode: "byok",
    region: "eu-test-1",
  },
  start: async (request) => ({
    localSessionId: request.localSessionId,
    cancel: async () => {},
    close: async () => {},
  }),
};

describe("provider-agnostic transcription policy", () => {
  test("defaults off and rejects malformed or incomplete policy bags", () => {
    expect(resolveWorkspaceTranscriptionPolicy({})).toEqual(DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY);
    expect(
      resolveWorkspaceTranscriptionPolicy({
        transcription: { ...acceptedPolicy, acceptanceId: null },
      }),
    ).toEqual(DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY);
    expect(
      resolveWorkspaceTranscriptionPolicy({
        transcription: {
          ...acceptedPolicy,
          primary: { ...acceptedPolicy.primary, credentialConnectionId: "secret-not-a-reference" },
        },
      }),
    ).toEqual(DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY);
    expect(
      resolveWorkspaceTranscriptionPolicy({
        transcription: {
          ...acceptedPolicy,
          primary: {
            ...acceptedPolicy.primary,
            provider: " azure-speech ",
            credentialMode: "managed",
            credentialConnectionId: null,
          },
        },
      }),
    ).toEqual(DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY);
    expect(
      resolveWorkspaceTranscriptionPolicy({
        transcription: {
          ...acceptedPolicy,
          fallback: { mode: "explicit", targets: [acceptedPolicy.primary!] },
        },
      }),
    ).toEqual(DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY);
    expect(
      resolveWorkspaceTranscriptionPolicy({
        transcription: {
          ...acceptedPolicy,
          privacy: { ...acceptedPolicy.privacy, unexpectedAuthorization: true },
        },
      }),
    ).toEqual(DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY);
  });

  test("authorizes only an exact accepted target and never inherits turn model policy", () => {
    expect(authorizeTranscriptionAdapter(acceptedPolicy, primaryAdapter.descriptor)).toMatchObject({
      authorized: true,
      acceptanceId: acceptedPolicy.acceptanceId,
    });
    expect(
      authorizeTranscriptionAdapter(acceptedPolicy, {
        ...primaryAdapter.descriptor,
        provider: "coding-model-provider",
      }),
    ).toEqual({ authorized: false, reason: "provider_mismatch" });
    expect(
      authorizeTranscriptionAdapter(acceptedPolicy, {
        ...primaryAdapter.descriptor,
        region: "silent-fallback-region",
      }),
    ).toEqual({ authorized: false, reason: "region_mismatch" });
    expect(
      authorizeTranscriptionAdapter(
        { ...acceptedPolicy, acceptanceId: "not-an-accepted-policy-id" },
        primaryAdapter.descriptor,
      ),
    ).toEqual({ authorized: false, reason: "unaccepted" });
  });

  test("requires explicit fallback selection and binds requests to privacy and cost policy", () => {
    const fallback = authorizeTranscriptionAdapter(
      acceptedPolicy,
      {
        provider: "fixture-fallback",
        model: null,
        credentialMode: "managed",
        region: null,
      },
      { kind: "fallback", index: 0 },
    );
    expect(fallback).toMatchObject({ authorized: true, selection: { kind: "fallback", index: 0 } });

    const request = createTranscriptionSessionRequest({
      policy: acceptedPolicy,
      adapter: primaryAdapter,
      localSessionId: "local-session-1",
      sequenceFloor: 9,
    });
    expect(request).toEqual({
      localSessionId: "local-session-1",
      policyAcceptanceId: acceptedPolicy.acceptanceId!,
      selection: { kind: "primary" },
      target: acceptedPolicy.primary!,
      language: "en-US",
      retention: acceptedPolicy.retention,
      privacy: acceptedPolicy.privacy,
      cost: acceptedPolicy.cost,
      sequenceFloor: 9,
    });
    expect(
      createTranscriptionSessionRequest({
        policy: acceptedPolicy,
        adapter: primaryAdapter,
        localSessionId: "local-session-1",
        sequenceFloor: -1,
      }),
    ).toBeNull();
  });
});
