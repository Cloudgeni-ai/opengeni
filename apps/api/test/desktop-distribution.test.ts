import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import type { Settings } from "@opengeni/config";
import type { ApiRouteDeps } from "@opengeni/core";
import { createApp } from "../src/app";
import type { AppDependencies } from "../src/app";
import {
  createDesktopVersionResolver,
  desktopInstallerFor,
  desktopReleaseFile,
  githubRepositoryOf,
  newestDesktopVersion,
  registerDesktopDistributionRoutes,
} from "../src/routes/desktop-distribution";

const RELEASES = "https://github.com/Cloudgeni-ai/opengeni/releases";

function routes(settings: Settings, resolveVersion?: () => Promise<string>) {
  const app = new Hono();
  registerDesktopDistributionRoutes(app, { settings } as ApiRouteDeps, resolveVersion);
  return app;
}

function refs(...tags: string[]) {
  return tags.map((tag) => ({ ref: `refs/tags/${tag}` }));
}

function fakeGitHub(answers: Array<unknown>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("no", { status: answer });
    return Response.json(answer);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("desktop release files", () => {
  test("maps every published download to its versioned name", () => {
    const expected: Record<string, string> = {
      "Opengeni-mac.dmg": "Opengeni-1.2.3-mac.dmg",
      "Opengeni-mac.zip": "Opengeni-1.2.3-mac.zip",
      "Opengeni-windows.exe": "Opengeni-1.2.3-windows.exe",
      "Opengeni-windows-x64.exe": "Opengeni-1.2.3-windows-x64.exe",
      "Opengeni-windows-arm64.exe": "Opengeni-1.2.3-windows-arm64.exe",
      "Opengeni-linux-x86_64.AppImage": "Opengeni-1.2.3-linux-x86_64.AppImage",
      "Opengeni-linux-arm64.AppImage": "Opengeni-1.2.3-linux-arm64.AppImage",
      "Opengeni-linux-amd64.deb": "Opengeni-1.2.3-linux-amd64.deb",
      "Opengeni-linux-arm64.deb": "Opengeni-1.2.3-linux-arm64.deb",
      "Opengeni-linux-x86_64.rpm": "Opengeni-1.2.3-linux-x86_64.rpm",
      "Opengeni-linux-aarch64.rpm": "Opengeni-1.2.3-linux-aarch64.rpm",
      SHA256SUMS: "SHA256SUMS",
    };
    for (const [asset, file] of Object.entries(expected)) {
      expect(desktopReleaseFile(asset, "1.2.3")).toBe(file);
    }
  });

  test("refuses anything else", () => {
    for (const asset of [
      "Opengeni-mac.dmg.blockmap",
      "latest-mac.yml",
      "Opengeni-1.2.3-mac.dmg",
      "opengeni-agent-x86_64-unknown-linux-musl",
      "Opengeni-linux-x86_64.AppImage/../x",
      "Opengeni-mac.dmg?x=1",
    ]) {
      expect(desktopReleaseFile(asset, "1.2.3")).toBeNull();
    }
  });

  test("the newest stable desktop tag wins numerically", () => {
    expect(
      newestDesktopVersion([
        "desktop-v0.1.9",
        "desktop-v0.1.12",
        "desktop-v0.2.0-beta.1",
        "agent-v9.9.9",
        "desktop-v0.1.2",
      ]),
    ).toBe("0.1.12");
    expect(newestDesktopVersion(["agent-v1.0.0"])).toBeNull();
  });

  test("only GitHub release pages name a repository", () => {
    expect(githubRepositoryOf(RELEASES)).toBe("Cloudgeni-ai/opengeni");
    expect(githubRepositoryOf("https://downloads.example.com/releases")).toBeNull();
  });
});

describe("desktop version resolver", () => {
  test("a pin is served without asking GitHub", async () => {
    const github = fakeGitHub([]);
    const resolve = createDesktopVersionResolver({
      pinnedVersion: "0.1.5",
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
    });
    expect(await resolve()).toBe("0.1.5");
    expect(github.calls).toHaveLength(0);
  });

  test("looks the newest release up once and reuses it while fresh", async () => {
    let clock = 0;
    const github = fakeGitHub([
      refs("desktop-v0.1.11", "desktop-v0.1.12"),
      refs("desktop-v0.1.13"),
    ]);
    const resolve = createDesktopVersionResolver({
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
      now: () => clock,
      freshForMs: 1_000,
    });
    expect(await Promise.all([resolve(), resolve()])).toEqual(["0.1.12", "0.1.12"]);
    expect(github.calls).toEqual([
      "https://api.github.com/repos/Cloudgeni-ai/opengeni/git/matching-refs/tags/desktop-v",
    ]);
    clock = 999;
    expect(await resolve()).toBe("0.1.12");
    expect(github.calls).toHaveLength(1);
    // Once stale, the known version answers at once while a refresh runs.
    clock = 1_000;
    expect(await resolve()).toBe("0.1.12");
    await Bun.sleep(0);
    expect(await resolve()).toBe("0.1.13");
    expect(github.calls).toHaveLength(2);
  });

  test("keeps serving the last known version when GitHub fails", async () => {
    let clock = 0;
    const github = fakeGitHub([refs("desktop-v0.1.12"), 500, new Error("offline")]);
    const resolve = createDesktopVersionResolver({
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
      now: () => clock,
      freshForMs: 10,
      retryAfterMs: 100,
    });
    expect(await resolve()).toBe("0.1.12");
    clock = 10;
    expect(await resolve()).toBe("0.1.12");
    await Bun.sleep(0);
    // The failed refresh backs off instead of asking again on every request.
    clock = 50;
    expect(await resolve()).toBe("0.1.12");
    expect(github.calls).toHaveLength(2);
    clock = 110;
    expect(await resolve()).toBe("0.1.12");
    expect(github.calls).toHaveLength(3);
  });

  test("answers 503 until a release exists, and backs off between lookups", async () => {
    let clock = 0;
    const github = fakeGitHub([500, refs("agent-v1.0.0"), refs("desktop-v0.1.0")]);
    const resolve = createDesktopVersionResolver({
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
      now: () => clock,
      retryAfterMs: 100,
    });
    await expect(resolve()).rejects.toMatchObject({ status: 503 });
    clock = 50;
    await expect(resolve()).rejects.toMatchObject({ status: 503 });
    expect(github.calls).toHaveLength(1);
    clock = 100;
    await expect(resolve()).rejects.toMatchObject({ status: 503 });
    clock = 200;
    expect(await resolve()).toBe("0.1.0");
  });

  test("a release host other than GitHub needs a pin", async () => {
    const resolve = createDesktopVersionResolver({
      releasesBase: "https://downloads.example.com/releases",
    });
    await expect(resolve()).rejects.toMatchObject({ status: 503 });
  });
});

describe("desktop download routes", () => {
  test("redirects a version-less name to the current release", async () => {
    const app = routes(testSettings(), async () => "0.1.12");
    const res = await app.request("/desktop/latest/Opengeni-mac.dmg");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${RELEASES}/download/desktop-v0.1.12/Opengeni-0.1.12-mac.dmg`,
    );
    const sums = await app.request("/desktop/latest/SHA256SUMS");
    expect(sums.headers.get("location")).toBe(`${RELEASES}/download/desktop-v0.1.12/SHA256SUMS`);
  });

  test("the release page redirects to the current release", async () => {
    const app = routes(testSettings(), async () => "0.1.12");
    const res = await app.request("/desktop/latest");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${RELEASES}/tag/desktop-v0.1.12`);
  });

  test("an unknown name is a 404 and costs no lookup", async () => {
    let lookups = 0;
    const app = routes(testSettings(), async () => {
      lookups++;
      return "0.1.12";
    });
    const res = await app.request("/desktop/latest/latest-mac.yml");
    expect(res.status).toBe(404);
    expect(lookups).toBe(0);
  });

  test("the operator pin decides the version", async () => {
    const app = routes(testSettings({ desktopStableVersion: "0.1.7" }));
    const res = await app.request("/desktop/latest/Opengeni-linux-amd64.deb");
    expect(res.headers.get("location")).toBe(
      `${RELEASES}/download/desktop-v0.1.7/Opengeni-0.1.7-linux-amd64.deb`,
    );
  });

  test("serves the installer pointed at this server", async () => {
    const app = routes(testSettings({ publicBaseUrl: "https://cp.example.com/" }));
    const res = await app.request("/desktop/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shellscript");
    const body = await res.text();
    expect(body.startsWith("#!/bin/sh")).toBe(true);
    expect(body).toContain('OPENGENI_DESKTOP_DEFAULT_BASE_URL="https://cp.example.com"');
    expect(body).not.toContain('OPENGENI_DESKTOP_DEFAULT_BASE_URL=""');
  });

  test("the installer is served verbatim without a public address", () => {
    const body = 'x\nOPENGENI_DESKTOP_DEFAULT_BASE_URL=""\n';
    expect(desktopInstallerFor(body, undefined)).toBe(body);
    expect(desktopInstallerFor(body, "javascript:alert(1)")).toBe(body);
  });

  test("downloads need no credentials on an auth-required deployment", async () => {
    const settings = testSettings({ authRequired: true, desktopStableVersion: "0.1.12" });
    const app = createApp({
      settings,
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    } satisfies AppDependencies);
    expect((await app.request("/desktop/install.sh")).status).toBe(200);
    expect((await app.request("/desktop/latest/Opengeni-mac.zip")).status).toBe(302);
    expect((await app.request("/desktop/latest")).status).toBe(302);
    expect((await app.request("/desktop/other")).status).toBe(401);
  });
});
