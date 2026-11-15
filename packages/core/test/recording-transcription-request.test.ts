import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import {
  RecordingTranscriptionError,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionRequest,
  type RecordingTranscriptionResult,
} from "../src/recording-transcription";
import {
  recordingTranscriptionFailureLogAttributes,
  sendRecordingTranscriptionRequest,
  type RecordingTranscriptionRequestFailure,
} from "../src/recording-transcription-request";
import { createAzureSpeechRecordingTranscriptionProvider } from "../src/recording-transcription-azure";

const heard: RecordingTranscriptionResult = {
  languages: ["en"],
  audioMilliseconds: 80,
  diarized: false,
  words: [],
  text: "hello",
};

const request: RecordingTranscriptionRequest = {
  audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", fileName: "a.wav" },
  model: "fast-model",
  diarize: false,
  scope: { accountId: "a", workspaceId: "w", subjectId: "s", requestId: "version-1:a1:0" },
};

type Call = { requestId: string | undefined; signal: AbortSignal; startedAt: number };

/**
 * A provider that documents answering within the audio's length and retrying
 * after 20 then 40 ms (the real one documents seconds); each call does what
 * `answer` says for its number.
 */
function fastProvider(
  answer: (call: number, signal: AbortSignal) => Promise<RecordingTranscriptionResult>,
  timing: RecordingTranscriptionProvider["requestTiming"] | null = {
    realTimeFactor: 1,
    retryDelaysMilliseconds: [20, 40],
  },
) {
  const calls: Call[] = [];
  const provider: RecordingTranscriptionProvider = {
    id: "fast",
    name: "Fast",
    funding: "deployment",
    ...(timing ? { requestTiming: timing } : {}),
    models: [],
    async transcribe(input) {
      calls.push({
        requestId: input.scope?.requestId,
        signal: input.signal!,
        startedAt: performance.now(),
      });
      return await answer(calls.length, input.signal!);
    },
  };
  return { provider, calls };
}

