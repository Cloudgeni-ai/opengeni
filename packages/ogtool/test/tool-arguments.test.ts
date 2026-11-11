import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../src/tool-arguments";

describe("ogtool call arguments", () => {
  test("a halved reference escape reads as the literal reference", () => {
    // The agent wrote "\\{{secret:…}}" for JSON; the shell splice removed one backslash.
    expect(parseToolArguments(String.raw`{"token":"\{{secret:Linear/token}}"}`)).toEqual({
      token: "{{secret:Linear/token}}",
    });
    expect(parseToolArguments(String.raw`{"file":"\{{secretfile:Kube/config}}"}`)).toEqual({
      file: "{{secretfile:Kube/config}}",
    });
  });

  test("valid JSON is never rewritten", () => {
    expect(parseToolArguments(String.raw`{"token":"\\{{secret:X}}"}`)).toEqual({
      token: String.raw`\{{secret:X}}`,
    });
    expect(parseToolArguments(`{"token":"{{secret:X}}"}`)).toEqual({ token: "{{secret:X}}" });
  });

  test("other invalid JSON still fails, with a hint when it holds a reference", () => {
    expect(() => parseToolArguments(String.raw`{"token":"\q{{secret:X}}"}`)).toThrow(
      /one backslash/u,
    );
    expect(() => parseToolArguments(`{"token":`)).toThrow(/^tool arguments must be valid JSON$/u);
  });
});
