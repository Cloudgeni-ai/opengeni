import { describe, expect, mock, test } from "bun:test";

import {
  GITHUB_IDENTITIES_GUIDANCE,
  personalGitHubIdentityStatus,
  type PersonalGitHubConnectionSummary,
  type PersonalGitHubPerson,
} from "../src/mcp/github-identity-status";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const LINK = `https://app.example.test/workspaces/${WORKSPACE_ID}/plugins?open=integration%3Agithub&github=personal`;
const writer: PersonalGitHubPerson = {
  subjectId: "person-a",
  permissions: ["connections:read", "connections:write", "github:use"],
};
const reader: PersonalGitHubPerson = {
  subjectId: "person-a",
  permissions: ["connections:read", "github:use"],
};

function connection(
  status: string,
  metadata: Record<string, unknown> = { githubLogin: "octocat" },
): PersonalGitHubConnectionSummary {
  return { id: "connection-1", status, workspaceId: WORKSPACE_ID, metadata };
}

function read(
  overrides: Partial<Parameters<typeof personalGitHubIdentityStatus>[0]> = {},
): ReturnType<typeof personalGitHubIdentityStatus> {
  return personalGitHubIdentityStatus({
    enabled: true,
    workspaceId: WORKSPACE_ID,
    baseUrl: "https://app.example.test/",
    person: writer,
    loadConnection: async () => null,
    loadRepositoryCount: async () => 0,
    ...overrides,
  });
}

describe("personal GitHub identity status for the agent", () => {
  test("a deployment without personal sign-in reports only that, without reading", async () => {
    const loadConnection = mock(async () => connection("active"));
    const status = await read({ enabled: false, loadConnection });
    expect(status).toMatchObject({
      enabled: false,
      connected: false,
      status: "disabled",
      connectUrl: null,
      manageUrl: null,
    });
    expect(loadConnection).not.toHaveBeenCalled();
  });

  test("not connected gives a link that opens the personal connect flow", async () => {
    const status = await read();
    expect(status).toEqual({
      enabled: true,
      connected: false,
      status: "not_connected",
      login: null,
      repositoryCount: null,
      connectUrl: LINK,
      manageUrl: null,
    });
    // Without a configured public origin the link stays a console path.
    expect((await read({ baseUrl: "" })).connectUrl).toBe(
      `/workspaces/${WORKSPACE_ID}/plugins?open=integration%3Agithub&github=personal`,
    );
  });

  test("a revoked connection counts as not connected", async () => {
    const status = await read({ loadConnection: async () => connection("revoked") });
    expect(status.status).toBe("not_connected");
    expect(status.connectUrl).toBe(LINK);
  });

  test("connected reports the login and allowed repository count, and the chooser link", async () => {
    const loadRepositoryCount = mock(async () => 4);
    const status = await read({
      loadConnection: async () => connection("active"),
      loadRepositoryCount,
    });
    expect(status).toEqual({
      enabled: true,
      connected: true,
      status: "connected",
      login: "octocat",
      repositoryCount: 4,
      connectUrl: null,
      manageUrl: LINK,
    });
    expect(loadRepositoryCount).toHaveBeenCalledWith("person-a", connection("active"));
  });

  test("connected with no allowed repositories points at the chooser", async () => {
    const status = await read({ loadConnection: async () => connection("active") });
    expect(status.repositoryCount).toBe(0);
    expect(status.note).toContain("manageUrl");
  });

  test("a failed repository count still reports the connection", async () => {
    const status = await read({
      loadConnection: async () => connection("active", {}),
      loadRepositoryCount: async () => {
        throw new Error("GitHub is rate limited");
      },
    });
    expect(status).toMatchObject({
      connected: true,
      status: "connected",
      login: null,
      repositoryCount: null,
    });
  });

  test("a connection needing reauthorization asks the person to reconnect", async () => {
    const status = await read({ loadConnection: async () => connection("needs_reauth") });
    expect(status).toMatchObject({
      connected: false,
      status: "needs_reconnect",
      login: "octocat",
      connectUrl: LINK,
      manageUrl: null,
    });
  });

  test("links need connections:write; reading needs connections:read", async () => {
    const notConnected = await read({ person: reader });
    expect(notConnected).toMatchObject({ status: "not_connected", connectUrl: null });
    expect(notConnected.note).toBeTruthy();
    const connected = await read({
      person: reader,
      loadConnection: async () => connection("active"),
      loadRepositoryCount: async () => 2,
    });
    expect(connected).toMatchObject({ connected: true, repositoryCount: 2, manageUrl: null });
    const loadConnection = mock(async () => connection("active"));
    const blind = await read({
      person: { subjectId: "person-a", permissions: ["github:use"] },
      loadConnection,
    });
    expect(blind).toMatchObject({ connected: null, status: "unknown", connectUrl: null });
    expect(loadConnection).not.toHaveBeenCalled();
  });

  test("work no person started has no personal identity", async () => {
    const status = await read({ person: null });
    expect(status).toMatchObject({ connected: null, status: "unknown", connectUrl: null });
  });

  test("never carries credentials", async () => {
    const status = await read({
      loadConnection: async () =>
        connection("active", { githubLogin: "octocat", accessToken: "gho_secret" }),
    });
    expect(JSON.stringify(status)).not.toContain("gho_secret");
  });

  test("guidance maps each request to one identity", () => {
    expect(GITHUB_IDENTITIES_GUIDANCE).toContain("'Connect my GitHub'");
    expect(GITHUB_IDENTITIES_GUIDANCE).toContain("means personal");
    expect(GITHUB_IDENTITIES_GUIDANCE).toContain("'install the GitHub app'");
    expect(GITHUB_IDENTITIES_GUIDANCE).toContain("means the app");
  });
});
