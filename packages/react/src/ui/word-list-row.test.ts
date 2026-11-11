import { describe, expect, test } from "bun:test";
import { wordListTerms } from "./word-list-row";

describe("wordListTerms", () => {
  test("one word per line or between commas, each once whatever its case", () => {
    expect(wordListTerms("Kubernetes\n acme ,Grafana  Max;\n\nAcme")).toEqual([
      "Kubernetes",
      "acme",
      "Grafana Max",
    ]);
    expect(wordListTerms("  \n")).toEqual([]);
  });
});
