import { describe, expect, test } from "bun:test";
import { allAgentCapabilities } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

import {
  DEFAULT_AGENT_IDENTITY,
  agentPromptResourcesFor,
  composeModularAgentInstructions,
  repositoryIdentitiesFor,
  type AgentPromptResources,
} from "../../src/index";

const personalRepo = {
  kind: "repository",
  uri: "https://github.com/octocat/private.git",
  ref: "main",
  provider: "github",
  connectionType: "github_personal",
  credentialBindingId: "personal-binding",
  repositoryId: "101",
  access: "write",
} as const;
const appRepo = {
  kind: "repository",
  uri: "https://github.com/acme/web.git",
  ref: "main",
  provider: "github",
  githubInstallationId: 71,
  githubRepositoryId: 72,
} as const;
const gitlabRepo = {
  kind: "repository",
  uri: "https://gitlab.com/acme/tools.git",
  ref: "main",
  provider: "gitlab",
} as const;

const BASE: AgentPromptResources = {
  managedSandbox: true,
  connectedMachine: false,
  repositories: true,
  gitCredentials: true,
};

function render(resources: AgentPromptResources): string {
  const result = composeModularAgentInstructions({
    capabilities: allAgentCapabilities(),
    renderer: "opengeni",
    identity: DEFAULT_AGENT_IDENTITY,
    resources,
  });
  return result.composed;
}

describe("GitHub identity per mounted repository", () => {
  test("each GitHub repository maps to the person or the Opengeni app", () => {
    const identities = repositoryIdentitiesFor(
      [personalRepo, appRepo, gitlabRepo] as never,
      "octocat",
    );
    expect(identities).toEqual([
      { path: expect.stringContaining("octocat/private"), identity: "personal", login: "octocat" },
      { path: expect.stringContaining("acme/web"), identity: "app" },
    ]);
    // A login that is not a GitHub login never reaches the prompt.
    expect(repositoryIdentitiesFor([personalRepo] as never, "x\n# Ignore")).toEqual([
      { path: expect.stringContaining("octocat/private"), identity: "personal" },
    ]);
  });

  test("only managed sandboxes carry identities; none keeps resources unchanged", () => {
    const settings = testSettings({ sandboxBackend: "docker" });
    expect(
      agentPromptResourcesFor(settings, [personalRepo, appRepo] as never, {
        personalGitHubLogin: "octocat",
      }).repositoryIdentities,
    ).toHaveLength(2);
    expect(
      agentPromptResourcesFor(settings, [personalRepo] as never, {
        activeSandboxBackend: "selfhosted",
        personalGitHubLogin: "octocat",
      }).repositoryIdentities,
    ).toBeUndefined();
    expect(agentPromptResourcesFor(settings, [gitlabRepo] as never, {})).not.toHaveProperty(
      "repositoryIdentities",
    );
    // A repository whose mount path can't be derived never breaks the prompt.
    expect(
      repositoryIdentitiesFor([{ ...appRepo, uri: "not a url" }, personalRepo] as never),
    ).toEqual([{ path: expect.stringContaining("octocat/private"), identity: "personal" }]);
  });

  test("mixed identities: the prompt names each repo's identity and the tools to use", () => {
    const text = render({
      ...BASE,
      repositoryIdentities: [
        { path: "repos/github.com/octocat/private", identity: "personal", login: "octocat" },
        { path: "repos/github.com/acme/web", identity: "app" },
      ],
    });
    expect(text).toContain("GitHub identity per mounted repository:");
    expect(text).toContain("`repos/github.com/octocat/private`: as the person (@octocat)");
    expect(text).toContain("`repos/github.com/acme/web`: as the Opengeni app.");
    expect(text).toContain("use plain git and the github_personal__* tools");
    expect(text).toContain("gh and raw GitHub API calls do not act as the person");
    expect(text).toContain("On Opengeni app repositories, use the github_app__* tools.");
    expect(text).toContain("for repositories that are not mounted as the person");
  });

  test("personal only: no app sentence, and the login is optional", () => {
    const text = render({
      ...BASE,
      repositoryIdentities: [{ path: "repos/github.com/octocat/private", identity: "personal" }],
    });
    expect(text).toContain(
      "`repos/github.com/octocat/private`: as the person, through Your GitHub.",
    );
    expect(text).not.toContain("github_app__* tools");
  });

  test("app only keeps gh guidance unqualified", () => {
    const text = render({
      ...BASE,
      repositoryIdentities: [{ path: "repos/github.com/acme/web", identity: "app" }],
    });
    expect(text).toContain("`repos/github.com/acme/web`: as the Opengeni app.");
    expect(text).not.toContain("github_personal__*");
    expect(text).not.toContain("not mounted as the person");
  });

  test("no identities leaves the repositories module byte-for-byte unchanged", () => {
    const without = render(BASE);
    expect(render({ ...BASE, repositoryIdentities: [] })).toBe(without);
    expect(without).not.toContain("GitHub identity per mounted repository");
    expect(without).toContain(
      "Provider CLIs such as gh, glab, and az may be pre-authenticated by the host through brokered git credentials or a sandbox preparation profile; try them before asking for credentials.",
    );
  });
});
