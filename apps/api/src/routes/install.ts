import { readFile, stat } from "node:fs/promises";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";

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
  "/opengeni-agent-minisign.pub": {
    file: "opengeni-agent-minisign.pub",
    contentType: "text/plain; charset=utf-8",
  },
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

// "The agent ships inside the control-plane" (cont.): the committed install
// scripts default their release-asset base URL to the public archive
// (get.opengeni.ai) so a from-source / standalone copy still works. But a
// DEPLOYED control plane must serve a script that pulls the agent from ITSELF —
// the per-SHA binary baked into THIS image, via the /agent/* routes below — so
// `curl https://<this-host>/install.sh | sh` installs the exact agent that
// matches the API it enrolls against, with NO dependency on a public CDN (which a
// private/air-gapped deploy may not even resolve). When a public base URL is
// configured we therefore rewrite each script's default-base-URL marker line to
// that origin before serving. The user's OPENGENI_INSTALL_BASE_URL env override
// still wins at run time (the scripts use `:-default`); only the built-in DEFAULT
// changes. The marker lines are kept shape-stable in agent/install/install.{sh,ps1}.
const DEFAULT_BASE_REWRITES: Record<string, (base: string) => { from: string; to: string }> = {
  "install.sh": (base) => ({
    from: 'OPENGENI_INSTALL_DEFAULT_BASE_URL="https://get.opengeni.ai"',
    to: `OPENGENI_INSTALL_DEFAULT_BASE_URL="${base}"`,
  }),
  "install.ps1": (base) => ({
    from: "$OpengeniInstallDefaultBaseUrl = 'https://get.opengeni.ai'",
    to: `$OpengeniInstallDefaultBaseUrl = '${base}'`,
  }),
};

// Rewrite a served script's default release-asset base URL to this deployment's
// own public origin. A no-op when no public base URL is configured (the public
// archive default stands), when the URL is not absolute http(s) (never serve a
// script with a broken base), or when the file has no marker (script drift — fail
// safe to serving it verbatim rather than crashing the install surface).
function rewriteDefaultBaseUrl(
  file: string,
  body: string,
  publicBaseUrl: string | undefined,
): string {
  if (!publicBaseUrl || !/^https?:\/\//.test(publicBaseUrl)) {
    return body;
  }
  const base = publicBaseUrl.replace(/\/+$/, "");
  const rule = DEFAULT_BASE_REWRITES[file]?.(base);
  if (!rule || !body.includes(rule.from)) {
    return body;
  }
  return body.replace(rule.from, rule.to);
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
      // Serve the committed body, but rewrite the install scripts' default
      // asset base URL to THIS deployment's origin so the agent is pulled from
      // the same control plane it enrolls against (see rewriteDefaultBaseUrl).
      const body = rewriteDefaultBaseUrl(file, await loadAsset(file), deps.settings.publicBaseUrl);
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

  // `latest` → the BAKED binary if present, else the dedicated moving
  // `agent-latest` GitHub Release. We deliberately do NOT use GitHub's
  // repo-global `releases/latest` alias here: in this monorepo that alias is
  // perpetually shadowed by the frequent changesets package releases (e.g.
  // `@opengeni/contracts@x.y.z`), which carry no agent binaries → 404. The
  // `agent-latest` release is maintained by .github/workflows/agent-release.yml
  // as a moving tag that always points at the newest signed mac/windows
  // binaries (+ checksums, install scripts, minisign pubkey).
  app.get("/agent/latest/:asset", async (c) => {
    const asset = c.req.param("asset");
    if (!ASSET_NAME.test(asset)) {
      throw new HTTPException(400, { message: "invalid asset name" });
    }
    return serveAsset(asset, `${releasesBase}/download/agent-latest/${asset}`);
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
