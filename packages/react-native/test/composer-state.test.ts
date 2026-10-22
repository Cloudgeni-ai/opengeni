import { describe, expect, test } from "bun:test";
import { GENIE_PREPARING_PHRASES, GENIE_WAITING_PHRASES } from "@opengeni/react/timeline-model";
import { createOpenGeniText } from "@opengeni/react/messages";
import {
  composerAlternateSend,
  composerTrailingMode,
  nativeLoadingPhrases,
} from "../src/timeline/composer-state";

const t = createOpenGeniText();

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

describe("composer alternate send", () => {
  const working = { trailing: "send" as const, available: true };

  test("a phone can always queue or steer while the agent works", () => {
    expect(composerAlternateSend({ ...working, alternateSend: "queue" })).toBe("queue");
    expect(composerAlternateSend({ ...working, alternateSend: "steer" })).toBe("steer");
  });

  test("only beside Send, while Send takes its busy path, and when the host offers it", () => {
    expect(
      composerAlternateSend({ ...working, alternateSend: "steer", trailing: "pause" }),
    ).toBeNull();
    expect(composerAlternateSend({ ...working, alternateSend: null })).toBeNull();
    expect(composerAlternateSend({ ...working })).toBeNull();
    expect(
      composerAlternateSend({ ...working, alternateSend: "steer", available: false }),
    ).toBeNull();
  });
});

describe("native loading phrases", () => {
  test("built-in copy per phase by default", () => {
    expect(nativeLoadingPhrases(t, [], "preparing")).toEqual(GENIE_PREPARING_PHRASES(t));
    expect(nativeLoadingPhrases(t, [], "waiting")).toEqual(GENIE_WAITING_PHRASES(t));
  });

  test("a host's phrases replace both phases, as on web", () => {
    const own = ["Looking into it…", "One moment…"];
    expect(nativeLoadingPhrases(t, own, "preparing")).toBe(own);
    expect(nativeLoadingPhrases(t, own, "waiting")).toBe(own);
  });
});
