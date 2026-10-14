import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { testSettings } from "@opengeni/testing";
import {
  calculateVoiceInputCost,
  defaultVoiceInputPricing,
  getSettings,
  parseVoiceInputPricingJson,
  resolveVoiceInputProviderRegistry,
  unpricedVoiceInputProviders,
  voiceInputPricingIssues,
  type VoiceInputUsage,
} from "@opengeni/config";
import {
  createVoiceInputBilling,
  TranscriptionBillingRefusedError,
  TranscriptionServiceError,
  voiceInputBillableUsage,
  type TranscriptionBilling,
} from "@opengeni/core";
import { createFfmpegAudioNormalizer } from "../src/transcription/normalize";
import { createTranscriptionService } from "../src/transcription/service";
import { createMaiTranscriptionProvider } from "../src/transcription/providers/azure-mai";
import { parseTranscriptionResponseBody } from "../src/transcription/providers/openai";

const pricing = { microsPerMinute: 6000, marginBps: 500 };
const request = {
  workspaceId: "workspace",
  accountId: "account",
  subjectId: "subject",
  requestId: "request",
  audio: new Uint8Array([1, 2, 3]),
  mimeType: "audio/webm",
  durationSeconds: 1,
  billing: {
    sourceId: "unit",
    attribution: { kind: "service" as const },
  },
};
const settings = testSettings({
  billingMode: "stripe",
  voiceInputProviderOrder: "azure-mai,azure-openai",
  voiceInputMaiEndpoint: "https://speech.example.test",
  voiceInputMaiApiKey: "test-key",
  voiceInputMaiPricingJson: JSON.stringify(pricing),
  voiceInputAzureEndpoint: "https://models.example.test",
  voiceInputAzureDeployment: "gpt-transcribe",
  voiceInputAzureApiKey: "test-key",
});
/** Server-normalized WAV stand-in: 3 s measured by the server. */
const NORMALIZED = new Uint8Array([82, 73, 70, 70]);
const normalizeAudio = async () => ({ bytes: NORMALIZED, durationSeconds: 3 });
const settleWith = (
  settle: TranscriptionBilling["settle"],
  admit: TranscriptionBilling["admit"] = async () => {},
): TranscriptionBilling => ({ admit, settle });
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;

test("MAI uses Speech multipart and the provider's measured duration", async () => {
  let sent: Request | undefined;
  const provider = createMaiTranscriptionProvider({
    endpoint: "https://speech.example.test/",
    apiKey: "key",
    apiVersion: "2025-10-15",
    model: "MAI-Transcribe-2",
    ffmpegPath: "ffmpeg",
    fetch: async (url, init) => {
      sent = new Request(url, init);
      return Response.json({
        durationMilliseconds: 5123,
        combinedPhrases: [{ text: "hello" }],
        phrases: [{ locale: "en" }],
      });
    },
  });
  const result = await provider.transcribe({
    ...request,
    mimeType: "audio/wav",
    filename: "audio.wav",
  });
  expect(result).toEqual({
    text: "hello",
    languages: ["en"],
    usage: { kind: "duration", seconds: 5.123 },
  });
  expect(sent!.url).toBe(
    "https://speech.example.test/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
  );
  const form = await sent!.formData();
  expect(JSON.parse(String(form.get("definition")))).toEqual({
    enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
  });
  expect(form.get("audio")).toBeInstanceOf(File);
});

test("GPT parses language objects and duration usage", () => {
  expect(
    parseTranscriptionResponseBody({
      text: "hello",
      languages: [{ code: "en" }],
      usage: { type: "duration", seconds: 5 },
    }),
  ).toEqual({ text: "hello", languages: ["en"], usage: { kind: "duration", seconds: 5 } });
});

test("funding refusal sends no audio and never tries another paid provider", async () => {
  let sends = 0;
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    normalizeAudio,
    fetch: async () => {
      sends++;
      return Response.json({});
    },
    billing: settleWith(
      async () => {
        throw Error("unexpected settlement");
      },
      async () => {
        throw new TranscriptionBillingRefusedError({
          code: "insufficient_credits",
          message: "Add credits",
        });
      },
    ),
  });
  await expect(service.transcribe(request)).rejects.toMatchObject({
    code: "insufficient_credits",
    status: 402,
  });
  expect(sends).toBe(0);
});

