import { describe, expect, test } from "bun:test";
import { getSettings } from "../src";

describe("realtime voice configuration", () => {
  test("is fail-closed by default", () => {
    expect(withEnv({}, () => getSettings()).codexRealtimeVoiceEnabled).toBe(false);
  });

  test("maps the explicit experimental kill switch", () => {
    expect(
      withEnv({ OPENGENI_CODEX_REALTIME_VOICE_ENABLED: "true" }, () => getSettings())
        .codexRealtimeVoiceEnabled,
    ).toBe(true);
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}
