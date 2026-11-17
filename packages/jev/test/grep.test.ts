/** code_grep: the caller's patterns in parallel, excerpts around hits, judged waves, early stop and fallback. */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  DecisionRequestError,
  DecisionUnavailableError,
  type DecisionModel,
  type DecisionQuestion,
} from "@opengeni/decisions";
import {
  CODE_GREP_LIMITS,
  CodeSearchArgumentError,
  JevClient,
  createJevDecisionModel,
  parseCodeGrepArguments,
  renderCodeGrepError,
  runCodeGrep,
} from "../src";
import { makeFixtureRepo } from "./helpers/fixture";
import { LocalCodeSearchWorkspace } from "./helpers/local-workspace";

const describeWithRipgrep = Bun.which("rg") ? describe : describe.skip;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo(): string {
  const files: Record<string, string> = {
    "src/auth/token.ts": [
      "export function refreshToken(session: Session) {",
      "  const expiresAt = session.expiresAt;",
      "  if (expiresAt < Date.now()) return renewSession(session);",
      "  return session.token;",
      "}",
    ].join("\n"),
    "src/auth/renew.ts": [
      "export async function renewSession(session: Session) {",
      "  const res = await fetch('/renew', { method: 'POST' });",
      "  return (await res.json()).token;",
      "}",
    ].join("\n"),
    "docs/notes.md": "The token is refreshed by refreshToken when it expires.\n",
  };
  for (let i = 0; i < 30; i++)
    files[`src/noise/file${i}.ts`] =
      `// token helper ${i}\nexport const token${i} = "token-${i}";\n`;
  const root = makeFixtureRepo(files);
  roots.push(root);
  return root;
}

interface Call {
  ids: string[];
  stop: boolean;
}

/** A decision model that calls excerpts from the named paths relevant and records request shapes. */
function fakeModel(opts: {
  relevant: (path: string) => boolean;
  stop?: number;
  maxQuestionsPerRequest?: number;
  fail?: Error;
}): DecisionModel & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ...(opts.maxQuestionsPerRequest ? { maxQuestionsPerRequest: opts.maxQuestionsPerRequest } : {}),
    async decide(input, questions, options) {
      if (opts.fail) throw opts.fail;
      const ids = Object.keys(questions);
      const stop = ids.length === 1 && ids[0] === "stop";
      calls.push({ ids, stop });
      await options?.onUsage?.({
        requests: 1,
        inputTokens: 100,
        costUsd: 0.00001,
        model: "fake",
        provider: "fake",
        costSource: "estimate",
      });
      const state = input as { excerpts?: Record<string, { path: string }> };
      const answers = Object.fromEntries(
        ids.map((id) => {
          const q = questions[id] as DecisionQuestion;
          expect(q.type).toBe("predicate");
          const p = stop ? (opts.stop ?? 0) : opts.relevant(state.excerpts![id]!.path) ? 0.9 : 0.1;
          return [id, { type: "predicate", probability: p }];
        }),
      );
      return { answers } as never;
    },
  };
}