test("one-shot sends the server-normalized audio and bills its measured duration, never the caller's", async () => {
  let settled: Parameters<TranscriptionBilling["settle"]>[0] | undefined;
  const sent: { url: string; audio: unknown }[] = [];
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    normalizeAudio,
    fetch: async (url, init) => {
      const form = init?.body as FormData;
      sent.push({ url: String(url), audio: form.get("audio") });
      return Response.json({ durationMilliseconds: 5000, combinedPhrases: [{ text: "hello" }] });
    },
    billing: settleWith(async (input) => {
      settled = input;
      return { creditCostMicros: 525 };
    }),
  });
  const result = await service.transcribe({ ...request, durationSeconds: 0.1 });
  expect(result.text).toBe("hello");
  expect(result.creditCostMicros).toBe(525);
  expect(result.audioSeconds).toBe(3);
  expect(settled).toMatchObject({
    providerId: "azure-mai",
    usage: { kind: "duration", seconds: 5 },
    billing: { sourceId: "unit", trustedDurationSeconds: 3 },
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toContain("speech.example.test");
  expect((sent[0]!.audio as File).type).toBe("audio/wav");
  expect(new Uint8Array(await (sent[0]!.audio as File).arrayBuffer())).toEqual(NORMALIZED);
});

test("token usage on a per-minute-only price bills the server-measured duration", async () => {
  let billed: ReturnType<typeof voiceInputBillableUsage> | undefined;
  const service = createTranscriptionService({
    settings: { ...settings, voiceInputProviderOrder: "azure-openai" },
    db: {} as never,
    normalizeAudio,
    fetch: async () =>
      Response.json({
        text: "gpt words",
        usage: {
          type: "tokens",
          input_tokens: 120,
          output_tokens: 8,
          input_token_details: { audio_tokens: 120, text_tokens: 0 },
        },
      }),
    billing: settleWith(async (input) => {
      billed = voiceInputBillableUsage({
        pricing: input.pricing,
        usage: input.usage,
        trustedDurationSeconds: input.billing.trustedDurationSeconds,
      });
      return { creditCostMicros: 1 };
    }),
  });
  const result = await service.transcribe(request);
  expect(result.text).toBe("gpt words");
  expect(billed).toEqual({ usage: { kind: "duration", seconds: 3 }, basis: "server_duration" });
});

test("a refused oversized upload never reaches the provider or billing", async () => {
  let sends = 0;
  let settles = 0;
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    normalizeAudio: async () => {
      throw new TranscriptionServiceError({ code: "too_large", message: "Audio is too long." });
    },
    fetch: async () => {
      sends++;
      return Response.json({});
    },
    billing: settleWith(async () => {
      settles++;
      return { creditCostMicros: 1 };
    }),
  });
  await expect(service.transcribe(request)).rejects.toMatchObject({ code: "too_large" });
  expect(sends).toBe(0);
  expect(settles).toBe(0);
});

test("a settlement failure after provider success still returns the transcript, logs the keys, and retries the same unit", async () => {
  const logs: { message: string; attributes: Record<string, unknown> }[] = [];
  const attempts: Parameters<TranscriptionBilling["settle"]>[0][] = [];
  let settledOnRetry!: () => void;
  const retried = new Promise<void>((resolve) => {
    settledOnRetry = resolve;
  });
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    normalizeAudio,
    settlementRetryDelaysMilliseconds: [0, 0],
    log: (message, attributes) => {
      logs.push({ message, attributes });
      if (message.includes("settled on retry")) settledOnRetry();
    },
    fetch: async () =>
      Response.json({ durationMilliseconds: 5000, combinedPhrases: [{ text: "keep me" }] }),
    billing: settleWith(async (input) => {
      attempts.push(input);
      if (attempts.length < 3) throw new Error("connection terminated unexpectedly");
      return { creditCostMicros: 525 };
    }),
  });
  const result = await service.transcribe(request);
  expect(result.text).toBe("keep me");
  expect(result.creditCostMicros).toBe(0);
  await retried;
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts.map((attempt) => attempt.billing.sourceId))).toEqual(new Set(["unit"]));
  expect(logs[0]).toMatchObject({
    attributes: {
      sourceId: "unit",
      usageIdempotencyKey: "voice.transcription_cost:unit",
      debitIdempotencyKey: "credit:voice_transcription_debit:voice_input:workspace:unit",
      willRetry: true,
    },
  });
});

