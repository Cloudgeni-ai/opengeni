/**
 * tool.ts - the model-facing surface of code_search: name, description, input schema, argument
 * parsing and short error texts. The worker wires these to runCodeSearch.
 */
import { JevRequestError, JevUnavailableError } from "../client";
import { CodeSearchRipgrepMissingError, CodeSearchWorkspaceError } from "./workspace";

export const CODE_SEARCH_TOOL_NAME = "code_search";

export const CODE_SEARCH_TOOL_DESCRIPTION =
  "Find where something is implemented, configured or decided in the code under the working directory, in one call " +
  "instead of many separate searches and file reads. Give one precise question and 6-15 keywords: likely identifiers " +
  "(camelCase and snake_case), file-name fragments, config keys, error strings and synonyms. Optional subQuestions " +
  "split a question with distinct parts; optional paths limit the search to directories. It searches the whole " +
  "workspace in parallel, ranks files and passages with a fast relevance model, follows definitions one level, and " +
  "returns the most relevant source passages verbatim with file paths and line numbers plus a coverage status. Use " +
  "its evidence directly and search further only for gaps it reports.";

export const CODE_SEARCH_LIMITS = {
  questionMinChars: 3,
  questionMaxChars: 2000,
  keywordsMax: 20,
  keywordMaxChars: 120,
  subQuestionsMax: 3,
  subQuestionMaxChars: 1000,
  pathsMax: 8,
  pathMaxChars: 1000,
} as const;

const L = CODE_SEARCH_LIMITS;

/** Plain JSON (mutable arrays), so it fits any JSON-schema slot of a tool definition. */
export type CodeSearchJsonValue =
  | string
  | number
  | boolean
  | null
  | CodeSearchJsonValue[]
  | { [key: string]: CodeSearchJsonValue };

/** JSON schema of the tool input; parseCodeSearchArguments enforces the same rules. */
export const codeSearchInputSchema: { [key: string]: CodeSearchJsonValue } = {
  type: "object",
  properties: {
    question: {
      type: "string",
      minLength: L.questionMinChars,
      maxLength: L.questionMaxChars,
      description:
        "One precise question about the code, for example where a behavior is implemented or how a value is computed.",
    },
    keywords: {
      type: "array",
      minItems: 1,
      maxItems: L.keywordsMax,
      items: { type: "string", minLength: 1, maxLength: L.keywordMaxChars },
      description:
        "6-15 search keywords: likely identifiers (camelCase, snake_case, UPPER_CASE), file-name fragments, config or env keys, error strings, synonyms. Case and camel/snake/kebab variants are searched automatically.",
    },
    subQuestions: {
      type: "array",
      maxItems: L.subQuestionsMax,
      items: { type: "string", minLength: 1, maxLength: L.subQuestionMaxChars },
      description: "Optional: the distinct parts of a multi-part question, one per entry.",
    },
    paths: {
      type: "array",
      maxItems: L.pathsMax,
      items: { type: "string", minLength: 1, maxLength: L.pathMaxChars },
      description:
        "Optional: workspace-relative directories or files to limit the search to. Default: the whole workspace.",
    },
  },
  required: ["question", "keywords"],
  additionalProperties: false,
};

export interface CodeSearchArguments {
  question: string;
  keywords: string[];
  subQuestions: string[];
  paths: string[];
}

/** Invalid tool arguments; the message is written for the model. */
export class CodeSearchArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeSearchArgumentError";
  }
}

const KNOWN_ARGUMENTS = new Set(["question", "keywords", "subQuestions", "paths"]);

