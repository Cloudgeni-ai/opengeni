import {
  SITE_GATEWAY_REPORT_PATH,
  SITE_GATEWAY_VERSION_PREFIX,
  SITE_SESSION_COOKIE,
  SITE_VIEW_AS_QUERY,
  type SiteViewAs,
  type SiteViewer,
} from "@opengeni/contracts";
import { probeAccess } from "./access";
import { loginLocation, redirect } from "./auth";
import {
  SITE_VIEW_COOKIE,
  VIEW_COOKIE_MAX_AGE,
  clearCookie,
  mintVisitor,
  serializeCookie,
} from "./cookies";
import { utf8 } from "./crypto";
import { SITE_FRAME_SANDBOX, applySecurityHeaders, newNonce, shellCsp } from "./headers";
import { UpstreamError } from "./host-map";
import { escapeHtml, messagePage, neutralPage } from "./pages";
import { SITE_GATEWAY_SHELL_SCRIPT } from "./shell/shell-script.gen";
import type { ShellConfig } from "./shell/shell-config";
import { signedApiRequest } from "./signing";
import { requiresSignIn, siteCaller, type SiteContext } from "./site-context";

const SHELL_STYLE =
  "html,body{margin:0;height:100%;background:#fff}body{display:flex;flex-direction:column}#og-site{flex:1;width:100%;border:0;display:block}#og-footer{display:flex;justify-content:flex-end;gap:12px;padding:2px 10px;font:11px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f6f6;border-top:1px solid #e3e3e3}#og-footer a{color:#666;text-decoration:none}#og-footer a:hover{text-decoration:underline}#og-preview{margin-right:auto;color:#7a4b00}#og-preview a{color:#7a4b00;text-decoration:underline}#og-footer.og-previewing{background:#fff4dc;border-top-color:#f0d9a8}#og-human{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45)}#og-human[hidden]{display:none}#og-human>div{background:#fff;color:#111;padding:20px;border-radius:8px;font:14px system-ui,sans-serif;text-align:center}";

const VIEW_AS_LABEL: Record<SiteViewAs, string> = {
  public: "a public visitor",
  invited: "an invited person",
};

/** `<path>?og_view_as=off` for the current page: the "Exit preview" link. */
export function exitPreviewHref(url: URL): string {
  const target = new URL(url);
  target.searchParams.set(SITE_VIEW_AS_QUERY, "off");
  return `${target.pathname}${target.search}`;
}

/** JSON for a `<script type="application/json">` element: never closes the element early. */
function inertJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function shellHtml(init: {
  nonce: string;
  title: string;
  versionId: string;
  noindex: boolean;
  config: ShellConfig;
  /** Set while a member previews the Site as a visitor: shows the banner with Exit preview. */
  preview?: { viewAs: SiteViewAs; exitHref: string } | null;
}): string {
  const title = escapeHtml(init.title || "Site");
  const preview = init.preview
    ? `<span id="og-preview">Viewing as ${VIEW_AS_LABEL[init.preview.viewAs]} · <a href="${escapeHtml(
        init.preview.exitHref,
      )}">Exit preview</a></span>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${
    init.noindex ? '<meta name="robots" content="noindex">' : ""
  }<title>${title}</title><style nonce="${init.nonce}">${SHELL_STYLE}</style></head><body><iframe id="og-site" title="${title}" sandbox="${SITE_FRAME_SANDBOX}" referrerpolicy="no-referrer" src="${SITE_GATEWAY_VERSION_PREFIX}/${encodeURIComponent(init.versionId)}"></iframe><footer id="og-footer"${
    preview ? ' class="og-previewing"' : ""
  }>${preview}<a href="${SITE_GATEWAY_REPORT_PATH}" target="_blank" rel="noopener">Report</a></footer><div id="og-human" hidden><div><p>Confirm you are human to continue.</p><div id="og-human-widget"></div></div></div><script type="application/json" id="og-shell-config">${inertJson(
    init.config,
  )}</script><script nonce="${init.nonce}">${SITE_GATEWAY_SHELL_SCRIPT}</script></body></html>`;
}

/**
 * `?og_view_as=invited|public|off` on a page load: a workspace member starts
 * or ends previewing the Site as that role ("View as visitor"). The API
 * records it on the member's site session and refuses anyone else; the
 * gateway then redirects to the same page without the parameter. Without a
 * site session the viewer signs in first (the parameter survives in the
 * return path). Returns null when the parameter is absent.
 */
