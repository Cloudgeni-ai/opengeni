import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildShellModule } from "../scripts/build-shell";
import {
  PERMISSIONS_POLICY,
  SITE_FRAME_SANDBOX,
  SITE_HTML_CSP,
  applySecurityHeaders,
  jsonError,
  newNonce,
  pageCsp,
  shellCsp,
} from "../src/headers";
import { shellHtml } from "../src/shell";
import { SITE_GATEWAY_SHELL_SCRIPT } from "../src/shell/shell-script.gen";

describe("shell page", () => {
  const nonce = newNonce();
  const html = shellHtml({
    nonce,
    title: "Q3 <b>numbers</b>",
    versionId: "11111111-1111-4111-8111-111111111111",
    noindex: true,
    config: {
      viewer: { kind: "member", id: "u1", name: "</script><script>x", email: null, signedIn: true },
      turnstileSiteKey: null,
    },
  });

  test("frames the version in an opaque-origin sandbox with a Report link", () => {
    expect(html).toContain(`sandbox="${SITE_FRAME_SANDBOX}"`);
    expect(SITE_FRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(SITE_FRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(html).toContain('src="/_og/v/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('<a href="/_og/report"');
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  test("escapes the title and keeps embedded config inert", () => {
    expect(html).toContain("Q3 &lt;b&gt;numbers&lt;/b&gt;");
    expect(html).not.toContain("</script><script>x");
    // Only the nonce'd bridge script executes; the config is JSON data.
    const markup = html.replace(SITE_GATEWAY_SHELL_SCRIPT, "");
    const scripts = [...markup.matchAll(/<script([^>]*)>/gu)].map((match) => match[1]);
    expect(scripts).toEqual([' type="application/json" id="og-shell-config"', ` nonce="${nonce}"`]);
  });

  test("the inline bundle never terminates its own script element", () => {
    const body = html.slice(html.indexOf(`<script nonce="${nonce}">`));
    expect(body.match(/<\/script/giu)?.length).toBe(1);
  });
});

describe("security headers", () => {
  test("the shell CSP is nonce-only and same-origin", () => {
    const csp = shellCsp("abc", { turnstile: false });
    expect(csp).toBe(
      "default-src 'none'; script-src 'nonce-abc'; style-src 'nonce-abc'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    expect(shellCsp("abc", { turnstile: true })).toContain(
      "script-src 'nonce-abc' https://challenges.cloudflare.com",
    );
    expect(pageCsp("abc")).not.toContain("script-src");
  });

  test("Site HTML is sandboxed by header and framable only by its shell", () => {
    expect(SITE_HTML_CSP).toBe(`sandbox ${SITE_FRAME_SANDBOX}; frame-ancestors 'self'`);
  });

  test("every response gets the baseline headers", () => {
    const headers = applySecurityHeaders(new Headers(), { noindex: true, hsts: true });
    expect(Object.fromEntries(headers)).toEqual({
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": PERMISSIONS_POLICY,
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex",
    });
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"])
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
    const plain = applySecurityHeaders(new Headers(), { noindex: false, hsts: false });
    expect(plain.has("x-robots-tag")).toBe(false);
    expect(plain.has("strict-transport-security")).toBe(false);
  });

  test("gateway refusals use the API error envelope", async () => {
    const response = jsonError(429, {
      code: "site_rate_limited",
      message: "Slow down",
      retryable: true,
    });
    expect(await response.json()).toEqual({
      error: {
        status: 429,
        code: "site_rate_limited",
        message: "Slow down",
        retryable: true,
        outcomeUnknown: false,
      },
    });
  });
});

test("the committed shell bundle is up to date and small", async () => {
  const committed = readFileSync(
    resolve(import.meta.dir, "../src/shell/shell-script.gen.ts"),
    "utf8",
  );
  expect(committed).toBe(await buildShellModule());
  expect(committed.length).toBeLessThan(40 * 1024);
});