describeWithRipgrep("runCodeGrep", () => {
  test("runs every caller pattern within the sandbox rg allowlist and keeps only judged-relevant excerpts", async () => {
    const ws = new LocalCodeSearchWorkspace(repo());
    const model = fakeModel({ relevant: (p) => p.startsWith("src/auth/") });
    const r = await runCodeGrep({
      question: "How is an expired session token renewed?",
      patterns: ["refreshToken", "renewSession\\(", "token"],
      workspace: ws,
      decisionModel: model,
    });
    // One rg call per pattern; LocalCodeSearchWorkspace rejects flags outside the allowlist.
    expect(ws.calls.filter((c) => c.kind === "ripgrep")).toHaveLength(3);
    const shownPaths = new Set(r.excerpts.filter((e) => (e.p ?? 0) >= 0.5).map((e) => e.path));
    expect([...shownPaths].sort()).toEqual(["src/auth/renew.ts", "src/auth/token.ts"]);
    expect(r.text).toContain("--- src/auth/token.ts:");
    expect(r.text).not.toContain("--- src/noise/");
    expect(r.text).toContain("Other matching files");
    expect(r.stats.judge).toBe("on");
    expect(r.stats.decision.requests).toBeGreaterThan(0);
    expect(r.judgeError).toBeNull();
  });

  test("smart case by default, literal fallback for an invalid regex", async () => {
    const ws = new LocalCodeSearchWorkspace(repo());
    const r = await runCodeGrep({
      question: "Where is the renew call?",
      patterns: ["RENEWSESSION", "renewSession(", "renewsession"],
      workspace: ws,
    });
    const rg = ws.calls.filter((c) => c.kind === "ripgrep").map((c) => c.args);
    expect(rg[0]).not.toContain("-i");
    expect(rg[2]).toContain("-i");
    expect(rg[1]![rg[1]!.indexOf("-e") + 1]).toBe("renewSession\\(");
    expect(r.stats.invalidPatterns).toEqual([1]);
    expect(r.stats.patternFiles[0]).toBe(0);
    expect(r.stats.patternFiles[2]).toBeGreaterThan(0);
    expect(r.text).toContain("not a valid regex; searched literally");
  });

  test("batches excerpts to the provider's question cap", async () => {
    const ws = new LocalCodeSearchWorkspace(repo());
    const model = fakeModel({ relevant: () => false, maxQuestionsPerRequest: 3 });
    const r = await runCodeGrep({
      question: "token helpers",
      patterns: ["token"],
      workspace: ws,
      decisionModel: model,
    });
    const judging = model.calls.filter((c) => !c.stop);
    expect(judging.length).toBeGreaterThan(1);
    expect(Math.max(...judging.map((c) => c.ids.length))).toBeLessThanOrEqual(3);
    expect(r.stats.judged).toBe(Math.min(r.stats.excerpts, 4 * 24));
  });

  test("stops after the first wave once the stop question is confident", async () => {
    const ws = new LocalCodeSearchWorkspace(repo());
    const model = fakeModel({ relevant: (p) => p.includes("noise/file1"), stop: 0.95 });
    const r = await runCodeGrep({
      question: "token constants",
      patterns: ["token"],
      workspace: ws,
      decisionModel: model,
      limits: { waveSize: 8 },
    });
    expect(r.stats.excerpts).toBeGreaterThan(8);
    expect(r.stats.waves).toBeLessThan(Math.ceil(r.stats.excerpts / 8));
    expect(r.stats.stoppedEarly).toBe(true);
    expect(model.calls.some((c) => c.stop)).toBe(true);
    expect(r.text).toContain("stopped early");
  });

  test("does not ask the stop question before anything is relevant", async () => {
    const ws = new LocalCodeSearchWorkspace(repo());
    const model = fakeModel({ relevant: () => false, stop: 1 });
    const r = await runCodeGrep({
      question: "q?",
      patterns: ["token"],
      workspace: ws,
      decisionModel: model,
      limits: { waveSize: 8 },
    });
    expect(model.calls.some((c) => c.stop)).toBe(false);
    expect(r.stats.stoppedEarly).toBe(false);
    expect(r.stats.relevant).toBe(0);
  });

  test("a judge failure falls back to match order and reports the error", async () => {
    for (const fail of [
      new DecisionUnavailableError("down"),
      new DecisionRequestError("too big"),
    ]) {
      const ws = new LocalCodeSearchWorkspace(repo());
      const r = await runCodeGrep({
        question: "How is a token renewed?",
        patterns: ["renewSession"],
        workspace: ws,
        decisionModel: fakeModel({ relevant: () => true, fail }),
      });
      expect(r.stats.judge).toBe("failed");
      expect(r.judgeError).toBe(fail);
      expect(r.text).toContain("Relevance judging failed");
      expect(r.text).toContain("--- src/auth/");
    }
  });

  test("without a judge the excerpts come back in match order within the budget", async () => {
    const ws = new LocalCodeSearchWorkspace(repo());
    const r = await runCodeGrep({
      question: "q?",
      patterns: ["token", "renewSession"],
      workspace: ws,
      budgetChars: 600,
    });
    expect(r.stats.judge).toBe("off");
    expect(r.stats.shown).toBeGreaterThan(0);
    expect(r.stats.shown).toBeLessThan(r.stats.excerpts);
    // Files matching both patterns rank first.
    expect(r.text.indexOf("--- src/auth/")).toBeLessThan(r.text.indexOf("Other matching files"));
  });

  test("paths limit the search and missing paths are reported", async () => {
    const ws = new LocalCodeSearchWorkspace(repo());
    const r = await runCodeGrep({
      question: "q?",
      patterns: ["token"],
      paths: ["src/auth", "nope"],
      workspace: ws,
    });
    expect(r.excerpts.every((e) => e.path.startsWith("src/auth/"))).toBe(true);
    expect(r.text).toContain("paths not found (ignored): nope");
  });
});

