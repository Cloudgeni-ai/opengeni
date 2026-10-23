import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  githubDeliveryInstallationId,
  githubDeliveryRepositoryId,
  githubEventTypeCatalog,
  githubOwnLogins,
  readGitHubDelivery,
  verifyGitHubWebhook,
  WebhookBodyError,
} from "../src";

const encoder = new TextEncoder();
const receivedAt = new Date("2026-10-24T08:00:00.000Z");
const ownLogins = githubOwnLogins(["opengeni-agent", undefined, " Lens "]);

const repository = {
  id: 42,
  name: "api",
  full_name: "acme/api",
  private: true,
  owner: { login: "acme" },
  default_branch: "main",
  html_url: "https://github.com/acme/api",
  // Payloads repeat large objects the event leaves out.
  hooks_url: "https://api.github.com/repos/acme/api/hooks",
};

function delivery(event: string, payload: Record<string, unknown>, id = "d-1") {
  return {
    headers: new Headers({ "x-github-event": event, "x-github-delivery": id }),
    body: encoder.encode(JSON.stringify(payload)),
    receivedAt,
    ownLogins,
  };
}

function only(reading: ReturnType<typeof readGitHubDelivery>) {
  if (reading.kind !== "events") throw new Error(`expected events, got ${reading.reason}`);
  expect(reading.events).toHaveLength(1);
  return reading.events[0]!;
}

