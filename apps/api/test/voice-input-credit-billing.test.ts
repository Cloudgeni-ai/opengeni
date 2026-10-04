import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  calculateVoiceInputCost,
  parseVoiceInputPricingJson,
  resolveVoiceInputProviderRegistry,
} from "@opengeni/config";
import { TranscriptionBillingRefusedError, voiceInputBillableUsage } from "@opengeni/core";
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
  mimeType: "audio/wav",
  durationSeconds: 1,
  billing: {
    idempotencyKey: "server-key",
    sourceType: "voice_transcription",
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
  const result = await provider.transcribe({ ...request, filename: "audio.wav" });
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
    fetch: async () => {
      sends++;
      return Response.json({});
    },
    billing: {
      admit: async () => {
        throw new TranscriptionBillingRefusedError({
          code: "insufficient_credits",
          message: "Add credits",
        });
      },
      settle: async () => {
        throw Error("unexpected settlement");
      },
    },
  });
  await expect(service.transcribe(request)).rejects.toMatchObject({
    code: "insufficient_credits",
    status: 402,
  });
  expect(sends).toBe(0);
});

test("settlement receives measured usage, not the caller's duration; provider stays pinned", async () => {
  let settled: unknown;
  const urls: string[] = [];
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    fetch: async (url) => {
      urls.push(String(url));
      return Response.json({ durationMilliseconds: 5000, combinedPhrases: [{ text: "hello" }] });
    },
    billing: {
      admit: async () => {},
      settle: async (input) => {
        settled = input;
        return { creditCostMicros: 525 };
      },
    },
  });
  const result = await service.transcribe({ ...request, providerId: "azure-mai" });
  expect(result.creditCostMicros).toBe(525);
  expect(settled).toMatchObject({
    providerId: "azure-mai",
    usage: { kind: "duration", seconds: 5 },
    billing: { idempotencyKey: "server-key" },
  });
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("speech.example.test");
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

test("unpriced deployment providers are unavailable; invalid pricing is rejected", () => {
  expect(
    resolveVoiceInputProviderRegistry({ ...settings, voiceInputMaiPricingJson: undefined }).map(
      (p) => p.id,
    ),
  ).toEqual(["azure-openai"]);
  expect(() => parseVoiceInputPricingJson('{"microsPerMinute":-1}')).toThrow();
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

test("resumable settlement waits for the fenced transcript transaction", async () => {
  const transactions: unknown[] = [];
  const service = createTranscriptionService({
    settings,
    db: {} as never,
    fetch: async () =>
      Response.json({ durationMilliseconds: 5000, combinedPhrases: [{ text: "hello" }] }),
    billing: {
      admit: async () => {},
      settle: async (_input, transaction) => {
        transactions.push(transaction);
        return { creditCostMicros: 525 };
      },
    },
  });
  const result = await service.transcribe({
    ...request,
    providerId: "azure-mai",
    deferBillingSettlement: true,
  });
  expect(result.text).toBe("hello");
  expect(transactions).toHaveLength(0);
  const transaction = {} as never;
  await result.settleBilling!(transaction);
  expect(transactions).toEqual([transaction]);
});
