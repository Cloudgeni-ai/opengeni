import { describe, expect, test } from "bun:test";

import { openGitHubInstallationSettings } from "@/components/github-app-connect-launcher";
import type { GitHubAppInfo } from "@/types";

function clientReturning(configureUrl: string | null) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      getGitHubApp: async (workspaceId: string) => {
        calls.push(workspaceId);
        return {
          installations: [{ installationId: 42, configureUrl }],
        } as unknown as GitHubAppInfo;
      },
    },
  };
}

describe("GitHub installation settings link", () => {
  test("fetches a freshly minted link at click time and follows it", async () => {
    const fresh =
      "https://api.opengeni.test/v1/workspaces/w/github/installations/42/configure?state=now";
    const { client, calls } = clientReturning(fresh);
    const visited: string[] = [];
    await openGitHubInstallationSettings(client as never, "w", 42, (url) => visited.push(url));
    expect(calls).toEqual(["w"]);
    expect(visited).toEqual([fresh]);
  });

  test("explains instead of navigating when this principal cannot manage it", async () => {
    const { client } = clientReturning(null);
    const visited: string[] = [];
    await expect(
      openGitHubInstallationSettings(client as never, "w", 42, (url) => visited.push(url)),
    ).rejects.toThrow("Ask a workspace admin");
    expect(visited).toEqual([]);
  });
});
