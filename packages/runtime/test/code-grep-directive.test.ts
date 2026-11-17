import { describe, expect, test } from "bun:test";
import {
  CODE_GREP_DIRECTIVE,
  CODE_GREP_SHELL_DIRECTIVE,
  CODE_SEARCH_DIRECTIVE,
  codeSearchDirectiveFor,
} from "../src";

describe("code search directive", () => {
  test("follows the deployment's code-search engine", () => {
    expect(codeSearchDirectiveFor({ codeSearchEngine: "search" })).toBe(CODE_SEARCH_DIRECTIVE);
    expect(codeSearchDirectiveFor({ codeSearchEngine: "grep" })).toBe(CODE_GREP_DIRECTIVE);
    expect(CODE_GREP_DIRECTIVE).toContain("`code_grep`");
    expect(CODE_GREP_DIRECTIVE).not.toContain("code_search");
  });

  test("names the cg command when code_grep is offered only from the shell", () => {
    expect(codeSearchDirectiveFor({ codeSearchEngine: "grep", codeGrepShellCommand: "on" })).toBe(
      CODE_GREP_DIRECTIVE,
    );
    expect(codeSearchDirectiveFor({ codeSearchEngine: "grep", codeGrepShellCommand: "only" })).toBe(
      CODE_GREP_SHELL_DIRECTIVE,
    );
    expect(
      codeSearchDirectiveFor({ codeSearchEngine: "search", codeGrepShellCommand: "only" }),
    ).toBe(CODE_SEARCH_DIRECTIVE);
    expect(CODE_GREP_SHELL_DIRECTIVE).toContain("`cg QUESTION PATTERN... [-- PATH...]`");
    expect(CODE_GREP_SHELL_DIRECTIVE).not.toContain("code_grep");
  });
});
