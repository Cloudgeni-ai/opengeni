import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  buildPersonalGitHubGitCredentials,
  personalGitBrokerOrigin,
} from "../src/personal-github-git-credentials";

describe("personal GitHub Git credential consumer", () => {
  test("is absent by default and cannot affect the GitHub App lane", () => {
    expect(
      buildPersonalGitHubGitCredentials(
        {} as never,
        testSettings({
          githubPersonalOauthEnabled: false,
        }),
      ),
    ).toBeNull();
  });

  test("rejects an insecure remote broker origin when enabled", () => {
    expect(() =>
      buildPersonalGitHubGitCredentials(
        {} as never,
        testSettings({
          githubPersonalOauthEnabled: true,
          integrationsStateSecret: "broker-secret",
          environment: "production",
          sandboxBackend: "modal",
          publicBaseUrl: "http://api.internal.test",
        }),
      ),
    ).toThrow("personal GitHub Git broker configuration is unavailable");
  });

  test("uses the Docker host broker without exposing the provider token", () => {
    expect(
      buildPersonalGitHubGitCredentials(
        {} as never,
        testSettings({
          githubPersonalOauthEnabled: true,
          integrationsStateSecret: "broker-secret",
          environment: "production",
          sandboxBackend: "docker",
          apiPort: 3100,
          publicBaseUrl: "http://127.0.0.1:3100",
        }),
      ),
    ).toBeFunction();
  });

  test("translates a host loopback URL for Docker sandboxes and accepts service DNS", () => {
    const translated = new URL(
      personalGitBrokerOrigin(
        testSettings({
          environment: "production",
          sandboxBackend: "docker",
          opengeniMcpUrl: "http://127.0.0.1:3100/v1/workspaces/{workspaceId}/mcp",
        }),
      )!,
    );
    expect(translated.protocol).toBe("http:");
    expect(translated.port).toBe("3100");
    expect(["127.0.0.1", "localhost"]).not.toContain(translated.hostname);
    expect(
      personalGitBrokerOrigin(
        testSettings({
          environment: "production",
          sandboxBackend: "docker",
          opengeniMcpUrl: "http://api:8000/v1/workspaces/{workspaceId}/mcp",
        }),
      ),
    ).toBe("http://api:8000");
  });
});
