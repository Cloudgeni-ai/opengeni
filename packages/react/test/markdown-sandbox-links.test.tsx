import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Markdown,
  sandboxFileLocationFromHref,
  sandboxFilePathFromHref,
} from "../src/components/markdown";

describe("sandbox markdown links", () => {
  test("recognizes sandbox and /workspace file links, including optional lines", () => {
    expect(sandboxFileLocationFromHref("sandbox:/workspace/reports/final.pdf")).toEqual({
      path: "reports/final.pdf",
      line: null,
    });
    expect(sandboxFileLocationFromHref("sandbox:/workspace/src/app.py:12")).toEqual({
      path: "src/app.py",
      line: 12,
    });
    expect(sandboxFileLocationFromHref("/workspace/src/app.py:12")).toEqual({
      path: "src/app.py",
      line: 12,
    });
    expect(sandboxFileLocationFromHref("sandbox:/workspace/My%20Project/My%20Report.md:3")).toEqual(
      {
        path: "My Project/My Report.md",
        line: 3,
      },
    );
    expect(sandboxFilePathFromHref("sandbox:/workspace/report%20final.pdf")).toBe(
      "report final.pdf",
    );
    expect(sandboxFileLocationFromHref("sandbox:/workspace/src/app.py:12-20")).toEqual({
      path: "src/app.py:12-20",
      line: null,
    });
    expect(sandboxFileLocationFromHref("sandbox:/tmp/final.pdf")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/workspace/reports/../final.pdf")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/workspace/:12")).toBeNull();
    expect(sandboxFileLocationFromHref("https://example.com/final.pdf")).toBeNull();
    expect(sandboxFileLocationFromHref("/abs/path/app.py:12")).toBeNull();
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
    expect(html).toContain("Download reports/final.pdf");
    expect(html).not.toContain('href="sandbox:');
  });

  test("labels a line link as an in-session Files open", () => {
    const html = renderToStaticMarkup(
      <Markdown onSandboxFile={() => undefined}>
        {"[app.py](sandbox:/workspace/src/app.py:12)"}
      </Markdown>,
    );
    expect(html).toContain('<button type="button"');
    expect(html).toContain("Open src/app.py at line 12");
    expect(html).not.toContain('href="sandbox:');
  });
});
