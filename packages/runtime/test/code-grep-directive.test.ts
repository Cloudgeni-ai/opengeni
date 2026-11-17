import { describe, expect, test } from "bun:test";
import { CODE_GREP_DIRECTIVE, CODE_SEARCH_DIRECTIVE, codeSearchDirectiveFor } from "../src";

describe("code search directive", () => {
  test("follows the deployment's code-search engine", () => {
    expect(codeSearchDirectiveFor({ codeSearchEngine: "search" })).toBe(CODE_SEARCH_DIRECTIVE);
    expect(codeSearchDirectiveFor({ codeSearchEngine: "grep" })).toBe(CODE_GREP_DIRECTIVE);
    expect(CODE_GREP_DIRECTIVE).toContain("`code_grep`");
    expect(CODE_GREP_DIRECTIVE).not.toContain("code_search");
  });
});
