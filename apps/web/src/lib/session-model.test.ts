import { describe, expect, test } from "bun:test";

import { resolveSessionComposerModel } from "./session-model";

describe("resolveSessionComposerModel", () => {
  test("uses durable session.model when there is no override", () => {
    expect(
      resolveSessionComposerModel({
        requested: "codex/gpt-5.6-luna",
        durableSessionModel: "codex/gpt-5.6-luna",
        codexCompactionMode: "remote_v2",
      }),
    ).toBe("codex/gpt-5.6-luna");
  });

  test("keeps a Codex override on remote_v2", () => {
    expect(
      resolveSessionComposerModel({
        requested: "codex/gpt-5.6-terra",
        durableSessionModel: "codex/gpt-5.6-luna",
        codexCompactionMode: "remote_v2",
      }),
    ).toBe("codex/gpt-5.6-terra");
  });

  test("rejects a stale OpenAI default override on remote_v2", () => {
    expect(
      resolveSessionComposerModel({
        requested: "gpt-5.6-sol",
        durableSessionModel: "codex/gpt-5.6-luna",
        codexCompactionMode: "remote_v2",
      }),
    ).toBe("codex/gpt-5.6-luna");
  });

  test("allows non-Codex models on portable sessions", () => {
    expect(
      resolveSessionComposerModel({
        requested: "gpt-5.6-sol",
        durableSessionModel: "gpt-5.6-luna",
        codexCompactionMode: "portable",
      }),
    ).toBe("gpt-5.6-sol");
  });
});
