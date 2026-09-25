import { describe, expect, test } from "bun:test";
import {
  CODE_SEARCH_TOOL_DESCRIPTION,
  CODE_SEARCH_TOOL_NAME,
  CodeSearchArgumentError,
  CodeSearchRipgrepMissingError,
  CodeSearchWorkspaceError,
  JevRequestError,
  JevUnavailableError,
  codeSearchInputSchema,
  parseCodeSearchArguments,
  renderCodeSearchError,
} from "../src";

const base = {
  question: "Where is the compaction threshold computed?",
  keywords: ["compactionThreshold"],
};

function argError(args: Record<string, unknown>): string {
  try {
    parseCodeSearchArguments(args);
  } catch (e) {
    expect(e).toBeInstanceOf(CodeSearchArgumentError);
    return (e as Error).message;
  }
  throw new Error("expected CodeSearchArgumentError");
}

describe("tool surface", () => {
  test("name, description and schema", () => {
    expect(CODE_SEARCH_TOOL_NAME).toBe("code_search");
    expect(CODE_SEARCH_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(900);
    expect(CODE_SEARCH_TOOL_DESCRIPTION).toContain("6-15 keywords");
    expect(codeSearchInputSchema).toMatchObject({
      type: "object",
      required: ["question", "keywords"],
      additionalProperties: false,
      properties: {
        question: { type: "string", minLength: 3, maxLength: 2000 },
        keywords: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 120 },
        },
        subQuestions: { type: "array", maxItems: 3 },
        paths: { type: "array", maxItems: 8 },
      },
    });
    expect(JSON.parse(JSON.stringify(codeSearchInputSchema))).toEqual(codeSearchInputSchema);
  });
});

describe("parseCodeSearchArguments", () => {
  test("trims, drops empty entries and dedupes", () => {
    const a = parseCodeSearchArguments({
      question: "  Where is the compaction threshold computed?  ",
      keywords: [" compactionThreshold ", "", "compactionThreshold", "contextWindow"],
      subQuestions: ["  How is it computed? ", " ", "How is it computed?"],
      paths: ["./apps/worker/", "apps/worker", "packages//", "."],
    });
    expect(a).toEqual({
      question: "Where is the compaction threshold computed?",
      keywords: ["compactionThreshold", "contextWindow"],
      subQuestions: ["How is it computed?"],
      paths: ["apps/worker", "packages", "."],
    });
  });

  test("optional fields may be omitted or null", () => {
    expect(parseCodeSearchArguments({ ...base, subQuestions: null, paths: null })).toEqual({
      ...base,
      subQuestions: [],
      paths: [],
    });
    expect(parseCodeSearchArguments(base)).toEqual({ ...base, subQuestions: [], paths: [] });
  });

  test("rejects bad questions and keywords with model-readable messages", () => {
    expect(argError({ keywords: ["a"] })).toMatch(/question is required/);
    expect(argError({ question: " a ", keywords: ["x"] })).toMatch(/at least 3 characters/);
    expect(argError({ question: "q".repeat(2001), keywords: ["x"] })).toMatch(/at most 2000/);
    expect(argError({ question: base.question })).toMatch(/keywords is required/);
    expect(argError({ question: base.question, keywords: "a,b" })).toMatch(/array of strings/);
    expect(argError({ question: base.question, keywords: [" ", ""] })).toMatch(
      /at least one non-empty keyword/,
    );
    expect(
      argError({
        question: base.question,
        keywords: Array.from({ length: 21 }, (_, i) => `k${i}`),
      }),
    ).toMatch(/at most 20/);
    expect(argError({ question: base.question, keywords: ["k".repeat(121)] })).toMatch(
      /at most 120 characters/,
    );
    expect(argError({ ...base, subQuestions: ["a", "b", "c", "d"] })).toMatch(/at most 3/);
    expect(argError({ ...base, extra: 1 })).toMatch(/unknown argument "extra"/);
  });

  test("rejects absolute, escaping and option-like paths", () => {
    expect(argError({ ...base, paths: ["/etc"] })).toMatch(/absolute/);
    expect(argError({ ...base, paths: ["~/x"] })).toMatch(/absolute/);
    expect(argError({ ...base, paths: ["C:\\repo"] })).toMatch(/absolute/);
    expect(argError({ ...base, paths: ["../other"] })).toMatch(/leaves the working directory/);
    expect(argError({ ...base, paths: ["apps/../../x"] })).toMatch(/leaves the working directory/);
    expect(argError({ ...base, paths: ["-rf"] })).toMatch(/must not start with "-"/);
    expect(argError({ ...base, paths: Array.from({ length: 9 }, (_, i) => `p${i}`) })).toMatch(
      /at most 8/,
    );
  });
});

describe("renderCodeSearchError", () => {
  test("Jev unavailable points to exec_command", () => {
    const t = renderCodeSearchError(
      new JevUnavailableError("Jev unavailable after 3 attempts (HTTP 503)"),
    );
    expect(t).toBe(
      "code_search is unavailable right now (Jev unavailable after 3 attempts (HTTP 503)). Search with exec_command (rg, sed) instead.",
    );
  });
  test("missing ripgrep", () => {
    expect(renderCodeSearchError(new CodeSearchRipgrepMissingError())).toContain(
      "ripgrep (rg) is not installed in this workspace",
    );
    expect(
      renderCodeSearchError(
        new CodeSearchWorkspaceError("ripgrep (rg) is not installed in this workspace"),
      ),
    ).toContain("ripgrep (rg) is not installed in this workspace");
    expect(renderCodeSearchError(new CodeSearchWorkspaceError("spawn rg ENOENT"))).toContain(
      "is not installed",
    );
  });
  test("other failures", () => {
    expect(
      renderCodeSearchError(
        new JevRequestError("Jev rejected the request (HTTP 400: max_tokens_exceeded)"),
      ),
    ).toMatch(/^code_search failed: .*max_tokens_exceeded.*exec_command/);
    expect(renderCodeSearchError(new CodeSearchWorkspaceError("sandbox offline"))).toBe(
      "code_search could not search this workspace (sandbox offline). Search with exec_command (rg, sed) instead.",
    );
    expect(
      renderCodeSearchError(new CodeSearchArgumentError("keywords must be an array of strings")),
    ).toBe("code_search: invalid arguments: keywords must be an array of strings.");
    expect(
      renderCodeSearchError(new DOMException("The operation was aborted.", "AbortError")),
    ).toBe("code_search was cancelled.");
    expect(renderCodeSearchError(new Error("boom"))).toMatch(
      /^code_search failed unexpectedly \(boom\)/,
    );
    expect(renderCodeSearchError(new JevUnavailableError("x".repeat(1000))).length).toBeLessThan(
      400,
    );
  });
});
