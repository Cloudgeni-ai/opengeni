import { describe, expect, test } from "bun:test";
import { classifySessionLinkUrl, parseGitHubLinkRef, SessionWaitingOn } from "../src";

describe("classifySessionLinkUrl", () => {
  test("GitHub pull requests and issues carry a ref", () => {
    expect(classifySessionLinkUrl("https://github.com/acme/api/pull/12/files")).toMatchObject({
      kind: "pull_request",
      provider: "github",
      ref: "acme/api#12",
      github: { owner: "acme", repo: "api", number: 12, type: "pull" },
    });
    expect(classifySessionLinkUrl("https://github.com/acme/api/issues/3")).toMatchObject({
      kind: "issue",
      ref: "acme/api#3",
    });
    expect(classifySessionLinkUrl("https://github.com/acme/api")).toMatchObject({
      kind: "link",
      provider: "github",
      ref: null,
    });
  });

  test("Linear issues and Slack threads are recognised by shape", () => {
    expect(classifySessionLinkUrl("https://linear.app/team/issue/ope-1060/title")).toMatchObject({
      kind: "issue",
      provider: "linear",
      ref: "OPE-1060",
    });
    expect(
      classifySessionLinkUrl("https://acme.slack.com/archives/C123/p1700000000123456"),
    ).toMatchObject({ kind: "thread", provider: "slack" });
  });

  test("anything else is a plain link; non-web URLs are refused", () => {
    expect(classifySessionLinkUrl("https://example.com/report")).toMatchObject({
      kind: "link",
      provider: "other",
    });
    expect(classifySessionLinkUrl("javascript:alert(1)")).toBeNull();
    expect(classifySessionLinkUrl("not a url")).toBeNull();
  });

  test("parseGitHubLinkRef reads owner/repo#n", () => {
    expect(parseGitHubLinkRef("acme/api#7")).toMatchObject({
      owner: "acme",
      repo: "api",
      number: 7,
    });
    expect(parseGitHubLinkRef("OPE-1")).toBeNull();
    expect(parseGitHubLinkRef(null)).toBeNull();
  });

  test("a wait names a person or none", () => {
    expect(
      SessionWaitingOn.parse({
        source: "agent",
        person: "Kari",
        subjectId: null,
        reason: "Needs the staging password",
        since: "2026-11-20T10:00:00.000Z",
      }).person,
    ).toBe("Kari");
  });
});
