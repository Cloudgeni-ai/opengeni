import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";

// The get.<domain> install-serving routes (dossier §23.1). These are
// UNAUTHENTICATED (see http/auth.ts isAuthExempt — the `installExemptPaths` set)
// so a fresh machine with no credentials can `curl -fsSL https://get.<domain>/install.sh`,
// read it first, then pipe to sh. They serve the IN-REPO committed script bodies
// (agent/install/*) verbatim — a single branded, audit-greppable trust root — and
// redirect the per-version release-binary asset URLs to GitHub Releases.
//
// The script BODIES contain NO secrets (POSIX sh, the device-flow captures the
// loud consent). The redirect targets are public GitHub Release assets.

// The committed install artifacts, resolved relative to this module so the API
// (run from source under /app via bun) locates the sibling agent/install/ dir at
// runtime. apps/api/src/routes -> ../../../../agent/install.
const INSTALL_DIR = new URL("../../../../agent/install/", import.meta.url);

// The static text artifacts served verbatim, with their content types. Each is
// read once at first request and memoized (committed files; immutable per deploy).
const TEXT_ASSETS: Record<string, { file: string; contentType: string }> = {
  "/install.sh": { file: "install.sh", contentType: "text/x-shellscript; charset=utf-8" },
  "/install.ps1": { file: "install.ps1", contentType: "text/plain; charset=utf-8" },
  "/uninstall.sh": { file: "uninstall.sh", contentType: "text/x-shellscript; charset=utf-8" },
  "/opengeni-agent-minisign.pub": { file: "opengeni-agent-minisign.pub", contentType: "text/plain; charset=utf-8" },
};

const assetCache = new Map<string, string>();

async function loadAsset(file: string): Promise<string> {
  const cached = assetCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const body = await readFile(new URL(file, INSTALL_DIR), "utf8");
  assetCache.set(file, body);
  return body;
}

// `/agent/latest/<asset>` and `/agent/v<ver>/<asset>` (+ the `.sha256` / `.minisig`
// siblings the install script fetches) — see agent/install/install.sh asset_url().
// `<asset>` and the version segment are constrained so the redirect cannot be used
// as an open redirector: only the agent asset-name shape + a `v`-prefixed version.
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The install script's version path segment is the literal `v<ver>` (e.g. v1.2.3).
const VERSION_SEG = /^v[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function registerInstallRoutes(app: Hono, deps: ApiRouteDeps): void {
  const releasesBase = deps.settings.agentReleasesBaseUrl.replace(/\/+$/, "");

  for (const [path, { file, contentType }] of Object.entries(TEXT_ASSETS)) {
    app.get(path, async (c) => {
      const body = await loadAsset(file);
      return c.text(body, 200, {
        "content-type": contentType,
        // Short cache: the edge serves the latest committed copy; new installs
        // should pick up script fixes promptly, but a brief cache absorbs bursts.
        "cache-control": "public, max-age=300",
      });
    });
  }

  // Release-binary redirects. `latest` → the GitHub "latest release" alias;
  // a pinned `v<ver>` → the immutable `agent-v<ver>` tag asset.
  app.get("/agent/latest/:asset", (c) => {
    const asset = c.req.param("asset");
    if (!ASSET_NAME.test(asset)) {
      throw new HTTPException(400, { message: "invalid asset name" });
    }
    return c.redirect(`${releasesBase}/latest/download/${asset}`, 302);
  });

  // The version segment is the literal `v<ver>` (e.g. `v1.2.3`) — Hono cannot bind
  // a param glued to a literal prefix, so the whole segment is the param and the
  // `v` prefix is validated/stripped here. The release tag is `agent-v<ver>`.
  app.get("/agent/:versionSeg/:asset", (c) => {
    const versionSeg = c.req.param("versionSeg");
    const asset = c.req.param("asset");
    // `/agent/latest/<asset>` is handled by the more specific route above; any
    // other version segment must be the `v<ver>` shape.
    if (!VERSION_SEG.test(versionSeg) || !ASSET_NAME.test(asset)) {
      throw new HTTPException(400, { message: "invalid version or asset name" });
    }
    return c.redirect(`${releasesBase}/download/agent-${versionSeg}/${asset}`, 302);
  });
}

// The path prefixes/exact paths the install routes own — exported so the auth
// middleware can exempt them (they must be reachable with no credentials).
export const installExactPaths: ReadonlySet<string> = new Set(Object.keys(TEXT_ASSETS));

export function isInstallRedirectPath(path: string): boolean {
  return path.startsWith("/agent/latest/") || path.startsWith("/agent/v");
}
