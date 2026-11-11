import { describe, expect, test } from "bun:test";
import { withoutAudioTags } from "../src/realtime-transcript";

describe("withoutAudioTags", () => {
  test("drops delivery tags anywhere in a transcript", () => {
    expect(
      withoutAudioTags(
        "[calm] I checked with the session agent. [pause] There are three open pull requests. [laughs]",
      ),
    ).toBe("I checked with the session agent. There are three open pull requests.");
  });

  test("leaves ordinary text alone", () => {
    expect(withoutAudioTags("Deploy finished in 3 minutes.")).toBe("Deploy finished in 3 minutes.");
  });

  test("a transcript of only tags becomes empty", () => {
    expect(withoutAudioTags(" [sighs] ")).toBe("");
  });
});
