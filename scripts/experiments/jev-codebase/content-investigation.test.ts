import { test, expect } from "bun:test";
import { searchContent, searchTerms } from "./content-search";
import { investigateContent } from "./content-investigation";
import { SourceTools } from "./trajectory";
import type { Snapshot, Question } from "./core";
const snapshot = (files: Record<string, string>): Snapshot => ({
  revision: "fixed",
  digest: "fixed",
  limited: false,
  excluded: 0,
  chunks: Object.entries(files).map(([path, text], i) => ({
    id: `f${i}`,
    path,
    startLine: 1,
    endLine: text.split("\n").length,
    text,
  })),
});
const answers = (qs: Record<string, Question>, choose: (id: string) => string) =>
  Object.fromEntries(
    Object.entries(qs).map(([id, q]) => {
      const proposed = choose(id);
      const choice =
        ["reference", "context"].includes(id) && !(proposed in q.criteria) ? "none" : proposed;
      return [
        id,
        {
          choice,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  );
test("search matches contents, never an attractive filename without matching code", () => {
  const s = new SourceTools(
    snapshot({
      "needle-policy.ts": "export const unrelated=1;",
      "boring.ts": "export function f() { return needle; }",
    }),
  );
  const r = searchContent(s, ["needle"]);
  expect(r.hits.map((h) => h.path)).toEqual(["boring.ts"]);
  expect(r.hits[0].text).toBe("export function f() { return needle; }");
});
test("caller search hints are preserved and initial retrieval is deterministic", () => {
  const request = {
    question: "Where is membership decided?",
    context: "creator identity",
    searchHints: ["knownCreators", "more creators"],
  };
  expect(searchTerms(request).slice(0, 2)).toEqual(request.searchHints);
  const s = new SourceTools(snapshot({ "a.ts": "const knownCreators = [];" }));
  expect(searchContent(s, searchTerms(request)).digest).toBe(
    searchContent(s, searchTerms({ ...request, searchHints: searchTerms(request) })).digest,
  );
});
test("content search paginates exact matches and rejects unbounded input", () => {
  const s = new SourceTools(
    snapshot(
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}.ts`, "const needle = 1;"])),
    ),
  );
  const a = searchContent(s, ["needle"]),
    b = searchContent(s, ["needle"], a.nextOffset!);
  expect(a.hits).toHaveLength(16);
  expect(b.hits).toHaveLength(4);
  expect(b.nextOffset).toBe(null);
  expect(searchContent(s, [], 0).hits).toEqual([]);
  expect(() => searchContent(s, ["needle"], -1)).toThrow("invalid_content_search");
});
test("content selected read returns exact evidence and typed binary answer", async () => {
  const s = snapshot({
    "misleading-policy.ts": "export const unrelated=1;",
    "actual.ts": "export function allows(x:boolean) { return x; }",
  });
  const r = await investigateContent(
    s,
    {
      question: "Does allows return x?",
      searchHints: ["allows"],
      requestedOutput: "answer_if_supported",
    },
    async (state, qs) => {
      expect(Object.values(qs).every((q) => q.instructions.includes("untrusted evidence"))).toBe(
        true,
      );
      return answers(qs, (id) =>
        id.startsWith("h")
          ? "read"
          : id.startsWith("r")
            ? "essential"
            : id === "action"
              ? "complete"
              : "yes",
      );
    },
  );
  expect(r.answer).toBe("yes");
  expect(r.status).toBe("evidence_ready");
  expect(r.evidence[0].path).toBe("actual.ts");
});
test("evidence mode suppresses binary answer and missing matches cannot prove no", async () => {
  const s = snapshot({ "a.ts": "const needle = true;" });
  const r = await investigateContent(
    s,
    { question: "needle", requestedOutput: "evidence" },
    async (_, qs) =>
      answers(qs, (id) =>
        id.startsWith("h")
          ? "read"
          : id.startsWith("r")
            ? "essential"
            : id === "action"
              ? "complete"
              : "yes",
      ),
  );
  expect(r.answer).toBe("indecisive");
  const missing = await investigateContent(
    s,
    { question: "absentToken", requestedOutput: "answer_if_supported" },
    async () => {
      throw new Error("unexpected_call");
    },
  );
  expect(missing.answer).toBe("indecisive");
  expect(missing.reasonCode).toBe("no_content_matches");
});
test("rejected first-page snippets broaden content search instead of committing to a filename", async () => {
  const s = snapshot(
    Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [
        `${String(i).padStart(2, "0")}.ts`,
        `export const needle${i} = ${i};`,
      ]),
    ),
  );
  let page = 0;
  const r = await investigateContent(
    s,
    { question: "needle", requestedOutput: "evidence" },
    async (_, qs) => {
      if (Object.keys(qs)[0].startsWith("h")) {
        page++;
        return answers(qs, () => (page === 1 ? "skip" : "read"));
      }
      return answers(qs, (id) =>
        id.startsWith("r") ? "essential" : id === "action" ? "complete" : "indecisive",
      );
    },
  );
  expect(page).toBe(2);
  expect(r.evidence.some((e) => e.path === "16.ts")).toBe(true);
});
test("source references support another content search after insufficient evidence", async () => {
  const s = snapshot({
    "a.ts": "export function initial() { return helper(); }",
    "b.ts": "export function helper() { return true; }",
  });
  let assessments = 0;
  const r = await investigateContent(
    s,
    { question: "initial", requestedOutput: "evidence" },
    async (_, qs) => {
      if (Object.keys(qs)[0].startsWith("h")) return answers(qs, () => "read");
      assessments++;
      return answers(qs, (id) =>
        id === "reference"
          ? "ref0"
          : id.startsWith("r")
            ? "essential"
            : id === "action"
              ? assessments === 1
                ? "references"
                : "complete"
              : "indecisive",
      );
    },
  );
  expect(r.trace.filter((t) => t.stage === "content_search")).toHaveLength(2);
  expect(r.evidence.some((e) => e.path === "b.ts")).toBe(true);
});
test("unsupported completion, invalid IDs and provider errors fail safely", async () => {
  const s = snapshot({ "a.ts": "const needle=true;" });
  const r = await investigateContent(
    s,
    { question: "needle", requestedOutput: "answer_if_supported" },
    async (_, qs) =>
      answers(qs, (id) =>
        id.startsWith("h")
          ? "read"
          : id.startsWith("r")
            ? "irrelevant"
            : id === "action"
              ? "complete"
              : "yes",
      ),
  );
  expect(r.answer).toBe("indecisive");
  expect(r.status).toBe("needs_guidance");
  await expect(investigateContent(s, { question: "needle" }, async () => ({}))).rejects.toThrow();
  await expect(
    investigateContent(s, { question: "needle" }, async () => {
      throw new Error("billing_unknown");
    }),
  ).rejects.toThrow("billing_unknown");
});
test("invalid hint lengths normalize consistently and unavailable matches are explicit", async () => {
  expect(
    searchTerms({ question: "needle", searchHints: ["x", " valid ", "z".repeat(121)] }),
  ).toEqual(["valid"]);
  expect(searchTerms({ question: "z".repeat(121) })).toEqual([]);
  const s = snapshot({ "huge.ts": "needle" + "x".repeat(13000) });
  const result = searchContent(new SourceTools(s), ["needle"]);
  expect(result.total).toBe(1);
  expect(result.unavailableWindows).toBe(1);
  const r = await investigateContent(s, { question: "needle" }, async () => {
    throw new Error("unexpected_call");
  });
  expect(r.reasonCode).toBe("matches_unavailable");
  expect(searchContent(new SourceTools(s), ["needle"], 0, 0).error).toBe("content_search_deadline");
});
test("bounded enclosing read includes the selected match after oversized preceding lines", async () => {
  const text = `export function outer() {\n/*${"x".repeat(13000)}*/\nreturn needle;\n}`;
  let assessed = false;
  await investigateContent(
    snapshot({ "a.ts": text }),
    { question: "needle" },
    async (state: any, qs) => {
      if (qs.action) {
        assessed = true;
        expect(state.source.some((r: any) => r.text.includes("return needle"))).toBe(true);
      }
      return answers(qs, (id) =>
        id.startsWith("h")
          ? "read"
          : id.startsWith("r")
            ? "essential"
            : id === "action"
              ? "complete"
              : "indecisive",
      );
    },
  );
  expect(assessed).toBe(true);
});
test("context added after assessment cannot authorize a decisive answer", async () => {
  const s = snapshot({
    "a.ts": 'import { guard } from "./policy";\nexport function needle() { return guard(); }',
  });
  const r = await investigateContent(
    s,
    { question: "needle", requestedOutput: "answer_if_supported" },
    async (_, qs) =>
      answers(qs, (id) =>
        id.startsWith("h")
          ? "read"
          : id.startsWith("r")
            ? "essential"
            : id === "action"
              ? "complete"
              : "yes",
      ),
  );
  expect(r.coverage.unassessedContextChars).toBeGreaterThan(0);
  expect(r.answer).toBe("indecisive");
});
test("selected matches beyond the per-round allowance survive for follow-up reads", async () => {
  const s = snapshot(
    Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`${i}.ts`, `export const needle${i}=true;`]),
    ),
  );
  let rounds = 0;
  const r = await investigateContent(s, { question: "needle" }, async (_, qs) => {
    if (!qs.action) return answers(qs, () => "read");
    rounds++;
    return answers(qs, (id) =>
      /^r\d+$/.test(id)
        ? "essential"
        : id === "action"
          ? rounds === 1
            ? "pending"
            : "complete"
          : "indecisive",
    );
  });
  expect(r.coverage.inspectedFiles).toBe(6);
  expect(r.coverage.pendingSelectedMatches).toBe(0);
});
test("truncated enclosing context is exposed and can be read before a decisive answer", async () => {
  const lines = [
    "export function outer() {",
    ...Array.from({ length: 140 }, (_, i) => `const x${i}=${i};`),
    "return needle;",
    ...Array.from({ length: 25 }, (_, i) => `const tail${i}=${i};`),
    "}",
  ];
  const r = await investigateContent(
    snapshot({ "a.ts": lines.join("\n") }),
    { question: "needle", requestedOutput: "answer_if_supported" },
    async (state: any, qs) => {
      if (!qs.action) return answers(qs, () => "read");
      return answers(qs, (id) =>
        /^r\d+$/.test(id)
          ? "essential"
          : id === "context"
            ? state.unreadEnclosingRanges.length
              ? "gap0"
              : "none"
            : id === "action"
              ? state.unreadEnclosingRanges.length
                ? "read_context"
                : "complete"
              : id === "answer"
                ? "yes"
                : "none",
      );
    },
  );
  expect(r.coverage.unreadEnclosingRanges).toEqual([]);
  expect(r.answer).toBe("yes");
});
test("reference candidates paginate to dependencies beyond the first 32 names", async () => {
  const s = snapshot({
    "a.ts": `export function needle(){${Array.from({ length: 40 }, (_, i) => `const local${i}=${i};`).join("")}return requiredHelper();}`,
    "b.ts": "export function requiredHelper(){return true;}",
  });
  const r = await investigateContent(s, { question: "needle" }, async (state: any, qs) => {
    if (!qs.action) return answers(qs, () => "read");
    const found = Object.entries(qs.reference.criteria).find(
      ([, v]) => v === "requiredHelper",
    )?.[0];
    return answers(qs, (id) =>
      /^r\d+$/.test(id)
        ? "essential"
        : id === "reference"
          ? (found ?? "none")
          : id === "action"
            ? state.source.some((x: any) => x.path === "b.ts")
              ? "complete"
              : found
                ? "references"
                : "more_references"
            : "indecisive",
    );
  });
  expect(r.evidence.some((e) => e.path === "b.ts")).toBe(true);
});
test("read-count budget never silently discards a ninth selected match", async () => {
  const s = snapshot(
    Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`${i}.ts`, `export const needle${i}=true;`]),
    ),
  );
  let rounds = 0;
  const r = await investigateContent(
    s,
    { question: "needle", requestedOutput: "answer_if_supported" },
    async (_, qs) => {
      if (!qs.action) return answers(qs, () => "read");
      rounds++;
      return answers(qs, (id) =>
        /^r\d+$/.test(id)
          ? "essential"
          : id === "action"
            ? rounds < 3
              ? "pending"
              : "complete"
            : id === "answer"
              ? "yes"
              : "none",
      );
    },
  );
  expect(r.coverage.pendingSelectedMatches).toBe(1);
  expect(r.coverage.readBlock).toBe("budget_blocked");
  expect(r.answer).toBe("indecisive");
  expect(r.status).toBe("partial");
});
test("character-budget rejected reads remain pending and cannot authorize yes", async () => {
  const s = snapshot(
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        `${i}.ts`,
        `export function f${i}(){\nconst needle=true;\n\n\n\n/*${"x".repeat(9000)}*/\nreturn true;\n}`,
      ]),
    ),
  );
  let rounds = 0;
  const r = await investigateContent(
    s,
    { question: "needle", requestedOutput: "answer_if_supported" },
    async (_, qs) => {
      if (!qs.action) return answers(qs, () => "read");
      rounds++;
      return answers(qs, (id) =>
        /^r\d+$/.test(id)
          ? "essential"
          : id === "action"
            ? rounds < 3
              ? "pending"
              : "complete"
            : id === "answer"
              ? "yes"
              : "none",
      );
    },
  );
  expect(r.coverage.pendingSelectedMatches).toBeGreaterThan(0);
  expect(r.coverage.readBlock).toBe("budget_blocked");
  expect(r.answer).toBe("indecisive");
  expect(r.internalChars).toBeLessThanOrEqual(48000);
});
