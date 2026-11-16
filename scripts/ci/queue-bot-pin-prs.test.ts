import { describe, expect, test } from "bun:test";
import {
  BOT_LOGIN,
  githubApi,
  queueBotPinPulls,
  queueVerdict,
  type CheckRunFacts,
  type CommitFacts,
  type PullFacts,
} from "./queue-bot-pin-prs";

const REPOSITORY = "Cloudgeni-ai/opengeni";
const HEAD = "e6409e01474e2a841407f840b8e70329a5d98c2f";

function pull(overrides: Partial<PullFacts> = {}): PullFacts {
  return {
    number: 7625,
    state: "open",
    draft: false,
    author: BOT_LOGIN,
    headRef: "chore/browser-engine-pins-auto",
    headSha: HEAD,
    headRepository: REPOSITORY,
    baseRepository: REPOSITORY,
    labels: [],
    mergeable: true,
    ...overrides,
  };
}
const botCommits: CommitFacts[] = [{ author: BOT_LOGIN, committer: BOT_LOGIN }];
const green: CheckRunFacts[] = [{ name: "PR CI", status: "completed", conclusion: "success" }];

describe("queueVerdict", () => {
  test("queues a bot pin-refresh PR whose PR CI passed on its head", () => {
    expect(queueVerdict(pull(), botCommits, green)).toEqual({ queue: true });
    expect(
      queueVerdict(pull({ headRef: "chore/xai-client-version-auto" }), botCommits, green),
    ).toEqual({ queue: true });
    // GitHub still computing mergeability is not a conflict.
    expect(queueVerdict(pull({ mergeable: null }), botCommits, green)).toEqual({ queue: true });
    // A failed run followed by a passing one on the same head counts.
    expect(
      queueVerdict(pull(), botCommits, [
        { name: "PR CI", status: "completed", conclusion: "failure" },
        ...green,
      ]),
    ).toEqual({ queue: true });
  });

  test("never queues a human's PR or a bot branch a human pushed to", () => {
    const cases: [PullFacts, CommitFacts[]][] = [
      [pull({ author: "benyhh" }), botCommits],
      [pull({ headRef: "benyhh/browser-engine-pins" }), botCommits],
      [pull({ headRepository: "someone/opengeni" }), botCommits],
      [pull({ headRepository: null }), botCommits],
      [pull(), [...botCommits, { author: "benyhh", committer: "benyhh" }]],
      [pull(), [{ author: BOT_LOGIN, committer: "web-flow" }]],
      [pull(), [{ author: null, committer: BOT_LOGIN }]],
      [pull(), []],
    ];
    for (const [facts, commits] of cases) {
      expect(queueVerdict(facts, commits, green).queue).toBe(false);
    }
  });

  test("waits until it can land", () => {
    const cases: [PullFacts, CheckRunFacts[]][] = [
      [pull({ state: "closed" }), green],
      [pull({ draft: true }), green],
      [pull({ mergeable: false }), green],
      [pull({ labels: ["queue-ready"] }), green],
      [pull(), []],
      [pull(), [{ name: "PR CI", status: "in_progress", conclusion: null }]],
      [pull(), [{ name: "PR CI", status: "completed", conclusion: "failure" }]],
      [pull(), [{ name: "PR fast checks", status: "completed", conclusion: "success" }]],
      [pull(), [...green, { name: "PR CI", status: "queued", conclusion: null }]],
    ];
    for (const [facts, checks] of cases) {
      expect(queueVerdict(facts, botCommits, checks).queue).toBe(false);
    }
  });
});

describe("queueBotPinPulls", () => {
  function fakeGitHub(input: {
    pulls: Record<string, unknown[]>;
    detail: Record<string, unknown>;
  }) {
    const requests: { method: string; path: string; body?: unknown }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const path = url.replace(`https://api.github.com/repos/${REPOSITORY}/`, "");
      const method = init?.method ?? "GET";
      requests.push({
        method,
        path,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      let body: unknown = null;
      if (path.startsWith("pulls?")) {
        const head = decodeURIComponent(new URL(url).searchParams.get("head")!);
        body = input.pulls[head] ?? [];
      } else if (/^pulls\/\d+$/.test(path)) body = input.detail[path.split("/")[1]!];
      else if (/^pulls\/\d+\/commits/.test(path))
        body = [{ author: { login: BOT_LOGIN }, committer: { login: BOT_LOGIN } }];
      else if (path.startsWith("commits/")) body = { check_runs: green };
      else if (path.startsWith("issues/")) body = [];
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return { api: githubApi({ token: "token", repository: REPOSITORY, fetch }), requests };
  }
  const restPull = (number: number, ref: string, labels: string[] = []) => ({
    number,
    state: "open",
    draft: false,
    user: { login: BOT_LOGIN },
    head: { ref, sha: HEAD, repo: { full_name: REPOSITORY } },
    base: { repo: { full_name: REPOSITORY } },
    labels: labels.map((name) => ({ name })),
    mergeable: true,
  });

  test("labels a ready PR queue-ready, once, and only on the bot branches", async () => {
    const { api, requests } = fakeGitHub({
      pulls: {
        "Cloudgeni-ai:chore/browser-engine-pins-auto": [
          restPull(7625, "chore/browser-engine-pins-auto"),
        ],
        "Cloudgeni-ai:chore/xai-client-version-auto": [
          restPull(7700, "chore/xai-client-version-auto", ["queue-ready"]),
        ],
      },
      detail: {
        "7625": restPull(7625, "chore/browser-engine-pins-auto"),
        "7700": restPull(7700, "chore/xai-client-version-auto", ["queue-ready"]),
      },
    });
    const report = await queueBotPinPulls({ api, owner: "Cloudgeni-ai" });
    expect(report).toEqual([
      `#7625: queued ${HEAD.slice(0, 10)}`,
      "#7700: not queued, it is already queued",
    ]);
    expect(requests.filter((request) => request.method !== "GET")).toEqual([
      { method: "POST", path: "issues/7625/labels", body: { labels: ["queue-ready"] } },
    ]);
    // Only the two pin branches are looked up.
    expect(
      requests.filter((request) => request.path.startsWith("pulls?")).map((r) => r.path),
    ).toEqual([
      "pulls?state=open&head=Cloudgeni-ai%3Achore%2Fbrowser-engine-pins-auto",
      "pulls?state=open&head=Cloudgeni-ai%3Achore%2Fxai-client-version-auto",
    ]);
  });

  test("a dry run writes nothing", async () => {
    const { api, requests } = fakeGitHub({
      pulls: {
        "Cloudgeni-ai:chore/browser-engine-pins-auto": [
          restPull(7625, "chore/browser-engine-pins-auto"),
        ],
      },
      detail: { "7625": restPull(7625, "chore/browser-engine-pins-auto") },
    });
    expect(await queueBotPinPulls({ api, owner: "Cloudgeni-ai", dryRun: true })).toEqual([
      `#7625: would queue ${HEAD.slice(0, 10)}`,
      "chore/xai-client-version-auto: no open pull request",
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });
});
