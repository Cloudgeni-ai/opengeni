import { describe, expect, test } from "bun:test";
import { withoutProviderCitationHandles } from "../src/provider-citation-handles";

// Built from escapes so the private-use delimiters are visible in review.
const OPEN = "\uE200";
const SEP = "\uE202";
const CLOSE = "\uE201";
const handle = (...references: string[]) =>
  `${OPEN}cite${references.map((reference) => `${SEP}${reference}`).join("")}${CLOSE}`;

describe("withoutProviderCitationHandles", () => {
  test.each([
    [
      "one handle with the space before it",
      `It ends in March. ${handle("turn559410search0")}`,
      "It ends in March.",
    ],
    [
      "a handle with several references mid-paragraph",
      `The rule applies. ${handle("turn648869view0", "turn382080view0")}\n\n### Next`,
      "The rule applies.\n\n### Next",
    ],
    ["a file citation", `See the notes ${OPEN}filecite${SEP}turn3file0${CLOSE}.`, "See the notes."],
    [
      "a handle written as plain text",
      "It ends in March.citeturn0search1turn0news2\nUse v3.",
      "It ends in March.\nUse v3.",
    ],
    [
      "a handle still streaming",
      `The answer is 42. ${OPEN}cite${SEP}turn0sea`,
      "The answer is 42.",
    ],
    ["stray delimiters from a cut-short handle", `Before ${SEP} after${CLOSE}.`, "Before  after."],
  ] as const)("removes %s", (_label, text, visible) => {
    expect(withoutProviderCitationHandles(text)).toBe(visible);
  });

  test("keeps ordinary words and text without handles exactly", () => {
    const text = "We cite sources, and we are excited about citeable work.";
    expect(withoutProviderCitationHandles(text)).toBe(text);
  });
});
