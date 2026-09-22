import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedPath,
  investigate,
  localDependencies,
  loadSnapshot,
  namedEntryPaths,
  rankChunks,
  requiresRuntimeEvidence,
  termsFor,
  validateAnswers,
  wholeLineWindow,
  type Judge,
  type Question,
  type Snapshot,
} from "./core";
import { scoreInvestigation } from "./scoring";
import { SourceTools } from "./trajectory";

const snapshot: Snapshot = {
  revision: "fixed",
  digest: "hash",
  excluded: 0,
  limited: false,
  chunks: [
    {
      id: "e0",
      path: "src/cancel.ts",
      startLine: 1,
      endLine: 1,
      text: "export function run(signal) { signal.throwIfAborted(); execute(); }",
    },
    {
      id: "e1",
      path: "src/log.ts",
      startLine: 1,
      endLine: 1,
      text: "export const log = console.log;",
    },
  ],
};
const answer = (qs: Record<string, Question>, choices: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(qs).map(([id, q]) => [
      id,
      {
        choice: choices[id],
        probabilities: Object.fromEntries(
          Object.keys(q.criteria).map((k) => [k, k === choices[id] ? 1 : 0]),
        ),
      },
    ]),
  );
const judge =
  (choices: Record<string, string>): Judge =>
  async (_, qs) =>
    answer(qs, qs.next ? { next: "e0" } : choices);

