import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  createSpeechToTextDeployment,
  createTranscriptionService,
  dictationProviders,
  speechToTextModelFor,
  transcriptText,
} from "../src/transcription-service";
import {
  planRecordingTextSpans,
  recordingWordsFromText,
  RecordingTranscriptionError,
  type RecordingTranscriptionProvider,
} from "../src/recording-transcription";
import { textModelCapabilities } from "../src/transcription-service/text-models";

const azure = {
  recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
  recordingAzureSpeechApiKey: "key",
};

/** A stand-in provider whose one text model records what it heard. */
function fakeTextProvider(
  id: string,
  funding: RecordingTranscriptionProvider["funding"],
  transcribe: RecordingTranscriptionProvider["transcribe"],
): RecordingTranscriptionProvider {
  return {
    id,
    name: id,
    funding,
    models: [
      {
        model: `${id}-model`,
        name: `${id}-model`,
        capabilities: textModelCapabilities({ maxDurationSeconds: 600, maxFileBytes: null }),
        usdPerHour: 0,
      },
    ],
    transcribe,
  };
}

describe("speech-to-text deployment", () => {
  test("offers every provider for every use, in the voice input order", () => {
    const deployment = createSpeechToTextDeployment({ settings: testSettings({}) });
    expect(deployment.order).toEqual(["openai", "elevenlabs"]);
    expect(deployment.registry.get("openai")?.funding).toBe("deployment");
    expect(deployment.registry.get("elevenlabs")?.funding).toBe("workspace_key");
    expect(deployment.meetingDefault).toEqual({ providerId: "elevenlabs", model: "scribe_v2" });
    expect(deployment.pinned).toBeNull();
    // Scribe serves dictation too, after the deployment's own providers.
    expect(dictationProviders(deployment).map((provider) => provider.model.model)).toEqual([
      "gpt-transcribe",
      "scribe_v2",
    ]);
  });

  test("the deployment's Azure Speech account becomes the meeting default and one provider with voice input MAI", async () => {
    const deployment = createSpeechToTextDeployment({
      settings: testSettings({
        ...azure,
        voiceInputProviderOrder: "azure-mai,openai",
        voiceInputMaiEndpoint: "https://voice.example.test",
        voiceInputMaiApiKey: "voice-key",
        voiceInputMaiPricingJson: JSON.stringify({ microsPerMinute: 6000, marginBps: 0 }),
      }),
    });
    expect(deployment.order).toEqual(["azure-speech", "openai", "elevenlabs"]);
    expect(deployment.meetingDefault).toEqual({
      providerId: "azure-speech",
      model: "MAI-Transcribe-2",
    });
    const spec = deployment.registry.get("azure-speech")!.models[0]!;
    expect(spec.creditPricing).toEqual({ microsPerMinute: 6000, marginBps: 0 });
    expect(
      await deployment.credentials("azure-speech", { accountId: "a", workspaceId: "w" }),
    ).toEqual({ credentials: null });
    expect(await deployment.available("azure-speech")).toBe(true);
  });

  test("the Azure Speech account signs in with the deployment's Entra identity and reports a refusal", async () => {
    const identity = {
      recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
      azureTenantId: "tenant",
      azureClientId: "client",
    };
    const tokens: string[] = [];
    const signedIn = createSpeechToTextDeployment({
      settings: testSettings({ ...identity, azureFederatedTokenFile: "/var/token" }),
      readTokenFile: async () => "assertion",
      fetch: (async (url: string, init?: RequestInit) => {
        if (String(url).includes("/oauth2/")) {
          tokens.push(new URLSearchParams(String(init?.body)).get("client_assertion") ?? "");
          return Response.json({ access_token: "entra", expires_in: 3_600 });
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer entra");
        return Response.json({ durationMilliseconds: 0, phrases: [] });
      }) as unknown as typeof fetch,
    });
    const audio = { bytes: new Uint8Array([1]), mimeType: "audio/wav", fileName: "a.wav" };
    await signedIn.registry
      .get("azure-speech")!
      .transcribe({ audio, model: "MAI-Transcribe-2", diarize: false }, null as never);
    expect(tokens).toEqual(["assertion"]);

    const refused = createSpeechToTextDeployment({
      settings: testSettings({ ...identity, azureClientSecret: "secret" }),
      fetch: (async () =>
        Response.json({ error: "invalid_client" }, { status: 401 })) as unknown as typeof fetch,
    });
    const error = (await refused.registry
      .get("azure-speech")!
      .transcribe({ audio, model: "MAI-Transcribe-2", diarize: false }, null as never)
      .catch((caught: unknown) => caught)) as RecordingTranscriptionError;
    expect(error).toBeInstanceOf(RecordingTranscriptionError);
    expect([error.code, error.retryable]).toEqual(["unauthorized", false]);
  });

  test("the order can name the recording providers, which keep their place", () => {
    const named = createSpeechToTextDeployment({
      settings: testSettings({
        ...azure,
        voiceInputProviderOrder: "elevenlabs,openai,azure-speech",
      }),
    });
    expect(named.order).toEqual(["elevenlabs", "openai", "azure-speech"]);
    const reversed = createSpeechToTextDeployment({
      settings: testSettings({ ...azure, voiceInputProviderOrder: "azure-speech,elevenlabs" }),
    });
    expect(reversed.order).toEqual(["azure-speech", "elevenlabs"]);
    const unnamed = createSpeechToTextDeployment({
      settings: testSettings({ ...azure, voiceInputProviderOrder: "openai" }),
    });
    expect(unnamed.order).toEqual(["openai", "azure-speech", "elevenlabs"]);
  });

  test("workspace key providers resolve the workspace's key, or are missing", async () => {
    const deployment = createSpeechToTextDeployment(
      { settings: testSettings({}) },
      {
        loadWorkspaceKey: async (_provider, scope) => (scope.workspaceId === "keyed" ? "el" : null),
      },
    );
    expect(
      await deployment.credentials("elevenlabs", { accountId: "a", workspaceId: "keyed" }),
    ).toEqual({ credentials: { apiKey: "el" } });
    expect(
      await deployment.credentials("elevenlabs", { accountId: "a", workspaceId: "other" }),
    ).toBe("missing");
    expect(await deployment.available("elevenlabs", { accountId: "a", workspaceId: "keyed" })).toBe(
      true,
    );
    expect(await deployment.available("elevenlabs", { accountId: "a", workspaceId: "other" })).toBe(
      false,
    );
    expect(await deployment.available("nope")).toBe(false);
  });

  test("a pin is the only model for every use, and must be offered", () => {
    const deployment = createSpeechToTextDeployment({
      settings: testSettings({ ...azure, speechToTextPinned: "azure-speech/MAI-Transcribe-2" }),
    });
    const pin = { providerId: "azure-speech", model: "MAI-Transcribe-2" };
    expect(deployment.pinned).toEqual(pin);
    expect(deployment.meetingDefault).toEqual(pin);
    expect(
      speechToTextModelFor(deployment, "meeting", { providerId: "elevenlabs", model: "scribe_v2" }),
    ).toEqual(pin);
    expect(speechToTextModelFor(deployment, "dictation", null)).toEqual(pin);
    expect(() =>
      createSpeechToTextDeployment({
        settings: testSettings({ speechToTextPinned: "azure-speech/MAI-Transcribe-2" }),
      }),
    ).toThrow(/does not offer/u);
  });
});

describe("dictation over the shared providers", () => {
  const request = {
    workspaceId: "workspace",
    accountId: "account",
    subjectId: "subject",
    requestId: "request",
    audio: new Uint8Array([1, 2, 3]),
    mimeType: "audio/webm",
  };

  test("a key provider hears dictation with the workspace's key and is never charged", async () => {
    const heard: Array<{ model: string; key: unknown; scope: unknown }> = [];
    const settings = testSettings({ voiceInputProviderOrder: "openai", billingMode: "stripe" });
    const deployment = createSpeechToTextDeployment(
      { settings },
      {
        providers: [
          fakeTextProvider("elevenlabs", "workspace_key", async (input, credentials) => {
            heard.push({ model: input.model, key: credentials, scope: input.scope });
            return {
              languages: ["en"],
              audioMilliseconds: null,
              diarized: false,
              words: [],
              text: "hi",
            };
          }),
        ],
        loadWorkspaceKey: async () => "workspace-key",
      },
    );
    const service = createTranscriptionService({
      settings,
      db: {} as never,
      deployment,
      billing: {
        admit: async () => {
          throw new Error("never admitted");
        },
        settle: async () => {
          throw new Error("never settled");
        },
      },
    });
    const result = await service.transcribe({ ...request, preferredProvider: "elevenlabs" });
    expect(result).toMatchObject({ text: "hi", providerId: "elevenlabs", creditCostMicros: 0 });
    expect(heard).toEqual([
      {
        model: "elevenlabs-model",
        key: { apiKey: "workspace-key" },
        scope: {
          accountId: "account",
          workspaceId: "workspace",
          subjectId: "subject",
          requestId: "request",
        },
      },
    ]);
  });

  test("an unauthorized provider falls back to the next one before any text", async () => {
    const settings = testSettings({ voiceInputProviderOrder: "openai" });
    const deployment = createSpeechToTextDeployment(
      { settings },
      {
        providers: [
          fakeTextProvider("first", "workspace_subscription", async () => {
            throw new RecordingTranscriptionError("signed out", "unauthorized", false);
          }),
          fakeTextProvider("second", "workspace_subscription", async () => ({
            languages: [],
            audioMilliseconds: null,
            diarized: false,
            words: [
              {
                text: "Hello",
                startMilliseconds: 0,
                endMilliseconds: 1,
                speaker: null,
                spaceBefore: false,
              },
              {
                text: ",",
                startMilliseconds: 1,
                endMilliseconds: 2,
                speaker: null,
                spaceBefore: false,
              },
              {
                text: "there",
                startMilliseconds: 2,
                endMilliseconds: 3,
                speaker: null,
                spaceBefore: true,
              },
            ],
          })),
        ],
      },
    );
    const service = createTranscriptionService({ settings, db: {} as never, deployment });
    const result = await service.transcribe({ ...request, preferredProvider: "first" });
    expect(result).toMatchObject({ text: "Hello, there", providerId: "second" });
  });

  test("a pinned deployment never sends dictation elsewhere", async () => {
    const settings = testSettings({
      ...azure,
      speechToTextPinned: "azure-speech/MAI-Transcribe-2",
    });
    const service = createTranscriptionService({
      settings,
      db: {} as never,
      deployment: createSpeechToTextDeployment({ settings }),
    });
    expect(await service.availableProviderIds?.({ workspaceId: "w" })).toEqual(["azure-speech"]);
    expect(await service.selectProvider?.({ workspaceId: "w", preferredProvider: "openai" })).toBe(
      "azure-speech",
    );
    await expect(service.transcribe({ ...request, providerId: "openai" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("text spans for models without timings", () => {
  test("without turns, a track is cut into equal spans the model can take", () => {
    expect(planRecordingTextSpans(25_000, null, 10_000)).toEqual([
      { startMilliseconds: 0, endMilliseconds: 8_333, speaker: null },
      { startMilliseconds: 8_333, endMilliseconds: 16_667, speaker: null },
      { startMilliseconds: 16_667, endMilliseconds: 25_000, speaker: null },
    ]);
    expect(planRecordingTextSpans(0, null, null)).toEqual([]);
  });

  test("turns become one span per speaker, joined, padded and never overlapping", () => {
    const spans = planRecordingTextSpans(
      60_000,
      [
        { startMilliseconds: 1_000, endMilliseconds: 5_000, speaker: "A" },
        { startMilliseconds: 5_800, endMilliseconds: 9_000, speaker: "A" },
        { startMilliseconds: 9_500, endMilliseconds: 9_900, speaker: "B" },
        { startMilliseconds: 20_000, endMilliseconds: 30_000, speaker: "B" },
        { startMilliseconds: 29_000, endMilliseconds: 31_000, speaker: "A" },
        { startMilliseconds: 40_000, endMilliseconds: 40_500, speaker: "A" },
      ],
      null,
    );
    expect(spans).toEqual([
      // A's two turns join; B's short reply folds into A's span.
      { startMilliseconds: 750, endMilliseconds: 10_150, speaker: "A" },
      // Overlapping speech is heard once, in the span already playing.
      { startMilliseconds: 19_750, endMilliseconds: 31_250, speaker: "B" },
      // A short turn far from any other is still heard.
      { startMilliseconds: 39_750, endMilliseconds: 40_750, speaker: "A" },
    ]);
    // Close turns of different speakers split the gap between them.
    expect(
      planRecordingTextSpans(
        2_000,
        [
          { startMilliseconds: 0, endMilliseconds: 900, speaker: "A" },
          { startMilliseconds: 1_000, endMilliseconds: 2_000, speaker: "B" },
        ],
        null,
      ),
    ).toEqual([
      { startMilliseconds: 0, endMilliseconds: 950, speaker: "A" },
      { startMilliseconds: 950, endMilliseconds: 2_000, speaker: "B" },
    ]);
  });

  test("a span's text becomes words spread over it", () => {
    const words = recordingWordsFromText("Hei  Ola, ja", {
      startMilliseconds: 1_000,
      endMilliseconds: 2_000,
      speaker: "A",
    });
    expect(words.map((word) => [word.text, word.startMilliseconds, word.endMilliseconds])).toEqual([
      ["Hei", 1_000, 1_333],
      ["Ola,", 1_333, 1_750],
      ["ja", 1_750, 2_000],
    ]);
    expect(words.every((word) => word.speaker === "A")).toBe(true);
    expect(
      recordingWordsFromText("  ", { startMilliseconds: 0, endMilliseconds: 1, speaker: null }),
    ).toEqual([]);
  });

  test("a result's text is the model's own, else its words joined", () => {
    expect(
      transcriptText({
        languages: [],
        audioMilliseconds: null,
        diarized: false,
        words: [],
        text: "x",
      }),
    ).toBe("x");
  });
});
