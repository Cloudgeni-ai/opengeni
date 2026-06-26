import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AppDependencies } from "../src/app";
import { testSettings } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";

// The get.<domain> install-serving routes (dossier §23.1). These only read
// settings + the committed agent/install/* files; db / bus / workflowClient are
// never touched, so we stub them and force managedAuth null (no Better Auth). No
// docker/postgres needed — safe to run in isolation.
function appFor(settings: Settings) {
  const deps = {
    settings,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } satisfies AppDependencies;
  return createApp(deps);
}

describe("get.<domain> install routes", () => {
  test("GET /install.sh serves the committed POSIX script as a shell content type", async () => {
    const res = await appFor(testSettings()).request("/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shellscript");
    expect(res.headers.get("cache-control")).toContain("max-age");
    const body = await res.text();
    // The real committed install.sh body (no secrets; curl|sh entrypoint).
    expect(body).toContain("OPENGENI_INSTALL_BASE_URL");
    expect(body).toContain("opengeni-agent");
  });

  test("GET /install.ps1 serves the Windows installer", async () => {
    const res = await appFor(testSettings()).request("/install.ps1");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("GET /uninstall.sh serves the uninstall script", async () => {
    const res = await appFor(testSettings()).request("/uninstall.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shellscript");
  });

  test("GET /opengeni-agent-minisign.pub serves the public key as text/plain", async () => {
    const res = await appFor(testSettings()).request("/opengeni-agent-minisign.pub");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // A minisign public key file leads with the untrusted-comment line.
    expect(body).toContain("minisign public key");
  });

  test("GET /agent/latest/<asset> redirects to the GitHub latest-release alias", async () => {
    const res = await appFor(testSettings()).request("/agent/latest/opengeni-agent-x86_64-unknown-linux-musl");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/Cloudgeni-ai/opengeni/releases/latest/download/opengeni-agent-x86_64-unknown-linux-musl",
    );
  });

  test("GET /agent/v<ver>/<asset> redirects to the immutable agent-v<ver> tag asset", async () => {
    const res = await appFor(testSettings()).request("/agent/v1.2.3/opengeni-agent-universal-apple-darwin.minisig");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-v1.2.3/opengeni-agent-universal-apple-darwin.minisig",
    );
  });

  test("a configured agentReleasesBaseUrl overrides the redirect target", async () => {
    const settings = testSettings({ agentReleasesBaseUrl: "https://mirror.example.com/rel/" });
    const res = await appFor(settings).request("/agent/latest/opengeni-agent-x86_64-unknown-linux-musl");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://mirror.example.com/rel/latest/download/opengeni-agent-x86_64-unknown-linux-musl",
    );
  });

  test("rejects an asset name that is not the agent asset shape (no open redirect)", async () => {
    const res = await appFor(testSettings()).request("/agent/latest/..%2F..%2Fevil");
    expect(res.status).toBe(400);
  });

  test("the install routes are reachable with auth REQUIRED (unauthenticated curl)", async () => {
    // A fresh machine holds no credentials; the install bodies carry no secrets,
    // so the routes must be auth-exempt even when authRequired is on.
    const settings = testSettings({ authRequired: true, accessKey: "secret-key", authAllowHealth: true });
    const app = appFor(settings);

    const installed = await app.request("/install.sh");
    expect(installed.status).toBe(200);

    const redirect = await app.request("/agent/latest/opengeni-agent-x86_64-unknown-linux-musl");
    expect(redirect.status).toBe(302);

    // A normal authenticated route is still gated (proves auth is actually on).
    const gated = await app.request("/v1/workspaces/ws_test/api-keys");
    expect(gated.status).toBe(401);
  });
});
