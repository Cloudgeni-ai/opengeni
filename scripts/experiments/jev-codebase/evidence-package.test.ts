import { test, expect } from "bun:test";
import { mergeEvidence, packEvidence } from "./evidence-package";
import type { Chunk } from "./core";
test("small referenced guard is retained without adding unrelated functions", () => {
  const text =
    "function guard(n:number) { return n === 1; }\nfunction other() { return false; }\nexport const answer = guard(1);";
  const r = packEvidence([c(3, 3, "export const answer = guard(1);")], [c(1, 3, text)], 1000);
  expect(r.contextHelpersAdded).toBe(1);
  expect(r.evidence.some((s) => s.text.includes("other"))).toBe(false);
  expect(r.evidence.some((s) => s.text.includes("function guard"))).toBe(true);
});
const c = (start: number, end: number, text: string): Chunk => ({
  id: `s${start}`,
  path: "sample.ts",
  startLine: start,
  endLine: end,
  text,
});
test("overlap is paid once and unread gaps remain gaps", () => {
  expect(mergeEvidence([c(1, 3, "a\nb\nc"), c(3, 5, "c\nd\ne")])).toEqual([
    { ...c(1, 5, "a\nb\nc\nd\ne") },
  ]);
  expect(mergeEvidence([c(1, 1, "a"), c(3, 3, "c")])).toHaveLength(2);
  expect(() => mergeEvidence([c(1, 2, "a\nb"), c(2, 2, "changed")])).toThrow(
    "conflicting_evidence_lines",
  );
});
test("budget considers merged unique lines before dropping a selected window", () => {
  const r = packEvidence([c(1, 3, "a\nb\nc"), c(3, 5, "c\nd\ne")], [], 9);
  expect(r.evidence[0].text).toBe("a\nb\nc\nd\ne");
  expect(r.omittedEssentialSpans).toBe(false);
});
test("used aliased imports are retained, unrelated bindings are not", () => {
  const file = c(
    1,
    4,
    'import { check as allowed } from "./policy";\nimport { unused } from "./elsewhere";\n\nexport const result = allowed();',
  );
  const r = packEvidence([c(4, 4, "export const result = allowed();")], [file], 1000);
  expect(r.contextImportsAdded).toBe(1);
  expect(r.evidence.map((s) => s.startLine)).toEqual([4, 1]);
  expect(r.evidence.some((s) => s.text.includes("unused"))).toBe(false);
});
test("import omission due to budget is explicit and never displaces selected logic", () => {
  const line = "export const result = allowed();",
    file = c(1, 2, 'import { allowed } from "./policy";\n' + line);
  const r = packEvidence([c(2, 2, line)], [file], line.length);
  expect(r.evidence).toHaveLength(1);
  expect(r.omittedContextSpans).toBe(true);
  expect(r.omittedEssentialSpans).toBe(false);
});
test("contextual keyword aliases and escaped identifier references retain imports", () => {
  for (const [binding, reference] of [
    ["type", "type"],
    ["check", "\\u0063heck"],
  ]) {
    const selected = `export const result = ${reference}();`;
    const file = c(1, 2, `import { check as ${binding} } from "./policy";\n${selected}`);
    expect(packEvidence([c(2, 2, selected)], [file], 1000).contextImportsAdded).toBe(1);
  }
});
