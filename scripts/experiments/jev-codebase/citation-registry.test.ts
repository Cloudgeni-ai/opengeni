import { test, expect } from "bun:test";
import { CitationRegistry } from "./citation-registry";
test("stable citation handles resolve complete delivered ranges without model line arithmetic", () => {
  const r = new CitationRegistry(),
    span = { path: "a.ts", startLine: 51, endLine: 136 };
  const id = r.register(span);
  expect(r.register(span)).toBe(id);
  expect(r.resolve([id, id], [span])).toEqual([span]);
});
test("invented and budget-dropped evidence cannot be cited", () => {
  const r = new CitationRegistry(),
    id = r.register({ path: "a.ts", startLine: 1, endLine: 3 });
  expect(() => r.resolve([id], [])).toThrow("citation_not_delivered");
  expect(() => r.resolve(["c999"], [])).toThrow();
  expect(() =>
    r.resolve(
      [id],
      [
        { path: "a.ts", startLine: 1, endLine: 1 },
        { path: "a.ts", startLine: 3, endLine: 3 },
      ],
    ),
  ).toThrow();
});
