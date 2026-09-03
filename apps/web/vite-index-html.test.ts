import { describe, expect, test } from "bun:test";

import { compactProtectedIndexHtml } from "./vite-index-html";

const canonicalFilename = "/workspace/apps/web/index.html";
const protectedIndex = `
  <!doctype html>
  <html>
    <head>
      <link rel="icon" href="/favicon.svg" />
      <meta name="referrer" content="no-referrer" />
      <script id="opengeni-setup-account-bootstrap">window.bootstrap = true;</script>
    </head>
    <body><script type="module" src="/src/main.tsx"></script></body>
  </html>
`;

describe("protected Vite index transform", () => {
  test("moves the setup bootstrap ahead of injected app-shell subrequests", () => {
    const html = compactProtectedIndexHtml(protectedIndex, {
      filename: canonicalFilename,
      canonicalFilename,
    });

    expect(html.indexOf('id="opengeni-setup-account-bootstrap"')).toBeLessThan(
      html.indexOf('<link rel="icon"'),
    );
    expect(html.indexOf('id="opengeni-setup-account-bootstrap"')).toBeLessThan(
      html.indexOf('script type="module"'),
    );
    expect(html).not.toMatch(/>\s+</);
  });

  test("fails closed when the canonical app shell loses setup protection", () => {
    expect(() =>
      compactProtectedIndexHtml("<!doctype html><html><head></head></html>", {
        filename: canonicalFilename,
        canonicalFilename,
      }),
    ).toThrow("setup-account bootstrap is missing from index.html");
  });

  test("does not impose app-shell setup protection on independent HTML fixtures", () => {
    const fixture = "<!doctype html>\n<html><head><title>Fixture</title></head></html>";
    expect(
      compactProtectedIndexHtml(fixture, {
        filename: "/workspace/apps/web/test/ai-gateway-connection.html",
        canonicalFilename,
      }),
    ).toBe(fixture);
  });
});
