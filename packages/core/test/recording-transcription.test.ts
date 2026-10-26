import { describe, expect, test } from "bun:test";
import {
  buildRecordingSegments,
  recordingSpeakerLabels,
  createElevenLabsRecordingTranscriptionProvider,
  createRecordingTranscriptionProviderRegistry,
  estimateRecordingTranscriptionCostMicros,
  findRecordingTranscriptionModel,
  labelWordsFromTurns,
  parseElevenLabsTranscript,
  planRecordingTracks,
  recordingDiarizationKind,
  RecordingTranscriptionError,
  type RecordingTranscribedWord,
} from "../src/recording-transcription";

function word(
  text: string,
  start: number,
  end: number,
  speaker: string | null = null,
  spaceBefore = true,
): RecordingTranscribedWord {
  return { text, startMilliseconds: start, endMilliseconds: end, speaker, spaceBefore };
}

describe("parseElevenLabsTranscript", () => {
  test("keeps words, spacing and speakers and drops audio events", () => {
    const result = parseElevenLabsTranscript({
      language_code: "nor",
      audio_duration_secs: 4.25,
      words: [
        { text: "Hei", type: "word", start: 0.1, end: 0.4, speaker_id: "speaker_0" },
        { text: " ", type: "spacing", start: 0.4, end: 0.5 },
        { text: "(laughter)", type: "audio_event", start: 0.5, end: 0.9 },
        { text: "alle", type: "word", start: 0.9, end: 1.2, speaker_id: "speaker_0" },
        { text: ",", type: "word", start: 1.2, end: 1.2, speaker_id: "speaker_0" },
        { text: "", type: "word", start: 1.3, end: 1.4 },
        { text: "ja", type: "word", start: "bad", end: 1.6 },
      ],
    });
    expect(result.languages).toEqual(["no"]);
    expect(result.audioMilliseconds).toBe(4250);
    expect(result.diarized).toBe(true);
    expect(result.words).toEqual([
      word("Hei", 100, 400, "speaker_0", false),
      word("alle", 900, 1200, "speaker_0", true),
      word(",", 1200, 1200, "speaker_0", false),
    ]);
  });

  test("an empty body is a retryable provider error", () => {
    expect(() => parseElevenLabsTranscript(null)).toThrow(RecordingTranscriptionError);
  });

  test("words without speakers are not diarized", () => {
    const result = parseElevenLabsTranscript({ words: [{ text: "hi", start: 0, end: 1 }] });
    expect(result.diarized).toBe(false);
    expect(result.languages).toEqual([]);
    expect(result.audioMilliseconds).toBeNull();
  });
});

describe("labelWordsFromTurns", () => {
  test("assigns the most-overlapping speaker and the nearest one in gaps", () => {
    const labelled = labelWordsFromTurns(
      [word("a", 0, 400), word("b", 900, 1300), word("c", 2100, 2200), word("d", 5000, 5100)],
      [
        { startMilliseconds: 1000, endMilliseconds: 2000, speaker: "B" },
        { startMilliseconds: 0, endMilliseconds: 1000, speaker: "A" },
        { startMilliseconds: 2500, endMilliseconds: 4000, speaker: "C" },
      ],
    );
    expect(labelled.map((item) => item.speaker)).toEqual(["A", "B", "B", "C"]);
  });

  test("no turns leaves words unlabelled", () => {
    expect(labelWordsFromTurns([word("a", 0, 1, "x")], [])[0]!.speaker).toBeNull();
  });
});

describe("planRecordingTracks", () => {
  test("the microphone next to system audio is the person recording", () => {
    expect(
      planRecordingTracks([
        { trackNumber: 2, source: "system" },
        { trackNumber: 1, source: "microphone" },
      ]),
    ).toEqual([
      { trackNumber: 1, fixedLabel: "track-1", diarize: false },
      { trackNumber: 2, fixedLabel: null, diarize: true },
    ]);
  });

  test("a microphone on its own is diarized", () => {
    expect(planRecordingTracks([{ trackNumber: 1, source: "microphone" }])).toEqual([
      { trackNumber: 1, fixedLabel: null, diarize: true },
    ]);
  });
});

