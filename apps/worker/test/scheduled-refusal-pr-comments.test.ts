import { describe, expect, test } from "bun:test";
import {
  githubEventPullRequest,
  postRefusedRunComments,
  refusedRunCause,
  refusedRunCommentBody,
  refusedRunCommentMarker,
  refusedRunPullRequests,
  REFUSED_RUN_COMMENT_WINDOW_MS,
} from "../src/scheduled-refusal-pr-comments";

// A run a pull request event started, refused before its chat started, says
// so on the pull request once per cause, only where the allowlist and GitHub
// confirm the repository, and never for a test event.

const repository = { id: 42, full_name: "acme/api" };
const person = { kind: "person" as const, name: "octocat" };

function event(type: string, data: Record<string, unknown>, actor = person) {
  return { sourceKind: "github" as const, type, actor, data: { repository, ...data } };
}

describe("refused pull request runs", () => {
  test("finds the pull request of PR events and PR comments only", () => {
    expect(
      githubEventPullRequest(event("pull_request.opened", { pull_request: { number: 7 } })),
    ).toEqual({ repositoryId: 42, owner: "acme", name: "api", number: 7 });
    expect(
      githubEventPullRequest(
        event("issue_comment.created", { issue: { number: 8, pull_request: true } }),
      )?.number,
    ).toBe(8);
    expect(
      githubEventPullRequest(
        event("pull_request_review_comment.created", { pull_request: { number: 9 } }),
      )?.number,
    ).toBe(9);
    // An issue's comment, a push, and a test event (no sender) aren't.
    expect(
      githubEventPullRequest(
        event("issue_comment.created", { issue: { number: 8, pull_request: false } }),
      ),
    ).toBeNull();
    expect(githubEventPullRequest(event("push", { branch: "main" }))).toBeNull();
    expect(
      githubEventPullRequest(
        event("pull_request.opened", { pull_request: { number: 7 } }, {
          kind: "person",
          name: null,
        } as never),
      ),
    ).toBeNull();
    expect(
      githubEventPullRequest({
        ...event("pull_request.opened", { pull_request: { number: 7 } }),
        data: { repository: { id: 42, full_name: "../api" }, pull_request: { number: 7 } },
      }),
    ).toBeNull();
    // The same pull request twice is one.
    expect(
      refusedRunPullRequests([
        event("pull_request.opened", { pull_request: { number: 7 } }),
        event("issue_comment.created", { issue: { number: 7, pull_request: true } }),
      ]),
    ).toHaveLength(1);
  });

  test("tells only refusals that stopped the run before its chat", () => {
    const base = {
      status: "failed" as const,
      sessionId: null,
      error: null,
      admissionRefusal: null,
      admissionDiagnostic: null,
    };
    expect(refusedRunCause({ ...base, error: "scheduled_run_authority_proof_rejected" })).toBe(
      "scheduled_run_authority_proof_rejected",
    );
    expect(refusedRunCause({ ...base, error: "scheduled_agent_unavailable" })).toBe(
      "scheduled_agent_unavailable",
    );
    expect(
      refusedRunCause({
        ...base,
        status: "skipped",
        admissionRefusal: { reason: "insufficient_credits", retryable: true } as never,
      }),
    ).toBe("insufficient_credits");
    expect(refusedRunCause({ ...base, admissionDiagnostic: {} as never })).toBe(
      "connection_account_unavailable",
    );
    // A run that started its chat, one still going, or an unknown failure isn't told.
    expect(
      refusedRunCause({
        ...base,
        sessionId: "11111111-1111-4111-8111-111111111111",
        error: "scheduled_agent_unavailable",
      }),
    ).toBeNull();
    expect(refusedRunCause({ ...base, status: "queued" })).toBeNull();
    expect(refusedRunCause({ ...base, error: "boom" })).toBeNull();
  });

  test("says what couldn't run and why in plain words, naming only shared automations", () => {
    const shared = refusedRunCommentBody({
      cause: "scheduled_run_authority_proof_rejected",
      automation: "PR reviewer: When a pull request opens",
    });
    expect(shared).toContain("“PR reviewer: When a pull request opens”");
    expect(shared).toContain("save it again");
    expect(shared).toContain("Its owner has been told in Opengeni.");
    expect(shared).not.toContain("scheduled_run_authority_proof_rejected.");
    expect(shared).toContain(refusedRunCommentMarker("scheduled_run_authority_proof_rejected"));
    expect(refusedRunCommentBody({ cause: "odd", automation: null })).toContain(
      "couldn't run an automation on this pull request: it was refused before it started.",
    );
    expect(refusedRunCommentMarker("a-b <x>")).toBe("<!-- opengeni:automation-refused:abx -->");
  });

  function github(existing: unknown[] = []) {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        ...(init.body ? { body: String(init.body) } : {}),
      });
      return init.method === "POST"
        ? new Response("{}", { status: 201 })
        : new Response(JSON.stringify(existing), { status: 200 });
    };
    return { calls, fetch };
  }

  const settings = { githubAppId: "1", githubAppPrivateKey: "k", githubAppSlug: "opengeni-agent" };
  const pullRequests = [{ repositoryId: 42, owner: "acme", name: "api", number: 7 }];
  const now = new Date("2026-11-24T08:00:00.000Z");
  const lookup = async () => ({ id: 42 }) as never;
  const mintToken = async () => "token";
  const input = {
    taskId: "task",
    cause: "scheduled_agent_unavailable",
    automation: "PR reviewer",
    pullRequests,
    installationFor: new Map([[42, 9]]),
  };

  test("posts one comment through the App, unless it said so recently", async () => {
    const fresh = github();
    const posted = await postRefusedRunComments(
      { settings, lookup, mintToken, fetch: fresh.fetch, now: () => now },
      input,
      () => undefined,
    );
    expect(posted).toBe(1);
    expect(fresh.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    const since = new Date(now.getTime() - REFUSED_RUN_COMMENT_WINDOW_MS).toISOString();
    expect(fresh.calls[0]!.url).toBe(
      `https://api.github.com/repos/acme/api/issues/7/comments?since=${encodeURIComponent(since)}&per_page=100`,
    );
    expect(JSON.parse(fresh.calls[1]!.body!).body).toContain("its agent was deleted");

    const marker = refusedRunCommentMarker("scheduled_agent_unavailable");
    const told = github([{ user: { login: "opengeni-agent[bot]" }, body: `x ${marker}` }]);
    expect(
      await postRefusedRunComments(
        { settings, lookup, mintToken, fetch: told.fetch, now: () => now },
        input,
        () => undefined,
      ),
    ).toBe(0);
    expect(told.calls.map((call) => call.method)).toEqual(["GET"]);
    // Someone else quoting the marker doesn't silence it; another cause is told.
    const quoted = github([{ user: { login: "octocat" }, body: marker }]);
    expect(
      await postRefusedRunComments(
        { settings, lookup, mintToken, fetch: quoted.fetch, now: () => now },
        input,
        () => undefined,
      ),
    ).toBe(1);
    const other = github([{ user: { login: "opengeni-agent[bot]" }, body: marker }]);
    expect(
      await postRefusedRunComments(
        { settings, lookup, mintToken, fetch: other.fetch, now: () => now },
        { ...input, cause: "insufficient_credits" },
        () => undefined,
      ),
    ).toBe(1);
  });

  test("never comments where the allowlist or GitHub doesn't confirm the repository", async () => {
    const none = github();
    expect(
      await postRefusedRunComments(
        { settings, lookup, mintToken, fetch: none.fetch, now: () => now },
        { ...input, installationFor: new Map() },
        () => undefined,
      ),
    ).toBe(0);
    expect(
      await postRefusedRunComments(
        {
          settings,
          lookup: async () => ({ id: 43 }) as never,
          mintToken,
          fetch: none.fetch,
          now: () => now,
        },
        input,
        () => undefined,
      ),
    ).toBe(0);
    expect(
      await postRefusedRunComments(
        { settings, lookup: null, mintToken, fetch: none.fetch, now: () => now },
        input,
        () => undefined,
      ),
    ).toBe(0);
    expect(none.calls).toEqual([]);
  });
});
