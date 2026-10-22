import { describe, expect, test } from "bun:test";
import { realtimeVoiceOptions, resolveRealtimeVoice } from "../src/realtime-websocket";
import type { SessionRealtimeModel } from "@opengeni/contracts";

const provider = {
  voiceOptions: realtimeVoiceOptions,
  resolveLanguage: (tag: string) => (tag.toLowerCase().startsWith("nb") ? "no" : null),
};

describe("realtime voice settings", () => {
  test("a fixed voice list accepts only its own voices and offers nothing else", () => {
    const model: SessionRealtimeModel = "workspace-gateway/openai/gpt-realtime-2.1";
    expect(
      resolveRealtimeVoice({
        provider,
        model,
        connection: { voice: "not-a-voice", turnEagerness: "low", language: "nb-NO" },
        workspace: { voice: "marin" },
        personLanguage: "nb-NO",
      }),
    ).toEqual({ voice: "marin" });
    // An xAI voice is not an OpenAI voice.
    expect(
      resolveRealtimeVoice({
        provider,
        model,
        connection: { voice: "eve" },
        workspace: null,
        personLanguage: undefined,
      }),
    ).toEqual({});
  });

  test("custom voices, eagerness and language resolve field by field", () => {
    const model: SessionRealtimeModel = "workspace-elevenlabs/eleven_realtime_v1_max";
    expect(
      resolveRealtimeVoice({
        provider,
        model,
        connection: { turnEagerness: "low" },
        workspace: { voice: "library-voice-id", turnEagerness: "medium" },
        personLanguage: "nb-NO",
      }),
    ).toEqual({ voice: "library-voice-id", turnEagerness: "low", language: "no" });
    // An unsupported language falls through to the next layer.
    expect(
      resolveRealtimeVoice({
        provider,
        model,
        connection: { language: "xx" },
        workspace: null,
        personLanguage: "nb",
      }),
    ).toEqual({ language: "no" });
  });

  test("models without configurable voice settings get none", () => {
    expect(realtimeVoiceOptions("gpt-live-1-boulder-alpha")).toEqual({});
    expect(
      resolveRealtimeVoice({
        provider,
        model: "gpt-live-1-boulder-alpha",
        connection: { voice: "marin", language: "nb-NO", turnEagerness: "high" },
        workspace: null,
        personLanguage: "nb-NO",
      }),
    ).toEqual({});
  });
});
