import { describe, expect, mock, test } from "bun:test";
import type { SessionLinkWithStatus, SessionPullRequestDetail } from "@opengeni/sdk";
import { flush, registerDom, renderComponent } from "./render-hook";
import { dropdownMenuStub } from "./dropdown-menu-stub";

registerDom();
mock.module("../src/ui/dropdown-menu", dropdownMenuStub);

const { act } = await import("react");
const { PullRequestView, pullRequestLinkFromLinks } =
  await import("../src/app/components/session/pull-request-panel");

const LINK = {
  id: "pr-1",
  url: "https://github.com/acme/api/pull/7",
  provider: "github",
  kind: "pull_request",
  ref: "acme/api#7",
  title: "Faster diffs",
  status: null,
} as unknown as SessionLinkWithStatus;

function detail(state: SessionPullRequestDetail["state"]): SessionPullRequestDetail {
  return {
    url: LINK.url,
    owner: "acme",
    repo: "api",
    number: 7,
    title: "Faster diffs",
    state,
    author: { login: "ada", avatarUrl: null },
    base: "main",
    head: "fast",
    createdAt: null,
    mergedAt: null,
    body: "Why",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    commitCount: 1,
    commentCount: 0,
    mergeable: true,
    checks: "passing",
    review: null,
    files: [],
    filesTruncated: false,
    commits: [],
    comments: [],
    checkRuns: [],
  } as SessionPullRequestDetail;
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

describe("the PR tab", () => {
  test("Merge shows only for an open pull request the viewer may ask about, and only asks", async () => {
    let asked = 0;
    const onMerge = async () => {
      asked += 1;
    };
    for (const state of ["draft", "merged", "closed"] as const) {
      const rendered = await renderComponent(
        <PullRequestView
          link={LINK}
          state={{ status: "ready", detail: detail(state) }}
          onMerge={onMerge}
        />,
      );
      expect(rendered.container.querySelector("[data-pr-merge]")).toBeNull();
      expect(rendered.container.querySelector("[data-pr-github]")).not.toBeNull();
      await rendered.unmount();
    }
    const noAsk = await renderComponent(
      <PullRequestView link={LINK} state={{ status: "ready", detail: detail("open") }} />,
    );
    expect(noAsk.container.querySelector("[data-pr-merge]")).toBeNull();
    await noAsk.unmount();

    const rendered = await renderComponent(
      <PullRequestView
        link={LINK}
        state={{ status: "ready", detail: detail("open") }}
        onMerge={onMerge}
      />,
    );
    await click(rendered.container.querySelector("[data-pr-merge]"));
    expect(asked).toBe(1);
    expect(rendered.container.querySelector("[data-pr-merge]")?.hasAttribute("disabled")).toBe(
      true,
    );
    await rendered.unmount();
  });

  test("views live in the one menu, with a way back to Changes", async () => {
    const rendered = await renderComponent(
      <PullRequestView link={LINK} state={{ status: "ready", detail: detail("open") }} />,
    );
    await click(rendered.container.querySelector('[data-pr-tab="description"]'));
    expect(rendered.container.textContent).toContain("Why");
    await click(rendered.container.querySelector("[data-pr-back]"));
    expect(rendered.container.querySelector("[data-pr-back]")).toBeNull();
    await rendered.unmount();
  });

  test("loading, error with retry, and unreadable", async () => {
    const loading = await renderComponent(
      <PullRequestView link={LINK} state={{ status: "loading", detail: null }} />,
    );
    expect(loading.container.textContent).toContain("Loading");
    await loading.unmount();
    let retries = 0;
    const failed = await renderComponent(
      <PullRequestView
        link={LINK}
        state={{ status: "error", detail: null }}
        onRetry={() => {
          retries += 1;
        }}
      />,
    );
    await click(failed.container.querySelector("[data-pr-retry]"));
    expect(retries).toBe(1);
    await failed.unmount();
    const unreadable = await renderComponent(
      <PullRequestView link={LINK} state={{ status: "ready", detail: null }} />,
    );
    expect(unreadable.container.textContent).toContain("Can't read this pull request here.");
    await unreadable.unmount();
  });

  test("only GitHub pull requests get the tab", () => {
    const gitlab = { ...LINK, id: "mr", provider: "other" } as SessionLinkWithStatus;
    expect(pullRequestLinkFromLinks([gitlab])).toBeNull();
    expect(pullRequestLinkFromLinks([gitlab, LINK])?.id).toBe("pr-1");
  });
});