test("an unbillable usage shape still returns the transcript and is logged once, without retry", async () => {
  const logs: string[] = [];
  let settles = 0;
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    normalizeAudio,
    settlementRetryDelaysMilliseconds: [0],
    log: (message) => logs.push(message),
    fetch: async () =>
      Response.json({ durationMilliseconds: 5000, combinedPhrases: [{ text: "still yours" }] }),
    billing: settleWith(async () => {
      settles++;
      throw new TranscriptionServiceError({ code: "provider", message: "usage was not reported" });
    }),
  });
  const result = await service.transcribe(request);
  expect(result.text).toBe("still yours");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settles).toBe(1);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("UNSETTLED");
});

test("missing usage never charges a duration ceiling", () => {
  expect(() => voiceInputBillableUsage({ pricing, usage: null })).toThrow("usage was not reported");
  expect(
    voiceInputBillableUsage({
      pricing,
      usage: { kind: "duration", seconds: 5 },
    }).basis,
  ).toBe("provider_duration");
  expect(calculateVoiceInputCost(pricing, { kind: "duration", seconds: 5 })).toEqual({
    providerCostMicros: 500,
    creditCostMicros: 525,
  });
});

test("built-in GPT-4o transcribe prices name the audio token rate explicitly", () => {
  // developers.openai.com/api/docs/models/*: audio tokens, per 1M.
  expect(defaultVoiceInputPricing["gpt-4o-transcribe"]).toMatchObject({
    audioInputMicrosPerMillionTokens: 2_500_000,
    outputMicrosPerMillionTokens: 10_000_000,
  });
  expect(defaultVoiceInputPricing["gpt-4o-mini-transcribe"]).toMatchObject({
    audioInputMicrosPerMillionTokens: 1_250_000,
    outputMicrosPerMillionTokens: 5_000_000,
  });
  const usage: VoiceInputUsage = {
    kind: "tokens",
    inputTokens: 1_000,
    audioInputTokens: 1_000,
    textInputTokens: 0,
    outputTokens: 100,
  };
  expect(calculateVoiceInputCost(defaultVoiceInputPricing["gpt-4o-transcribe"]!, usage)).toEqual({
    providerCostMicros: 3_500,
    creditCostMicros: 3_675,
  });
});

test("unpriced or malformed deployment pricing withholds only that provider and never fails boot", () => {
  expect(
    resolveVoiceInputProviderRegistry({ ...settings, voiceInputMaiPricingJson: undefined }).map(
      (p) => p.id,
    ),
  ).toEqual(["azure-openai"]);
  expect(unpricedVoiceInputProviders({ ...settings, voiceInputMaiPricingJson: undefined })).toEqual(
    ["azure-mai"],
  );
  const malformed = { ...settings, voiceInputMaiPricingJson: '{"microsPerMinute":-1}' };
  expect(resolveVoiceInputProviderRegistry(malformed).map((p) => p.id)).toEqual(["azure-openai"]);
  expect(voiceInputPricingIssues(malformed)).toEqual([
    expect.objectContaining({
      providerId: "azure-mai",
      env: "OPENGENI_VOICE_INPUT_MAI_PRICING_JSON",
      reason: "malformed",
    }),
  ]);
  expect(() => parseVoiceInputPricingJson('{"microsPerMinute":-1}')).toThrow();
  // Shared by API and workers: a voice-only typo must not crash-loop either.
  expect(() =>
    getSettings({
      ...process.env,
      OPENGENI_VOICE_INPUT_MAI_PRICING_JSON: "{not json",
      OPENGENI_VOICE_INPUT_OPENAI_PRICING_JSON: '{"microsPerMinute":0}',
    }),
  ).not.toThrow();
});

