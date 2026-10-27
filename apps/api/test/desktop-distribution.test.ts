import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing/settings";
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
  refsFromLsRefs,
  registerDesktopDistributionRoutes,
} from "../src/routes/desktop-distribution";

const RELEASES = "https://github.com/Cloudgeni-ai/opengeni/releases";

function routes(settings: Settings, resolveVersion?: () => Promise<string>) {
  const app = new Hono();
  registerDesktopDistributionRoutes(app, { settings } as ApiRouteDeps, resolveVersion);
  return app;
}

const GIT_URL = "https://github.com/Cloudgeni-ai/opengeni.git/git-upload-pack";
const API_URL =
  "https://api.github.com/repos/Cloudgeni-ai/opengeni/git/matching-refs/tags/desktop-v";

function pkt(line: string) {
  return `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
}

/** A Git protocol v2 ls-refs response listing the tags. */
function lsRefs(...tags: string[]) {
  return `${tags.map((tag) => pkt(`${"a".repeat(40)} refs/tags/${tag}\n`)).join("")}0000`;
}

type Answer = string[] | number | Error | { raw: string };

/** GitHub's Git endpoint and REST API, each answering from its own queue. */
function fakeGitHub(git: Answer[], api: Answer[] = []) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const fromGit = String(url) === GIT_URL;
    if (fromGit) bodies.push(init?.body);
    const answer = (fromGit ? git : api).shift() ?? 500;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("no", { status: answer });
    if ("raw" in answer) return new Response(answer.raw);
    return fromGit
      ? new Response(lsRefs(...answer))
      : Response.json(answer.map((tag) => ({ ref: `refs/tags/${tag}` })));
  }) as unknown as typeof fetch;
  return { calls, bodies, fetchImpl };
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

  test("reads ref names from a Git ls-refs response", () => {
    expect(refsFromLsRefs(lsRefs("desktop-v0.1.9", "desktop-v0.1.10"))).toEqual([
      "refs/tags/desktop-v0.1.9",
      "refs/tags/desktop-v0.1.10",
    ]);
    expect(
      refsFromLsRefs(
        `${pkt(`${"b".repeat(40)} refs/tags/desktop-v1.0.0 peeled:${"c".repeat(40)}\n`)}0000`,
      ),
    ).toEqual(["refs/tags/desktop-v1.0.0"]);
    expect(refsFromLsRefs("0000")).toEqual([]);
    expect(() => refsFromLsRefs(`${pkt("ERR upload-pack: not our ref\n")}0000`)).toThrow(
      "not our ref",
    );
    expect(() => refsFromLsRefs("<html>rate limited</html>")).toThrow("Malformed");
    expect(() => refsFromLsRefs("00ffshort")).toThrow("Truncated");
    expect(() => refsFromLsRefs(pkt("ERR\n"))).toThrow("Git ls-refs failed");
    // A complete answer ends with a flush packet; a cut-off list is refused.
    expect(() => refsFromLsRefs("")).toThrow("Truncated");
    expect(() => refsFromLsRefs(pkt(`${"a".repeat(40)} refs/tags/desktop-v0.1.9\n`))).toThrow(
      "Truncated",
    );
  });

  test("packet lengths count bytes, not characters", () => {
    const line = `${"a".repeat(40)} refs/tags/desktop-v0.1.0-é\n`;
    const bytes = new TextEncoder().encode(line).length + 4;
    const body = `${bytes.toString(16).padStart(4, "0")}${line}${lsRefs("desktop-v0.1.1")}`;
    expect(refsFromLsRefs(body)).toEqual([
      "refs/tags/desktop-v0.1.0-é",
      "refs/tags/desktop-v0.1.1",
    ]);
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
    const github = fakeGitHub([["desktop-v0.1.11", "desktop-v0.1.12"], ["desktop-v0.1.13"]]);
    const resolve = createDesktopVersionResolver({
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
      now: () => clock,
      freshForMs: 1_000,
    });
    expect(await Promise.all([resolve(), resolve()])).toEqual(["0.1.12", "0.1.12"]);
    expect(github.calls).toEqual([GIT_URL]);
    expect(github.bodies).toEqual([
      "0014command=ls-refs\n00010023ref-prefix refs/tags/desktop-v\n0000",
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
    const github = fakeGitHub([["desktop-v0.1.12"], 500, new Error("offline")], [503, 403]);
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
    expect(github.calls).toEqual([GIT_URL, GIT_URL, API_URL]);
    clock = 110;
    expect(await resolve()).toBe("0.1.12");
    await Bun.sleep(0);
    expect(github.calls).toEqual([GIT_URL, GIT_URL, API_URL, GIT_URL, API_URL]);
  });

  test("answers 503 until a release exists, and backs off between lookups", async () => {
    let clock = 0;
    const github = fakeGitHub([500, ["agent-v1.0.0"], ["desktop-v0.1.0"]], [500]);
    const resolve = createDesktopVersionResolver({
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
      now: () => clock,
      retryAfterMs: 100,
    });
    await expect(resolve()).rejects.toMatchObject({ status: 503 });
    clock = 50;
    await expect(resolve()).rejects.toMatchObject({ status: 503 });
    expect(github.calls).toEqual([GIT_URL, API_URL]);
    clock = 100;
    await expect(resolve()).rejects.toMatchObject({ status: 503 });
    clock = 200;
    expect(await resolve()).toBe("0.1.0");
  });

  test("falls back to the REST API when the Git endpoint fails", async () => {
    const github = fakeGitHub([403], [["desktop-v0.1.30", "desktop-v0.1.31"]]);
    const resolve = createDesktopVersionResolver({
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
    });
    expect(await resolve()).toBe("0.1.31");
    expect(github.calls).toEqual([GIT_URL, API_URL]);
  });

  test("a rate-limited REST API does not matter while Git answers", async () => {
    const github = fakeGitHub([["desktop-v0.1.31"]], [403]);
    const resolve = createDesktopVersionResolver({
      releasesBase: RELEASES,
      fetchImpl: github.fetchImpl,
    });
    expect(await resolve()).toBe("0.1.31");
    expect(github.calls).toEqual([GIT_URL]);
  });

  test("an unreadable Git answer falls back to the REST API", async () => {
    for (const raw of ["<html>Too many requests</html>", ""]) {
      const github = fakeGitHub([{ raw }], [["desktop-v0.1.31"]]);
      const resolve = createDesktopVersionResolver({
        releasesBase: RELEASES,
        fetchImpl: github.fetchImpl,
      });
      expect(await resolve()).toBe("0.1.31");
      expect(github.calls).toEqual([GIT_URL, API_URL]);
    }
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
