import { describe, expect, test } from "bun:test";
import type { SessionLinkWithStatus } from "@opengeni/sdk";
import { renderToStaticMarkup } from "react-dom/server";

import { formatWaitingOn } from "../../lib/waiting-on";
import {
  latestLinksChange,
  LinkedList,
  openPullRequestFromLinks,
  sessionLinkStatusLine,
} from "./linked-panel";

function link(
  id: string,
  url: string,
  extra: Partial<SessionLinkWithStatus> = {},
): SessionLinkWithStatus {
  return {
    id,
    url,
    title: null,
    kind: url.includes("/pull/") ? "pull_request" : "link",
    provider: url.includes("github.com") ? "github" : "other",
    ref: null,
    addedBy: "agent",
    addedAt: "2026-11-20T10:00:00.000Z",
    status: null,
    ...extra,
  };
}

describe("waiting on", () => {
  const since = "2026-11-20T10:00:00.000Z";
  test("names the viewer, a named person or a member", () => {
    expect(
      formatWaitingOn(
        { source: "input", person: null, subjectId: "user:me", reason: null, since },
        "user:me",
        null,
      ),
    ).toBe("Waiting on you");
    expect(
      formatWaitingOn(
        { source: "agent", person: "Kari", subjectId: null, reason: "Password", since },
        "user:me",
        null,
      ),
    ).toBe("Waiting on Kari");
    expect(
      formatWaitingOn(
        { source: "input", person: null, subjectId: "user:ola", reason: null, since },
        "user:me",
        "Ola",
      ),
    ).toBe("Waiting on Ola");
  });
});

describe("Linked panel", () => {
  test("status lines stay short and plain", () => {
    expect(sessionLinkStatusLine(null)).toBeNull();
    expect(
      sessionLinkStatusLine({
        state: "open",
        label: null,
        title: "Fix it",
        checks: "failing",
        review: "approved",
      })?.tone,
    ).toBe("bad");
    expect(
      sessionLinkStatusLine({
        state: "merged",
        label: null,
        title: null,
        checks: null,
        review: null,
      })?.text,
    ).toContain("Merged");
  });

  test("the workbench uses the newest pull request that is still open", () => {
    const merged = link("a", "https://github.com/acme/api/pull/1", {
      status: { state: "merged", label: null, title: null, checks: null, review: null },
    });
    const open = link("b", "https://github.com/acme/api/pull/2");
    expect(openPullRequestFromLinks([open, merged])).toEqual({
      url: "https://github.com/acme/api/pull/2",
      number: 2,
    });
    expect(openPullRequestFromLinks([merged])).toBeNull();
    expect(openPullRequestFromLinks([link("c", "https://example.com")])).toBeNull();
  });

  test("re-reads on the latest links change", () => {
    expect(
      latestLinksChange([
        { type: "session.links.changed", sequence: 3 },
        { type: "turn.completed", sequence: 4 },
      ]),
    ).toBe(3);
    expect(latestLinksChange([])).toBe(0);
  });

  test("renders one row per item with its live title", () => {
    const html = renderToStaticMarkup(
      <LinkedList
        status="ready"
        links={[
          link("a", "https://github.com/acme/api/pull/7", {
            ref: "acme/api#7",
            status: {
              state: "open",
              label: null,
              title: "Fix it",
              checks: "passing",
              review: null,
            },
          }),
          link("b", "https://example.com/report", { title: "Report" }),
        ]}
      />,
    );
    expect(html).toContain("Fix it");
    expect(html).toContain("acme/api#7");
    expect(html).toContain("Report");
    expect(html).not.toContain("Remove");
    expect(renderToStaticMarkup(<LinkedList status="ready" links={[]} />)).toContain(
      "Nothing linked yet.",
    );
  });

  test("Linear and Slack lines: state and assignee, replies and last reply", () => {
    const now = new Date("2026-11-21T12:00:00.000Z");
    expect(
      sessionLinkStatusLine(
        {
          state: "open",
          label: "In Progress",
          title: "Login fails",
          checks: null,
          review: null,
          assignee: "Ada",
        },
        now,
      ),
    ).toEqual({ text: "In Progress · Ada", tone: "neutral" });
    expect(
      sessionLinkStatusLine(
        { state: "done", label: "Done", title: null, checks: null, review: null },
        now,
      )?.tone,
    ).toBe("good");
    expect(
      sessionLinkStatusLine(
        {
          state: "unknown",
          label: null,
          title: "Deploy is stuck",
          checks: null,
          review: null,
          replies: 3,
          lastReplyAt: "2026-11-21T10:00:00.000Z",
        },
        now,
      )?.text,
    ).toBe("3 replies · last reply 2 hours ago");
    expect(
      sessionLinkStatusLine(
        { state: "unknown", label: null, title: null, checks: null, review: null, replies: 0 },
        now,
      )?.text,
    ).toBe("No replies");
  });

  test("a link the viewer can't read yet offers Connect where the host gives a place", () => {
    const linear = link("l", "https://linear.app/acme/issue/ENG-1", {
      kind: "issue",
      provider: "linear",
      ref: "ENG-1",
      connect: { name: "Linear", capabilityId: "mcp:linear" },
    });
    const html = renderToStaticMarkup(
      <LinkedList
        status="ready"
        links={[linear]}
        connectHref={(connect) => `/plugins?suggested_capability=${connect.capabilityId}`}
      />,
    );
    expect(html).toContain("Connect Linear");
    expect(html).toContain("/plugins?suggested_capability=mcp:linear");
    expect(renderToStaticMarkup(<LinkedList status="ready" links={[linear]} />)).not.toContain(
      "Connect",
    );
  });
});