describe("buildRecordingSegments", () => {
  test("splits on speaker change and long pauses and merges tracks by time", () => {
    const segments = buildRecordingSegments([
      {
        trackNumber: 1,
        fixedLabel: "track-1",
        words: [
          word("Hello", 0, 300, null, false),
          word("there.", 350, 700),
          word("Later", 5000, 5400, null),
        ],
      },
      {
        trackNumber: 2,
        fixedLabel: null,
        words: [word("Hi", 1000, 1200, "speaker_7", false), word("Bye", 1300, 1500, "speaker_3")],
      },
    ]);
    expect(
      segments.map((segment) => [segment.trackNumber, segment.speakerLabel, segment.text]),
    ).toEqual([
      [1, "track-1", "Hello there."],
      [2, "speaker_0", "Hi"],
      [2, "speaker_1", "Bye"],
      [1, "track-1", "Later"],
    ]);
    expect(segments[0]!.words).toEqual([
      { text: "Hello", startMs: 0, endMs: 300 },
      { text: "there.", startMs: 350, endMs: 700 },
    ]);
  });

  test("speaker ids map to the labels the segments carry", () => {
    const tracks = [
      { trackNumber: 1, fixedLabel: "track-1", words: [word("Hello", 0, 300, null)] },
      {
        trackNumber: 2,
        fixedLabel: null,
        words: [
          word(" ", 900, 950, "S4"),
          word("Hi", 1000, 1200, "S2"),
          word("Bye", 1300, 1500, "S4"),
          word("Ok", 1600, 1700, "S2"),
        ],
      },
    ];
    expect(recordingSpeakerLabels(tracks)).toEqual(
      new Map([
        [
          2,
          new Map([
            ["S2", "speaker_0"],
            ["S4", "speaker_1"],
          ]),
        ],
      ]),
    );
    expect(buildRecordingSegments(tracks).map((segment) => segment.speakerLabel)).toEqual([
      "track-1",
      "speaker_0",
      "speaker_1",
      "speaker_0",
    ]);
  });

  test("prefixes labels with the track when several tracks are diarized", () => {
    const segments = buildRecordingSegments([
      { trackNumber: 1, fixedLabel: null, words: [word("a", 0, 100, "s")] },
      { trackNumber: 2, fixedLabel: null, words: [word("b", 200, 300, "s")] },
    ]);
    expect(segments.map((segment) => segment.speakerLabel)).toEqual([
      "t1_speaker_0",
      "t2_speaker_0",
    ]);
  });

  test("ends a long monologue at a sentence end after a minute", () => {
    const words: RecordingTranscribedWord[] = [];
    for (let second = 0; second < 70; second += 1) {
      words.push(word(second === 62 ? "done." : "word", second * 1000, second * 1000 + 800, "a"));
    }
    const segments = buildRecordingSegments([{ trackNumber: 1, fixedLabel: null, words }]);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text.endsWith("done.")).toBe(true);
    expect(segments[1]!.startMilliseconds).toBe(63_000);
  });
});

describe("recordingDiarizationKind", () => {
  const fixedAndDiarized = planRecordingTracks([
    { trackNumber: 1, source: "microphone" },
    { trackNumber: 2, source: "system" },
  ]);
  test("names who told speakers apart", () => {
    expect(
      recordingDiarizationKind({
        plans: fixedAndDiarized,
        providerDiarized: true,
        ourDiarizer: false,
      }),
    ).toBe("provider");
    expect(
      recordingDiarizationKind({
        plans: fixedAndDiarized,
        providerDiarized: true,
        ourDiarizer: true,
      }),
    ).toBe("ours");
    expect(
      recordingDiarizationKind({
        plans: fixedAndDiarized,
        providerDiarized: false,
        ourDiarizer: false,
      }),
    ).toBe("tracks");
    expect(
      recordingDiarizationKind({
        plans: planRecordingTracks([{ trackNumber: 1, source: "microphone" }]),
        providerDiarized: false,
        ourDiarizer: false,
      }),
    ).toBe("none");
  });
});

