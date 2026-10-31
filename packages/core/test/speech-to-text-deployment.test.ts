import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import {
  asRecordingTranscriptionError,
  asTranscriptionServiceError,
  createSpeechToTextDeployment,
  createTranscriptionService,
  dictationProviders,
  meetingModelFor,
  meetingModelWithoutCreditsFor,
  responseError,
  speechToTextModelFor,
  transcriptText,
  withoutFallback,
} from "../src/transcription-service";
import {
  RecordingTranscriptionError,
  type RecordingTranscriptionProvider,
} from "../src/recording-transcription";
import { TranscriptionServiceError } from "../src/transcription";
import { textModelCapabilities } from "../src/transcription-service/text-models";
import { openAiLanguage } from "../src/transcription-service/providers/openai-realtime";
import { createOpenAiTranscriptionProvider } from "../src/transcription-service/providers/openai";

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
    const signedIn = createSpeechToTextDeployment(
      { settings: testSettings({ ...identity, azureFederatedTokenFile: "/var/token" }) },
      {
        readTokenFile: async () => "assertion",
        fetch: (async (url: string, init?: RequestInit) => {
          if (String(url).includes("/oauth2/")) {
            tokens.push(new URLSearchParams(String(init?.body)).get("client_assertion") ?? "");
            return Response.json({ access_token: "entra", expires_in: 3_600 });
          }
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer entra");
          return Response.json({ durationMilliseconds: 0, phrases: [] });
        }) as unknown as typeof fetch,
      },
    );
    const audio = { bytes: new Uint8Array([1]), mimeType: "audio/wav", fileName: "a.wav" };
    await signedIn.registry
      .get("azure-speech")!
      .transcribe({ audio, model: "MAI-Transcribe-2", diarize: false }, null as never);
    expect(tokens).toEqual(["assertion"]);

    const refused = createSpeechToTextDeployment(
      { settings: testSettings({ ...identity, azureClientSecret: "secret" }) },
      {
        fetch: (async () =>
          Response.json({ error: "invalid_client" }, { status: 401 })) as unknown as typeof fetch,
      },
    );
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
        // Without a database the EU-only setting cannot be read (fail closed);
        // this workspace is not EU-only.
        isEuOnly: async () => false,
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

  test("the live transcript defaults to ElevenLabs, else a pinned provider's own live model, else none", () => {
    expect(createSpeechToTextDeployment({ settings: testSettings({}) }).liveDefault).toEqual({
      providerId: "elevenlabs",
      model: "scribe_v2_realtime",
    });
    expect(
      createSpeechToTextDeployment({
        settings: testSettings({ speechToTextPinned: "elevenlabs/scribe_v2" }),
      }).liveDefault,
    ).toEqual({ providerId: "elevenlabs", model: "scribe_v2_realtime" });
    expect(
      createSpeechToTextDeployment({
        settings: testSettings({ ...azure, speechToTextPinned: "azure-speech/MAI-Transcribe-2" }),
      }).liveDefault,
    ).toBeNull();
    // The named model must stream.
    expect(() =>
      createSpeechToTextDeployment({
        settings: testSettings({ recordingLiveTranscription: "openai/gpt-transcribe" }),
      }),
    ).toThrow(/live transcript/u);
  });

  test("a pinned deployment can stream the live transcript to its Azure OpenAI deployment, signed in with its identity", async () => {
    const minted: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const deployment = createSpeechToTextDeployment(
      {
        settings: testSettings({
          ...azure,
          speechToTextPinned: "azure-speech/MAI-Transcribe-2",
          recordingLiveTranscription: "azure-openai/gpt-4o-transcribe",
          voiceInputProviderOrder: "azure-openai",
          voiceInputAzureEndpoint: "https://ai.example.cognitiveservices.azure.com/",
          voiceInputAzureDeployment: "gpt-4o-transcribe",
          azureTenantId: "tenant",
          azureClientId: "client",
          azureClientSecret: "secret",
        }),
      },
      {
        fetch: (async (url: string, init?: RequestInit) => {
          if (String(url).includes("/oauth2/")) {
            return Response.json({ access_token: "entra", expires_in: 3_600 });
          }
          minted.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
            body: JSON.parse(String(init?.body)),
          });
          return Response.json({ value: "ek_live", expires_at: 1_900_000_000 });
        }) as unknown as typeof fetch,
      },
    );
    expect(deployment.liveDefault).toEqual({
      providerId: "azure-openai",
      model: "gpt-4o-transcribe",
    });
    // Meetings and dictation stay on the pin.
    expect(speechToTextModelFor(deployment, "dictation", null)).toEqual(deployment.pinned);
    expect(
      await deployment.credentials("azure-openai", { accountId: "a", workspaceId: "w" }),
    ).toEqual({ credentials: null });
    const grant = await deployment.registry.get("azure-openai")!.createLiveSession!(
      { model: "gpt-4o-transcribe", language: "nb-NO" },
      null,
    );
    expect(grant).toEqual({
      protocol: "openai.realtime",
      url: "wss://ai.example.cognitiveservices.azure.com/openai/v1/realtime?intent=transcription",
      token: "ek_live",
      webrtcUrl: "https://ai.example.cognitiveservices.azure.com/openai/v1/realtime/calls",
      audio: { encoding: "pcm_s16le", sampleRate: 24_000 },
      expiresAt: new Date(1_900_000_000_000),
    });
    expect(minted).toEqual([
      {
        url: "https://ai.example.cognitiveservices.azure.com/openai/v1/realtime/client_secrets",
        authorization: "Bearer entra",
        body: {
          expires_after: { anchor: "created_at", seconds: 600 },
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24_000 },
                // Bokmål is transcribed as Norwegian.
                transcription: { model: "gpt-4o-transcribe", language: "no" },
                turn_detection: { type: "server_vad", silence_duration_ms: 500 },
              },
            },
          },
        },
      },
    ]);
  });
});

