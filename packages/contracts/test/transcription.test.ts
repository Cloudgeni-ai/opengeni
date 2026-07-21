import { describe, expect, test } from "bun:test";
import {
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
