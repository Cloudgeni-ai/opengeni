import { describe, expect, test } from "bun:test";
import {
  azureSpeechLocale,
  createAzureSpeechRecordingTranscriptionProvider,
  parseAzureSpeechTranscript,
} from "../src/recording-transcription-azure";
import { createRecordingTranscriptionDeployment } from "../src/recording-transcription-deployment";
import {
  mergeRecordingTranscriptionPieces,
  planRecordingTranscriptionPieces,
  RecordingTranscriptionError,
  type RecordingTranscriptionResult,
} from "../src/recording-transcription";

/** The shape Azure Speech's fast transcription returned for a real Norwegian clip. */
const azureResponse = {
  durationMilliseconds: 17_100,
  combinedPhrases: [{ text: "Hei Ola, kan du sende tallene? Ja." }],
  phrases: [
    {
      offsetMilliseconds: 0,
      durationMilliseconds: 8_020,
      text: "Hei Ola, kan du sende tallene?",
      locale: "nb",
      confidence: 0,
      words: [
        { text: "Hei", offsetMilliseconds: 80, durationMilliseconds: 180 },
        { text: "Ola,", offsetMilliseconds: 320, durationMilliseconds: 340 },
        { text: "kan", offsetMilliseconds: 840, durationMilliseconds: 180 },
        { text: "tallene?", offsetMilliseconds: 1_620, durationMilliseconds: 460 },
      ],
    },
    {
      offsetMilliseconds: 8_400,
      durationMilliseconds: 300,
      text: "Ja.",
      locale: "nb",
      words: [{ text: "Ja.", offsetMilliseconds: 8_400, durationMilliseconds: 259 }],
    },
  ],
};

