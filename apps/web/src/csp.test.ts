import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContentSecurityPolicy,
  CONTENT_HOSTING_ELEMENT_ID,
  contentHostingFor,
  inlineScriptHashes,
  isExactSource,
  parseContentSecuritySources,
  withContentHosting,
  type ConsoleContentSecuritySources,
} from "./csp";
import { contentSecurityApiUrlFromEnvironment, createWebHandler } from "./server";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PRODUCTION_SOURCES: ConsoleContentSecuritySources = {
  version: 1,
  directives: {
    "connect-src": ["https://acct.blob.core.windows.net", "https://eu.i.posthog.com"],
    "img-src": ["https://acct.blob.core.windows.net", "https://lh3.googleusercontent.com"],
    "media-src": ["https://acct.blob.core.windows.net"],
    "script-src": ["https://challenges.cloudflare.com"],
    "frame-src": ["https://challenges.cloudflare.com", "https://og.opengeni.site"],
    "form-action": [],
  },
  htmlFrameHost: "https://og.opengeni.site",
  imageProxyPath: "/v1/image-proxy",
};

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name!, values];
    }),
  );
}

async function served(sources: ConsoleContentSecuritySources | null) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-csp-"));
  roots.push(root);
  await mkdir(join(root, "office"), { recursive: true });
  await Bun.write(
    join(root, "index.html"),
    await readFile(new URL("../index.html", import.meta.url), "utf8"),
  );
  await Bun.write(
    join(root, "office/index.html"),
    '<!doctype html><head><script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script><script>window.boot=1</script></head>',
  );
  return createWebHandler(root, {
    publicOrigin: "https://app.opengeni.ai",
    contentSecurity: { current: () => sources, generation: () => 1 },
  });
}

