import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

// The baked dir install.ts serves per-SHA binaries from. In the committed tree it
// holds only a placeholder (so EVERY asset 302-redirects), and a deployed-env image
// build writes the signed binaries here before `docker build`. The redirect tests
// below therefore use assets that are NEVER baked into this Linux-musl-only dir
// (mac/windows/un-built arches) so they are deterministic regardless of any local
// build artifacts; the baked-path tests stage a throwaway file and clean it up.
const BAKED_DIR = fileURLToPath(new URL("../../../agent/install/baked/", import.meta.url));
const BAKED_FIXTURE = "opengeni-agent-x86_64-unknown-linux-musl-test-fixture";

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

  // "The agent ships inside the control-plane": a DEPLOYED control plane self-serves
  // its matching baked agent. The served install scripts must therefore default
  // their asset base URL to THIS deployment's own public origin (so `curl
  // <host>/install.sh | sh` pulls from the same host — no retired host dependency),
  // while the user's OPENGENI_INSTALL_BASE_URL override still wins.
  test("GET /install.sh rewrites the default asset base URL to the deployment's own origin", async () => {
    const settings = testSettings({ publicBaseUrl: "https://cp.example.com/" });
    const res = await appFor(settings).request("/install.sh");
    const body = await res.text();
    expect(body).toContain('OPENGENI_INSTALL_DEFAULT_BASE_URL="https://cp.example.com"');
    expect(body).not.toContain('OPENGENI_INSTALL_DEFAULT_BASE_URL="https://app.opengeni.ai"');
    // The user-facing override var name is untouched (operator can still repoint).
    expect(body).toContain("OPENGENI_INSTALL_BASE_URL");
  });

  test("GET /install.ps1 rewrites the default asset base URL to the deployment's own origin", async () => {
    const settings = testSettings({ publicBaseUrl: "https://cp.example.com" });
    const res = await appFor(settings).request("/install.ps1");
    const body = await res.text();
    expect(body).toContain("$OpengeniInstallDefaultBaseUrl = 'https://cp.example.com'");
    expect(body).not.toContain("$OpengeniInstallDefaultBaseUrl = 'https://app.opengeni.ai'");
  });

  test("GET installers keep the hosted app origin default when no public base URL is configured", async () => {
    const settings = testSettings({ publicBaseUrl: undefined });
    const app = appFor(settings);
    const unix = await (await app.request("/install.sh")).text();
    expect(unix).toContain('OPENGENI_INSTALL_DEFAULT_BASE_URL="https://app.opengeni.ai"');
    const windows = await (await app.request("/install.ps1")).text();
    expect(windows).toContain("$OpengeniInstallDefaultBaseUrl = 'https://app.opengeni.ai'");
  });

  test("GET /install.ps1 serves the Windows installer", async () => {
    const res = await appFor(testSettings()).request("/install.ps1");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    // The public provisioning wrapper's process-local variables must be printed
    // back into the interactive command; otherwise they disappear after `iex`.
    expect(body).toContain("$env:OPENGENI_WORKSPACE_ID = $(Quote-PowerShell");
    expect(body).toContain("$env:OPENGENI_API_URL = $(Quote-PowerShell");
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

  // An asset that is NEVER baked (mac universal) always falls through to the
  // GitHub-Releases redirect, so these assertions hold whether or not a Linux
  // binary happens to be baked into the local tree.
  test("GET /agent/latest/<unbaked-asset> redirects to the moving agent-latest release", async () => {
    const res = await appFor(testSettings()).request(
      "/agent/latest/opengeni-agent-universal-apple-darwin",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-latest/opengeni-agent-universal-apple-darwin",
    );
  });

  test("GET /agent/v<ver>/<unbaked-asset> redirects to the immutable agent-v<ver> tag asset", async () => {
    const res = await appFor(testSettings()).request(
      "/agent/v1.2.3/opengeni-agent-universal-apple-darwin.minisig",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-v1.2.3/opengeni-agent-universal-apple-darwin.minisig",
    );
  });

  test("GET /agent/stable/manifest.json redirects to the signed moving release asset", async () => {
    const app = appFor(testSettings());
    const manifest = await app.request("/agent/stable/manifest.json");
    expect(manifest.status).toBe(302);
    expect(manifest.headers.get("location")).toBe(
      "https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-latest/manifest.json",
    );
    const signature = await app.request("/agent/stable/manifest.json.minisig");
    expect(signature.status).toBe(302);
    expect(signature.headers.get("location")).toBe(
      "https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-latest/manifest.json.minisig",
    );
    expect((await app.request("/agent/beta/manifest.json")).status).toBe(400);
  });

  test("a configured agentReleasesBaseUrl overrides the redirect target", async () => {
    const settings = testSettings({ agentReleasesBaseUrl: "https://mirror.example.com/rel/" });
    const res = await appFor(settings).request(
      "/agent/latest/opengeni-agent-universal-apple-darwin",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://mirror.example.com/rel/download/agent-latest/opengeni-agent-universal-apple-darwin",
    );
  });

  test("rejects an asset name that is not the agent asset shape (no open redirect)", async () => {
    const res = await appFor(testSettings()).request("/agent/latest/..%2F..%2Fevil");
    expect(res.status).toBe(400);
  });

  test("the install routes are reachable with auth REQUIRED (unauthenticated curl)", async () => {
    // A fresh machine holds no credentials; the install bodies carry no secrets,
    // so the routes must be auth-exempt even when authRequired is on.
    const settings = testSettings({
      authRequired: true,
      accessKey: "secret-key",
      authAllowHealth: true,
    });
    const app = appFor(settings);

    const installed = await app.request("/install.sh");
    expect(installed.status).toBe(200);

    // A binary-asset route is auth-exempt too (here the un-baked mac asset 302s).
    const redirect = await app.request("/agent/latest/opengeni-agent-universal-apple-darwin");
    expect(redirect.status).toBe(302);

    // A normal authenticated route is still gated (proves auth is actually on).
    const gated = await app.request("/v1/workspaces/ws_test/api-keys");
    expect(gated.status).toBe(401);
  });
});

