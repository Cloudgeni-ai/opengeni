import { describe, expect, test } from "bun:test";
import { GENIE_PREPARING_PHRASES, GENIE_WAITING_PHRASES } from "@opengeni/react/timeline-model";
import { composerTrailingMode, nativeLoadingPhrases } from "../src/timeline/composer-state";

const idle = {
  value: "",
  canSend: false,
  paused: false,
  running: false,
  canResume: true,
  canPause: true,
  canCall: true,
};

describe("composer trailing action", () => {
  test("an empty, idle composer offers the call when the host has one", () => {
    expect(composerTrailingMode(idle)).toBe("call");
    expect(composerTrailingMode({ ...idle, canCall: false })).toBe("idle");
  });

  test("anything to send wins over the call", () => {
    expect(composerTrailingMode({ ...idle, value: "hi" })).toBe("send");
    // Attachments alone make the message sendable.
    expect(composerTrailingMode({ ...idle, canSend: true })).toBe("send");
    // Whitespace is not a message.
    expect(composerTrailingMode({ ...idle, value: "  " })).toBe("call");
  });

  test("pause and resume keep their place while the agent runs or is paused", () => {
    expect(composerTrailingMode({ ...idle, running: true })).toBe("pause");
    expect(composerTrailingMode({ ...idle, paused: true })).toBe("resume");
    expect(composerTrailingMode({ ...idle, running: true, canPause: false })).toBe("call");
  });
});

describe("native loading phrases", () => {
  test("built-in copy per phase by default", () => {
    expect(nativeLoadingPhrases([], "preparing")).toBe(GENIE_PREPARING_PHRASES);
    expect(nativeLoadingPhrases([], "waiting")).toBe(GENIE_WAITING_PHRASES);
  });

  test("a host's phrases replace both phases, as on web", () => {
    const own = ["Looking into it…", "One moment…"];
    expect(nativeLoadingPhrases(own, "preparing")).toBe(own);
    expect(nativeLoadingPhrases(own, "waiting")).toBe(own);
  });
});
