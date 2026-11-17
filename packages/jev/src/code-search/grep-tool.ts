/**
 * grep-tool.ts - the model-facing surface of code_grep: name, description, input schema, argument
 * parsing and short error texts. The worker wires these to runCodeGrep.
 */
import {
  CodeSearchArgumentError,
  normalizePath,
  stringList,
  type CodeSearchJsonValue,
} from "./tool";
import { CodeSearchRipgrepMissingError, CodeSearchWorkspaceError } from "./workspace";

export const CODE_GREP_TOOL_NAME = "code_grep";

export const CODE_GREP_TOOL_DESCRIPTION =
  "Search the code under the working directory with several ripgrep patterns at once and get back only the " +
  "excerpts that matter. Pass the question you are answering and the patterns you would otherwise grep for " +
  "(identifiers, strings, regular expressions). The patterns run in parallel; each hit is widened to its enclosing " +
  "function or block; a fast relevance model keeps the excerpts that bear on the question and stops once they " +
  "suffice. Returns those excerpts with paths and line numbers, then the other matching files it did not show. " +
  "Follow up with another search or a file read when something is missing.";

export const CODE_GREP_LIMITS = {
  questionMinChars: 3,
  questionMaxChars: 2000,
  patternsMax: 8,
  patternMaxChars: 300,
  pathsMax: 8,
  globsMax: 8,
  globMaxChars: 200,
} as const;

const L = CODE_GREP_LIMITS;

export const codeGrepInputSchema: { [key: string]: CodeSearchJsonValue } = {
  type: "object",
  properties: {
    question: {
      type: "string",
      minLength: L.questionMinChars,
      maxLength: L.questionMaxChars,
      description:
        "What you are trying to find or answer; used to judge which excerpts are relevant.",
    },
    patterns: {
      type: "array",
      minItems: 1,
      maxItems: L.patternsMax,
      items: { type: "string", minLength: 1, maxLength: L.patternMaxChars },
      description:
        "1-8 ripgrep regular expressions or literal strings, as you would pass to rg -e. Smart case: case-insensitive unless the pattern has an upper-case letter.",
    },
    paths: {
      type: "array",
      maxItems: L.pathsMax,
      items: { type: "string", minLength: 1, maxLength: 1000 },
      description:
        "Optional: workspace-relative files or directories to search. Default: the whole workspace.",
    },
    globs: {
      type: "array",
      maxItems: L.globsMax,
      items: { type: "string", minLength: 1, maxLength: L.globMaxChars },
      description: "Optional: ripgrep globs such as *.py or !**/tests/**.",
    },
    ignoreCase: {
      type: "boolean",
      description:
        "Optional: true for case-insensitive, false for case-sensitive. Default: smart case.",
    },
  },
  required: ["question", "patterns"],
  additionalProperties: false,
};

export interface CodeGrepArguments {
  question: string;
  patterns: string[];
  paths: string[];
  globs: string[];
  ignoreCase: boolean | undefined;
}

const KNOWN = new Set(["question", "patterns", "paths", "globs", "ignoreCase"]);

/** Validate and normalize code_grep arguments. Patterns keep their exact text (no trimming). */
export function parseCodeGrepArguments(args: Record<string, unknown>): CodeGrepArguments {
  const unknown = Object.keys(args).filter((k) => !KNOWN.has(k));
  if (unknown.length) {
    throw new CodeSearchArgumentError(
      `unknown argument ${unknown.map((k) => `"${k}"`).join(", ")}; allowed: question, patterns, paths, globs, ignoreCase`,
    );
  }
  if (typeof args.question !== "string")
    throw new CodeSearchArgumentError("question is required and must be a string");
  const question = args.question.trim();
  if (question.length < L.questionMinChars)
    throw new CodeSearchArgumentError(`question must be at least ${L.questionMinChars} characters`);
  if (question.length > L.questionMaxChars)
    throw new CodeSearchArgumentError(`question must be at most ${L.questionMaxChars} characters`);

  if (!Array.isArray(args.patterns) || args.patterns.some((p) => typeof p !== "string"))
    throw new CodeSearchArgumentError("patterns is required and must be an array of strings");
  const patterns = [...new Set((args.patterns as string[]).filter((p) => p.trim().length > 0))];
  if (!patterns.length)
    throw new CodeSearchArgumentError("patterns must contain at least one non-empty pattern");
  if (patterns.length > L.patternsMax)
    throw new CodeSearchArgumentError(
      `patterns accepts at most ${L.patternsMax} entries; split the search into two calls`,
    );
  if (patterns.some((p) => p.length > L.patternMaxChars))
    throw new CodeSearchArgumentError(
      `each pattern must be at most ${L.patternMaxChars} characters`,
    );
  if (patterns.some((p) => p.includes("\0")))
    throw new CodeSearchArgumentError("patterns must not contain NUL");

  const paths = [...new Set(stringList(args.paths, "paths", false).map(normalizePath))];
  if (paths.length > L.pathsMax)
    throw new CodeSearchArgumentError(`paths accepts at most ${L.pathsMax} entries`);
  const globs = stringList(args.globs, "globs", false);
  if (globs.length > L.globsMax)
    throw new CodeSearchArgumentError(`globs accepts at most ${L.globsMax} entries`);
  if (globs.some((g) => g.length > L.globMaxChars || g.includes("\0")))
    throw new CodeSearchArgumentError(`each glob must be at most ${L.globMaxChars} characters`);

  if (
    args.ignoreCase !== undefined &&
    args.ignoreCase !== null &&
    typeof args.ignoreCase !== "boolean"
  )
    throw new CodeSearchArgumentError("ignoreCase must be a boolean");
  const ignoreCase = typeof args.ignoreCase === "boolean" ? args.ignoreCase : undefined;
  return { question, patterns, paths, globs, ignoreCase };
}

const FALLBACK = "Search with exec_command (rg, sed) instead.";

/** Short model-facing text for a failed code_grep call. Judge failures never reach here: they fall back. */
export function renderCodeGrepError(error: unknown): string {
  const detail = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 240);
  if (error instanceof CodeSearchArgumentError)
    return `code_grep: invalid arguments: ${error.message}.`;
  if (error instanceof CodeSearchRipgrepMissingError)
    return "code_grep cannot run here: ripgrep (rg) is not installed in this workspace. Search with exec_command (grep, find, sed) instead.";
  if (error instanceof CodeSearchWorkspaceError)
    return `code_grep could not search this workspace (${detail(error)}). ${FALLBACK}`;
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  )
    return "code_grep was cancelled.";
  return `code_grep failed unexpectedly (${detail(error)}). ${FALLBACK}`;
}
