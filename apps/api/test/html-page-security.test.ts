import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  htmlPage,
  htmlPageContentSecurityPolicy,
  htmlPageResponse,
  withHtmlPageSecurity,
} from "../src/http/html-page-security";
import { connectFinishedPage } from "../src/integrations/connect-finished-page";
import { renderMcpOAuthConsentPage } from "../src/mcp-oauth";

const hash = (content: string) =>
  `'sha256-${createHash("sha256").update(content).digest("base64")}'`;

describe("API HTML page policy", () => {
  test("allows exactly the page's inline blocks by hash, never unsafe-inline", () => {
    const html =
      '<html><head><style>body{margin:0}</style></head><body><script type="application/json" id="d">{"a":1}</script><script>go()</script><script src="/x.js"></script></body></html>';
    const policy = htmlPageContentSecurityPolicy(html, { formAction: ["'self'"] });
    expect(
      htmlPageContentSecurityPolicy(html, {
        formAction: [
          "'self'",
          "https://github.com",
          "https://github.com",
          "*",
          "https:",
          "javascript:",
        ],
      }),
    ).toContain("form-action 'self' https://github.com;");
    expect(policy).toBe(
      `default-src 'none'; script-src ${hash("go()")}; style-src ${hash("body{margin:0}")}; img-src 'self' data:; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain(hash('{"a":1}'));
    expect(htmlPageContentSecurityPolicy("<p>plain</p>")).toBe(
      "default-src 'none'; img-src 'self' data:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  test("the pages the API renders keep working under their policy", async () => {
    const finished = connectFinishedPage();
    const policy = finished.headers.get("content-security-policy")!;
    expect(policy).toContain(hash("window.close();"));
    expect(policy).not.toContain("unsafe-inline");
    expect(finished.headers.get("x-content-type-options")).toBe("nosniff");
    expect(finished.headers.get("referrer-policy")).toBe("no-referrer");

    // The consent page's submit handling is a script block, not an attribute
    // (an inline handler attribute cannot be allowed by hash).
    const consent = renderMcpOAuthConsentPage({
      clientName: "Client",
      requestToken: "req_x",
      accounts: [{ id: "a1", name: "Org" }],
      workspaces: [{ id: "w1", accountId: "a1", name: "Main", kind: "standard" }],
      selectedWorkspaceId: "w1",
    } as unknown as Parameters<typeof renderMcpOAuthConsentPage>[0]);
    expect(consent).not.toMatch(/\son[a-z]+="/u);
    expect(consent).not.toMatch(/\sstyle="/u);
    expect(htmlPageContentSecurityPolicy(consent)).toMatch(/script-src 'sha256-/u);
  });

  test("adds the policy to a rendered page response once, keeping status and headers", async () => {
    const page = await withHtmlPageSecurity(
      new Response("<style>p{}</style><p>x</p>", {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8", "x-extra": "1" },
      }),
      { formAction: ["'self'"] },
    );
    expect(page.status).toBe(400);
    expect(page.headers.get("x-extra")).toBe("1");
    expect(page.headers.get("content-security-policy")).toContain(hash("p{}"));
    expect(await page.text()).toBe("<style>p{}</style><p>x</p>");

    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(await withHtmlPageSecurity(json)).toBe(json);
    const own = new Response("<p>x</p>", {
      headers: { "content-type": "text/html", "content-security-policy": "sandbox" },
    });
    expect((await withHtmlPageSecurity(own)).headers.get("content-security-policy")).toBe(
      "sandbox",
    );
    expect(htmlPageResponse("<p>x</p>", { status: 404 }).status).toBe(404);
  });

  test("a Hono page keeps headers the route set first", async () => {
    const app = new Hono();
    app.get("/page", (c) => {
      c.header("refresh", "0;url=https://example.test/");
      return htmlPage(c, "<script>a()</script>", { status: 400 });
    });
    const response = await app.request("/page");
    expect(response.status).toBe(400);
    expect(response.headers.get("refresh")).toBe("0;url=https://example.test/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(hash("a()"));
  });
});
