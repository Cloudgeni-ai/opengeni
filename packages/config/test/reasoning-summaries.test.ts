import { describe, expect, test } from "bun:test";
import { DEFAULT_REASONING_SUMMARIES, getSettings } from "../src";

describe("reasoning summary settings", () => {
  test("defaults to no summary for Codex Ultrafast and the earlier wire everywhere else", () => {
    const settings = withEnv({}, getSettings);
    expect(settings.reasoningSummaries).toEqual({
      codex: { standard: "detailed", priority: "detailed", fast: "detailed", ultrafast: "none" },
      openai: { standard: "auto", priority: "auto", fast: "auto", ultrafast: "auto" },
      azure: { standard: "auto", priority: "auto", fast: "auto", ultrafast: "auto" },
    });
    expect(settings.reasoningSummaries).toEqual(DEFAULT_REASONING_SUMMARIES);
    expect(
      withEnv({ OPENGENI_REASONING_SUMMARY_JSON: "  " }, getSettings).reasoningSummaries,
    ).toEqual(DEFAULT_REASONING_SUMMARIES);
  });

  test("each configured cell replaces only its own default", () => {
    const settings = withEnv(
      {
        OPENGENI_REASONING_SUMMARY_JSON: JSON.stringify({
          codex: { fast: "none", ultrafast: "auto" },
          azure: { ultrafast: "none" },
        }),
      },
      getSettings,
    );
    expect(settings.reasoningSummaries).toEqual({
      codex: { standard: "detailed", priority: "detailed", fast: "none", ultrafast: "auto" },
      openai: DEFAULT_REASONING_SUMMARIES.openai,
      azure: { standard: "auto", priority: "auto", fast: "auto", ultrafast: "none" },
    });
  });

  test("rejects malformed values, routes and latency modes", () => {
    for (const value of [
      "not json",
      "[]",
      '"none"',
      '{"codex":"none"}',
      '{"codex":{"ultrafast":"concise"}}',
      '{"codex":{"ultrafast":null}}',
      '{"codex":{"turbo":"none"}}',
      '{"anthropic":{"standard":"none"}}',
    ]) {
      expect(() => withEnv({ OPENGENI_REASONING_SUMMARY_JSON: value }, getSettings)).toThrow();
    }
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return run();
  } finally {
    process.env = original;
  }
}
