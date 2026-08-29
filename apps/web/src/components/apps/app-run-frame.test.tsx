import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  APP_RUN_IFRAME_ALLOW,
  APP_RUN_IFRAME_SANDBOX,
  AppRunFrame,
  safeAppLaunchUrl,
} from "./app-run-frame";

describe("OpenGeni App run frame security", () => {
  test("accepts only a declared dedicated HTTPS origin or distinct localhost origin", () => {
    expect(
      safeAppLaunchUrl(
        "https://apps.example.test/launch/1",
        "https://apps.example.test",
        "https://app.opengeni.ai",
      ),
    ).toBe("https://apps.example.test/launch/1");
    expect(
      safeAppLaunchUrl(
        "javascript:alert(1)",
        "https://apps.example.test",
        "https://app.opengeni.ai",
      ),
    ).toBeNull();
    expect(
      safeAppLaunchUrl(
        "https://evil.example.test/launch/1",
        "https://apps.example.test",
        "https://app.opengeni.ai",
      ),
    ).toBeNull();
    expect(
      safeAppLaunchUrl(
        "http://apps.example.test/launch/1",
        "http://apps.example.test",
        "http://localhost:3000",
      ),
    ).toBeNull();
  });

  test("omits parent-origin, popup, and top-navigation authority", () => {
    expect(APP_RUN_IFRAME_SANDBOX).toContain("allow-scripts");
    expect(APP_RUN_IFRAME_SANDBOX).not.toContain("allow-forms");
    expect(APP_RUN_IFRAME_SANDBOX).not.toContain("allow-downloads");
    expect(APP_RUN_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(APP_RUN_IFRAME_SANDBOX).not.toContain("allow-popups");
    expect(APP_RUN_IFRAME_SANDBOX).not.toContain("allow-top-navigation");
    const markup = renderToStaticMarkup(
      <AppRunFrame
        workspaceId="workspace-1"
        app={{
          id: "11111111-1111-4111-8111-111111111111",
          accountId: "22222222-2222-4222-8222-222222222222",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          slug: "status",
          title: "Status",
          description: null,
          status: "active",
          version: 1,
          latestSourceRevisionId: null,
          latestBuildId: "66666666-6666-4666-8666-666666666666",
          activeReleaseId: "44444444-4444-4444-8444-444444444444",
          createdBySubjectId: "subject-1",
          createdAt: "2026-08-29T12:00:00.000Z",
          updatedAt: "2026-08-29T12:00:00.000Z",
        }}
        catalog={{
          appId: "11111111-1111-4111-8111-111111111111",
          releaseId: "44444444-4444-4444-8444-444444444444",
          toolPolicyRevisionId: "55555555-5555-4555-8555-555555555555",
          catalogDigest: "a".repeat(64),
          tools: [],
        }}
        launch={{
          launchId: "77777777-7777-4777-8777-777777777777",
          appId: "11111111-1111-4111-8111-111111111111",
          releaseId: "44444444-4444-4444-8444-444444444444",
          authorityGeneration: "actor:7",
          launchUrl: "https://apps.example.test/launch/1",
          appOrigin: "https://apps.example.test",
          nonce: "n".repeat(32),
          expiresAt: "2026-08-29T12:15:00.000Z",
        }}
        client={{ callRuntimeTool: async () => ({}) as never }}
        productOrigin="https://app.opengeni.ai"
        onStop={() => undefined}
      />,
    );
    expect(markup).toContain(`sandbox="${APP_RUN_IFRAME_SANDBOX}"`);
    expect(markup).toContain('allow="camera');
    expect(APP_RUN_IFRAME_ALLOW).toContain("clipboard-read 'none'");
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('aria-label="Stop app"');
    expect(markup).toContain('aria-label="Reload app"');
  });

  test("fails closed when launch and catalog identities disagree", () => {
    const markup = renderToStaticMarkup(
      <AppRunFrame
        workspaceId="workspace-1"
        app={{
          id: "11111111-1111-4111-8111-111111111111",
          accountId: "22222222-2222-4222-8222-222222222222",
          workspaceId: "33333333-3333-4333-8333-333333333333",
          slug: "status",
          title: "Status",
          description: null,
          status: "active",
          version: 1,
          latestSourceRevisionId: null,
          latestBuildId: null,
          activeReleaseId: "44444444-4444-4444-8444-444444444444",
          createdBySubjectId: "subject-1",
          createdAt: "2026-08-29T12:00:00.000Z",
          updatedAt: "2026-08-29T12:00:00.000Z",
        }}
        catalog={{
          appId: "11111111-1111-4111-8111-111111111111",
          releaseId: "44444444-4444-4444-8444-444444444444",
          toolPolicyRevisionId: "55555555-5555-4555-8555-555555555555",
          catalogDigest: "a".repeat(64),
          tools: [],
        }}
        launch={{
          launchId: "77777777-7777-4777-8777-777777777777",
          appId: "66666666-6666-4666-8666-666666666666",
          releaseId: "44444444-4444-4444-8444-444444444444",
          authorityGeneration: "actor:7",
          launchUrl: "https://apps.example.test/launch/1",
          appOrigin: "https://apps.example.test",
          nonce: "n".repeat(32),
          expiresAt: "2026-08-29T12:15:00.000Z",
        }}
        client={{ callRuntimeTool: async () => ({}) as never }}
        productOrigin="https://app.opengeni.ai"
        onStop={() => undefined}
      />,
    );
    expect(markup).toContain("identity or capability projection did not match");
    expect(markup).not.toContain("<iframe");
  });
});
