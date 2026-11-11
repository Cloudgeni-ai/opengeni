import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMENT_MARKER,
  MAINTAINER,
  SECTION_BEGIN,
  SECTION_END,
  SELF_APPROVAL_COMMAND,
  approvedOnHead,
  commentBody,
  evaluate,
  guardedFiles,
  guardedPatterns,
  loadGuardedPatterns,
  patternRegExp,
  statusFor,
  toReview,
  type Review,
} from "./model-request-review";

const root = resolve(import.meta.dir, "../..");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const section = (...lines: string[]) =>
  ["# owners", "", SECTION_BEGIN, ...lines, SECTION_END, ""].join("\n");
const review = (state: string, extra: Partial<Review> = {}): Review => ({
  login: MAINTAINER,
  state,
  commitId: HEAD,
  body: "",
  submittedAt: 1_000,
  ...extra,
});

describe("the guarded CODEOWNERS section", () => {
  test("reads root-anchored patterns owned by the maintainer alone", () => {
    expect(
      guardedPatterns(
        section(
          "# comment",
          "",
          `/a/b.ts @${MAINTAINER}`,
          `/c/   @JorgenSandhaug`,
          "/d/*.patch @jorgensandhaug",
        ),
      ),
    ).toEqual(["/a/b.ts", "/c/", "/d/*.patch"]);
  });

  test("refuses a section that is missing, empty, not last, shared or unanchored", () => {
    expect(() => guardedPatterns("/a @jorgensandhaug\n")).toThrow("no");
    expect(() => guardedPatterns(section("# nothing"))).toThrow("names no paths");
    expect(() => guardedPatterns(`${section("/a @jorgensandhaug")}/a @someone\n`)).toThrow("last");
    expect(() => guardedPatterns(section("/a @jorgensandhaug @someone"))).toThrow("alone");
    expect(() => guardedPatterns(section("/a @someone"))).toThrow("alone");
    expect(() => guardedPatterns(section("/a"))).toThrow("alone");
    expect(() => guardedPatterns(section("a/b.ts @jorgensandhaug"))).toThrow("root");
    expect(() => guardedPatterns(section("!/a @jorgensandhaug"))).toThrow("root");
    expect(() => guardedPatterns(section("/ @jorgensandhaug"))).toThrow("root");
    // Comments after the section are fine.
    expect(guardedPatterns(`${section("/a @jorgensandhaug")}# trailing note\n`)).toEqual(["/a"]);
  });
});

describe("the path matcher", () => {
  const matches = (pattern: string, path: string) => patternRegExp(pattern).test(path);

  test("a literal path names that file, or everything below that directory", () => {
    expect(matches("/packages/runtime/src/a.ts", "packages/runtime/src/a.ts")).toBe(true);
    expect(matches("/packages/runtime/src/a.ts", "packages/runtime/src/a.tsx")).toBe(false);
    expect(matches("/packages/runtime/src/a.ts", "packages/runtime/src/a-ts")).toBe(false);
    expect(matches("/packages/runtime/src/a.ts", "x/packages/runtime/src/a.ts")).toBe(false);
    expect(matches("/packages/runtime/src", "packages/runtime/src/a.ts")).toBe(true);
    expect(matches("/packages/runtime/src", "packages/runtime/srcs/a.ts")).toBe(false);
  });

  test("a trailing slash names a directory and everything below it", () => {
    expect(matches("/a/b/", "a/b/c.ts")).toBe(true);
    expect(matches("/a/b/", "a/b/c/d.ts")).toBe(true);
    expect(matches("/a/b/", "a/b")).toBe(false);
    expect(matches("/a/b/", "a/bc/d.ts")).toBe(false);
  });

  test("wildcards: * and ? stay in one segment, ** crosses segments", () => {
    expect(
      matches("/patches/@openai%2Fagents-*.patch", "patches/@openai%2Fagents-core@0.14.3.patch"),
    ).toBe(true);
    expect(matches("/patches/@openai%2Fagents-*.patch", "patches/zod@4.6.7.patch")).toBe(false);
    expect(matches("/docs/*", "docs/a.md")).toBe(true);
    expect(matches("/docs/*", "docs/a/b.md")).toBe(false);
    expect(matches("/a/?.ts", "a/b.ts")).toBe(true);
    expect(matches("/a/?.ts", "a/bc.ts")).toBe(false);
    expect(matches("/a/**/z.ts", "a/z.ts")).toBe(true);
    expect(matches("/a/**/z.ts", "a/b/c/z.ts")).toBe(true);
    expect(matches("/a/**", "a/b/c.ts")).toBe(true);
    // Regular-expression characters are literal.
    expect(matches("/a+b(c).ts", "a+b(c).ts")).toBe(true);
    expect(matches("/a+b(c).ts", "aab(c)xts")).toBe(false);
  });

  test("lists the guarded files once, sorted", () => {
    expect(guardedFiles(["/z.ts", "/a/"], ["z.ts", "a/1.ts", "b.ts", "z.ts"])).toEqual([
      "a/1.ts",
      "z.ts",
    ]);
  });
});

