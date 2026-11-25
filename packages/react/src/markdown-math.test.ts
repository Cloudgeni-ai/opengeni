import { describe, expect, test } from "bun:test";
import { displayMathRanges, mayContainMath, prepareMathMarkdown } from "./markdown-math";

describe("display math scanning is linear", () => {
  test.each(["$$ a\n", "$$\n", "\\[\n", "\\[ a\n"])(
    "many unclosed %j openers stay fast and stay text",
    (opener) => {
      const text = opener.repeat(Math.floor(65_536 / opener.length));
      const started = performance.now();
      const prepared = prepareMathMarkdown(text);
      // Quadratic rescanning took about a second here; linear is a few milliseconds.
      expect(performance.now() - started).toBeLessThan(250);
      expect(prepared.hasMath).toBe(false);
    },
  );

  test("displayMathRanges finds the blocks the math pass rewrites, skipping fences", () => {
    const lines = ["a", "$$", "x", "", "y", "$$", "```", "$$", "z", "$$", "```", "\\[ w \\]", "$$"];
    expect(displayMathRanges(lines)).toEqual([
      { start: 1, end: 5 },
      { start: 11, end: 11 },
    ]);
    expect(displayMathRanges(["no math", "here"])).toEqual([]);
  });
});

const prepared = (text: string) => prepareMathMarkdown(text);

describe("prepareMathMarkdown", () => {
  test("text without math is returned as is", () => {
    const text = "Plain *text* with (brackets) and [links](https://example.com).";
    expect(prepared(text)).toEqual({ text, hasMath: false });
    expect(mayContainMath(text)).toBe(false);
  });

  test("backslash delimiters become dollar math", () => {
    expect(prepared("The area \\(A = \\pi r^2\\) grows.").text).toBe(
      "The area $$A = \\pi r^2$$ grows.",
    );
    expect(prepared("Inline display \\[x^2\\] here").text).toBe(
      "Inline display $$\\displaystyle x^2$$ here",
    );
  });

  test("display blocks on their own lines", () => {
    expect(prepared("Result:\n\\[\n\\boxed{\\Omega = 42}\n\\]\nDone").text).toBe(
      "Result:\n$$\n\\boxed{\\Omega = 42}\n$$\nDone",
    );
    expect(prepared("\\[ E = mc^2 \\]").text).toBe("$$\nE = mc^2\n$$");
    expect(prepared("$$ E = mc^2 $$").text).toBe("$$\nE = mc^2\n$$");
    expect(prepared("$$\na &= b \\\\\n\nc &= d\n$$")).toEqual({
      text: "$$\na &= b \\\\\n\nc &= d\n$$",
      hasMath: true,
    });
    expect(prepared("  \\[\n  x\n  \\]").text).toBe("  $$\n  x\n  $$");
  });

  test("single dollars follow the Pandoc rule", () => {
    expect(prepared("Let $x$ and $y_1$ be reals.").text).toBe("Let $$x$$ and $$y_1$$ be reals.");
    for (const text of [
      "It costs $5 and $10 a month.",
      "Between $5-$10 each.",
      "Budget: $20,000 to $30,000.",
      "A lone $ sign.",
      "Price $ 5 $ here",
    ]) {
      expect(prepared(text)).toEqual({ text, hasMath: false });
    }
  });

  test("code is never rewritten", () => {
    const fenced = "```ts\nconst price = `$${x}$`; // \\(not math\\)\n```";
    expect(prepared(fenced)).toEqual({ text: fenced, hasMath: false });
    const inline = "Run `echo $HOME $PATH` and `\\(x\\)` then $a$.";
    expect(prepared(inline).text).toBe("Run `echo $HOME $PATH` and `\\(x\\)` then $$a$$.");
  });

  test("escaped dollars stay text", () => {
    const text = "Escaped \\$x\\$ stays.";
    expect(prepared(text)).toEqual({ text, hasMath: false });
  });

  test("an unclosed display block stays text while it streams", () => {
    expect(prepared("Answer:\n\\[\n\\frac{a}{b}")).toEqual({
      text: "Answer:\n\\\\[\n\\frac{a}{b}",
      hasMath: false,
    });
    expect(prepared("Answer:\n$$\n\\frac{a}{b}").text).toBe("Answer:\n\\$\\$\n\\frac{a}{b}");
  });

  test("a bracket line followed by text stays inline", () => {
    expect(prepared("\\[x\\] is the class of x").text).toBe(
      "$$\\displaystyle x$$ is the class of x",
    );
  });
});
