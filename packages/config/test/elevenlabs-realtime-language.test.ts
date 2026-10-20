import { describe, expect, test } from "bun:test";

import { ELEVENLABS_REALTIME_LANGUAGES, resolveElevenLabsRealtimeLanguage } from "../src/index";

describe("resolveElevenLabsRealtimeLanguage", () => {
  test("maps app and browser language tags to ElevenLabs codes", () => {
    expect(resolveElevenLabsRealtimeLanguage("nb-NO")).toBe("no");
    expect(resolveElevenLabsRealtimeLanguage("nn")).toBe("no");
    expect(resolveElevenLabsRealtimeLanguage("no")).toBe("no");
    expect(resolveElevenLabsRealtimeLanguage("en-US")).toBe("en");
    expect(resolveElevenLabsRealtimeLanguage("pt-BR")).toBe("pt-br");
    expect(resolveElevenLabsRealtimeLanguage("pt_PT")).toBe("pt");
    expect(resolveElevenLabsRealtimeLanguage("zh-Hant-TW")).toBe("zh");
    expect(resolveElevenLabsRealtimeLanguage("iw")).toBe("he");
    expect(resolveElevenLabsRealtimeLanguage(" SV ")).toBe("sv");
  });

  test("returns null for languages ElevenLabs does not support", () => {
    expect(resolveElevenLabsRealtimeLanguage("eo")).toBeNull();
    expect(resolveElevenLabsRealtimeLanguage("")).toBeNull();
    expect(resolveElevenLabsRealtimeLanguage("x-klingon")).toBeNull();
  });

  test("every listed language resolves to itself", () => {
    expect(ELEVENLABS_REALTIME_LANGUAGES).toHaveLength(90);
    for (const language of ELEVENLABS_REALTIME_LANGUAGES) {
      expect(resolveElevenLabsRealtimeLanguage(language)).toBe(language);
    }
  });
});
