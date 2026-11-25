import { expect, test } from "bun:test";
import { inlineHtmlDocument } from "../src/components/artifacts/inline-html-document";
import { publishedHtmlArtifactDocument } from "../src/components/artifacts/published-html-artifact-frame";

test("inline visuals supply documented styles, controls and the optional SDK through the shared frame", () => {
  const html = inlineHtmlDocument(
    '<script src="/__opengeni/site-tools/client.js"></script><button class="btn">Hello</button>',
  );
  expect(html).toContain("--viz-series-1");
  expect(html).toContain('role="tablist"');
  expect(html).toContain("FloatingUIDOM");
  expect(html).toContain("lucide");
  expect(html).toContain("opengeni.preview.height");
  expect(publishedHtmlArtifactDocument(html, true)).toContain("createOpenGeniSiteClient");
});

test("inline visuals report their height before the helpers' CDN scripts, so slow helpers never hold the preview", () => {
  const html = inlineHtmlDocument('<div id="chart">bars</div>');
  const fragment = html.indexOf('<div id="chart">');
  const reporter = html.indexOf("opengeni.preview.height");
  const firstCdnScript = html.indexOf('<script src="https://unpkg.com/');
  expect(fragment).toBeGreaterThan(-1);
  expect(firstCdnScript).toBeGreaterThan(-1);
  expect(reporter).toBeGreaterThan(fragment);
  expect(reporter).toBeLessThan(firstCdnScript);
  expect(html.endsWith("</body></html>")).toBe(true);
});
