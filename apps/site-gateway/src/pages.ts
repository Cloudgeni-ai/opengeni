import { SITE_GATEWAY_LOGOUT_PATH } from "@opengeni/contracts";
import { SITE_ABUSE_CATEGORIES } from "./report-categories";
import { applySecurityHeaders, newNonce, pageCsp, type SecurityOptions } from "./headers";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PAGE_STYLE =
  "html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:Canvas;color:CanvasText}main{max-width:32rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0;opacity:.85}a{color:LinkText}label{display:block;margin:.75rem 0 .25rem;font-weight:600}select,textarea,input{width:100%;box-sizing:border-box;font:inherit;padding:.5rem}textarea{min-height:8rem}button{margin-top:1rem;font:inherit;padding:.5rem 1rem}";

export type PageInit = SecurityOptions & {
  status: number;
  title: string;
  /** Trusted HTML for the page body (callers escape every interpolated value). */
  body: string;
  headers?: HeadersInit;
};

/** A small script-free gateway page. Always no-store; shares the edge security headers. */
export function page(init: PageInit): Response {
  const nonce = newNonce();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escapeHtml(init.title)}</title><style nonce="${nonce}">${PAGE_STYLE}</style></head><body><main>${init.body}</main></body></html>`;
  const headers = applySecurityHeaders(new Headers(init.headers), {
    ...init,
    // The gateway's own pages are never indexed.
    noindex: true,
  });
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", pageCsp(nonce));
  return new Response(html, { status: init.status, headers });
}

type Security = Pick<SecurityOptions, "hsts">;

/** Missing, unpublished or not-yet-versioned hosts: say nothing about whether a Site exists. */
export function neutralPage(security: Security): Response {
  return page({
    ...security,
    noindex: true,
    status: 404,
    title: "Nothing here",
    body: "<h1>Nothing here</h1><p>There is no published Site at this address.</p>",
  });
}

export function takedownPage(security: Security, abuseEmail: string): Response {
  const email = escapeHtml(abuseEmail);
  return page({
    ...security,
    noindex: true,
    status: 410,
    title: "Site unavailable",
    body: `<h1>This Site has been taken down</h1><p>It is no longer available at this address.</p><p>Questions or reports: <a href="mailto:${email}">${email}</a></p>`,
  });
}

export function messagePage(
  security: Security,
  status: number,
  title: string,
  message: string,
  link?: { href: string; label: string },
): Response {
  return page({
    ...security,
    noindex: true,
    status,
    title,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${
      link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : ""
    }`,
  });
}

export function reportFormPage(
  security: Security,
  init: { title: string; abuseEmail: string; token: string; headers?: HeadersInit; error?: string },
): Response {
  const options = SITE_ABUSE_CATEGORIES.map(
    (category) => `<option value="${category.value}">${escapeHtml(category.label)}</option>`,
  ).join("");
  return page({
    ...security,
    noindex: true,
    status: init.error ? 400 : 200,
    title: "Report this Site",
    ...(init.headers ? { headers: init.headers } : {}),
    body: `<h1>Report this Site</h1><p>Tell us what is wrong with “${escapeHtml(init.title)}”. Reports go to the Site's owners and to the abuse team of this service. You can also email <a href="mailto:${escapeHtml(init.abuseEmail)}">${escapeHtml(init.abuseEmail)}</a>.</p>${
      init.error ? `<p role="alert">${escapeHtml(init.error)}</p>` : ""
    }<form method="post" action="/_og/report"><input type="hidden" name="token" value="${escapeHtml(init.token)}"><label for="category">Reason</label><select id="category" name="category" required>${options}</select><label for="message">Details</label><textarea id="message" name="message" maxlength="4000"></textarea><label for="contactEmail">Your email (optional)</label><input id="contactEmail" name="contactEmail" type="email" maxlength="320" autocomplete="email"><button type="submit">Send report</button></form>`,
  });
}

/** GET /_og/auth/logout: a script-free confirmation; signing out is a same-origin POST. */
export function logoutConfirmPage(security: Security, returnPath: string): Response {
  const action = `${SITE_GATEWAY_LOGOUT_PATH}?return=${encodeURIComponent(returnPath)}`;
  return page({
    ...security,
    noindex: true,
    status: 200,
    title: "Sign out",
    body: `<h1>Sign out of this Site?</h1><p>You can sign in again at any time.</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Sign out</button></form>`,
  });
}
