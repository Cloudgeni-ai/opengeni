import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type Permission, signDelegatedAccessToken } from "@opengeni/contracts";
import type { TranscriptionService } from "@opengeni/core";
import * as dbModule from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import { createTranscriptionService } from "../src/transcription/service";

const SECRET = "transcription-route-secret";
const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";

function service(available = true): TranscriptionService {
  return {
    limits: () => ({
      maxDurationSeconds: 60,
      maxSizeBytes: 10,
      acceptedMimeTypes: ["audio/webm"],
    }),
    available: () => available,
    transcribe: async () => ({
      text: "transcribed",
      languages: ["en"],
      providerId: "test",
      audioSeconds: 0,
      latencyMs: 1,
    }),
  };
}

function app(transcription: TranscriptionService | null = service()) {
  return createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      voiceInputProviderOrder: "",
    }),
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    transcription,
  });
}

async function bearer(permissions: Permission[] = ["sessions:create"]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    subjectId: "tester",
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

afterEach(() => {
  spyOn(dbModule, "getWorkspace").mockRestore();
});

describe("transcription routes", () => {
  test("does not advertise unscoped subscription capability", async () => {
    expect((await app(service(true)).request("/v1/config/client")).status).toBe(200);
    expect(await (await app(service(true)).request("/v1/config/client")).json()).toMatchObject({
      voiceInput: { available: false },
    });
    expect(await (await app(service(false)).request("/v1/config/client")).json()).toMatchObject({
      voiceInput: { available: false },
    });
  });

  test("requires session-create access", async () => {
    const response = await app().request(`/v1/workspaces/${WORKSPACE}/transcriptions`, {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: new Uint8Array([1]),
    });
    expect(response.status).toBe(401);
  });

  test.each([
    { voiceInput: { enabled: false } },
    {
      transcription: {
        enabled: false,
        acceptanceId: null,
        primary: null,
        language: null,
        autoDetectLanguage: true,
        diarization: { enabled: false, maxSpeakers: null },
        retention: { mode: "none", maxDays: null },
        privacy: { allowProviderLogging: false, allowProviderTraining: false },
        fallback: { mode: "disabled", targets: [] },
        cost: { currency: "USD", maxPerHour: null, maxPerMonth: null },
      },
    },
  ])("blocks disabled workspace policy", async (settings) => {
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings } as never);
    const response = await app().request(`/v1/workspaces/${WORKSPACE}/transcriptions`, {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "audio/webm",
      },
      body: new Uint8Array([1]),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "policy_blocked" });
  });

  test("returns only transcript response fields", async () => {
    spyOn(dbModule, "getWorkspace").mockResolvedValue({
      settings: {},
    } as never);
    const response = await app().request(`/v1/workspaces/${WORKSPACE}/transcriptions`, {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "audio/webm",
      },
      body: new Uint8Array([1, 2]),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "transcribed",
      languages: ["en"],
    });
  });
  test("returns the transcript even when settlement fails, billing only server facts", async () => {
    spyOn(dbModule, "getWorkspace").mockResolvedValue({ settings: {} } as never);
    const settled: unknown[] = [];
    const logged: string[] = [];
    const transcription = createTranscriptionService({
      settings: testSettings({
        billingMode: "stripe",
        voiceInputProviderOrder: "azure-mai",
        voiceInputMaiEndpoint: "https://speech.example.test",
        voiceInputMaiApiKey: "test-key",
        voiceInputMaiPricingJson: JSON.stringify({ microsPerMinute: 6000 }),
      }),
      db: {} as never,
      normalizeAudio: async () => ({ bytes: new Uint8Array([1]), durationSeconds: 4 }),
      settlementRetryDelaysMilliseconds: [],
      log: (message) => logged.push(message),
      fetch: async () => Response.json({ combinedPhrases: [{ text: "dictated paragraph" }] }),
      billing: {
        admit: async () => undefined,
        settle: async (input) => {
          settled.push(input);
          throw new Error("could not serialize access");
        },
      },
    });
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array([1, 2])], { type: "audio/webm" }), "a.webm");
    form.append("mimeType", "audio/webm");
    form.append("durationSeconds", "0.01");
    const response = await app(transcription).request(
      `/v1/workspaces/${WORKSPACE}/transcriptions`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(),
          "x-opengeni-correlation-id": "client-chosen-id",
        },
        body: form,
      },
    );
    const body = await response.json();
    expect({ status: response.status, body }).toEqual({
      status: 200,
      body: { text: "dictated paragraph", languages: [] },
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      usage: null,
      billing: {
        trustedDurationSeconds: 4,
        attribution: { kind: "human", initiatingHumanSubjectId: "tester" },
      },
    });
    const sourceId = (settled[0] as { billing: { sourceId: string } }).billing.sourceId;
    expect(sourceId).not.toContain("client-chosen-id");
    expect(sourceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(logged).toHaveLength(1);
  });
});