describe("parseCodeGrepArguments", () => {
  test("keeps patterns verbatim and normalizes paths", () => {
    const a = parseCodeGrepArguments({
      question: "  where?  ",
      patterns: [" foo\\(", "bar", "bar", ""],
      paths: ["./src/", "src"],
      globs: ["*.ts"],
      ignoreCase: true,
    });
    expect(a).toEqual({
      question: "where?",
      patterns: [" foo\\(", "bar"],
      paths: ["src"],
      globs: ["*.ts"],
      ignoreCase: true,
    });
  });

  test("rejects bad input with model-facing messages", () => {
    const bad: Array<Record<string, unknown>> = [
      { question: "where?" },
      { question: "x", patterns: ["a"] },
      {
        question: "where?",
        patterns: Array.from({ length: CODE_GREP_LIMITS.patternsMax + 1 }, (_, i) => `p${i}`),
      },
      { question: "where?", patterns: ["a".repeat(CODE_GREP_LIMITS.patternMaxChars + 1)] },
      { question: "where?", patterns: ["a"], paths: ["/etc"] },
      { question: "where?", patterns: ["a"], paths: ["../x"] },
      { question: "where?", patterns: ["a"], ignoreCase: "yes" },
      { question: "where?", patterns: ["a"], keywords: ["a"] },
    ];
    for (const args of bad) {
      expect(() => parseCodeGrepArguments(args)).toThrow(CodeSearchArgumentError);
      try {
        parseCodeGrepArguments(args);
      } catch (error) {
        expect(renderCodeGrepError(error)).toStartWith("code_grep: invalid arguments:");
      }
    }
  });
});

describe("JevClient limits", () => {
  test("a smaller question cap is exposed to callers and used when chunking", async () => {
    const bodies: Array<{ questions: Record<string, unknown> }> = [];
    const client = new JevClient({
      apiKey: "test",
      limits: { maxQuestionsPerRequest: 3 },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
        bodies.push(body);
        return new Response(
          JSON.stringify({
            answers: Object.fromEntries(
              Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.5 }]),
            ),
            usage: { input_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    expect(client.limits.maxQuestionsPerRequest).toBe(3);
    const model = createJevDecisionModel(client);
    expect(model.maxQuestionsPerRequest).toBe(3);
    expect(
      createJevDecisionModel(new JevClient({ apiKey: "t" })).maxQuestionsPerRequest,
    ).toBeUndefined();
    const questions = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `q${i}`,
        { type: "predicate" as const, question: `Is ${i} even?` },
      ]),
    );
    await model.decide({ n: 1 }, questions);
    expect(bodies.length).toBe(3);
    expect(Math.max(...bodies.map((b) => Object.keys(b.questions).length))).toBe(3);
  });
});
