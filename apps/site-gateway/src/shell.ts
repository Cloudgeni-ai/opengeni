import {
  SITE_GATEWAY_REPORT_PATH,
  SITE_GATEWAY_VERSION_PREFIX,
  SITE_SESSION_COOKIE,
  type SiteViewer,
} from "@opengeni/contracts";
import { probeAccess } from "./access";
import { loginLocation, redirect } from "./auth";
import { clearCookie, mintVisitor } from "./cookies";
import { SITE_FRAME_SANDBOX, applySecurityHeaders, newNonce, shellCsp } from "./headers";
import { escapeHtml, messagePage, neutralPage } from "./pages";
import { SITE_GATEWAY_SHELL_SCRIPT } from "./shell/shell-script.gen";
import type { ShellConfig } from "./shell/shell-config";
import { requiresSignIn, type SiteContext } from "./site-context";

const SHELL_STYLE =
  "html,body{margin:0;height:100%;background:#fff}body{display:flex;flex-direction:column}#og-site{flex:1;width:100%;border:0;display:block}#og-footer{display:flex;justify-content:flex-end;gap:12px;padding:2px 10px;font:11px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f6f6;border-top:1px solid #e3e3e3}#og-footer a{color:#666;text-decoration:none}#og-footer a:hover{text-decoration:underline}#og-human{position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45)}#og-human[hidden]{display:none}#og-human>div{background:#fff;color:#111;padding:20px;border-radius:8px;font:14px system-ui,sans-serif;text-align:center}";

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
}): string {
  const title = escapeHtml(init.title || "Site");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${
    init.noindex ? '<meta name="robots" content="noindex">' : ""
  }<title>${title}</title><style nonce="${init.nonce}">${SHELL_STYLE}</style></head><body><iframe id="og-site" title="${title}" sandbox="${SITE_FRAME_SANDBOX}" referrerpolicy="no-referrer" src="${SITE_GATEWAY_VERSION_PREFIX}/${encodeURIComponent(init.versionId)}"></iframe><footer id="og-footer"><a href="${SITE_GATEWAY_REPORT_PATH}" target="_blank" rel="noopener">Report</a></footer><div id="og-human" hidden><div><p>Confirm you are human to continue.</p><div id="og-human-widget"></div></div></div><script type="application/json" id="og-shell-config">${inertJson(
    init.config,
  )}</script><script nonce="${init.nonce}">${SITE_GATEWAY_SHELL_SCRIPT}</script></body></html>`;
}

/**
 * Any other GET: the shell page. Public Sites serve anonymous visitors
 * (minting `__Host-og_v`); members and invited Sites (and every Site on a
 * login-only deployment) need a site session the API confirms, otherwise the
 * viewer goes to sign-in.
 */
export async function handleShell(site: SiteContext): Promise<Response> {
  const cookies: string[] = [];
  let visitor = site.visitor;
  if (!visitor) {
    const minted = await mintVisitor(site.config.secret);
    visitor = minted.id;
    cookies.push(minted.setCookie);
  }
  let viewer: SiteViewer | null = null;
  if (requiresSignIn(site.config, site.record)) {
    if (!site.session) return redirect(site, loginLocation(site.url), 302, cookies);
    const probe = await probeAccess({ ...site, visitor });
    if (probe.kind === "signin")
      return redirect(site, loginLocation(site.url), 302, [
        ...cookies,
        clearCookie(SITE_SESSION_COOKIE),
      ]);
    if (probe.kind === "missing") return neutralPage(site);
    if (probe.kind === "forbidden") {
      const response = messagePage(
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
  });
  return new Response(site.request.method === "HEAD" ? null : html, { status: 200, headers });
}
