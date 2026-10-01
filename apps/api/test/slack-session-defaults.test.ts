import { describe, expect, test } from "bun:test";
import type { GitHubRepository, RepositoryResourceRef } from "@opengeni/contracts";
import {
  otherDeploymentLinkContext,
  otherDeploymentLinks,
  selectRecentRepositoryResources,
} from "../src/integrations/slack-session-defaults";

const workspaceId = "0f9a4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const sessionId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("links to another OpenGeni deployment", () => {
  const production = "https://app.opengeni.ai";

  test("recognizes a sibling deployment under the same parent domain", () => {
    const text = `Look at <https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}|this run>`;
    expect(otherDeploymentLinks(text, production)).toEqual([
      {
        url: `https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`,
        host: "staging.app.opengeni.ai",
      },
    ]);
    expect(
      otherDeploymentLinks(
        `https://app.opengeni.ai/workspaces/${workspaceId}`,
        "https://staging.app.opengeni.ai",
      ),
    ).toEqual([
      { url: `https://app.opengeni.ai/workspaces/${workspaceId}`, host: "app.opengeni.ai" },
    ]);
  });

  test("leaves this deployment, unrelated sites and non-OpenGeni routes alone", () => {
    expect(
      otherDeploymentLinks(
        [
          `https://app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`,
          `https://tracker.example.com/workspaces/${workspaceId}/sessions/${sessionId}`,
          "https://staging.app.opengeni.ai/settings",
          "https://docs.opengeni.ai/guides/slack",
        ].join(" "),
        production,
      ),
    ).toEqual([]);
  });

  test("does nothing without a named web origin", () => {
    const text = `https://staging.app.opengeni.ai/workspaces/${workspaceId}`;
    expect(otherDeploymentLinks(text, undefined)).toEqual([]);
    expect(otherDeploymentLinks(text, "http://127.0.0.1:3000")).toEqual([]);
    expect(otherDeploymentLinks(text, "http://localhost:3000")).toEqual([]);
  });

  test("names each distinct link once", () => {
    const link = `https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`;
    expect(
      otherDeploymentLinks(`${link} and again <${link.toUpperCase()}>`, production),
    ).toHaveLength(1);
  });

  test("tells the agent to name the other deployment instead of reporting not found", () => {
    const context = otherDeploymentLinkContext(
      `https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`,
      production,
    );
    expect(context).toContain("(this one is app.opengeni.ai)");
    expect(context).toContain(
      "Tell the user the link is for staging.app.opengeni.ai, not app.opengeni.ai",
    );
    expect(otherDeploymentLinkContext("no links here", production)).toBeNull();
  });
});

describe("Slack task repositories from recent use", () => {
  const catalogEntry = (
    id: number,
    name: string,
    extra: Partial<GitHubRepository> = {},
  ): GitHubRepository => ({
    id,
    installationId: 71,
    fullName: `example-owner/${name}`,
    name,
    private: true,
    htmlUrl: `https://github.com/example-owner/${name}`,
    cloneUrl: `https://github.com/example-owner/${name}.git`,
    defaultBranch: "trunk",
    accountLogin: "example-owner",
    accountType: "User",
    ...extra,
  });
  const used = (id: number | null, name: string, ref = "feature"): RepositoryResourceRef => ({
    kind: "repository",
    uri: `https://github.com/example-owner/${name}.git`,
    ref,
    ...(id !== null
      ? { provider: "github", githubInstallationId: 71, githubRepositoryId: id }
      : {}),
  });

  test("keeps recency order, the catalog's default branch, and marks each one best effort", () => {
    expect(
      selectRecentRepositoryResources(
        [used(2, "service"), used(1, "project"), used(2, "service")],
        [catalogEntry(1, "project"), catalogEntry(2, "service")],
      ),
    ).toEqual([
      {
        kind: "repository",
        uri: "https://github.com/example-owner/service.git",
        ref: "trunk",
        provider: "github",
        mountPath: "repos/github.com/example-owner/service",
        githubInstallationId: 71,
        githubRepositoryId: 2,
        optional: true,
      },
      {
        kind: "repository",
        uri: "https://github.com/example-owner/project.git",
        ref: "trunk",
        provider: "github",
        mountPath: "repos/github.com/example-owner/project",
        githubInstallationId: 71,
        githubRepositoryId: 1,
        optional: true,
      },
    ]);
  });

  test("matches a repository used by URL, case-insensitively, to its catalog entry", () => {
    expect(
      selectRecentRepositoryResources(
        [
          {
            kind: "repository",
            uri: "https://GitHub.com/Example-Owner/Project",
            ref: "main",
          },
        ],
        [catalogEntry(1, "project")],
      ).map((resource) => resource.githubRepositoryId),
    ).toEqual([1]);
  });

  test("drops repositories the catalog no longer offers, archived ones and empty ones", () => {
    expect(
      selectRecentRepositoryResources(
        [used(9, "gone"), used(3, "archived"), used(4, "empty"), used(1, "project")],
        [
          catalogEntry(1, "project"),
          catalogEntry(3, "archived", { archived: true, sizeKb: 120 }),
          catalogEntry(4, "empty", { archived: false, sizeKb: 0 }),
        ],
      ).map((resource) => resource.githubRepositoryId),
    ).toEqual([1]);
  });

  test("stops at five distinct repositories", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    expect(
      selectRecentRepositoryResources(
        names.map((name, index) => used(index + 1, name)),
        names.map((name, index) => catalogEntry(index + 1, name)),
      ).map((resource) => resource.githubRepositoryId),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("never counts a repository that was itself attached automatically", () => {
    expect(
      selectRecentRepositoryResources(
        [{ ...used(2, "service"), optional: true }, used(1, "project")],
        [catalogEntry(1, "project"), catalogEntry(2, "service")],
      ).map((resource) => resource.githubRepositoryId),
    ).toEqual([1]);
  });

  test("attaches nothing without recent use", () => {
    expect(selectRecentRepositoryResources([], [catalogEntry(1, "project")])).toEqual([]);
  });
});
