import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown, sandboxFilePathFromHref } from "../src/components/markdown";

describe("sandbox markdown links", () => {
  test("recognizes only file-shaped workspace sandbox links", () => {
    expect(sandboxFilePathFromHref("sandbox:/workspace/reports/final.pdf")).toBe(
      "reports/final.pdf",
    );
    expect(sandboxFilePathFromHref("sandbox:/workspace/report%20final.pdf")).toBe(
      "report final.pdf",
    );
    expect(sandboxFilePathFromHref("sandbox:/tmp/final.pdf")).toBeNull();
    expect(sandboxFilePathFromHref("sandbox:/workspace/reports/../final.pdf")).toBeNull();
    expect(sandboxFilePathFromHref("https://example.com/final.pdf")).toBeNull();
  });

  test("renders raw sandbox links as a disabled explanation without a session handler", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Download report](sandbox:/workspace/reports/final.pdf)"}</Markdown>,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Download report");
    expect(html).not.toContain('href="sandbox:');
  });

  test("renders a session-aware sandbox link as a button instead of a navigation", () => {
    const html = renderToStaticMarkup(
      <Markdown onSandboxFile={() => undefined}>
        {"[Download report](sandbox:/workspace/reports/final.pdf)"}
      </Markdown>,
    );
    expect(html).toContain('<button type="button"');
    expect(html).toContain("Download report");
    expect(html).not.toContain('href="sandbox:');
  });
});
