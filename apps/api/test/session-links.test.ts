import { describe, expect, test } from "bun:test";
import { eventMatchesTrigger, githubOwnLogins, readGitHubDelivery } from "@opengeni/core";
import { classifySessionLinkUrl } from "@opengeni/contracts";
import {
  readGitHubIssueStatus,
  readGitHubPullRequestStatus,
  summarizeGitHubChecks,
  summarizeGitHubReviews,
} from "../src/integrations/session-link-status";
import { sessionLinkWakeRequest } from "../src/mcp/session-coordination-tools";

const encoder = new TextEncoder();

function link(url: string, title: string | null = null) {
  const classified = classifySessionLinkUrl(url);
  if (!classified) throw new Error(`unclassified ${url}`);
  return { url: classified.url, kind: classified.kind, ref: classified.ref, title };
}

function githubEvent(event: string, payload: Record<string, unknown>, sender = "octo") {
  const reading = readGitHubDelivery({
    headers: new Headers({ "x-github-event": event, "x-github-delivery": "d-1" }),
    body: encoder.encode(JSON.stringify({ ...payload, sender: { login: sender } })),
    receivedAt: new Date("2026-11-20T10:00:00.000Z"),
    ownLogins: githubOwnLogins(["opengeni-agent"]),
  });
  if (reading.kind !== "events") throw new Error(reading.reason);
  return reading.events[0]!;
}

const repository = { id: 1, name: "api", full_name: "acme/api", owner: { login: "acme" } };

function pullRequestClosed(number: number, merged: boolean, sender?: string) {
  return githubEvent(
    "pull_request",
    {
      action: "closed",
      repository,
      pull_request: {
        number,
        title: "Fix it",
        state: "closed",
        merged,
        html_url: `https://github.com/acme/api/pull/${number}`,
      },
    },
    sender,
  );
}

function trigger(request: ReturnType<typeof sessionLinkWakeRequest>) {
  return {
    eventTypes: [request.eventType],
    conditions: request.conditions,
    includeOwnEvents: true,
  };
}

describe("merge wake", () => {
  const request = sessionLinkWakeRequest(link("https://github.com/acme/api/pull/7"), "merged");

  test("fires on that pull request's merge only", () => {
    expect(eventMatchesTrigger(pullRequestClosed(7, true), trigger(request))).toBe(true);
    expect(eventMatchesTrigger(pullRequestClosed(7, false), trigger(request))).toBe(false);
    expect(eventMatchesTrigger(pullRequestClosed(8, true), trigger(request))).toBe(false);
  });

  test("fires when Opengeni's own app merged it", () => {
    expect(
      eventMatchesTrigger(pullRequestClosed(7, true, "opengeni-agent[bot]"), trigger(request)),
    ).toBe(true);
  });

  test("a link typed in another case still matches GitHub's spelling", () => {
    const typed = sessionLinkWakeRequest(
      link("https://github.com/ACME/Api/pull/7"),
      "merged",
      "acme/api",
    );
    expect(eventMatchesTrigger(pullRequestClosed(7, true), trigger(typed))).toBe(true);
  });

  test("asks the agent to report back where the work started", () => {
    expect(request.prompt).toContain("acme/api#7");
    expect(request.prompt).toContain("Report back where this work started");
  });

  test("a release wake matches the repository's published releases", () => {
    const release = sessionLinkWakeRequest(
      link("https://github.com/acme/api/pull/7"),
      "release_published",
    );
    const published = githubEvent("release", {
      action: "published",
      repository,
      release: { tag_name: "v1.2.0", html_url: "https://github.com/acme/api/releases/v1.2.0" },
    });
    expect(eventMatchesTrigger(published, trigger(release))).toBe(true);
    const otherRepo = githubEvent("release", {
      action: "published",
      repository: { ...repository, full_name: "acme/web" },
      release: { tag_name: "v1" },
    });
    expect(eventMatchesTrigger(otherRepo, trigger(release))).toBe(false);
  });

  test("refuses links that are not GitHub pull requests", () => {
    expect(() =>
      sessionLinkWakeRequest(link("https://github.com/acme/api/issues/3"), "merged"),
    ).toThrow();
    expect(() => sessionLinkWakeRequest(link("https://example.com/x"), "merged")).toThrow();
  });
});

describe("live GitHub status", () => {
  test("checks: failing beats pending beats passing; none without any", () => {
    expect(summarizeGitHubChecks([], null, 0)).toBe("none");
    expect(
      summarizeGitHubChecks(
        [
          { status: "completed", conclusion: "success" },
          { status: "in_progress", conclusion: null },
        ],
        "success",
        0,
      ),
    ).toBe("pending");
    expect(
      summarizeGitHubChecks(
        [
          { status: "completed", conclusion: "failure" },
          { status: "in_progress", conclusion: null },
        ],
        "success",
        0,
      ),
    ).toBe("failing");
    expect(summarizeGitHubChecks([], "failure", 1)).toBe("failing");
    expect(
      summarizeGitHubChecks([{ status: "completed", conclusion: "success" }], "pending", 0),
    ).toBe("passing");
  });

  test("reviews: each reviewer's latest decisive review counts", () => {
    expect(summarizeGitHubReviews([], 0)).toBe("none");
    expect(summarizeGitHubReviews([], 1)).toBe("review_required");
    expect(
      summarizeGitHubReviews(
        [
          { state: "CHANGES_REQUESTED", user: { login: "a" } },
          { state: "COMMENTED", user: { login: "a" } },
          { state: "APPROVED", user: { login: "a" } },
        ],
        0,
      ),
    ).toBe("approved");
    expect(
      summarizeGitHubReviews(
        [
          { state: "APPROVED", user: { login: "a" } },
          { state: "CHANGES_REQUESTED", user: { login: "b" } },
        ],
        0,
      ),
    ).toBe("changes_requested");
  });

  test("reads a pull request's state, checks and review", async () => {
    const responses: Record<string, unknown> = {
      "/repos/acme/api/pulls/7": {
        state: "open",
        draft: false,
        title: "Fix it",
        head: { sha: "abc" },
        requested_reviewers: [],
      },
      "/repos/acme/api/commits/abc/check-runs?per_page=100": {
        check_runs: [{ status: "completed", conclusion: "success" }],
      },
      "/repos/acme/api/commits/abc/status": { state: "pending", statuses: [] },
      "/repos/acme/api/pulls/7/reviews?per_page=100": [{ state: "APPROVED", user: { login: "a" } }],
    };
    const status = await readGitHubPullRequestStatus(
      async (path) => responses[path] ?? Promise.reject(new Error(path)),
      { owner: "acme", repo: "api", number: 7 },
    );
    expect(status).toEqual({
      state: "open",
      label: null,
      title: "Fix it",
      checks: "passing",
      review: "approved",
    });
  });

  test("a merged pull request skips checks and review; an issue reads open or done", async () => {
    const merged = await readGitHubPullRequestStatus(
      async () => ({ state: "closed", merged: true, title: "Fix it" }),
      { owner: "acme", repo: "api", number: 7 },
    );
    expect(merged.state).toBe("merged");
    expect(merged.checks).toBeNull();
    const issue = await readGitHubIssueStatus(async () => ({ state: "closed", title: "Bug" }), {
      owner: "acme",
      repo: "api",
      number: 3,
    });
    expect(issue).toMatchObject({ state: "done", title: "Bug" });
  });
});