test("readiness is scoped to the workspace's available subscription", async () => {
  const service = createTranscriptionService({
    settings: testSettings({
      voiceInputProviderOrder: "codex-subscription",
      codexSubscriptionEnabled: true,
    }),
    db: {} as never,
    probeCodex: (context) => context?.workspaceId === "connected",
  });
  expect(await service.available({ workspaceId: "new" })).toBe(false);
  expect(await service.availableProviderIds?.({ workspaceId: "new" })).toEqual([]);
  expect(await service.available({ workspaceId: "connected" })).toBe(true);
});

test("readiness honours preference and fallback; a throwing probe never fails the caller", async () => {
  const service = createTranscriptionService({
    settings: {
      ...settings,
      voiceInputProviderOrder: "codex-subscription,azure-mai",
      codexSubscriptionEnabled: true,
    },
    db: {} as never,
    probeCodex: () => {
      throw new Error("probe database unavailable");
    },
  });
  const pinned = {
    workspaceId: "w",
    subjectId: "s",
    preferredProvider: "codex-subscription",
    fallbackEnabled: false,
  };
  expect(await service.availableProviderIds?.(pinned)).toEqual(["azure-mai"]);
  expect(await service.available(pinned)).toBe(false);
  expect(await service.available({ ...pinned, fallbackEnabled: true })).toBe(true);
});

test("an unverifiable payer is a policy refusal, not a microphone error", async () => {
  const billing = createVoiceInputBilling({ db: {} as never, settings });
  const refusal = billing.admit({
    accountId: "a",
    workspaceId: "w",
    attribution: { kind: "unknown" },
  });
  await expect(refusal).rejects.toMatchObject({ code: "policy_blocked", status: 403 });
});

test("resumable settlement runs only when the route asks, after the transcript is durable, and never rejects", async () => {
  let settles = 0;
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    settlementRetryDelaysMilliseconds: [],
    log: () => undefined,
    fetch: async () =>
      Response.json({ durationMilliseconds: 5000, combinedPhrases: [{ text: "hello" }] }),
    billing: settleWith(async () => {
      settles++;
      throw new Error("debit failed");
    }),
  });
  const result = await service.transcribe({
    ...request,
    mimeType: "audio/wav",
    billing: { ...request.billing, trustedDurationSeconds: 5 },
    providerId: "azure-mai",
    deferBillingSettlement: true,
  });
  expect(result.text).toBe("hello");
  expect(settles).toBe(0);
  await expect(result.settleBilling!()).resolves.toBeUndefined();
  expect(settles).toBe(1);
});

test.skipIf(!ffmpegAvailable)(
  "ffmpeg normalizer measures duration and refuses audio past the limit",
  async () => {
    const tone = (seconds: number) =>
      new Uint8Array(
        spawnSync(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=440:duration=${seconds}`,
            "-c:a",
            "libopus",
            "-f",
            "webm",
            "pipe:1",
          ],
          { maxBuffer: 16 * 1024 * 1024 },
        ).stdout,
      );
    const normalize = createFfmpegAudioNormalizer({ ffmpegPath: "ffmpeg" });
    const ok = await normalize({ audio: tone(2), mimeType: "audio/webm", maxDurationSeconds: 5 });
    expect(ok.durationSeconds).toBeGreaterThan(1.9);
    expect(ok.durationSeconds).toBeLessThan(2.1);
    expect(String.fromCharCode(...ok.bytes.slice(0, 4))).toBe("RIFF");
    await expect(
      normalize({ audio: tone(9), mimeType: "audio/webm", maxDurationSeconds: 5 }),
    ).rejects.toMatchObject({ code: "too_large" });
  },
  30_000,
);