async function handleViewAs(
  site: SiteContext,
  visitor: string,
  cookies: string[],
): Promise<Response | null> {
  const raw = site.url.searchParams.get(SITE_VIEW_AS_QUERY);
  if (raw === null || site.request.method !== "GET") return null;
  const target = new URL(site.url);
  target.searchParams.delete(SITE_VIEW_AS_QUERY);
  const back = `${target.pathname}${target.search}`;
  const viewAs: SiteViewAs | null | undefined =
    raw === "invited" || raw === "public" ? raw : raw === "off" ? null : undefined;
  if (viewAs === undefined) return redirect(site, back, 302, cookies);
  if (!site.session)
    return viewAs === null
      ? redirect(site, back, 302, [...cookies, clearCookie(SITE_VIEW_COOKIE)])
      : redirect(site, loginLocation(site.url), 302, cookies);
  let response: Response;
  try {
    response = await fetch(
      await signedApiRequest(site.config, siteCaller({ ...site, visitor }), {
        method: "POST",
        suffix: "/auth/view-as",
        body: utf8(JSON.stringify({ viewAs })),
        headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
      }),
    );
  } catch {
    throw new UpstreamError("Starting the preview failed", null);
  }
  await response.body?.cancel();
  if (response.status === 401)
    return redirect(site, loginLocation(site.url), 302, [
      ...cookies,
      clearCookie(SITE_SESSION_COOKIE),
    ]);
  if (response.status === 403) {
    const page = messagePage(
      site,
      403,
      "Preview not available",
      "Only workspace members can preview this Site as a visitor.",
      { href: back, label: "Back to the Site" },
    );
    for (const cookie of cookies) page.headers.append("Set-Cookie", cookie);
    return page;
  }
  if (!response.ok) throw new UpstreamError("Starting the preview failed", response.status);
  return redirect(site, back, 302, [
    ...cookies,
    viewAs === null
      ? clearCookie(SITE_VIEW_COOKIE)
      : serializeCookie(SITE_VIEW_COOKIE, viewAs, VIEW_COOKIE_MAX_AGE),
  ]);
}

/**
 * Any other GET: the shell page. Public Sites serve anonymous visitors
 * (minting `__Host-og_v`); members and invited Sites (and every Site on a
 * login-only deployment) need a site session the API confirms, otherwise the
 * viewer goes to sign-in. While a member previews the Site as a visitor
 * (`__Host-og_view`), the API is asked on every Site, and the footer shows
 * the preview with an Exit preview link.
 */
export async function handleShell(site: SiteContext): Promise<Response> {
  const cookies: string[] = [];
  let visitor = site.visitor;
  if (!visitor) {
    const minted = await mintVisitor(site.config.secret);
    visitor = minted.id;
    cookies.push(minted.setCookie);
  }
  const viewAsResponse = await handleViewAs(site, visitor, cookies);
  if (viewAsResponse) return viewAsResponse;
  const previewCookie = site.cookies.has(SITE_VIEW_COOKIE);
  let viewer: SiteViewer | null = null;
  let viewAs: SiteViewAs | null = null;
  if (requiresSignIn(site.config, site.record) || (previewCookie && site.session)) {
    if (!site.session) return redirect(site, loginLocation(site.url), 302, cookies);
    const probe = await probeAccess({ ...site, visitor });
    if (probe.kind === "signin")
      return redirect(site, loginLocation(site.url), 302, [
        ...cookies,
        clearCookie(SITE_SESSION_COOKIE),
        ...(previewCookie ? [clearCookie(SITE_VIEW_COOKIE)] : []),
      ]);
    if (probe.kind === "missing") return neutralPage(site);
    if (probe.kind === "forbidden") {
      // A preview as a role the Site is not shared with: say so, and offer the way out.
      const response = previewCookie
        ? messagePage(
            site,
            403,
            "Not available to this visitor",
            "People in the role you are previewing as can't open this Site.",
            { href: exitPreviewHref(site.url), label: "Exit preview" },
          )
        : messagePage(
            site,
            403,
            "No access",
            "You are signed in, but this Site is not shared with your account.",
            { href: "/_og/auth/logout", label: "Sign out" },
          );
      for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
      return response;
    }
    viewer = probe.viewer;
    viewAs = probe.viewAs;
    // The preview ended elsewhere (signed out, session replaced): drop the stale cookie.
    if (previewCookie && !viewAs) cookies.push(clearCookie(SITE_VIEW_COOKIE));
  }
  const nonce = newNonce();
  const headers = applySecurityHeaders(new Headers(), { noindex: site.noindex, hsts: site.hsts });
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", shellCsp(nonce, { turnstile: !!site.config.turnstile }));
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  const html = shellHtml({
    nonce,
    title: site.record.title,
    versionId: site.record.versionId,
    noindex: site.noindex,
    config: { viewer, turnstileSiteKey: site.config.turnstile?.siteKey ?? null },
    preview: viewAs ? { viewAs, exitHref: exitPreviewHref(site.url) } : null,
  });
  return new Response(site.request.method === "HEAD" ? null : html, { status: 200, headers });
}