/** Never answers; ends only when its signal aborts, as a hung HTTP request does. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function after<T>(milliseconds: number, value: () => T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value()), milliseconds));
}

describe("sending a transcription request as the provider documents", () => {
  test("a request unanswered after its audio's length is sent again after the documented wait", async () => {
    const { provider, calls } = fastProvider((call, signal) =>
      call === 1 ? hang(signal) : Promise.resolve(heard),
    );
    const failures: RecordingTranscriptionRequestFailure[] = [];
    const startedAt = performance.now();
    const result = await sendRecordingTranscriptionRequest({
      provider,
      request,
      credentials: null,
      audioMilliseconds: 80,
      onFailure: (failure) => failures.push(failure),
    });
    const elapsed = performance.now() - startedAt;
    expect(result).toBe(heard);
    // 80 ms of audio, then the documented 20 ms wait: not the minutes a hung
    // connection takes to end.
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(1_000);
    expect(calls.map((call) => call.requestId)).toEqual(["version-1:a1:0", "version-1:a1:0:r1"]);
    expect(calls[1]!.startedAt - calls[0]!.startedAt).toBeGreaterThanOrEqual(95);
    // The hung request was stopped before the answer was returned.
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(failures).toEqual([
      expect.objectContaining({
        providerId: "fast",
        model: "fast-model",
        requestId: "version-1:a1:0",
        request: 1,
        overdue: true,
        error: null,
        retryInMilliseconds: 20,
      }),
    ]);
  });

  test("a late request that answers before its retry is sent costs nothing more", async () => {
    const { provider, calls } = fastProvider(() => after(90, () => heard));
    const failures: RecordingTranscriptionRequestFailure[] = [];
    const result = await sendRecordingTranscriptionRequest({
      provider,
      request,
      credentials: null,
      audioMilliseconds: 80,
      onFailure: (failure) => failures.push(failure),
    });
    expect(result).toBe(heard);
    expect(calls).toHaveLength(1);
    expect(failures.map((failure) => failure.overdue)).toEqual([true]);
  });

  test("a late request that answers after its retry was sent still wins, and the retry stops", async () => {
    const { provider, calls } = fastProvider((call, signal) =>
      call === 1 ? after(150, () => heard) : hang(signal),
    );
    const result = await sendRecordingTranscriptionRequest({
      provider,
      request,
      credentials: null,
      audioMilliseconds: 80,
    });
    expect(result).toBe(heard);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.signal.aborted).toBe(true);
  });

  test("a transient failure is retried after the documented wait", async () => {
    const unavailable = new RecordingTranscriptionError("down", "unavailable", true, {
      status: 503,
    });
    const { provider, calls } = fastProvider((call) =>
      call === 1 ? Promise.reject(unavailable) : Promise.resolve(heard),
    );
    const failures: RecordingTranscriptionRequestFailure[] = [];
    expect(
      await sendRecordingTranscriptionRequest({
        provider,
        request,
        credentials: null,
        audioMilliseconds: 80,
        onFailure: (failure) => failures.push(failure),
      }),
    ).toBe(heard);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.startedAt - calls[0]!.startedAt).toBeGreaterThanOrEqual(18);
    expect(failures).toEqual([
      expect.objectContaining({ overdue: false, error: unavailable, retryInMilliseconds: 20 }),
    ]);
  });

  test("permanent failures and rate limits end it at once", async () => {
    for (const error of [
      new RecordingTranscriptionError("bad audio", "invalid_audio", false),
      new RecordingTranscriptionError("slow down", "rate_limited", true),
    ]) {
      const { provider, calls } = fastProvider(() => Promise.reject(error));
      const failures: RecordingTranscriptionRequestFailure[] = [];
      await expect(
        sendRecordingTranscriptionRequest({
          provider,
          request,
          credentials: null,
          audioMilliseconds: 80,
          onFailure: (failure) => failures.push(failure),
        }),
      ).rejects.toBe(error);
      expect(calls).toHaveLength(1);
      expect(failures).toEqual([expect.objectContaining({ error, retryInMilliseconds: null })]);
    }
  });

  test("after the documented retries it gives up with a retryable timeout, stopping every request", async () => {
    const { provider, calls } = fastProvider((_, signal) => hang(signal));
    const failures: RecordingTranscriptionRequestFailure[] = [];
    const error = await sendRecordingTranscriptionRequest({
      provider,
      request,
      credentials: null,
      audioMilliseconds: 30,
      onFailure: (failure) => failures.push(failure),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecordingTranscriptionError);
    expect([
      (error as RecordingTranscriptionError).code,
      (error as RecordingTranscriptionError).retryable,
    ]).toEqual(["timeout", true]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
    expect(failures.map((failure) => failure.retryInMilliseconds)).toEqual([20, 40, null]);
  });

  test("the caller's abort stops every request, also while it waits to retry", async () => {
    const caller = new AbortController();
    const { provider, calls } = fastProvider(() =>
      Promise.reject(new RecordingTranscriptionError("down", "unavailable", true)),
    );
    setTimeout(() => caller.abort(new Error("cancelled")), 5);
    const error = await sendRecordingTranscriptionRequest({
      provider,
      request: { ...request, signal: caller.signal },
      credentials: null,
      audioMilliseconds: 80,
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe("cancelled");
    await after(60, () => undefined);
    expect(calls).toHaveLength(1);
  });

  test("without documented timing, or without the audio's length, it is sent once", async () => {
    for (const [timing, audioMilliseconds] of [
      [null, 80],
      [{ realTimeFactor: 1, retryDelaysMilliseconds: [20] }, null],
    ] as const) {
      const unavailable = new RecordingTranscriptionError("down", "unavailable", true);
      const { provider, calls } = fastProvider(() => Promise.reject(unavailable), timing);
      await expect(
        sendRecordingTranscriptionRequest({
          provider,
          request,
          credentials: null,
          audioMilliseconds,
        }),
      ).rejects.toBe(unavailable);
      expect(calls).toHaveLength(1);
    }
  });
});

describe("the log line of a failed request", () => {
  test("carries what the provider said, through the observability boundary", async () => {
    const provider = createAzureSpeechRecordingTranscriptionProvider({
      endpoint: "https://speech.example.cognitiveservices.azure.com",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "InternalServerError",
              message:
                "The request timed out while generating the response. key=sk-abcdefghijklmnopqrstuvwxyz123456",
            },
          }),
          { status: 504, headers: { "apim-request-id": "4f6c1a2e-8f0b-4c1e-9d2a-0b1c2d3e4f50" } },
        )) as unknown as typeof fetch,
    });
    const failure = await sendRecordingTranscriptionRequest({
      provider: { ...provider, requestTiming: undefined },
      request,
      credentials: { apiKey: "k" },
      audioMilliseconds: 12_600,
      onFailure: () => undefined,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RecordingTranscriptionError);

    const lines: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => lines.push(line);
    try {
      const observability = createObservability(
        {
          observabilityStructuredLogs: true,
          serviceName: "opengeni",
          environment: "test",
        } as never,
        { component: "worker" },
      );
      observability.warn(
        "Transcription provider request failed",
        recordingTranscriptionFailureLogAttributes({
          providerId: "azure-speech",
          model: "MAI-Transcribe-2",
          requestId: "version-1:a1:0",
          request: 1,
          elapsedMilliseconds: 62_259,
          overdue: false,
          error: failure,
          retryInMilliseconds: 2_000,
        }),
      );
    } finally {
      console.warn = original;
    }
    const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(logged).toMatchObject({
      message: "Transcription provider request failed",
      provider: "azure-speech",
      model: "MAI-Transcribe-2",
      attempt: 1,
      durationMs: 62_259,
      outcome: "retrying",
      reason: "unavailable",
      delayMs: 2_000,
      providerStatus: 504,
      providerErrorCode: "InternalServerError",
      providerRequestId: "4f6c1a2e-8f0b-4c1e-9d2a-0b1c2d3e4f50",
      correlationId: "version-1:a1:0",
    });
    expect(logged.providerErrorMessage).toStartWith(
      "The request timed out while generating the response.",
    );
    expect(lines[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(logged).not.toHaveProperty("errorClass");
  });

  test("a connection the provider dropped logs the transport's code and message", async () => {
    const dropped = Object.assign(new Error("The socket connection was closed unexpectedly."), {
      code: "ECONNRESET",
    });
    const provider = createAzureSpeechRecordingTranscriptionProvider({
      endpoint: "https://speech.example.cognitiveservices.azure.com",
      fetch: (async () => {
        throw dropped;
      }) as unknown as typeof fetch,
    });
    const error = (await provider
      .transcribe(request, { apiKey: "k" })
      .catch((caught: unknown) => caught)) as RecordingTranscriptionError;
    expect([error.code, error.retryable]).toEqual(["network", true]);
    expect(error.detail).toEqual({
      providerCode: "ECONNRESET",
      providerMessage: "Error: The socket connection was closed unexpectedly.",
    });
    expect(
      recordingTranscriptionFailureLogAttributes({
        providerId: "azure-speech",
        model: "MAI-Transcribe-2",
        requestId: null,
        request: 6,
        elapsedMilliseconds: 10,
        overdue: false,
        error,
        retryInMilliseconds: null,
      }),
    ).toEqual({
      provider: "azure-speech",
      model: "MAI-Transcribe-2",
      attempt: 6,
      durationMs: 10,
      outcome: "failed",
      reason: "network",
      providerErrorCode: "ECONNRESET",
      providerErrorMessage: "Error: The socket connection was closed unexpectedly.",
    });
  });
});
