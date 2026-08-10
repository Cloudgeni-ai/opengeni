import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createOneShotPendingSlackLink, pendingSlackLinkFromUrl } from "./context";
import { SlackLinkAccessRequiredDescription } from "./routes/workspace";

const workspaceId = "00000000-0000-4000-8000-000000000141";

describe("Slack link continuation", () => {
  test("accepts only the log-safe fragment form on capabilities", () => {
    expect(
      pendingSlackLinkFromUrl(
        `https://app.example.test/workspaces/${workspaceId}/capabilities#slack_link=signed.fragment`,
      ),
    ).toEqual({ workspaceId, token: "signed.fragment" });
    expect(
      pendingSlackLinkFromUrl(
        `https://app.example.test/workspaces/${workspaceId}/capabilities?slack_link=signed.query`,
      ),
    ).toBeNull();
    expect(
      pendingSlackLinkFromUrl(
        `https://app.example.test/workspaces/${workspaceId}/sessions#slack_link=signed.fragment`,
      ),
    ).toBeNull();
  });

  test("renders the required sentence with only the proven workspace name emphasized", () => {
    const markup = renderToStaticMarkup(
      <p>
        <SlackLinkAccessRequiredDescription workspaceName="Platform" />
      </p>,
    );
    expect(markup).toBe(
      "<p>You need access to <strong>Platform</strong> to connect your Slack account.</p>",
    );
    expect(
      renderToStaticMarkup(
        <p>
          <SlackLinkAccessRequiredDescription workspaceName="this workspace" />
        </p>,
      ),
    ).toContain(
      "You need access to <strong>this workspace</strong> to connect your Slack account.",
    );
  });

  test("consumes a bootstrapped bearer once so a Root/provider remount cannot resurrect it", () => {
    const pending = {
      workspaceId: "00000000-0000-4000-8000-000000000141",
      token: "one-shot-signed-link",
    };
    const take = createOneShotPendingSlackLink(pending);
    expect(take()).toEqual(pending);
    expect(take()).toBeNull();
    expect(take()).toBeNull();
  });
});
