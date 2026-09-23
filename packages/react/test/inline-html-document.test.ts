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
