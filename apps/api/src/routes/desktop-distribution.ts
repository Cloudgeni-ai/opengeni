import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";

// Public download routes for the desktop app. Like the agent install routes,
// they are unauthenticated so a person can install the app before signing in:
//
//   GET /desktop/install.sh          the macOS and Linux installer
//   GET /desktop/latest              302 to the current release's page
//   GET /desktop/latest/<asset>      302 to the current release's file
//
// <asset> is a version-less release file name such as Opengeni-mac.dmg. The
// route redirects to Opengeni-<version>-mac.dmg on the desktop-v<version>
// release. GitHub's repository-wide "latest release" can't be used: agent and
// package releases share the repository, so "latest" is rarely the desktop app.

const INSTALL_DIR =
  [
    new URL("./assets/desktop-install/", import.meta.url),
    new URL("../../../desktop/install/", import.meta.url),
  ].find((candidate) => existsSync(candidate)) ??
  new URL("../../../desktop/install/", import.meta.url);

export const DESKTOP_INSTALLER_PATH = "/desktop/install.sh";
export const DESKTOP_RELEASE_PAGE_PATH = "/desktop/latest";
export const DESKTOP_DOWNLOAD_PREFIX = "/desktop/latest/";

// Every file a desktop release publishes for people to download, without its
// version. A strict list, so the redirect can't point anywhere else.
const RELEASE_FILE =
  /^Opengeni-(mac\.dmg|mac\.zip|windows\.exe|windows-(?:x64|arm64)\.exe|linux-(?:x86_64|arm64)\.AppImage|linux-(?:amd64|arm64)\.deb|linux-(?:x86_64|aarch64)\.rpm)$/u;

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;
const TAG_PREFIX = "desktop-v";

/** The versioned release file for a version-less name, or null if it isn't one. */
export function desktopReleaseFile(asset: string, version: string): string | null {
  if (asset === "SHA256SUMS") return asset;
  const match = RELEASE_FILE.exec(asset);
  return match ? `Opengeni-${version}-${match[1]}` : null;
}

/** The highest stable version among desktop-v<version> tags. */
export function newestDesktopVersion(tags: readonly string[]): string | null {
  let best: number[] | null = null;
  for (const tag of tags) {
    if (!tag.startsWith(TAG_PREFIX)) continue;
    const match = STABLE_VERSION.exec(tag.slice(TAG_PREFIX.length));
    if (!match) continue;
    const version = match.slice(1).map(Number);
    if (!best || compareVersions(version, best) > 0) best = version;
  }
  return best ? best.join(".") : null;
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** owner/name for a https://github.com/<owner>/<name>/releases base, else null. */
export function githubRepositoryOf(releasesBase: string): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/?$/u.exec(releasesBase);
  return match?.[1] ?? null;
}

export interface DesktopVersionResolverOptions {
  /** An operator pin. When set, it is the only version ever served. */
  pinnedVersion?: string | undefined;
  releasesBase: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a looked-up version is reused. */
  freshForMs?: number;
  /** How long to wait before looking again after a failed lookup. */
  retryAfterMs?: number;
}

/**
 * The version /desktop/latest serves: the pin, or the newest desktop-v tag on
 * the release repository. A lookup is shared by concurrent requests and reused
 * for ten minutes, well within GitHub's unauthenticated rate limit. When GitHub
 * is unreachable the last known version keeps serving.
 */