// The "agent ships inside the control-plane" path: when THIS image bakes a binary
// into agent/install/baked/, the /agent/latest/* routes serve it directly (200)
// instead of 302-redirecting. Pinned `v<ver>` paths are always immutable release
// redirects and must never return this deployment's baked current binary.
// octet-stream and the .sha256/.minisig sidecars as text. We stage a throwaway
// fixture so the test is hermetic and never depends on a real build artifact.
describe("get.<domain> install routes — baked binary serving", () => {
  beforeEach(async () => {
    await mkdir(BAKED_DIR, { recursive: true });
    await writeFile(`${BAKED_DIR}${BAKED_FIXTURE}`, "BAKED-BINARY-BYTES");
    await writeFile(`${BAKED_DIR}${BAKED_FIXTURE}.sha256`, "deadbeef  baked\n");
    await writeFile(`${BAKED_DIR}${BAKED_FIXTURE}.minisig`, "untrusted comment: x\nSIG\n");
  });

  afterEach(async () => {
    await rm(`${BAKED_DIR}${BAKED_FIXTURE}`, { force: true });
    await rm(`${BAKED_DIR}${BAKED_FIXTURE}.sha256`, { force: true });
    await rm(`${BAKED_DIR}${BAKED_FIXTURE}.minisig`, { force: true });
  });

  test("GET /agent/latest/<baked-asset> serves the baked binary as octet-stream (no redirect)", async () => {
    const res = await appFor(testSettings()).request(`/agent/latest/${BAKED_FIXTURE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("x-opengeni-agent-source")).toBe("baked");
    expect(await res.text()).toBe("BAKED-BINARY-BYTES");
  });

  test("GET /agent/v<ver>/<baked-asset> never serves the baked current binary", async () => {
    const res = await appFor(testSettings()).request(`/agent/v9.9.9/${BAKED_FIXTURE}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("x-opengeni-agent-source")).toBeNull();
    expect(res.headers.get("location")).toBe(
      `https://github.com/Cloudgeni-ai/opengeni/releases/download/agent-v9.9.9/${BAKED_FIXTURE}`,
    );
  });

  test("GET the baked .sha256 / .minisig sidecars as text/plain", async () => {
    const sha = await appFor(testSettings()).request(`/agent/latest/${BAKED_FIXTURE}.sha256`);
    expect(sha.status).toBe(200);
    expect(sha.headers.get("content-type")).toContain("text/plain");
    expect(await sha.text()).toContain("deadbeef");

    const sig = await appFor(testSettings()).request(`/agent/latest/${BAKED_FIXTURE}.minisig`);
    expect(sig.status).toBe(200);
    expect(sig.headers.get("content-type")).toContain("text/plain");
    expect(await sig.text()).toContain("untrusted comment");
  });

  test("an un-baked asset still 302s to GitHub Releases even while another asset is baked", async () => {
    const res = await appFor(testSettings()).request(
      "/agent/latest/opengeni-agent-universal-apple-darwin",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "/releases/download/agent-latest/opengeni-agent-universal-apple-darwin",
    );
  });
});
