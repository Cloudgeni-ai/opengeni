import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import {
  continuedGitHubBrowserGrantClaims,
  githubBrowserBaseUrl,
  githubBrowserGrantClaims,
  githubBrowserGrantFromState,
  githubBrowserGrantMaxAgeSeconds,
  githubSessionReturnPath,
} from "../src/github-browser-flow";

const grant: AccessGrant = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "configured-manager",
  permissions: ["github:manage"],
};

describe("GitHub configured-token browser handoff", () => {
  test("mints a bounded manage capability only for configured managers", () => {
    expect(githubBrowserGrantClaims({ productAccessMode: "local" }, grant, 1_000)).toEqual({});
    expect(
      githubBrowserGrantClaims(
        { productAccessMode: "configured" },
        { ...grant, permissions: ["github:use"] },
        1_000,
      ),
    ).toEqual({});
    expect(githubBrowserGrantClaims({ productAccessMode: "configured" }, grant, 1_000)).toEqual({
      browserGrantSubjectId: grant.subjectId,
      browserGrantExpiresAt: 1_000 + githubBrowserGrantMaxAgeSeconds,
    });
  });

  test("accepts the signed handoff only within its original ten-minute window", () => {
    const state = {
      nonce: "nonce",
      iat: 1_000,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      browserGrantSubjectId: grant.subjectId,
      browserGrantExpiresAt: 1_000 + githubBrowserGrantMaxAgeSeconds,
    };
    expect(
      githubBrowserGrantFromState(
        { productAccessMode: "configured" },
        state,
        grant.workspaceId,
        1_599,
      ),
    ).toMatchObject({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      permissions: ["github:manage"],
    });
    expect(
      githubBrowserGrantFromState(
        { productAccessMode: "configured" },
        state,
        grant.workspaceId,
        1_601,
      ),
    ).toBeNull();
    expect(
      githubBrowserGrantFromState(
        { productAccessMode: "configured" },
        {
          ...state,
          browserGrantExpiresAt: 1_001 + githubBrowserGrantMaxAgeSeconds,
        },
        grant.workspaceId,
        1_001,
      ),
    ).toBeNull();
  });

  test("carries only the server-validated session return path through GitHub state rotations", () => {
    expect(
      continuedGitHubBrowserGrantClaims({
        nonce: "nonce",
        iat: 1_000,
        browserGrantSubjectId: grant.subjectId,
        browserGrantExpiresAt: 1_600,
        returnPath: `/workspaces/${grant.workspaceId}/sessions/session-id?capability_auth=api%3Agithub-app`,
      }),
    ).toEqual({
      browserGrantSubjectId: grant.subjectId,
      browserGrantExpiresAt: 1_600,
      returnPath: `/workspaces/${grant.workspaceId}/sessions/session-id?capability_auth=api%3Agithub-app`,
    });
  });

  test("accepts only same-workspace session return paths", () => {
    const valid = `/workspaces/${grant.workspaceId}/sessions/session-id?capability_auth=api%3Agithub-app`;
    expect(githubSessionReturnPath(valid, grant.workspaceId)).toBe(valid);
    for (const rejected of [
      "https://attacker.example/session",
      "//attacker.example/session",
      `/workspaces/another-workspace/sessions/session-id`,
      `/workspaces/${grant.workspaceId}/capabilities`,
      `/workspaces/${grant.workspaceId}/sessions`,
    ]) {
      expect(githubSessionReturnPath(rejected, grant.workspaceId)).toBeNull();
    }
  });

  test("prefers the explicit GitHub callback host over the general public host", () => {
    expect(
      githubBrowserBaseUrl({
        githubAppManifestBaseUrl: "https://github.opengeni.test/",
        publicBaseUrl: "https://api.opengeni.test/",
      }),
    ).toBe("https://github.opengeni.test");
  });
});