describe("the repository's guarded paths", () => {
  const patterns = loadGuardedPatterns();
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  test("every pattern still names something, so a rename cannot silently drop coverage", () => {
    for (const pattern of patterns) {
      if (/[*?]/.test(pattern))
        expect(guardedFiles([pattern], tracked).length, pattern).toBeGreaterThan(0);
      else expect(existsSync(resolve(root, pattern.slice(1))), pattern).toBe(true);
    }
  });

  test("covers the files of the Claude thinking-replay change, and none of its tests", () => {
    // The files of the change that resent earlier Claude thinking as plain text.
    const files = [
      ".changeset/claude-thinking-replay-never-breaks-a-chat.md",
      "apps/worker/test/anthropic-failure-diagnostic-purpose.test.ts",
      "docs/context-compaction.md",
      "packages/react/src/lib/format.ts",
      "packages/react/test/format.test.ts",
      "packages/runtime/src/anthropic-messages.ts",
      "packages/runtime/src/model-provider-routing.ts",
      "packages/runtime/src/opaque-reasoning-replay.ts",
      "packages/runtime/src/provider-history-adapter.ts",
      "packages/runtime/test/anthropic-progress-updates.test.ts",
      "packages/runtime/test/opaque-reasoning-replay-matrix.test.ts",
    ];
    expect(guardedFiles(patterns, files)).toEqual([
      "packages/runtime/src/anthropic-messages.ts",
      "packages/runtime/src/model-provider-routing.ts",
      "packages/runtime/src/opaque-reasoning-replay.ts",
      "packages/runtime/src/provider-history-adapter.ts",
    ]);
  });

  test("guards the gate itself, and no test or Skill", () => {
    expect(
      guardedFiles(patterns, [
        ".github/CODEOWNERS",
        ".github/workflows/model-request-review.yml",
        "scripts/ci/model-request-review.ts",
      ]),
    ).toHaveLength(3);
    const guarded = guardedFiles(patterns, tracked);
    expect(guarded.filter((f) => /\.test\.tsx?$|\/test\//.test(f))).toEqual([]);
    expect(guarded.filter((f) => /SKILL\.md$|bundled_[a-z_]*skills\//.test(f))).toEqual([]);
  });
});

describe("the maintainer's approval", () => {
  test("counts only his latest decisive review on the exact head", () => {
    expect(approvedOnHead([review("APPROVED")], HEAD, "someone")).toBe(true);
    expect(approvedOnHead([review("APPROVED", { login: "JorgenSandhaug" })], HEAD, "x")).toBe(true);
    expect(approvedOnHead([review("APPROVED", { commitId: OLD })], HEAD, "someone")).toBe(false);
    expect(approvedOnHead([review("APPROVED", { login: "someone-else" })], HEAD, "x")).toBe(false);
    expect(approvedOnHead([review("DISMISSED")], HEAD, "someone")).toBe(false);
    expect(approvedOnHead([review("APPROVED", { submittedAt: null })], HEAD, "x")).toBe(false);
    expect(approvedOnHead([], HEAD, "someone")).toBe(false);
    // A later "changes requested" revokes; a plain comment does not.
    expect(
      approvedOnHead(
        [review("APPROVED"), review("CHANGES_REQUESTED", { submittedAt: 2_000 })],
        HEAD,
        "x",
      ),
    ).toBe(false);
    expect(
      approvedOnHead(
        [
          review("CHANGES_REQUESTED", { submittedAt: 2_000 }),
          review("APPROVED", { submittedAt: 3_000 }),
        ],
        HEAD,
        "x",
      ),
    ).toBe(true);
    expect(
      approvedOnHead([review("APPROVED"), review("COMMENTED", { submittedAt: 2_000 })], HEAD, "x"),
    ).toBe(true);
    // Dismissing his later "changes requested" does not bring the approval back.
    expect(
      approvedOnHead([review("APPROVED"), review("DISMISSED", { submittedAt: 2_000 })], HEAD, "x"),
    ).toBe(false);
  });

  test("on his own PR, a comment review that starts with the command approves", () => {
    const command = review("COMMENTED", { body: `\n  ${SELF_APPROVAL_COMMAND}\nlooks right` });
    expect(approvedOnHead([command], HEAD, MAINTAINER)).toBe(true);
    // Not on anyone else's PR, not on another head, not mid-text.
    expect(approvedOnHead([command], HEAD, "someone")).toBe(false);
    expect(approvedOnHead([{ ...command, commitId: OLD }], HEAD, MAINTAINER)).toBe(false);
    expect(
      approvedOnHead(
        [review("COMMENTED", { body: `please ${SELF_APPROVAL_COMMAND}` })],
        HEAD,
        MAINTAINER,
      ),
    ).toBe(false);
    expect(
      approvedOnHead(
        [review("COMMENTED", { body: SELF_APPROVAL_COMMAND, login: "someone" })],
        HEAD,
        MAINTAINER,
      ),
    ).toBe(false);
  });

  test("reads a REST review", () => {
    expect(
      toReview({
        user: { login: MAINTAINER },
        state: "APPROVED",
        commit_id: HEAD,
        body: "ok",
        submitted_at: "2026-11-11T12:00:00Z",
      }),
    ).toEqual({
      login: MAINTAINER,
      state: "APPROVED",
      commitId: HEAD,
      body: "ok",
      submittedAt: Date.parse("2026-11-11T12:00:00Z"),
    });
  });
});

describe("the verdict", () => {
  const patterns = ["/packages/runtime/src/anthropic-messages.ts"];
  const guarded = "packages/runtime/src/anthropic-messages.ts";

  test("passes a PR that changes no guarded file without reading its reviews", async () => {
    let read = false;
    const verdict = await evaluate({
      patterns,
      files: ["README.md"],
      headSha: HEAD,
      author: "x",
      reviews: async () => {
        read = true;
        return [];
      },
    });
    expect(verdict).toEqual({ guarded: [], needsApproval: false, approved: false, pass: true });
    expect(read).toBe(false);
    expect(statusFor(verdict)).toEqual({
      state: "success",
      description: "Changes no model request files",
    });
  });

  test("fails a guarded PR until the head is approved, and fails closed on too many files", async () => {
    const blocked = await evaluate({
      patterns,
      files: [guarded, "README.md"],
      headSha: HEAD,
      author: "x",
      reviews: async () => [review("APPROVED", { commitId: OLD })],
    });
    expect(blocked).toEqual({
      guarded: [guarded],
      needsApproval: true,
      approved: false,
      pass: false,
    });
    expect(statusFor(blocked).state).toBe("failure");
    expect(statusFor(blocked).description).toBe(
      `Changes 1 model request file: needs ${MAINTAINER}'s approval of this head`,
    );

    const approved = await evaluate({
      patterns,
      files: [guarded],
      headSha: HEAD,
      author: "x",
      reviews: async () => [review("APPROVED")],
    });
    expect(approved.pass).toBe(true);
    expect(statusFor(approved)).toEqual({
      state: "success",
      description: `${MAINTAINER} approved this head`,
    });

    const unlisted = await evaluate({
      patterns,
      files: null,
      headSha: HEAD,
      author: "x",
      reviews: async () => [],
    });
    expect(unlisted).toMatchObject({ guarded: null, needsApproval: true, pass: false });
    expect(statusFor(unlisted).description).toStartWith("Too many files to check");
    for (const verdict of [blocked, approved, unlisted])
      expect(statusFor(verdict).description.length).toBeLessThanOrEqual(140);
  });

  test("the comment lists the guarded files and says how to approve", () => {
    const blocked = { guarded: [guarded], needsApproval: true, approved: false, pass: false };
    const body = commentBody(blocked, HEAD, "someone");
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain(`- \`${guarded}\``);
    expect(body).toContain(`@${MAINTAINER} approves its current head (\`${HEAD.slice(0, 10)}\`)`);
    expect(body).toContain("Keep it a draft");
    expect(body).not.toContain(SELF_APPROVAL_COMMAND);
    expect(commentBody(blocked, HEAD, MAINTAINER)).toContain(SELF_APPROVAL_COMMAND);
    const approved = commentBody({ ...blocked, approved: true, pass: true }, HEAD, "someone");
    expect(approved).toContain(`@${MAINTAINER} approved head`);
    expect(approved).not.toContain("Keep it a draft");
    expect(
      commentBody({ guarded: [], needsApproval: false, approved: false, pass: true }, HEAD, "x"),
    ).toContain("no longer changes");
  });
});

describe("the workflows", () => {
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");

  test("the gate runs main's code only, never the PR's", () => {
    const workflow = read(".github/workflows/model-request-review.yml");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("workflows: [Model request review signal]");
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflow).not.toContain("github.event.pull_request.head.sha");
    // Untrusted names reach the script through the environment only.
    expect(workflow).not.toMatch(/run: .*\$\{\{/);
    expect(read(".github/workflows/model-request-review-signal.yml")).toContain(
      "name: Model request review signal",
    );
  });

  test("the merge batcher checks out the gate and its CODEOWNERS section", () => {
    const batcher = read(".github/workflows/merge-batcher.yml");
    expect(batcher).toContain("/scripts/ci/model-request-review.ts");
    expect(batcher).toContain("/.github/CODEOWNERS");
  });
});
