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
  transcriptLanguages,
  withoutMicrophoneEchoes,
  withRecorderVoice,
  type RecordingTranscribedWord,
  type RecordingTrackWords,
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

describe("transcriptLanguages", () => {
  test("a transcript asked for in one language is in that language", () => {
    // A model that labels a few Norwegian phrases as Danish.
    expect(transcriptLanguages("nb", new Set(["nb", "da"]))).toEqual(["nb"]);
    // Norwegian's written forms are one language; the model's name is kept.
    expect(transcriptLanguages("no", ["nb"])).toEqual(["nb"]);
    expect(transcriptLanguages("en", ["en-US", "en-GB", "de"])).toEqual(["en-US", "en-GB"]);
    // Nothing heard in it: the language asked for.
    expect(transcriptLanguages("nb", ["da"])).toEqual(["nb"]);
    expect(transcriptLanguages("nob", [])).toEqual(["nb"]);
  });

  test("without a language asked for, every language heard counts", () => {
    expect(transcriptLanguages(undefined, ["nb", "en", "nb"])).toEqual(["nb", "en"]);
    expect(transcriptLanguages(null, [])).toEqual([]);
  });
});

describe("planRecordingTracks", () => {
  test("the microphone next to system audio is the person recording's", () => {
    expect(
      planRecordingTracks([
        { trackNumber: 2, source: "system" },
        { trackNumber: 1, source: "microphone" },
      ]),
    ).toEqual([
      { trackNumber: 1, recorderLabel: "track-1" },
      { trackNumber: 2, recorderLabel: null },
    ]);
  });

  test("a microphone on its own is anyone's", () => {
    expect(planRecordingTracks([{ trackNumber: 1, source: "microphone" }])).toEqual([
      { trackNumber: 1, recorderLabel: null },
    ]);
  });
});

describe("withRecorderVoice", () => {
  const recorder = { label: "track-0", speaker: null };
  const speakerOf = (track: RecordingTrackWords) => track.recorder?.speaker;

  test("one voice on the microphone is the person recording, whole track", () => {
    const track = withRecorderVoice(
      { trackNumber: 0, recorder, words: [word("hei", 0, 400, "A"), word("du", 500, 800, "A")] },
      null,
    );
    expect(speakerOf(track)).toBeNull();
    expect(buildRecordingSegments([track]).map((segment) => segment.speakerLabel)).toEqual([
      "track-0",
    ]);
  });

  test("with several voices, the one that spoke the most is the person recording", () => {
    const track = withRecorderVoice(
      {
        trackNumber: 0,
        recorder,
        words: [
          word("Hei", 0, 300, "A"),
          word("hva", 400, 700, "A"),
          word("trenger", 3_000, 3_600, "B"),
          word("dere?", 3_700, 4_500, "B"),
          word("Et", 7_000, 7_200, "A"),
          word("tilbud.", 7_300, 7_800, "A"),
          word(" ", 7_900, 9_900, "C"),
        ],
      },
      null,
    );
    expect(speakerOf(track)).toBe("B");
  });

  test("the remembered voice picks the person recording over who spoke the most", () => {
    const track = withRecorderVoice(
      {
        trackNumber: 0,
        recorder,
        words: [word("Hei", 0, 300, "A"), word("trenger", 3_000, 6_000, "B")],
      },
      "A",
    );
    expect(speakerOf(track)).toBe("A");
    expect(withRecorderVoice({ ...track, recorder }, "Z").recorder?.speaker).toBe("B");
  });

  test("other voices on the microphone are numbered with everyone else", () => {
    const microphone = withRecorderVoice(
      {
        trackNumber: 0,
        recorder,
        words: [
          word("Hei", 0, 300, "S1"),
          word("velkommen.", 400, 1_400, "S1"),
          word("Takk.", 2_000, 2_400, "S0"),
          word("Kort", 3_000, 3_200, null),
        ],
      },
      null,
    );
    const tracks: RecordingTrackWords[] = [
      microphone,
      {
        trackNumber: 1,
        recorder: null,
        words: [word("Hallo", 5_000, 5_400, "S0"), word("der", 8_000, 8_300, "S1")],
      },
    ];
    expect(
      buildRecordingSegments(tracks).map((segment) => [segment.trackNumber, segment.speakerLabel]),
    ).toEqual([
      [0, "track-0"],
      [0, "speaker_0"],
      [0, "track-0"],
      [1, "speaker_1"],
      [1, "speaker_2"],
    ]);
    expect(recordingSpeakerLabels(tracks)).toEqual(
      new Map([
        [
          0,
          new Map([
            ["S1", "track-0"],
            ["S0", "speaker_0"],
          ]),
        ],
        [
          1,
          new Map([
            ["S0", "speaker_1"],
            ["S1", "speaker_2"],
          ]),
        ],
      ]),
    );
  });

  test("leaves tracks that are not the person recording's as they are", () => {
    const track: RecordingTrackWords = {
      trackNumber: 1,
      recorder: null,
      words: [word("a", 0, 100, "A"), word("b", 200, 900, "B")],
    };
    expect(withRecorderVoice(track, "A")).toBe(track);
  });

  test("a voice that was the speakers' echo is never the person recording, and its leftovers go", () => {
    const track = withRecorderVoice(
      {
        trackNumber: 0,
        recorder,
        words: [
          word("Takk", 0, 400, "A"),
          word("skal", 1_000, 4_000, "E"),
          word("Ja", 5_000, 5_300, "B"),
          word("Kort", 6_000, 6_200, null),
        ],
        echoSpeakers: ["E"],
      },
      null,
    );
    expect(speakerOf(track)).toBe("A");
    expect(track.words.map((item) => item.text)).toEqual(["Takk", "Ja", "Kort"]);
  });

  test("one voice stays the person recording's, echo or not", () => {
    const words = [word("Takk", 0, 400, "E"), word("da", 500, 800, "E")];
    const track = withRecorderVoice({ trackNumber: 0, recorder, words, echoSpeakers: ["E"] }, null);
    expect(speakerOf(track)).toBeNull();
    expect(track.words).toEqual(words);
  });

  test("when every voice is an echo, the one that spoke the most is the person recording", () => {
    const track = withRecorderVoice(
      {
        trackNumber: 0,
        recorder,
        words: [word("Takk", 0, 2_000, "E1"), word("da", 3_000, 3_300, "E2")],
        echoSpeakers: ["E1", "E2"],
      },
      null,
    );
    expect(speakerOf(track)).toBe("E1");
    expect(track.words.map((item) => item.text)).toEqual(["Takk"]);
  });

  test("the remembered voice is the person recording even when it was marked as echo", () => {
    const track = withRecorderVoice(
      {
        trackNumber: 0,
        recorder,
        words: [word("Hei", 0, 300, "A"), word("trenger", 3_000, 6_000, "B")],
        echoSpeakers: ["A"],
      },
      "A",
    );
    expect(speakerOf(track)).toBe("A");
    expect(track.words).toHaveLength(2);
  });
});

