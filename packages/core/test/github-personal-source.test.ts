import { describe, expect, test } from "bun:test";
import {
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
});