describe("console Content-Security-Policy", () => {
  test("the served page's inline scripts are allowed by the hashes of the exact served bytes", async () => {
    const handler = await served(PRODUCTION_SOURCES);
    const response = await handler(new Request("https://app.opengeni.ai/sign-in"));
    const html = await response.text();
    const policy = directives(response.headers.get("content-security-policy")!);
    const inline = [
      ...html.matchAll(
        /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/gu,
      ),
    ];
    expect(inline.length).toBeGreaterThan(0);
    for (const [, body] of inline) {
      const hash = `'sha256-${createHash("sha256").update(body!).digest("base64")}'`;
      expect(policy.get("script-src")).toContain(hash);
    }
    expect(policy.get("script-src")).not.toContain("'unsafe-inline'");
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
  });

  test("production-shaped policy: every directive defined, exact hosts only", async () => {
    const handler = await served(PRODUCTION_SOURCES);
    const header = (await handler(new Request("https://app.opengeni.ai/"))).headers.get(
      "content-security-policy",
    )!;
    const policy = directives(header);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
    expect(policy.get("frame-src")).toEqual([
      "'self'",
      "https://challenges.cloudflare.com",
      "https://og.opengeni.site",
    ]);
    expect(policy.get("connect-src")).toContain("wss://app.opengeni.ai");
    expect(policy.get("connect-src")).toContain("https://acct.blob.core.windows.net");
    expect(policy.get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://acct.blob.core.windows.net",
      "https://lh3.googleusercontent.com",
    ]);
    for (const [name, values] of policy) {
      for (const value of values) {
        expect({
          name,
          value,
          exact: value === "data:" || value === "blob:" || isExactSource(value),
        }).toEqual({
          name,
          value,
          exact: true,
        });
        expect(value).not.toBe("*");
        expect(value).not.toMatch(/^(?:https?|wss?):$/u);
      }
    }
  });

  test("the API's sources can never widen the policy to * or a bare scheme", () => {
    const parsed = parseContentSecuritySources({
      version: 1,
      directives: {
        "img-src": ["*", "https:", "https://ok.example", "javascript:", "'unsafe-inline'x"],
        "script-src": ["https://*", "http:"],
        "not-a-directive": ["https://x.example"],
      },
      htmlFrameHost: "https://og.example.site/path",
      imageProxyPath: "//evil.example",
    });
    expect(parsed?.directives["img-src"]).toEqual(["https://ok.example"]);
    expect(parsed?.directives["script-src"]).toEqual([]);
    expect(parsed?.htmlFrameHost).toBeNull();
    expect(parsed?.imageProxyPath).toBe("/v1/image-proxy");
    expect(parseContentSecuritySources({ version: 2, directives: {} })).toBeNull();
    expect(parseContentSecuritySources("nope")).toBeNull();
  });

  test("Office pages: Office hosts may frame them, office.js loads, inline script hashed", async () => {
    const handler = await served(PRODUCTION_SOURCES);
    const response = await handler(new Request("https://app.opengeni.ai/office/"));
    const html = await response.text();
    const policy = directives(response.headers.get("content-security-policy")!);
    expect(policy.get("frame-ancestors")).toContain("https://*.officeapps.live.com");
    expect(policy.get("script-src")).toContain("https://appsforoffice.microsoft.com");
    expect(policy.get("script-src")).toContain(inlineScriptHashes(html)[0]);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(html).toContain(`id="${CONTENT_HOSTING_ELEMENT_ID}"`);
  });

  test("the console learns its content hosting from an inert JSON block", async () => {
    const handler = await served(PRODUCTION_SOURCES);
    const html = await (await handler(new Request("https://app.opengeni.ai/"))).text();
    const block = new RegExp(
      `<script type="application/json" id="${CONTENT_HOSTING_ELEMENT_ID}">([^<]*)</script>`,
      "u",
    ).exec(html);
    expect(JSON.parse(block![1]!)).toEqual({
      htmlFrameHost: "https://og.opengeni.site",
      imageProxy: {
        url: "/v1/image-proxy",
        directOrigins: [
          "https://acct.blob.core.windows.net",
          "https://lh3.googleusercontent.com",
          "https://app.opengeni.ai",
        ],
      },
    });
    // A hostile value cannot close the script element.
    const escaped = withContentHosting("<html><head></head></html>", { x: "</script><b>" });
    expect(escaped).not.toContain("</script><b>");
    expect(contentHostingFor(null, undefined).htmlFrameHost).toBe("self");
  });

  test("without a Sites domain the console serves the same-origin frame host", async () => {
    const handler = await served({ ...PRODUCTION_SOURCES, htmlFrameHost: null });
    const frame = await handler(
      new Request("https://app.opengeni.ai/_og/html-frame?parent=https%3A%2F%2Fapp.opengeni.ai"),
    );
    expect(frame.status).toBe(200);
    const policy = frame.headers.get("content-security-policy")!;
    expect(policy).toContain("sandbox ");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("frame-ancestors 'self'");
    // With a Sites frame host the path is just the SPA (no second frame host).
    const withSites = await served(PRODUCTION_SOURCES);
    const spa = await withSites(new Request("https://app.opengeni.ai/_og/html-frame"));
    expect(spa.headers.get("content-security-policy")).not.toContain("sandbox ");
  });

  test("reads the sources from the API inside the deployment", () => {
    expect(
      contentSecurityApiUrlFromEnvironment({
        OPENGENI_DEMO_API_URL: "http://opengeni-api:8000",
        OPENGENI_PUBLIC_BASE_URL: "https://app.opengeni.ai",
      }),
    ).toBe("http://opengeni-api:8000/");
    expect(
      contentSecurityApiUrlFromEnvironment({ OPENGENI_PUBLIC_BASE_URL: "https://app.opengeni.ai" }),
    ).toBe("https://app.opengeni.ai/");
    expect(contentSecurityApiUrlFromEnvironment({})).toBeUndefined();
    expect(
      buildContentSecurityPolicy({ kind: "console", sources: null, scriptHashes: [] }),
    ).toContain("default-src 'self'");
  });
});