/** Validate and normalize tool arguments (trim, drop empty entries, dedupe, workspace-relative paths). */
export function parseCodeSearchArguments(args: Record<string, unknown>): CodeSearchArguments {
  const unknown = Object.keys(args).filter((k) => !KNOWN_ARGUMENTS.has(k));
  if (unknown.length) {
    throw new CodeSearchArgumentError(
      `unknown argument ${unknown.map((k) => `"${k}"`).join(", ")}; allowed: question, keywords, subQuestions, paths`,
    );
  }

  if (typeof args.question !== "string")
    throw new CodeSearchArgumentError("question is required and must be a string");
  const question = args.question.trim();
  if (question.length < L.questionMinChars)
    throw new CodeSearchArgumentError(`question must be at least ${L.questionMinChars} characters`);
  if (question.length > L.questionMaxChars)
    throw new CodeSearchArgumentError(`question must be at most ${L.questionMaxChars} characters`);

  const keywords = stringList(args.keywords, "keywords", true);
  if (!keywords.length)
    throw new CodeSearchArgumentError("keywords must contain at least one non-empty keyword");
  if (keywords.length > L.keywordsMax)
    throw new CodeSearchArgumentError(
      `keywords accepts at most ${L.keywordsMax} entries; keep the ${L.keywordsMax} most specific`,
    );
  const longKeyword = keywords.find((k) => k.length > L.keywordMaxChars);
  if (longKeyword)
    throw new CodeSearchArgumentError(
      `each keyword must be at most ${L.keywordMaxChars} characters; use short identifiers or phrases`,
    );

  const subQuestions = stringList(args.subQuestions, "subQuestions", false);
  if (subQuestions.length > L.subQuestionsMax)
    throw new CodeSearchArgumentError(`subQuestions accepts at most ${L.subQuestionsMax} entries`);
  if (subQuestions.some((s) => s.length > L.subQuestionMaxChars)) {
    throw new CodeSearchArgumentError(
      `each sub-question must be at most ${L.subQuestionMaxChars} characters`,
    );
  }

  const paths = [...new Set(stringList(args.paths, "paths", false).map(normalizePath))];
  if (paths.length > L.pathsMax)
    throw new CodeSearchArgumentError(`paths accepts at most ${L.pathsMax} entries`);

  return { question, keywords, subQuestions, paths };
}

function stringList(value: unknown, name: string, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required)
      throw new CodeSearchArgumentError(`${name} is required and must be an array of strings`);
    return [];
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new CodeSearchArgumentError(`${name} must be an array of strings`);
  }
  return [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
}

function normalizePath(raw: string): string {
  if (raw.length > L.pathMaxChars)
    throw new CodeSearchArgumentError(`each path must be at most ${L.pathMaxChars} characters`);
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new CodeSearchArgumentError(
      `path "${raw}" is absolute; give paths relative to the working directory`,
    );
  }
  let p = raw;
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  if (!p) p = ".";
  if (p.split("/").some((seg) => seg === "..")) {
    throw new CodeSearchArgumentError(
      `path "${raw}" leaves the working directory; ".." is not allowed`,
    );
  }
  if (p.startsWith("-")) throw new CodeSearchArgumentError(`path "${raw}" must not start with "-"`);
  return p;
}

const FALLBACK = "Search with exec_command (rg, sed) instead.";

/** Short model-facing text for a failed code_search call. */
export function renderCodeSearchError(error: unknown): string {
  const detail = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 240);
  if (error instanceof CodeSearchArgumentError)
    return `code_search: invalid arguments: ${error.message}.`;
  if (error instanceof JevUnavailableError)
    return `code_search is unavailable right now (${detail(error)}). ${FALLBACK}`;
  if (error instanceof JevRequestError)
    return `code_search failed: the relevance model rejected the request (${detail(error)}). ${FALLBACK}`;
  if (isRipgrepMissing(error)) {
    return "code_search cannot run here: ripgrep (rg) is not installed in this workspace. Search with exec_command (grep, find, sed) instead.";
  }
  if (error instanceof CodeSearchWorkspaceError)
    return `code_search could not search this workspace (${detail(error)}). ${FALLBACK}`;
  if (isAbort(error)) return "code_search was cancelled.";
  return `code_search failed unexpectedly (${detail(error)}). ${FALLBACK}`;
}

function isRipgrepMissing(error: unknown): boolean {
  if (error instanceof CodeSearchRipgrepMissingError) return true;
  if (!(error instanceof CodeSearchWorkspaceError)) return false;
  const m = error.message;
  return /ripgrep|\brg\b/i.test(m) && /not (installed|found)|missing|ENOENT|no such file/i.test(m);
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