describe("ElevenLabs provider", () => {
  const audio = {
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "audio/ogg",
    fileName: "track-1.ogg",
  };

  test("posts multipart audio with the requested options", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const provider = createElevenLabsRecordingTranscriptionProvider({
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return Response.json({
          language_code: "eng",
          words: [{ text: "hi", type: "word", start: 0, end: 0.5, speaker_id: "speaker_1" }],
        });
      }) as unknown as typeof fetch,
    });
    const result = await provider.transcribe(
      {
        audio,
        model: "scribe_v2",
        diarize: true,
        maxSpeakers: 50,
        language: "en",
        keyterms: ["Opengeni", "Scribe"],
      },
      { apiKey: "test-key" },
    );
    expect(result.words).toHaveLength(1);
    expect(seen!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((seen!.init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const form = seen!.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("diarize")).toBe("true");
    expect(form.get("num_speakers")).toBe("32");
    expect(form.get("language_code")).toBe("en");
    expect(form.getAll("keyterms")).toEqual(["Opengeni", "Scribe"]);
    expect(form.get("timestamps_granularity")).toBe("word");
    expect((form.get("file") as File).size).toBe(3);
  });

  test("maps HTTP failures to typed errors", async () => {
    const failing = (status: number) =>
      createElevenLabsRecordingTranscriptionProvider({
        fetch: (async () =>
          Response.json({ detail: { message: "nope" } }, { status })) as unknown as typeof fetch,
      });
    const attempt = async (status: number) => {
      try {
        await failing(status).transcribe(
          { audio, model: "scribe_v2", diarize: false },
          { apiKey: "k" },
        );
      } catch (error) {
        return error as RecordingTranscriptionError;
      }
      throw new Error("expected failure");
    };
    expect(await attempt(401)).toMatchObject({ code: "unauthorized", retryable: false });
    expect(await attempt(429)).toMatchObject({ code: "rate_limited", retryable: true });
    expect(await attempt(503)).toMatchObject({ code: "unavailable", retryable: true });
    expect(await attempt(422)).toMatchObject({ code: "invalid_audio", retryable: false });
    expect((await attempt(400)).message).toContain("nope");
  });

  test("network failures are retryable", async () => {
    const provider = createElevenLabsRecordingTranscriptionProvider({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(
      provider.transcribe({ audio, model: "scribe_v2", diarize: false }, { apiKey: "k" }),
    ).rejects.toMatchObject({ code: "network", retryable: true });
  });

  test("grants a live session with a single-use token, never the key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = createElevenLabsRecordingTranscriptionProvider({
      now: () => new Date("2026-10-24T10:00:00Z"),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ token: "sutkn_abc" });
      }) as unknown as typeof fetch,
    });
    const grant = await provider.createLiveSession!(
      { model: "scribe_v2_realtime", language: "nb" },
      { apiKey: "secret-key" },
    );
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("secret-key");
    const url = new URL(grant.url);
    expect(url.origin + url.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_id: "scribe_v2_realtime",
      token: "sutkn_abc",
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      include_timestamps: "true",
      // ElevenLabs knows Norwegian as one language, so Bokmål goes as "no".
      language_code: "no",
    });
    expect(grant.url).not.toContain("secret-key");
    expect(grant.protocol).toBe("elevenlabs.scribe_realtime");
    expect(grant.audio).toEqual({ encoding: "pcm_s16le", sampleRate: 16_000 });
    expect(grant.expiresAt.toISOString()).toBe("2026-10-24T10:14:00.000Z");
  });

  test("a rejected key fails the live grant as unauthorized", async () => {
    const provider = createElevenLabsRecordingTranscriptionProvider({
      fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(
      provider.createLiveSession!({ model: "scribe_v2_realtime" }, { apiKey: "k" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("registry and cost", () => {
  test("finds the default model and prices an hour", () => {
    const found = findRecordingTranscriptionModel(
      createRecordingTranscriptionProviderRegistry(),
      "elevenlabs",
      "scribe_v2",
    );
    expect(found?.spec.capabilities.diarization).toBe(true);
    expect(estimateRecordingTranscriptionCostMicros(found!.spec, 3_600_000)).toBe(220_000);
    expect(
      estimateRecordingTranscriptionCostMicros(found!.spec, 3_600_000, { keyterms: true }),
    ).toBe(286_000);
    expect(
      findRecordingTranscriptionModel(createRecordingTranscriptionProviderRegistry(), "x", "y"),
    ).toBeNull();
  });

  test("live and batch models are only found for their own use", () => {
    const registry = createRecordingTranscriptionProviderRegistry();
    expect(
      findRecordingTranscriptionModel(registry, "elevenlabs", "scribe_v2_realtime"),
    ).toBeNull();
    expect(findRecordingTranscriptionModel(registry, "elevenlabs", "scribe_v2", "live")).toBeNull();
    const live = findRecordingTranscriptionModel(
      registry,
      "elevenlabs",
      "scribe_v2_realtime",
      "live",
    );
    expect(live?.spec.capabilities.live).toBe(true);
    expect(estimateRecordingTranscriptionCostMicros(live!.spec, 3_600_000)).toBe(390_000);
  });
});
