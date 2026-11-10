import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import { consoleContentSecuritySources } from "../src/http/console-content-security";

const storage = (base: string) => ({
  createGetUrl: async ({ key }: { key: string }) => ({ url: `${base}/container/${key}?sig=x` }),
});

function allSources(result: Awaited<ReturnType<typeof consoleContentSecuritySources>>) {
  return Object.values(result.directives).flat();
}

describe("console Content-Security-Policy sources", () => {
  test("lists exactly the configured external origins, never * or a bare scheme", async () => {
    const result = await consoleContentSecuritySources({
      settings: testSettings({
        productAccessMode: "managed",
        publicBaseUrl: "https://app.example.com",
        webBaseUrl: "https://app.example.com",
        sitesDomain: "example.site",
        signupChallengeEnabled: true,
        signupChallengeSiteKey: "site-key",
        managedAuthGoogleClientId: "google",
        managedAuthGithubClientId: "github",
      } as never),
      objectStorage: storage("https://acct.blob.core.windows.net") as never,
    });
    expect(result.directives["connect-src"]).toContain("https://acct.blob.core.windows.net");
    expect(result.directives["img-src"]).toContain("https://acct.blob.core.windows.net");
    expect(result.directives["media-src"]).toContain("https://acct.blob.core.windows.net");
    expect(result.directives["script-src"]).toEqual(["https://challenges.cloudflare.com"]);
    expect(result.directives["frame-src"]).toEqual([
      "https://challenges.cloudflare.com",
      "https://og.example.site",
    ]);
    expect(result.directives["img-src"]).toContain("https://lh3.googleusercontent.com");
    expect(result.directives["img-src"]).toContain("https://avatars.githubusercontent.com");
    expect(result.directives["form-action"]).toEqual([]);
    expect(result.htmlFrameHost).toBe("https://og.example.site");
    expect(result.imageProxyPath).toBe("/v1/image-proxy");
    for (const source of allSources(result)) {
      expect(source).not.toBe("*");
      expect(source).not.toMatch(/^[a-z]+:$/u);
    }
  });

  test("adds nothing that is not configured", async () => {
    const result = await consoleContentSecuritySources({
      settings: testSettings({ productAccessMode: "managed", sitesDomain: undefined } as never),
      objectStorage: null,
    });
    expect(result.directives["script-src"]).toEqual([]);
    expect(result.directives["frame-src"]).toEqual([]);
    expect(result.htmlFrameHost).toBeNull();
    // Self-hosted operators post the GitHub App manifest form to GitHub.
    const selfHosted = await consoleContentSecuritySources({
      settings: testSettings({ productAccessMode: "local" } as never),
      objectStorage: null,
    });
    expect(selfHosted.directives["form-action"]).toEqual(["https://github.com"]);
  });

  test("the route is public and uncached", async () => {
    const app = createApp({
      settings: testSettings({ productAccessMode: "managed" }),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    const response = await app.request("http://localhost/v1/config/content-security");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { version: number; directives: object };
    expect(body.version).toBe(1);
    expect(Object.keys(body.directives).sort()).toEqual([
      "connect-src",
      "form-action",
      "frame-src",
      "img-src",
      "media-src",
      "script-src",
    ]);
  });
});