describe("read-only investigation contract", () => {
  test("character budgets never label a truncated line as exact source", () => {
    const line = "export const x = '" + "x".repeat(9500) + "';";
    const decisive = "export const y = '" + "y".repeat(900) + "'; deny();";
    expect(wholeLineWindow([line, decisive])).toEqual([line]);
    expect(wholeLineWindow(["x".repeat(10001)])).toEqual([]);
    expect(wholeLineWindow(["one", "two"], 7)).toEqual(["one", "two"]);
  });
  test("subdir scopes cannot bypass sensitive ancestor exclusions", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-subdir-test-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
    };
    try {
      git("init");
      for (const dir of ["secrets", "credentials", "nested/.env.private", "src"]) {
        mkdirSync(join(root, dir), { recursive: true });
        await Bun.write(join(root, dir, "config.ts"), "export const synthetic = true;\n");
      }
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      );
      for (const scope of ["secrets", "credentials/", "nested/.env.private"]) {
        const s = loadSnapshot(root, "HEAD", scope);
        expect(s.chunks).toEqual([]);
        expect(s.excluded).toBe(1);
      }
      expect(loadSnapshot(root, "HEAD", "src").chunks.map((c) => c.path)).toEqual(["config.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("snapshot ignores dirty files and does not follow committed symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-snapshot-test-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
    };
    try {
      git("init");
      await Bun.write(join(root, "source.ts"), "export const value = 1;\n\n");
      await Bun.write(join(root, ".env.json"), '{"token":"synthetic-do-not-read"}');
      symlinkSync(".env.json", join(root, "alias.ts"));
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      );
      await Bun.write(join(root, "source.ts"), "export const value = 2;\n");
      const s = loadSnapshot(root);
      expect(s.chunks.map((c) => c.path)).toEqual(["source.ts"]);
      expect(s.chunks[0].text).toContain("value = 1");
      expect(s.excluded).toBe(2);
      expect(new SourceTools(s).read("source.ts", 1, 5)).toEqual({
        path: "source.ts",
        startLine: 1,
        endLine: 2,
        text: "export const value = 1;\n",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("excludes common sensitive and generated paths", () => {
    for (const path of [
      ".env",
      ".env.json",
      "secrets/config.json",
      "node_modules/a.ts",
      "private.key",
      "dist/app.js",
    ])
      expect(allowedPath(path)).toBe(false);
    expect(allowedPath("src/cancel.ts")).toBe(true);
  });
  test("keyword hints do not remove other candidates", () => {
    expect(
      rankChunks(
        snapshot.chunks,
        termsFor({ question: "Does cancellation work?", searchHints: ["cancel"] }),
      ),
    ).toHaveLength(2);
  });
  test("decisive answer retains exact supporting source", async () => {
    const r = await investigate(
      snapshot,
      { question: "Does run check signal?" },
      judge({ relevant: "keep", answer: "yes", basis: "witness", control: "finish" }),
    );
    expect(r.answer).toBe("yes");
    expect(r.evidence[0]).toEqual(snapshot.chunks[0]);
    expect(r.coverage.remainingChunks).toBe(1);
  });
  test("evidence-only request never emits yes/no", async () => {
    const r = await investigate(
      snapshot,
      { question: "Does run check signal?", requestedOutput: "evidence" },
      judge({ relevant: "keep", answer: "yes", basis: "witness", control: "finish" }),
    );
    expect(r.answer).toBe("indecisive");
    expect(r.evidence).toHaveLength(1);
  });
  test("exhaustive claim blocked with unexplored source", async () => {
    const r = await investigate(
      snapshot,
      { question: "Is there any unchecked call?" },
      judge({ relevant: "keep", answer: "no", basis: "exhaustive", control: "finish" }),
    );
    expect(r.answer).toBe("indecisive");
  });
  test("uncertain evidence is retained on yield", async () => {
    const r = await investigate(
      snapshot,
      { question: "Enabled in staging?" },
      judge({
        relevant: "uncertain",
        answer: "indecisive",
        basis: "insufficient",
        control: "yield",
      }),
    );
    expect(r.status).toBe("needs_guidance");
    expect(r.evidence).toHaveLength(1);
  });
  test("invented ID fails closed", async () => {
    const r = await investigate(snapshot, { question: "Find it" }, async () => ({
      next: { choice: "../../secret", probabilities: {} },
    }));
    expect(r.status).toBe("error");
    expect(r.evidence).toHaveLength(0);
  });
  test("provider failure cannot become a negative answer", async () => {
    const r = await investigate(snapshot, { question: "Does it work?" }, async () => {
      throw new Error("unavailable");
    });
    expect(r.status).toBe("error");
    expect(r.answer).toBe("indecisive");
  });
  test("rejects invalid probabilities", () => {
    expect(() =>
      validateAnswers(
        { a: { type: "choice", instructions: "Choose", criteria: { yes: "yes" } } },
        { a: { choice: "yes", probabilities: { yes: 2 } } },
      ),
    ).toThrow();
  });
  test("step budget produces partial evidence, no fabricated completion", async () => {
    const r = await investigate(
      snapshot,
      { question: "Trace behavior" },
      judge({ relevant: "keep", answer: "indecisive", basis: "insufficient", control: "continue" }),
      { maxSteps: 1, candidateBatch: 2, maxEvidenceChars: 1000, deadlineMs: 1000 },
    );
    expect(r.status).toBe("budget_exhausted");
    expect(r.evidence).toHaveLength(1);
  });
  test("runtime claims yield even if the model confidently says yes", async () => {
    const request = { question: "Does the live production deployment currently enable this?" };
    expect(requiresRuntimeEvidence(request)).toBe(true);
    const r = await investigate(
      snapshot,
      request,
      judge({ relevant: "keep", answer: "yes", basis: "witness", control: "finish" }),
    );
    expect(r.answer).toBe("indecisive");
    expect(r.status).toBe("needs_guidance");
  });
  test("unread runtime import blocks premature completion", async () => {
    const s = {
      ...snapshot,
      chunks: [
        {
          ...snapshot.chunks[0],
          text: "import { log } from './log'; export function run() { log(); }",
        },
        snapshot.chunks[1],
      ],
    };
    expect(localDependencies(s.chunks[0], s)).toEqual(["src/log.ts"]);
    expect(namedEntryPaths(s, { question: "Does run log?" })).toEqual(["src/cancel.ts"]);
    const r = await investigate(
      s,
      { question: "Does run log?" },
      judge({ relevant: "keep", answer: "yes", basis: "witness", control: "finish" }),
      { maxSteps: 1, candidateBatch: 2, maxEvidenceChars: 1000, deadlineMs: 1000 },
    );
    expect(r.answer).toBe("indecisive");
    expect(r.coverage.unresolvedLocalPaths).toEqual(["src/log.ts"]);
  });
  test("type-only imports do not force execution-path reads", () => {
    const c = {
      ...snapshot.chunks[0],
      text: "import type { Logger } from './log'; export function run() {}",
    };
    expect(localDependencies(c, snapshot)).toEqual([]);
  });
  test("missing or excluded relative imports remain unresolved and block completion", async () => {
    for (const specifier of ["./missing", "../secrets/config.js", "../outside.ts"]) {
      const s = {
        ...snapshot,
        excluded: 1,
        limited: true,
        chunks: [
          {
            ...snapshot.chunks[0],
            text: `import { check } from '${specifier}'; export function run() { return check(); }`,
          },
        ],
      };
      const expected = specifier === "./missing" ? "src/missing" : specifier.slice(3);
      expect(localDependencies(s.chunks[0], s)).toEqual([expected]);
      const r = await investigate(
        s,
        { question: "Does run enforce authentication?" },
        judge({ relevant: "keep", answer: "yes", basis: "witness", control: "finish" }),
      );
      expect(r.answer).toBe("indecisive");
      expect(r.status).toBe("partial");
      expect(r.coverage.unresolvedLocalPaths).toEqual([expected]);
    }
  });
  test("rejects an assessment returned after the deadline even if the judge ignores abort", async () => {
    let assessmentReturned = false;
    const r = await investigate(
      snapshot,
      { question: "Does run check signal?" },
      async (_, qs) => {
        if (qs.next) return answer(qs, { next: "e0" });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assessmentReturned = true;
        return answer(qs, { relevant: "keep", answer: "yes", basis: "witness", control: "finish" });
      },
      { maxSteps: 1, candidateBatch: 2, maxEvidenceChars: 1000, deadlineMs: 100 },
    );
    expect(assessmentReturned).toBe(true);
    expect(r.status).toBe("error");
    expect(r.reasonCode).toBe("deadline");
    expect(r.answer).toBe("indecisive");
  });
  test("scores operational validity, answer agreement and strict evidence separately", async () => {
    const r = await investigate(
      snapshot,
      { question: "Does run check signal?" },
      judge({ relevant: "keep", answer: "yes", basis: "witness", control: "finish" }),
    );
    expect(scoreInvestigation(r, "yes", ["src/cancel.ts"])).toEqual({
      operationalSuccess: true,
      answerCorrect: true,
      strictEvidenceSuccess: true,
      wrongDecisive: false,
      requiredPathRecall: 1,
    });
    const incomplete = scoreInvestigation(r, "yes", ["src/cancel.ts", "src/log.ts"]);
    expect(incomplete.answerCorrect).toBe(true);
    expect(incomplete.requiredPathRecall).toBe(0.5);
    expect(incomplete.strictEvidenceSuccess).toBe(false);
    expect(
      scoreInvestigation(
        {
          ...r,
          coverage: { ...r.coverage, unresolvedLocalPaths: ["src/missing"] },
        },
        "yes",
        ["src/cancel.ts"],
      ).strictEvidenceSuccess,
    ).toBe(false);
    for (const status of ["error", "budget_exhausted"] as const) {
      const failed = scoreInvestigation({ ...r, status, answer: "indecisive" }, "indecisive", []);
      expect(failed.operationalSuccess).toBe(false);
      expect(failed.answerCorrect).toBe(false);
      expect(failed.strictEvidenceSuccess).toBe(false);
    }
    const abstained = scoreInvestigation(
      { ...r, status: "needs_guidance", answer: "indecisive" },
      "indecisive",
      [],
    );
    expect(abstained.operationalSuccess).toBe(true);
    expect(abstained.answerCorrect).toBe(true);
    expect(abstained.strictEvidenceSuccess).toBe(true);
    const wrong = scoreInvestigation(r, "no", ["src/cancel.ts"]);
    expect(wrong.operationalSuccess).toBe(true);
    expect(wrong.answerCorrect).toBe(false);
    expect(wrong.strictEvidenceSuccess).toBe(false);
    expect(wrong.wrongDecisive).toBe(true);
  });
});