export function createDesktopVersionResolver(
  options: DesktopVersionResolverOptions,
): () => Promise<string> {
  const { pinnedVersion } = options;
  if (pinnedVersion) return async () => pinnedVersion;
  const repository = githubRepositoryOf(options.releasesBase);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const freshForMs = options.freshForMs ?? 10 * 60_000;
  const retryAfterMs = options.retryAfterMs ?? 30_000;
  let known: string | null = null;
  let nextLookupAt = 0;
  let inFlight: Promise<void> | null = null;

  async function lookUp(): Promise<void> {
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/git/matching-refs/tags/${TAG_PREFIX}`,
        {
          headers: { accept: "application/vnd.github+json", "user-agent": "opengeni-api" },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const refs = (await response.json()) as Array<{ ref?: unknown }>;
      const version = newestDesktopVersion(
        refs.flatMap((entry) =>
          typeof entry.ref === "string" && entry.ref.startsWith("refs/tags/")
            ? [entry.ref.slice("refs/tags/".length)]
            : [],
        ),
      );
      if (version) known = version;
      nextLookupAt = now() + (version ? freshForMs : retryAfterMs);
    } catch {
      nextLookupAt = now() + retryAfterMs;
    }
  }

  return async () => {
    if (!repository) {
      throw new HTTPException(503, {
        message: "Desktop downloads need OPENGENI_DESKTOP_STABLE_VERSION for this release host.",
      });
    }
    if (now() >= nextLookupAt) {
      inFlight ??= lookUp().finally(() => {
        inFlight = null;
      });
      // The first lookup has nothing to fall back to; later ones refresh in
      // the background and keep serving the version already known.
      if (!known) await inFlight;
    }
    if (!known) {
      throw new HTTPException(503, { message: "No desktop release is available yet." });
    }
    return known;
  };
}

let installerBody: string | undefined;

// The installer resolves releases through this server when it knows the
// server's address, so a deployment's version pin applies. A copy run from the
// repository looks the release up on GitHub itself.
const BASE_URL_MARKER = 'OPENGENI_DESKTOP_DEFAULT_BASE_URL=""';

export function desktopInstallerFor(body: string, publicBaseUrl: string | undefined): string {
  if (!publicBaseUrl || !/^https?:\/\//u.test(publicBaseUrl)) return body;
  const base = publicBaseUrl.replace(/\/+$/u, "");
  return body.replace(BASE_URL_MARKER, `OPENGENI_DESKTOP_DEFAULT_BASE_URL="${base}"`);
}

export function registerDesktopDistributionRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  resolveVersion = createDesktopVersionResolver({
    pinnedVersion: deps.settings.desktopStableVersion,
    releasesBase: deps.settings.agentReleasesBaseUrl.replace(/\/+$/u, ""),
  }),
): void {
  const releasesBase = deps.settings.agentReleasesBaseUrl.replace(/\/+$/u, "");

  app.get(DESKTOP_INSTALLER_PATH, async (c) => {
    installerBody ??= await readFile(new URL("install.sh", INSTALL_DIR), "utf8");
    return c.text(desktopInstallerFor(installerBody, deps.settings.publicBaseUrl), 200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  });

  // The release page, listing every platform's download.
  app.get(DESKTOP_RELEASE_PAGE_PATH, async () => {
    const version = await resolveVersion();
    return new Response(null, {
      status: 302,
      headers: {
        location: `${releasesBase}/tag/${TAG_PREFIX}${version}`,
        "cache-control": "public, max-age=300",
      },
    });
  });

  app.get(`${DESKTOP_DOWNLOAD_PREFIX}:asset`, async (c) => {
    const asset = c.req.param("asset");
    // Validate before resolving, so a bad name never costs a lookup.
    if (!desktopReleaseFile(asset, "0.0.0")) {
      throw new HTTPException(404, { message: "Unknown desktop download." });
    }
    const version = await resolveVersion();
    const file = desktopReleaseFile(asset, version)!;
    return new Response(null, {
      status: 302,
      headers: {
        location: `${releasesBase}/download/${TAG_PREFIX}${version}/${file}`,
        "cache-control": "public, max-age=300",
      },
    });
  });
}

export function isDesktopDistributionPath(path: string): boolean {
  return (
    path === DESKTOP_INSTALLER_PATH ||
    path === DESKTOP_RELEASE_PAGE_PATH ||
    path.startsWith(DESKTOP_DOWNLOAD_PREFIX)
  );
}