describe("buildRecordingSegments", () => {
  test("splits on speaker change and long pauses and merges tracks by time", () => {
    const segments = buildRecordingSegments([
      {
        trackNumber: 1,
        recorder: { label: "track-1", speaker: null },
        words: [
          word("Hello", 0, 300, null, false),
          word("there.", 350, 700),
          word("Later", 5000, 5400, null),
        ],
      },
      {
        trackNumber: 2,
        recorder: null,
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
    const tracks: RecordingTrackWords[] = [
      {
        trackNumber: 1,
        recorder: { label: "track-1", speaker: null },
        words: [word("Hello", 0, 300, null)],
      },
      {
        trackNumber: 2,
        recorder: null,
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

  test("numbers speakers across tracks when several tracks are diarized", () => {
    const segments = buildRecordingSegments([
      { trackNumber: 1, recorder: null, words: [word("a", 0, 100, "s")] },
      { trackNumber: 2, recorder: null, words: [word("b", 200, 300, "s")] },
    ]);
    expect(segments.map((segment) => segment.speakerLabel)).toEqual(["speaker_0", "speaker_1"]);
  });

  test("ends a long monologue at a sentence end after a minute", () => {
    const words: RecordingTranscribedWord[] = [];
    for (let second = 0; second < 70; second += 1) {
      words.push(word(second === 62 ? "done." : "word", second * 1000, second * 1000 + 800, "a"));
    }
    const segments = buildRecordingSegments([{ trackNumber: 1, recorder: null, words }]);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text.endsWith("done.")).toBe(true);
    expect(segments[1]!.startMilliseconds).toBe(63_000);
  });
});

describe("recordingDiarizationKind", () => {
  const recorderAndCall = planRecordingTracks([
    { trackNumber: 1, source: "microphone" },
    { trackNumber: 2, source: "system" },
  ]);
  test("names who told speakers apart", () => {
    expect(
      recordingDiarizationKind({
        plans: recorderAndCall,
        providerDiarized: true,
        ourDiarizer: false,
      }),
    ).toBe("provider");
    expect(
      recordingDiarizationKind({
        plans: recorderAndCall,
        providerDiarized: true,
        ourDiarizer: true,
      }),
    ).toBe("ours");
    expect(
      recordingDiarizationKind({
        plans: recorderAndCall,
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

  test("an account out of credit is out of credit, not a bad key", async () => {
    const provider = createElevenLabsRecordingTranscriptionProvider({
      fetch: (async () =>
        Response.json(
          {
            detail: {
              status: "quota_exceeded",
              message: "This request exceeds your quota of 90000. You have 970 credits remaining.",
            },
          },
          { status: 401 },
        )) as unknown as typeof fetch,
    });
    const failure = await provider
      .transcribe({ audio, model: "scribe_v2", diarize: false }, { apiKey: "k" })
      .then(
        () => null,
        (error: unknown) => error as RecordingTranscriptionError,
      );
    expect(failure).toMatchObject({ code: "quota_exceeded", retryable: false });
    expect(failure?.message).toContain("970 credits remaining");
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

describe("withoutMicrophoneEchoes", () => {
  const sources = [
    { trackNumber: 0, source: "microphone" as const },
    { trackNumber: 1, source: "system" as const },
  ];
  /** One word every 300 ms from `start`; a lone "." is punctuation glued to the word before. */
  function said(sentence: string, start: number): RecordingTranscribedWord[] {
    return sentence
      .split(" ")
      .map((text, index) =>
        word(text, start + index * 300, start + index * 300 + 250, null, text !== "."),
      );
  }
  function tracks(microphone: RecordingTranscribedWord[], computer: RecordingTranscribedWord[]) {
    const result: RecordingTrackWords[] = [
      { trackNumber: 0, recorder: { label: "track-0", speaker: null }, words: microphone },
      { trackNumber: 1, recorder: null, words: computer },
    ];
    return result;
  }
  const text = (track: RecordingTrackWords) => track.words.map((item) => item.text).join(" ");

  test("drops what the microphone heard from the speakers, a little late", () => {
    const [microphone, computer] = withoutMicrophoneEchoes(
      tracks(
        [
          ...said("Vi kommer på mandag klokka åtte .", 1_150),
          ...said("Takk , da sier jeg fra til snekkeren", 5_000),
        ],
        said("Vi kommer på mandag klokka åtte.", 1_000),
      ),
      sources,
    );
    expect(text(microphone!)).toBe("Takk , da sier jeg fra til snekkeren");
    expect(computer!.words).toHaveLength(6);
  });

  test("drops an echo with a misheard word or two, and keeps the person talking right after", () => {
    const [microphone] = withoutMicrophoneEchoes(
      tracks(
        said("vi kommer på mandag klokka åtta for å legge kabler jeg tar med nøkkelen", 1_100),
        said("Vi kommer på mandag klokka åtte for å legge kabler", 1_000),
      ),
      sources,
    );
    expect(text(microphone!)).toBe("jeg tar med nøkkelen");
  });

  test("keeps a word both happen to say at once, and words said at another time", () => {
    const microphone = [...said("ja", 2_000), ...said("vi kommer på mandag", 30_000)];
    const [kept] = withoutMicrophoneEchoes(
      tracks(microphone, [...said("Ja.", 2_100), ...said("Vi kommer på mandag", 1_000)]),
      sources,
    );
    expect(kept!.words).toEqual(microphone);
  });

  test("leaves recordings without computer audio as they are", () => {
    const microphone = said("vi kommer på mandag", 1_000);
    const only: RecordingTrackWords[] = [{ trackNumber: 0, recorder: null, words: microphone }];
    const [kept] = withoutMicrophoneEchoes(only, [{ trackNumber: 0, source: "microphone" }]);
    expect(kept).toBe(only[0]);
  });

  test("a voice that was almost all echo is the speakers, not someone in the room", () => {
    const by = (speaker: string, words: RecordingTranscribedWord[]) =>
      words.map((item) => ({ ...item, speaker }));
    const [microphone] = withoutMicrophoneEchoes(
      tracks(
        [
          // The call through the speakers, with a misheard bit the echo left behind.
          ...by("E", said("vi kommer på mandag klokka åtte for å legge kabler", 1_100)),
          ...by("E", said("en gave", 4_400)),
          // The person recording and someone next to them.
          ...by("A", said("jeg tar med nøkkelen og låser opp porten", 8_000)),
          ...by("B", said("og jeg tar med kaffe", 12_000)),
        ],
        said("Vi kommer på mandag klokka åtte for å legge kabler", 1_000),
      ),
      sources,
    );
    expect(microphone!.echoSpeakers).toEqual(["E"]);
    expect(text(microphone!)).toBe(
      "en gave jeg tar med nøkkelen og låser opp porten og jeg tar med kaffe",
    );

    const segments = buildRecordingSegments([withRecorderVoice(microphone!, null)]);
    expect(segments.map((segment) => [segment.speakerLabel, segment.text])).toEqual([
      ["track-0", "jeg tar med nøkkelen og låser opp porten"],
      ["speaker_0", "og jeg tar med kaffe"],
    ]);
  });

  test("someone who says a few words along with the call is still a person", () => {
    const [microphone] = withoutMicrophoneEchoes(
      tracks(
        [
          ...said("vi kommer på", 1_100).map((item) => ({ ...item, speaker: "B" })),
          ...said("og så tar vi en kaffe etterpå i kantina", 3_000).map((item) => ({
            ...item,
            speaker: "B",
          })),
        ],
        said("Vi kommer på mandag", 1_000),
      ),
      sources,
    );
    expect(microphone!.echoSpeakers).toBeUndefined();
  });
});