describe("Azure Speech recordings", () => {
  test("turns phrases into timed words with spacing", () => {
    const result = parseAzureSpeechTranscript(azureResponse);
    expect(result.languages).toEqual(["nb"]);
    expect(result.audioMilliseconds).toBe(17_100);
    expect(result.diarized).toBe(false);
    expect(
      result.words.map((word) => [word.text, word.startMilliseconds, word.endMilliseconds]),
    ).toEqual([
      ["Hei", 80, 260],
      ["Ola,", 320, 660],
      ["kan", 840, 1_020],
      ["tallene?", 1_620, 2_080],
      ["Ja.", 8_400, 8_659],
    ]);
    expect(result.words.map((word) => word.spaceBefore)).toEqual([false, true, true, true, true]);
    expect(parseAzureSpeechTranscript({ phrases: [] }).words).toEqual([]);
    expect(() => parseAzureSpeechTranscript(null)).toThrow(RecordingTranscriptionError);
  });

  test("sends Norwegian as Bokmål and keeps other languages to their base", () => {
    expect(azureSpeechLocale("no")).toBe("nb");
    expect(azureSpeechLocale("nor")).toBe("nb");
    expect(azureSpeechLocale("nb-NO")).toBe("nb");
    expect(azureSpeechLocale("nn")).toBe("nn");
    expect(azureSpeechLocale("en-GB")).toBe("en");
    expect(azureSpeechLocale("sv")).toBe("sv");
  });

  test("asks for word timestamps, the language and keyterms with the right credential", async () => {
    const calls: Array<{ url: string; headers: Headers; definition: unknown; file: File }> = [];
    const provider = createAzureSpeechRecordingTranscriptionProvider({
      endpoint: "https://speech.example.cognitiveservices.azure.com/",
      fetch: (async (url: string, init: RequestInit) => {
        const form = init.body as FormData;
        calls.push({
          url,
          headers: new Headers(init.headers),
          definition: JSON.parse(String(form.get("definition"))),
          file: form.get("audio") as File,
        });
        return Response.json(azureResponse);
      }) as typeof fetch,
    });
    const spec = provider.models[0]!;
    expect(spec.capabilities.batch).toBe(true);
    expect(spec.capabilities.diarization).toBe(false);
    expect(spec.audioFormats).toEqual(["flac", "wav", "mp3"]);
    const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/flac", fileName: "t.flac" };
    const result = await provider.transcribe(
      { audio, model: spec.model, language: "no", diarize: true, keyterms: ["Vatra"] },
      { accessToken: "token-1" },
    );
    expect(result.words).toHaveLength(5);
    await provider.transcribe({ audio, model: spec.model, diarize: false }, { apiKey: "key-1" });
    expect(calls[0]!.url).toBe(
      "https://speech.example.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    );
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer token-1");
    expect(calls[0]!.definition).toEqual({
      enhancedMode: {
        enabled: true,
        model: "MAI-Transcribe-2",
        modelOptions: { timestamps: "word" },
      },
      locales: ["nb"],
      phraseList: { phrases: ["Vatra"] },
    });
    expect(calls[0]!.file.name).toBe("t.flac");
    expect(calls[1]!.headers.get("ocp-apim-subscription-key")).toBe("key-1");
    expect(calls[1]!.headers.get("authorization")).toBeNull();
    expect(calls[1]!.definition).toEqual({
      enhancedMode: {
        enabled: true,
        model: "MAI-Transcribe-2",
        modelOptions: { timestamps: "word" },
      },
    });
  });

  test("maps Azure failures to retryable and permanent errors", async () => {
    const failing = (status: number, body: string) =>
      createAzureSpeechRecordingTranscriptionProvider({
        endpoint: "https://speech.example.cognitiveservices.azure.com",
        fetch: (async () => new Response(body, { status })) as unknown as typeof fetch,
      });
    const attempt = async (status: number, body = "") => {
      try {
        await failing(status, body).transcribe(
          {
            audio: { bytes: new Uint8Array([1]), mimeType: "audio/webm", fileName: "a.webm" },
            model: "MAI-Transcribe-2",
            diarize: false,
          },
          { apiKey: "k" },
        );
      } catch (error) {
        return error as RecordingTranscriptionError;
      }
      throw new Error("expected a failure");
    };
    // What the service answers for audio it can't open.
    const invalid = await attempt(
      400,
      'MAI service returned an error: BadRequest - {"error":{"code":"invalid_audio","message":"Format not recognised."}}',
    );
    expect([invalid.code, invalid.retryable, invalid.message]).toEqual([
      "invalid_audio",
      false,
      "Azure Speech could not transcribe this audio (HTTP 400: invalid_audio)",
    ]);
    expect((await attempt(401)).code).toBe("unauthorized");
    expect((await attempt(429)).retryable).toBe(true);
    expect((await attempt(503)).code).toBe("unavailable");
    expect((await attempt(408)).retryable).toBe(true);
    expect((await attempt(400, '{"error":{"code":"AudioLengthLimitExceeded"}}')).code).toBe(
      "too_large",
    );
  });
});

describe("recording transcription deployment", () => {
  test("offers ElevenLabs with workspace keys by default", () => {
    const deployment = createRecordingTranscriptionDeployment({});
    expect([...deployment.registry.keys()]).toEqual(["elevenlabs"]);
    expect(deployment.defaultTranscription).toEqual({
      providerId: "elevenlabs",
      model: "scribe_v2",
    });
    expect(deployment.deploymentManaged("elevenlabs")).toBe(false);
    expect(deployment.deploymentCredentials("elevenlabs")).toBeNull();
  });

  test("adds the deployment's Azure Speech account and makes it the default", async () => {
    const withKey = createRecordingTranscriptionDeployment({
      recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
      recordingAzureSpeechApiKey: "key",
    });
    expect([...withKey.registry.keys()]).toEqual(["elevenlabs", "azure-speech"]);
    expect(withKey.defaultTranscription).toEqual({
      providerId: "azure-speech",
      model: "MAI-Transcribe-2",
    });
    expect(await withKey.deploymentCredentials("azure-speech")).toEqual({ apiKey: "key" });

    const withIdentity = createRecordingTranscriptionDeployment(
      {
        recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
        recordingTranscriptionDefault: "elevenlabs/scribe_v2",
        azureTenantId: "tenant",
        azureClientId: "client",
        azureFederatedTokenFile: "/var/token",
      },
      {
        readTokenFile: async () => "assertion",
        fetch: (async () =>
          Response.json({ access_token: "entra", expires_in: 3_600 })) as unknown as typeof fetch,
      },
    );
    expect(withIdentity.defaultTranscription).toEqual({
      providerId: "elevenlabs",
      model: "scribe_v2",
    });
    expect(withIdentity.deploymentManaged("azure-speech")).toBe(true);
    expect(await withIdentity.deploymentCredentials("azure-speech")).toEqual({
      accessToken: "entra",
    });

    const noCredential = createRecordingTranscriptionDeployment({
      recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
    });
    expect(noCredential.deploymentManaged("azure-speech")).toBe(false);
    expect(noCredential.deploymentCredentials("azure-speech")).toBeNull();
  });

  test("reports a refused identity as a transcription error", async () => {
    const refused = createRecordingTranscriptionDeployment(
      {
        recordingAzureSpeechEndpoint: "https://speech.example.cognitiveservices.azure.com",
        azureTenantId: "tenant",
        azureClientId: "client",
        azureClientSecret: "secret",
      },
      {
        fetch: (async () =>
          Response.json({ error: "invalid_client" }, { status: 401 })) as unknown as typeof fetch,
      },
    );
    const error = (await refused
      .deploymentCredentials("azure-speech")!
      .catch((caught: unknown) => caught)) as RecordingTranscriptionError;
    expect(error).toBeInstanceOf(RecordingTranscriptionError);
    expect([error.code, error.retryable]).toEqual(["unauthorized", false]);
  });
});

describe("pieces of long tracks", () => {
  test("keeps a track that fits whole", () => {
    expect(planRecordingTranscriptionPieces(90_000, 120_000)).toEqual([
      {
        startMilliseconds: 0,
        endMilliseconds: 90_000,
        keepFromMilliseconds: 0,
        keepUntilMilliseconds: Number.POSITIVE_INFINITY,
      },
    ]);
    expect(planRecordingTranscriptionPieces(90_000, null)).toHaveLength(1);
  });

  test("splits a long track into overlapping pieces under the limit", () => {
    const pieces = planRecordingTranscriptionPieces(250_000, 100_000);
    expect(pieces).toEqual([
      {
        startMilliseconds: 0,
        endMilliseconds: 90_000,
        keepFromMilliseconds: 0,
        keepUntilMilliseconds: 80_000,
      },
      {
        startMilliseconds: 70_000,
        endMilliseconds: 170_000,
        keepFromMilliseconds: 80_000,
        keepUntilMilliseconds: 160_000,
      },
      {
        startMilliseconds: 150_000,
        endMilliseconds: 250_000,
        keepFromMilliseconds: 160_000,
        keepUntilMilliseconds: 240_000,
      },
      {
        startMilliseconds: 230_000,
        endMilliseconds: 250_000,
        keepFromMilliseconds: 240_000,
        keepUntilMilliseconds: Number.POSITIVE_INFINITY,
      },
    ]);
    for (const piece of pieces) {
      expect(piece.endMilliseconds - piece.startMilliseconds).toBeLessThanOrEqual(100_000);
    }
  });

  test("takes each word once, from the piece whose window it starts in", () => {
    const pieces = planRecordingTranscriptionPieces(250_000, 100_000);
    // Every piece hears the words in its overlap too.
    const spoken = [10_000, 75_000, 79_900, 80_100, 155_000, 165_000, 245_000];
    const parts = pieces.map((piece) => ({
      piece,
      result: {
        languages: ["nb"],
        audioMilliseconds: piece.endMilliseconds - piece.startMilliseconds,
        diarized: true,
        words: spoken
          .filter((at) => at >= piece.startMilliseconds && at < piece.endMilliseconds)
          .map((at, index) => ({
            text: `w${at}`,
            startMilliseconds: at - piece.startMilliseconds,
            endMilliseconds: at - piece.startMilliseconds + 300,
            speaker: "speaker_0",
            spaceBefore: index > 0,
          })),
      } satisfies RecordingTranscriptionResult,
    }));
    const merged = mergeRecordingTranscriptionPieces(parts);
    expect(merged.words.map((word) => word.startMilliseconds)).toEqual(spoken);
    expect(merged.words.map((word) => word.spaceBefore)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // Speaker ids don't carry between calls.
    expect(merged.words.every((word) => word.speaker === null)).toBe(true);
    expect(merged.diarized).toBe(false);
    expect(merged.audioMilliseconds).toBe(250_000);
    expect(merged.languages).toEqual(["nb"]);
  });
});