describe("the model a workspace's meetings run", () => {
  const scope = { accountId: "a", workspaceId: "w", subjectId: "u" };
  /** A subscription the given workspaces are signed in to. */
  function subscription(signedIn: readonly string[]): RecordingTranscriptionProvider {
    return {
      ...fakeTextProvider("subscription", "workspace_subscription", async () => {
        throw new Error("not called");
      }),
      available: async (context) => signedIn.includes(context?.workspaceId ?? ""),
    };
  }
  function deploymentWith(input: {
    signedIn?: readonly string[];
    keyed?: readonly string[];
    wordAlignment?: boolean;
    settings?: Parameters<typeof testSettings>[0];
  }) {
    return createSpeechToTextDeployment(
      {
        settings: testSettings({
          voiceInputOpenaiEnabled: false,
          recordingWordAlignment: input.wordAlignment ?? true,
          ...input.settings,
        }),
      },
      {
        providers: [subscription(input.signedIn ?? [])],
        // Without a database the EU-only setting cannot be read (fail closed);
        // these workspaces are not EU-only.
        isEuOnly: async () => false,
        loadWorkspaceKey: async (_provider, { workspaceId }) =>
          (input.keyed ?? []).includes(workspaceId) ? "el" : null,
      },
    );
  }

  test("a workspace with only a subscription transcribes with it", async () => {
    const deployment = deploymentWith({ signedIn: ["w"] });
    expect(await meetingModelFor(deployment, null, scope)).toEqual({
      providerId: "subscription",
      model: "subscription-model",
    });
  });

  test("the deployment's default wins when this workspace can use it", async () => {
    const deployment = deploymentWith({ signedIn: ["w"], keyed: ["w"] });
    expect(await meetingModelFor(deployment, null, scope)).toEqual({
      providerId: "elevenlabs",
      model: "scribe_v2",
    });
  });

  test("with nothing usable it is the default, so the failure names what to connect", async () => {
    const deployment = deploymentWith({});
    expect(await meetingModelFor(deployment, null, scope)).toEqual(deployment.meetingDefault);
  });

  test("a text-only model serves meetings only where the deployment aligns words", async () => {
    const deployment = deploymentWith({ signedIn: ["w"], wordAlignment: false });
    expect(await meetingModelFor(deployment, null, scope)).toEqual(deployment.meetingDefault);
  });

  test("a pin, then a model the workspace names, come before what is usable", async () => {
    const named = { providerId: "elevenlabs", model: "scribe_v2" };
    expect(await meetingModelFor(deploymentWith({ signedIn: ["w"] }), named, scope)).toEqual(named);
    const pinned = deploymentWith({
      signedIn: ["w"],
      settings: { ...azure, speechToTextPinned: "azure-speech/MAI-Transcribe-2" },
    });
    expect(await meetingModelFor(pinned, null, scope)).toEqual(pinned.pinned!);
  });

  test("a refused deployment model gives way to one the payer doesn't pay credits for", async () => {
    // The deployment's own Azure account is the default and charges credits.
    const signedIn = deploymentWith({ signedIn: ["w"], settings: azure });
    expect(signedIn.meetingDefault.providerId).toBe("azure-speech");
    expect(await meetingModelWithoutCreditsFor(signedIn, scope)).toEqual({
      providerId: "subscription",
      model: "subscription-model",
    });
    // The workspace's own key counts too, in the deployment's order.
    expect(
      await meetingModelWithoutCreditsFor(deploymentWith({ keyed: ["w"], settings: azure }), scope),
    ).toEqual({ providerId: "elevenlabs", model: "scribe_v2" });
    // Nothing connected: nothing to switch to, so the refusal stands.
    expect(await meetingModelWithoutCreditsFor(deploymentWith({ settings: azure }), scope)).toBe(
      null,
    );
    // A pinned deployment sends audio to its one model only.
    const pinned = deploymentWith({
      signedIn: ["w"],
      settings: { ...azure, speechToTextPinned: "azure-speech/MAI-Transcribe-2" },
    });
    expect(await meetingModelWithoutCreditsFor(pinned, scope)).toBe(null);
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
    const heard: Array<{ model: string; key: unknown; scope: unknown; language?: string }> = [];
    const settings = testSettings({ voiceInputProviderOrder: "openai", billingMode: "stripe" });
    const deployment = createSpeechToTextDeployment(
      { settings },
      {
        isEuOnly: async () => false,
        providers: [
          fakeTextProvider("elevenlabs", "workspace_key", async (input, credentials) => {
            heard.push({
              model: input.model,
              key: credentials,
              scope: input.scope,
              ...(input.language ? { language: input.language } : {}),
            });
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
    // The language a dictation names reaches the provider.
    await service.transcribe({ ...request, preferredProvider: "elevenlabs", language: "nb" });
    expect(heard.at(-1)?.language).toBe("nb");
  });

  test("the vocabulary reaches a model that takes keyterms, and no other", async () => {
    const heard: Array<readonly string[] | undefined> = [];
    const settings = testSettings({ voiceInputProviderOrder: "openai" });
    const listening = fakeTextProvider("elevenlabs", "workspace_key", async (input) => {
      heard.push(input.keyterms);
      return { languages: [], audioMilliseconds: null, diarized: false, words: [], text: "hi" };
    });
    listening.models[0]!.capabilities = { ...listening.models[0]!.capabilities, keyterms: true };
    const deaf = fakeTextProvider("xai_subscription", "workspace_key", async (input) => {
      heard.push(input.keyterms);
      return { languages: [], audioMilliseconds: null, diarized: false, words: [], text: "hi" };
    });
    const service = createTranscriptionService({
      settings,
      db: {} as never,
      deployment: createSpeechToTextDeployment(
        { settings },
        {
          providers: [listening, deaf],
          loadWorkspaceKey: async () => "workspace-key",
          isEuOnly: async () => false,
        },
      ),
    });
    const keyterms = ["Kubernetes", "Ada Lovelace"];
    await service.transcribe({ ...request, preferredProvider: "elevenlabs", keyterms });
    await service.transcribe({ ...request, preferredProvider: "xai_subscription", keyterms });
    expect(heard).toEqual([keyterms, undefined]);
  });

  test("OpenAI hears the vocabulary as its prompt", async () => {
    const forms: FormData[] = [];
    const provider = createOpenAiTranscriptionProvider({
      apiKey: "key",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-4o-transcribe",
      fetch: (async (_url: string, init: RequestInit) => {
        forms.push(init.body as FormData);
        return Response.json({ text: "Kubernetes" });
      }) as unknown as typeof fetch,
    });
    expect(provider.models[0]!.capabilities.keyterms).toBe(true);
    const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", fileName: "a.wav" };
    await provider.transcribe(
      { audio, model: "gpt-4o-transcribe", diarize: false, keyterms: ["Kubernetes", " Ada "] },
      {},
    );
    await provider.transcribe({ audio, model: "gpt-4o-transcribe", diarize: false }, {});
    expect(forms.map((form) => form.get("prompt"))).toEqual(["Kubernetes, Ada", null]);
  });

  test("an unauthorized provider falls back to the next one before any text", async () => {
    const settings = testSettings({ voiceInputProviderOrder: "openai" });
    const deployment = createSpeechToTextDeployment(
      { settings },
      {
        isEuOnly: async () => false,
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
      deployment: createSpeechToTextDeployment({ settings }, { isEuOnly: async () => false }),
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

describe("a provider out of credit", () => {
  const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", fileName: "a.wav" };
  const request = {
    workspaceId: "workspace",
    accountId: "account",
    subjectId: "subject",
    requestId: "request",
    audio: new Uint8Array([1, 2, 3]),
    mimeType: "audio/webm",
  };
  const failingOpenAi = (status: number, body: unknown) =>
    createOpenAiTranscriptionProvider({
      apiKey: "key",
      baseUrl: "https://api.example.test/v1",
      model: "gpt-4o-transcribe",
      fetch: (async () => Response.json(body, { status })) as unknown as typeof fetch,
    });
  const meetingError = async (provider: RecordingTranscriptionProvider) => {
    try {
      await provider.transcribe({ audio, model: "gpt-4o-transcribe", diarize: false }, {});
    } catch (error) {
      return asRecordingTranscriptionError(error) as RecordingTranscriptionError;
    }
    throw new Error("expected a failure");
  };

  test("a meeting says the OpenAI account is out of credit, not that its key is wrong", async () => {
    const spent = await meetingError(
      failingOpenAi(429, {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
    );
    expect([spent.code, spent.retryable]).toEqual(["quota_exceeded", false]);
    const rejected = await meetingError(
      failingOpenAi(401, {
        error: { message: "Incorrect API key provided.", code: "invalid_api_key" },
      }),
    );
    expect(rejected.code).toBe("unauthorized");
    // A busy provider is neither.
    const busy = await meetingError(
      failingOpenAi(429, {
        error: {
          message: "Rate limit reached for requests. Please try again in 20s.",
          type: "requests",
          code: "rate_limit_exceeded",
        },
      }),
    );
    expect(busy.code).toBe("provider");
  });

  test("the provider's code survives the trip through voice input and back", () => {
    for (const code of ["quota_exceeded", "unauthorized", "rate_limited"] as const) {
      const original = new RecordingTranscriptionError("no", code, code === "rate_limited");
      const voice = asTranscriptionServiceError(original) as TranscriptionServiceError;
      expect([voice.code, voice.fallbackSafe]).toEqual(["unavailable", true]);
      const meeting = asRecordingTranscriptionError(voice) as RecordingTranscriptionError;
      expect([meeting.code, meeting.retryable]).toEqual([code, code === "rate_limited"]);
    }
    // A subscription keeps it too, though nothing falls back from it.
    const pinned = withoutFallback(responseError(402, { error: { code: "insufficient_quota" } }));
    expect(pinned.fallbackSafe).toBe(false);
    expect((asRecordingTranscriptionError(pinned) as RecordingTranscriptionError).code).toBe(
      "quota_exceeded",
    );
  });

  test("a spent provider still lets dictation fall back to the next one", async () => {
    const settings = testSettings({ voiceInputProviderOrder: "openai" });
    const deployment = createSpeechToTextDeployment(
      { settings },
      {
        isEuOnly: async () => false,
        providers: [
          fakeTextProvider("first", "workspace_subscription", async () => {
            throw new RecordingTranscriptionError("no credit", "quota_exceeded", false);
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
            ],
          })),
        ],
      },
    );
    const service = createTranscriptionService({ settings, db: {} as never, deployment });
    const result = await service.transcribe({ ...request, preferredProvider: "first" });
    expect(result).toMatchObject({ text: "Hello", providerId: "second" });
  });
});

describe("transcript text", () => {
  test("OpenAI models hear ISO 639-1 codes, with Bokmål and Nynorsk as Norwegian", () => {
    expect(
      ["nb", "nn", "nob", "nor", "no", "en", "eng", "en-US", "sv_SE", "zzzz", "", undefined].map(
        (tag) => openAiLanguage(tag),
      ),
    ).toEqual([
      "no",
      "no",
      "no",
      "no",
      "no",
      "en",
      "en",
      "en",
      "sv",
      undefined,
      undefined,
      undefined,
    ]);
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
