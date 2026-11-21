import { describe, expect, test } from "bun:test";
import { PersonalGitHubReadError } from "../src/domain/personal-github-reader";
import {
  githubPersonalReadEvents,
  githubPersonalTargets,
  githubReadEvent,
  githubReadEventTypeCatalog,
} from "../src/domain/event-triggers";
import { eventMatchesTrigger } from "../src/domain/event-triggers/matching";

describe("GitHub (your connection)", () => {
  test("reads only the pull requests and repositories its triggers name", () => {
    const early = new Date("2026-11-21T10:00:00Z");
    const late = new Date("2026-11-21T11:00:00Z");
    const merged = (number: unknown) => [
      { field: "data.repository.full_name", op: "equals", value: "Acme/API" },
      { field: "data.pull_request.number", op: "equals", value: number },
      { field: "data.pull_request.merged", op: "equals", value: true },
    ];
    const targets = githubPersonalTargets([
      { eventTypes: ["pull_request.closed"], conditions: merged(7), createdAt: late },
      { eventTypes: ["pull_request.closed"], conditions: merged(7), createdAt: early },
      // No number: nothing to poll.
      { eventTypes: ["pull_request.closed"], conditions: merged(undefined), createdAt: early },
      {
        eventTypes: ["release.published"],
        conditions: [{ field: "data.repository.full_name", op: "equals", value: "Acme/API" }],
        createdAt: late,
      },
      // Not a repository name.
      {
        eventTypes: ["release.published"],
        conditions: [{ field: "data.repository.full_name", op: "equals", value: "../x" }],
        createdAt: late,
      },
    ]);
    expect([...targets.pullRequests.values()]).toEqual([
      { repository: "Acme/API", number: 7, since: early },
    ]);
    expect([...targets.releases.values()]).toEqual([{ repository: "Acme/API", since: late }]);
  });

  test("a merge read from the API matches the trigger a webhook delivery would", () => {
    const event = githubReadEvent({
      event: "pull_request",
      action: "closed",
      payload: {
        action: "closed",
        repository: { full_name: "Acme/API", name: "API", owner: { login: "Acme" } },
        pull_request: { number: 7, state: "closed", merged: true, title: "Fix it" },
        sender: { login: "octocat", type: "User" },
      },
      externalId: "pr:acme/api#7",
      occurredAt: new Date("2026-11-21T12:00:00Z"),
    });
    expect(event.type).toBe("pull_request.closed");
    expect(event.actor).toEqual({ kind: "person", name: "octocat" });
    expect(
      eventMatchesTrigger(
        { type: event.type, data: event.data, actor: event.actor },
        {
          eventTypes: ["pull_request.closed"],
          conditions: [
            { field: "data.repository.full_name", op: "equals", value: "Acme/API" },
            { field: "data.pull_request.number", op: "equals", value: 7 },
            { field: "data.pull_request.merged", op: "equals", value: true },
          ],
          includeOwnEvents: true,
        },
      ),
    ).toBe(true);
    expect(githubReadEventTypeCatalog().map((entry) => entry.type)).toEqual([
      "pull_request.closed",
      "release.published",
    ]);
  });

  test("reads merges and releases since the trigger, each with a stable key", async () => {
    const since = new Date("2026-11-21T10:00:00.500Z");
    const merged = (repository: string, number: number) => ({
      eventTypes: ["pull_request.closed"],
      conditions: [
        { field: "data.repository.full_name", op: "equals", value: repository },
        { field: "data.pull_request.number", op: "equals", value: number },
      ],
      createdAt: since,
    });
    const targets = githubPersonalTargets([
      merged("acme/api", 1),
      merged("acme/api", 2),
      merged("acme/sso", 3),
      merged("acme/gone", 4),
      merged("acme/hidden", 5),
      {
        eventTypes: ["release.published"],
        conditions: [{ field: "data.repository.full_name", op: "equals", value: "acme/api" }],
        createdAt: since,
      },
    ]);
    const pages: Record<string, unknown> = {
      // Merged in the same second the wake was set up: still counts.
      "/repos/acme/api/pulls/1": {
        number: 1,
        state: "closed",
        merged: true,
        closed_at: "2026-11-21T10:00:00Z",
        base: { repo: { full_name: "Acme/API" } },
        user: { login: "ada" },
        merged_by: { login: "bob" },
      },
      // Closed long before the trigger: not this wake's merge.
      "/repos/acme/api/pulls/2": {
        number: 2,
        state: "closed",
        merged: true,
        closed_at: "2026-11-20T10:00:00Z",
        base: { repo: { full_name: "Acme/API" } },
      },
      "/repos/acme/api/releases?per_page=10": [
        {
          id: 77,
          tag_name: "v2",
          published_at: "2026-11-21T11:00:00Z",
          html_url: "https://github.com/Acme/API/releases/tag/v2",
          author: { login: "ada" },
        },
        { id: 78, draft: true, published_at: null },
        { id: 70, tag_name: "v1", published_at: "2026-11-01T00:00:00Z" },
      ],
    };
    const readerFor = async (repository: string) => {
      if (repository === "acme/hidden") return null;
      return async (path: string) => {
        if (repository === "acme/sso") throw new PersonalGitHubReadError(403);
        if (repository === "acme/gone") throw new PersonalGitHubReadError(404);
        if (!(path in pages)) throw new Error(`unexpected ${path}`);
        return pages[path];
      };
    };
    const first = await githubPersonalReadEvents(targets, readerFor);
    expect(first.found.map((each) => each.event.type)).toEqual([
      "pull_request.closed",
      "release.published",
    ]);
    expect(first.found[0]!.event.data).toMatchObject({
      repository: { full_name: "Acme/API" },
      pull_request: { number: 1, merged: true },
      sender: "bob",
    });
    expect(first.found[1]!.event.data).toMatchObject({
      repository: { full_name: "Acme/API" },
      release: { tag_name: "v2" },
    });
    // The SSO-protected repository failed alone; the gone one is skipped.
    expect(first.failures).toHaveLength(1);
    expect(first.reads).toBe(6);
    // Read again, the same merge and release have the same keys, so they fire once.
    const again = await githubPersonalReadEvents(targets, readerFor);
    expect(again.found.map((each) => each.key)).toEqual(first.found.map((each) => each.key));
  });

  test("new triggers are polled first when there are more than it reads", async () => {
    const triggers = Array.from({ length: 30 }, (_, index) => ({
      eventTypes: ["pull_request.closed"],
      conditions: [
        { field: "data.repository.full_name", op: "equals", value: "acme/api" },
        { field: "data.pull_request.number", op: "equals", value: index + 1 },
      ],
      createdAt: new Date(Date.UTC(2026, 10, 1 + index)),
    }));
    const read: string[] = [];
    await githubPersonalReadEvents(githubPersonalTargets(triggers), async () => async (path) => {
      read.push(path);
      return { state: "open" };
    });
    expect(read).toHaveLength(25);
    expect(read[0]).toBe("/repos/acme/api/pulls/30");
    expect(read).not.toContain("/repos/acme/api/pulls/5");
  });
});