describe("GitHub webhook deliveries", () => {
  test("verifies X-Hub-Signature-256 over the exact body", () => {
    const body = encoder.encode('{"zen":"Keep it logically awesome."}');
    const signature = `sha256=${createHmac("sha256", "hook-secret").update(body).digest("hex")}`;
    const headers = new Headers({ "x-hub-signature-256": signature });
    expect(verifyGitHubWebhook({ secret: "hook-secret", headers, body })).toBe(true);
    expect(verifyGitHubWebhook({ secret: "other", headers, body })).toBe(false);
    expect(
      verifyGitHubWebhook({ secret: "hook-secret", headers, body: encoder.encode("{}") }),
    ).toBe(false);
    expect(verifyGitHubWebhook({ secret: "hook-secret", headers: new Headers(), body })).toBe(
      false,
    );
  });

  test("names a pull request event by its action and keeps a compact shape", () => {
    const event = only(
      readGitHubDelivery(
        delivery("pull_request", {
          action: "opened",
          number: 7,
          installation: { id: 99 },
          repository,
          sender: { login: "octocat", type: "User" },
          pull_request: {
            number: 7,
            title: "Add retries",
            state: "open",
            draft: false,
            merged: false,
            user: { login: "octocat" },
            head: { ref: "retries", sha: "abc123" },
            base: { ref: "main" },
            labels: [{ name: "backend" }],
            html_url: "https://github.com/acme/api/pull/7",
            body: "x".repeat(5_000),
            _links: { self: { href: "https://api.github.com/..." } },
          },
        }),
      ),
    );
    expect(event.type).toBe("pull_request.opened");
    expect(event.externalId).toBe("d-1");
    expect(event.subject).toBe("acme/api#7");
    expect(event.summary).toBe("Pull request opened: acme/api#7 Add retries");
    expect(event.url).toBe("https://github.com/acme/api/pull/7");
    expect(event.actor).toEqual({ kind: "person", name: "octocat" });
    const data = event.data as Record<string, any>;
    expect(data.repository.full_name).toBe("acme/api");
    expect(data.repository.hooks_url).toBeUndefined();
    expect(data.pull_request.head).toEqual({ ref: "retries", sha: "abc123" });
    expect(data.pull_request.labels).toEqual(["backend"]);
    expect(data.pull_request._links).toBeUndefined();
    expect(String(data.pull_request.body).length).toBeLessThanOrEqual(1_501);
  });

  test("tells a merged pull request from one closed without merging", () => {
    const closed = (merged: boolean) =>
      only(
        readGitHubDelivery(
          delivery("pull_request", {
            action: "closed",
            repository,
            sender: { login: "octocat", type: "User" },
            pull_request: { number: 8, title: "Tidy", merged },
          }),
        ),
      );
    expect(closed(true).summary).toBe("Pull request merged: acme/api#8 Tidy");
    expect(closed(false).summary).toBe("Pull request closed without merging: acme/api#8 Tidy");
  });

  test("names an event without an action by the event alone", () => {
    const event = only(
      readGitHubDelivery(
        delivery("push", {
          ref: "refs/heads/main",
          before: "000",
          after: "abc",
          commits: [
            { id: "abcdef1234567890", message: "Fix it\n\nLonger text", author: { name: "Ada" } },
          ],
          repository,
          pusher: { name: "ada" },
          sender: { login: "ada", type: "User" },
          compare: "https://github.com/acme/api/compare/000...abc",
        }),
      ),
    );
    expect(event.type).toBe("push");
    expect(event.summary).toBe("1 commit pushed to main in acme/api");
    const data = event.data as Record<string, any>;
    expect(data.branch).toBe("main");
    expect(data.commits).toEqual([{ id: "abcdef123456", message: "Fix it", author: "Ada" }]);
  });

  test("marks events made by Opengeni's own Apps and by other bots", () => {
    const comment = (sender: Record<string, unknown>) =>
      only(
        readGitHubDelivery(
          delivery("issue_comment", {
            action: "created",
            repository,
            sender,
            issue: { number: 3, title: "Flaky test" },
            comment: { body: "Looking", user: sender },
          }),
        ),
      ).actor;
    expect(comment({ login: "opengeni-agent[bot]", type: "Bot" })).toEqual({
      kind: "opengeni",
      name: "opengeni-agent[bot]",
    });
    expect(comment({ login: "lens[bot]", type: "Bot" }).kind).toBe("opengeni");
    expect(comment({ login: "dependabot[bot]", type: "Bot" }).kind).toBe("bot");
    expect(comment({ login: "octocat", type: "User" }).kind).toBe("person");
  });

  test("ignores pings and installation changes, and refuses unreadable deliveries", () => {
    expect(readGitHubDelivery(delivery("ping", { zen: "hi" })).kind).toBe("ignored");
    expect(readGitHubDelivery(delivery("installation", { action: "created" })).kind).toBe(
      "ignored",
    );
    expect(() => readGitHubDelivery({ ...delivery("push", {}), headers: new Headers() })).toThrow(
      WebhookBodyError,
    );
    expect(() =>
      readGitHubDelivery({ ...delivery("push", {}), body: encoder.encode("not json") }),
    ).toThrow(WebhookBodyError);
  });

  test("reads the installation and repository a delivery is routed by", () => {
    expect(githubDeliveryInstallationId({ installation: { id: 99 } })).toBe(99);
    expect(githubDeliveryInstallationId({ installation: { id: "99" } })).toBeNull();
    expect(githubDeliveryRepositoryId({ repository })).toBe(42);
    expect(githubDeliveryRepositoryId({})).toBeNull();
  });
});

describe("GitHub event types", () => {
  test("marks types the App is not subscribed to as unavailable", () => {
    const catalog = githubEventTypeCatalog(
      [
        { type: "pull_request.opened", count: 3 },
        { type: "discussion.created", count: 1 },
      ],
      new Set(["pull_request", "push"]),
    );
    const byType = new Map(catalog.map((entry) => [entry.type, entry]));
    expect(byType.get("pull_request.opened")?.available).toBe(true);
    expect(byType.get("push")?.available).toBe(true);
    const issues = byType.get("issues.opened");
    expect(issues?.available).toBe(false);
    expect(issues?.unavailableReason).toContain('"issues"');
    expect(byType.get("discussion.created")).toMatchObject({
      description: "Received 1 time recently",
      available: false,
    });
    expect(catalog.filter((entry) => entry.type === "pull_request.opened")).toHaveLength(1);
  });

  test("offers every type when the App's subscriptions are unknown", () => {
    expect(githubEventTypeCatalog([], null).every((entry) => entry.available)).toBe(true);
  });
});
