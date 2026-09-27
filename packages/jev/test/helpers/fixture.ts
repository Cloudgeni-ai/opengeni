/** Small fixture repository and a deterministic fake Jev for the code_search tests. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JevClient } from "../../src";

export const FIXTURE_FILES: Record<string, string | Uint8Array> = {
  "src/compaction.ts": [
    "// Compaction helpers.",
    "export const DEFAULT_COMPACTION_RATIO = 0.9;",
    "",
    "/** Token threshold at which a turn compacts its context. */",
    "export function compactionThresholdTokens(contextWindow: number, ratio = DEFAULT_COMPACTION_RATIO): number {",
    "  const clamped = clampRatio(ratio);",
    "  return Math.floor(contextWindow * clamped);",
    "}",
    "",
    "export function clampRatio(ratio: number): number {",
    "  if (ratio < MIN_RATIO) return MIN_RATIO;",
    "  if (ratio > 0.95) return 0.95;",
    "  return ratio;",
    "}",
    "",
    "export const MIN_RATIO = 0.5;",
    "",
  ].join("\n"),
  "src/turn.ts": [
    'import { compactionThresholdTokens } from "./compaction";',
    "",
    "export interface TurnInput {",
    "  tokens: number;",
    "  contextWindow: number;",
    "}",
    "",
    "export async function runTurn(input: TurnInput): Promise<string> {",
    "  const limit = compactionThresholdTokens(input.contextWindow);",
    "  if (input.tokens > limit) {",
    "    await compactNow(input);",
    '    return "compacted";',
    "  }",
    '  return "ok";',
    "}",
    "",
    "async function compactNow(input: TurnInput): Promise<void> {",
    "  input.tokens = Math.floor(input.tokens / 2);",
    "}",
    "",
  ].join("\n"),
  "src/unrelated.ts": [
    "// Rate limiter; has its own threshold unrelated to compaction.",
    "export const RATE_THRESHOLD = 10;",
    "export function overThreshold(n: number): boolean {",
    "  return n > RATE_THRESHOLD;",
    "}",
    "",
  ].join("\n"),
  "docs/compaction.md": [
    "# Compaction",
    "",
    "Intro text.",
    "",
    "## Threshold",
    "",
    "The compaction threshold is `compactionThresholdTokens(contextWindow)`: the context window times",
    "the ratio (default 0.9, clamped to 0.5-0.95). A turn compacts when its tokens exceed it.",
    "",
    "## Other",
    "",
    "Unrelated section.",
    "",
  ].join("\n"),
  "test/compaction.test.ts": [
    'import { compactionThresholdTokens } from "../src/compaction";',
    'it("computes the threshold", () => {',
    "  expect(compactionThresholdTokens(1000)).toBe(900);",
    "});",
    "",
  ].join("\n"),
  "node_modules/pkg/index.js":
    "module.exports = function compactionThresholdTokens() { return 1; };\n",
  "dist/bundle.js": "function compactionThresholdTokens(){return 2}\n",
};

export function makeFixtureRepo(
  files: Record<string, string | Uint8Array> = FIXTURE_FILES,
): string {
  const root = mkdtempSync(join(tmpdir(), "code-search-fixture-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}

export interface FakeJevLog {
  requests: Array<{ state: any; questions: Record<string, any> }>;
}

export interface FakeJevOptions {
  good?: string[];
  /** Every request returns this retryable status (503 by default when true). */
  fail?: boolean;
  rejectStatus?: number;
  /** Only the sufficiency-check request fails with 503. */
  failStatus?: boolean;
  log?: FakeJevLog;
}

/**
 * Deterministic fake Jev: P(yes) = 0.9 when the judged item (file entry, passage text or lead) mentions one of
 * `good`, else 0.1. The second sub-question is only covered by passages mentioning compactNow. Status
 * questions answer 0.85. Usage is the request size / 3.2.
 */
export function fakeJevFetch(opts: FakeJevOptions = {}) {
  const good = opts.good ?? ["compactionThresholdTokens", "compactNow", "clampRatio", "MIN_RATIO"];
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method === "GET") return new Response("{}", { status: 200 });
    const body = JSON.parse(String(init.body));
    opts.log?.requests.push({ state: body.state, questions: body.questions });
    if (opts.fail) return Response.json({ detail: "overloaded" }, { status: 503 });
    if (opts.rejectStatus)
      return Response.json({ detail: "bad request" }, { status: opts.rejectStatus });
    const st = body.state;
    if (opts.failStatus && st.evidence !== undefined)
      return Response.json({ detail: "down" }, { status: 503 });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      let text = "";
      if (st.files?.[id]) text = st.files[id];
      else if (id.startsWith("rel::") || id.startsWith("cov::"))
        text = st.passages?.[id.split("::")[1]!]?.text ?? "";
      else if (st.leads?.[id]) text = st.leads[id];
      else if (id === "overall" || id.startsWith("sub::")) text = "status";
      let p = text === "status" ? 0.85 : good.some((g) => text.includes(g)) ? 0.9 : 0.1;
      if (id.startsWith("cov::") && id.endsWith("::1") && !text.includes("compactNow")) p = 0.1;
      answers[id] = { type: "noul", noul: p };
    }
    const tokens = Math.ceil(String(init.body).length / 3.2);
    return Response.json({
      model: "jev-fake-1",
      answers,
      usage: { input_tokens: tokens, output_tokens: 0 },
    });
  };
}

export function fakeJevClient(opts: FakeJevOptions = {}): JevClient {
  return new JevClient({
    apiKey: "test-key",
    baseUrl: "http://fake-jev.local",
    fetch: fakeJevFetch(opts),
    maxRetries: 0,
  });
}

/** Passage blocks of a pack: `== path:start-end  rel x` headers and their `N| text` lines. */
export function packPassages(
  text: string,
): Array<{ path: string; start: number; end: number; lines: string[] }> {
  const out: Array<{ path: string; start: number; end: number; lines: string[] }> = [];
  for (const block of text.split("\n\n")) {
    const m = /^== (.+):(\d+)-(\d+)  rel /.exec(block);
    if (!m) continue;
    out.push({
      path: m[1]!,
      start: Number(m[2]),
      end: Number(m[3]),
      lines: block.split("\n").filter((l) => /^\d+\| /.test(l)),
    });
  }
  return out;
}
