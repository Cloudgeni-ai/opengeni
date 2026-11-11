import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "../src/components/markdown";
import { loadMathPlugins } from "../src/components/markdown-math-loader";

describe("math in agent Markdown", () => {
  test("before the math renderer loads, a message renders as text", () => {
    const html = renderToStaticMarkup(<Markdown>{"Let $x$ be real."}</Markdown>);
    expect(html).not.toContain("katex");
    expect(html).toContain("Let $x$ be real.");
  });

  describe("once loaded", () => {
    beforeAll(async () => {
      await loadMathPlugins();
    });

    test("every delimiter typesets, inline and display", () => {
      const html = renderToStaticMarkup(
        <Markdown>
          {[
            "Inline $a^2$ and \\(\\Omega\\) here.",
            "",
            "\\[",
            "\\boxed{x = \\frac{1}{2}}",
            "\\]",
            "",
            "$$",
            "E = mc^2",
            "$$",
          ].join("\n")}
        </Markdown>,
      );
      expect(html.match(/class="katex"/g)?.length).toBe(4);
      expect(html.match(/class="katex-display"/g)?.length).toBe(2);
      expect(html).not.toContain("\\(");
      expect(html).not.toContain("$");
    });

    test("prices and code stay as written", () => {
      const html = renderToStaticMarkup(
        <Markdown>{"It costs $5 and $10. Run `echo $HOME`."}</Markdown>,
      );
      expect(html).not.toContain("katex");
      expect(html).toContain("It costs $5 and $10.");
      expect(html).toContain("<code");
      expect(html).toContain("echo $HOME");
    });

    test("invalid TeX shows its source instead of failing the message", () => {
      const html = renderToStaticMarkup(<Markdown>{"Broken $\\frac{1$ here."}</Markdown>);
      expect(html).toContain("katex-error");
      expect(html).toContain("here.");
    });
  });
});
