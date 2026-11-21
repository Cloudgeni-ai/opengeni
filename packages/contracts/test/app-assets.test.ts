import { describe, expect, test } from "bun:test";
import {
  SiteAssetManifest,
  injectSiteAssetBase,
  isSiteAssetPath,
  parseSiteAssetAddress,
  siteAssetApiBase,
  siteAssetContentType,
  siteAssetGatewayBase,
} from "../src/app-assets";

const VERSION = "0b7c4a52-8f3e-4c1e-9d0a-6a1f2b3c4d5e";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

describe("app asset paths", () => {
  test("accepts relative build files with an allowed extension", () => {
    for (const path of [
      "assets/index-4f2a.js",
      "assets/chart-Bx_1.mjs",
      "style.css",
      "fonts/inter@2.woff2",
      "img/logo.svg",
      "assets/index-4f2a.js.map",
    ])
      expect(isSiteAssetPath(path)).toBe(true);
  });

  test("refuses traversal, absolute, encoded, HTML and unknown files", () => {
    for (const path of [
      "",
      "/assets/a.js",
      "../a.js",
      "assets/../a.js",
      "./a.js",
      "assets//a.js",
      "a%2e.js",
      "a b.js",
      "index.html",
      "page.htm",
      "run.sh",
      "noext",
      ".js",
      `${"a/".repeat(300)}a.js`,
    ])
      expect(isSiteAssetPath(path)).toBe(false);
  });

  test("content types follow the extension, case-insensitively", () => {
    expect(siteAssetContentType("a/B.JS")).toBe("text/javascript; charset=utf-8");
    expect(siteAssetContentType("x.css")).toBe("text/css; charset=utf-8");
    expect(siteAssetContentType("x.wasm")).toBe("application/wasm");
    expect(siteAssetContentType("x.html")).toBeNull();
  });
});

describe("app asset addresses", () => {
  test("bases and the address round-trip", () => {
    expect(siteAssetGatewayBase(VERSION, TOKEN)).toBe(`/_og/a/${VERSION}/${TOKEN}/`);
    expect(siteAssetApiBase("https://api.example.test/", "ws-1", VERSION, TOKEN)).toBe(
      `https://api.example.test/v1/app-assets/ws-1/${VERSION}/${TOKEN}/`,
    );
    expect(parseSiteAssetAddress(`${VERSION}/${TOKEN}/assets/a-1.js`)).toEqual({
      versionId: VERSION,
      token: TOKEN,
      path: "assets/a-1.js",
    });
  });

  test("malformed addresses are null", () => {
    for (const rest of [
      `${VERSION}/${TOKEN}`,
      `${VERSION}/${TOKEN}/`,
      `not-a-uuid/${TOKEN}/a.js`,
      `${VERSION}/short/a.js`,
      `${VERSION}/${TOKEN}/../a.js`,
      `${VERSION}/${TOKEN}/index.html`,
    ])
      expect(parseSiteAssetAddress(rest)).toBeNull();
  });

  test("the manifest schema refuses bad paths and tokens", () => {
    const file = { path: "assets/a.js", sha256: "a".repeat(64), sizeBytes: 3 };
    expect(SiteAssetManifest.safeParse({ token: TOKEN, files: [file] }).success).toBe(true);
    expect(SiteAssetManifest.safeParse({ token: "x", files: [file] }).success).toBe(false);
    expect(
      SiteAssetManifest.safeParse({ token: TOKEN, files: [{ ...file, path: "../a.js" }] }).success,
    ).toBe(false);
  });
});

describe("injectSiteAssetBase", () => {
  const base = `/_og/a/${VERSION}/${TOKEN}/`;

  test("goes right after the doctype, before the build's own tags", () => {
    const html = `<!doctype html><html><head><base href="/"><script type="module" src="./assets/index.js"></script></head></html>`;
    const out = injectSiteAssetBase(html, base);
    expect(out.startsWith(`<!doctype html><base href="${base}"><script>`)).toBe(true);
    expect(out.indexOf(`<base href="${base}">`)).toBeLessThan(out.indexOf(`<base href="/">`));
    expect(out.endsWith(html.slice("<!doctype html>".length))).toBe(true);
  });

  test("skips a BOM and leading comments; without a doctype it goes first", () => {
    expect(injectSiteAssetBase("\ufeff<!-- a --> <!DOCTYPE html><p>x</p>", base)).toContain(
      `<!DOCTYPE html><base href="${base}">`,
    );
    expect(injectSiteAssetBase("<p>x</p>", base).startsWith(`<base href="${base}">`)).toBe(true);
    expect(
      injectSiteAssetBase("\ufeff<p>x</p>", base).startsWith(`\ufeff<base href="${base}">`),
    ).toBe(true);
  });

  test("escapes the base", () => {
    expect(injectSiteAssetBase("<p>", 'https://x.test/"><script>')).toContain(
      'href="https://x.test/&quot;>&lt;script>"',
    );
  });
});
