import { describe, expect, test } from "bun:test";
import { isNoReplyText, mayBecomeNoReplyText, NO_REPLY_SENTINEL } from "../src/no-reply";

describe("the no-reply token", () => {
  test("matches the token however the model wraps it", () => {
    for (const text of ["NO_REPLY", " no_reply ", "`NO_REPLY`", "**NO_REPLY**", "NO_REPLY."]) {
      expect(isNoReplyText(text)).toBe(true);
    }
  });

  test("never matches an answer that only mentions it", () => {
    for (const text of ["", "NO", "NO_REPLY needed here", "Nothing new, NO_REPLY"]) {
      expect(isNoReplyText(text)).toBe(false);
    }
  });

  test("holds streaming text only while it could still become the token", () => {
    expect(mayBecomeNoReplyText("N")).toBe(true);
    expect(mayBecomeNoReplyText("no_re")).toBe(true);
    expect(mayBecomeNoReplyText(NO_REPLY_SENTINEL)).toBe(true);
    expect(mayBecomeNoReplyText("")).toBe(false);
    expect(mayBecomeNoReplyText("Nothing changed")).toBe(false);
  });
});
