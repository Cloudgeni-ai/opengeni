import { describe, expect, test } from "bun:test";
import { wordListTerms } from "./word-list-row";

describe("wordListTerms", () => {
  test("one word per line or between commas, each once whatever its case", () => {
    expect(wordListTerms("Tripletex\n vatra ,Pelle  Max;\n\nVatra")).toEqual([
      "Tripletex",
      "vatra",
      "Pelle Max",
    ]);
    expect(wordListTerms("  \n")).toEqual([]);
  });
});
