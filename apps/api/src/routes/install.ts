import { readFile, stat } from "node:fs/promises";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";

// The get.<domain> install-serving routes (dossier §23.1). These are
// UNAUTHENTICATED (see http/auth.ts isAuthExempt — the `installExemptPaths` set)
// so a fresh machine with no credentials can `curl -fsSL https://get.<domain>/install.sh`,
// read it first, then pipe to sh. They serve the IN-REPO committed script bodies
// (agent/install/*) verbatim — a single branded, audit-greppable trust root.
//
// The script BODIES contain NO secrets (POSIX sh, the device-flow captures the
// loud consent). The release-binary asset routes serve the agent BAKED into THIS
// control-plane image (the per-SHA Linux musl binary + its `.sha256`/`.minisig`)
// when present, and otherwise 302-redirect to the matching GitHub Release asset.
//
// "The agent ships inside the control-plane" (the owned decision): for every
// deployed env (preview/staging/managed-prod) the API image — already built
// per-SHA by GitHub Actions from the PR branch — bakes the SIGNED `opengeni-agent`
// binary matching that EXACT control-plane SHA into agent/install/baked/ (a CI step
// signs + COPYs; the signing key never enters the Docker build). install.sh then
// pulls a binary that is guaranteed in lockstep with the API it enrolls against —
// zero drift, zero new store. GitHub Releases remains the PUBLIC archive + the
// self-update channel + the install.sh fallback (mac/windows, and any asset this
// image did not bake), reached by the 302 below.

// The committed install artifacts, resolved relative to this module so the API
// (run from source under /app via bun) locates the sibling agent/install/ dir at
// runtime. apps/api/src/routes -> ../../../../agent/install.
const INSTALL_DIR = new URL("../../../../agent/install/", import.meta.url);

// The baked release-binary dir (a sibling of the committed scripts). The build's
// signing step writes the per-SHA Linux musl binaries + their `.sha256`/`.minisig`
// siblings here; in a plain `docker build` (or a source checkout) it holds only a
// `.gitkeep`, so every asset falls through to the GitHub-Releases redirect.
const BAKED_DIR = new URL("baked/", INSTALL_DIR);

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

// The content type for a baked release asset. The binary is an
// application/octet-stream download; its `.sha256`/`.minisig` sidecars are short
// text the install script parses line-by-line.
function bakedContentType(asset: string): string {
  if (asset.endsWith(".sha256") || asset.endsWith(".minisig")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

// Read a baked asset's bytes, or `null` when it is not baked into THIS image (the
// signal to fall through to the GitHub-Releases redirect). The asset name is
// already validated against ASSET_NAME by the caller (no traversal possible), and
// BAKED_DIR is a fixed sibling, so the resolved path cannot escape the dir.
async function readBaked(asset: string): Promise<ArrayBuffer | null> {
  const url = new URL(asset, BAKED_DIR);
  try {
    const info = await stat(url);
    if (!info.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  // Return a standalone ArrayBuffer (a valid Response BodyInit). `readFile`'s
  // Buffer may be a view into a larger pooled allocation, so copy out the exact
  // byte range with `.slice` rather than handing over the backing store.
  const buf = await readFile(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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

  // Serve a release-binary asset: the BAKED per-SHA file if THIS image carries it
  // (the Linux musl binary + sidecars that match the control plane exactly),
  // otherwise 302 to the GitHub Release at `redirectUrl` (mac/windows + any
  // un-baked asset). The baked path makes the agent the API enrolls against
  // identical to the API that serves it — no version skew, no extra hop.
  async function serveAsset(asset: string, redirectUrl: string): Promise<Response> {
    const baked = await readBaked(asset);
    if (baked !== null) {
      return new Response(baked, {
        status: 200,
        headers: {
          "content-type": bakedContentType(asset),
          // The baked artifact is immutable for this image SHA: the binary, its
          // checksum, and its signature never change once built. A long cache is
          // safe; new installs land when a new image (new SHA) rolls out.
          "cache-control": "public, max-age=3600",
          "x-opengeni-agent-source": "baked",
        },
      });
    }
    // Not baked here → the GitHub Release is the source of truth (the public
    // archive + the documented install.sh fallback). 302 so the client refetches.
    return new Response(null, { status: 302, headers: { location: redirectUrl } });
  }

  // `latest` → the BAKED binary if present, else the GitHub "latest release" alias.
  app.get("/agent/latest/:asset", async (c) => {
    const asset = c.req.param("asset");
    if (!ASSET_NAME.test(asset)) {
      throw new HTTPException(400, { message: "invalid asset name" });
    }
    return serveAsset(asset, `${releasesBase}/latest/download/${asset}`);
  });

  // The version segment is the literal `v<ver>` (e.g. `v1.2.3`) — Hono cannot bind
  // a param glued to a literal prefix, so the whole segment is the param and the
  // `v` prefix is validated/stripped here. The release tag is `agent-v<ver>`.
  app.get("/agent/:versionSeg/:asset", async (c) => {
    const versionSeg = c.req.param("versionSeg");
    const asset = c.req.param("asset");
    // `/agent/latest/<asset>` is handled by the more specific route above; any
    // other version segment must be the `v<ver>` shape.
    if (!VERSION_SEG.test(versionSeg) || !ASSET_NAME.test(asset)) {
      throw new HTTPException(400, { message: "invalid version or asset name" });
    }
    return serveAsset(asset, `${releasesBase}/download/agent-${versionSeg}/${asset}`);
  });
}

// The path prefixes/exact paths the install routes own — exported so the auth
// middleware can exempt them (they must be reachable with no credentials).
export const installExactPaths: ReadonlySet<string> = new Set(Object.keys(TEXT_ASSETS));

export function isInstallRedirectPath(path: string): boolean {
  return path.startsWith("/agent/latest/") || path.startsWith("/agent/v");
}
