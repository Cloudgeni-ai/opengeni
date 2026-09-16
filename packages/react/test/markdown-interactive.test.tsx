import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/markdown";

const render = (block: { kind: "html" | "site"; content: string }) => (
  <section data-embed={block.kind}>{block.content}</section>
);
test("explicit completed HTML and Site fences render through the host", () => {
  for (const kind of ["html", "site"] as const) {
    const output = renderToStaticMarkup(
      <Markdown
        renderInteractiveBlock={render}
      >{`\`\`\`opengeni-${kind}\nhello\n\`\`\``}</Markdown>,
    );
    expect(output).toContain(`data-embed="${kind}"`);
  }
});
test("streaming soft-closers never execute incomplete HTML", () => {
  const output = renderToStaticMarkup(
    <Markdown streaming renderInteractiveBlock={render}>
      {"```opengeni-html\n<button>unfinished</button>"}
    </Markdown>,
  );
  expect(output).not.toContain("data-embed");
  expect(output).toContain("Preparing preview");
  expect(output).toContain('aria-busy="true"');
  expect(output).toContain("og-preview-loading");
  expect(output).toContain('<canvas aria-hidden="true"');
  expect(output).not.toContain("group/disclosure");
  expect(output).not.toContain('role="button"');
  expect(output).not.toContain("animate-spin");
  expect(output).not.toContain("min-h-32");
  expect(output).not.toContain("Generating the interactive content");
  expect(output).not.toContain("unfinished");
});

test("replayed partial previews stay hidden and interrupted previews stop loading", () => {
  for (const kind of ["html", "site"] as const) {
    for (const fence of ["```", "~~~~"] as const) {
      const source = `Intro\n\n${fence}opengeni-${kind}\n<button>private preview source</button>\n`;
      for (const streaming of [true, false]) {
        const output = renderToStaticMarkup(
          <Markdown streaming={streaming} renderInteractiveBlock={render}>
            {source}
          </Markdown>,
        );
        expect(output).not.toContain("private preview source");
        expect(output).not.toContain("<pre");
        expect(output).not.toContain("data-embed");
        expect(output).toContain(streaming ? "Preparing preview" : "Preview incomplete");
        expect(output).toContain(`aria-busy="${streaming}"`);
        expect(output.includes("og-preview-loading")).toBe(streaming);
        expect(output).not.toContain("og-command-reel-running");
        if (!streaming) {
          expect(output).toContain("Generation stopped before the preview was ready.");
        }
      }
      const completed = renderToStaticMarkup(
        <Markdown streaming renderInteractiveBlock={render}>
          {source + fence}
        </Markdown>,
      );
      expect(completed).toContain(`data-embed="${kind}"`);
      expect(completed).not.toContain("Preparing preview");
      expect(completed).not.toContain("og-preview-loading");
    }
  }
});
test("ordinary HTML fences and Markdown without host opt-in stay code", () => {
  expect(
    renderToStaticMarkup(
      <Markdown renderInteractiveBlock={render}>{"```html\nhello\n```"}</Markdown>,
    ),
  ).not.toContain("data-embed");
  expect(renderToStaticMarkup(<Markdown>{"```opengeni-html\nhello\n```"}</Markdown>)).toContain(
    "<pre",
  );
});

test("retained images use the host loader and reject malformed artifact URLs", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const images: unknown[] = [];
  const renderImage = (image: { src: string; alt: string }) => {
    images.push(image);
    return <span data-image="retained">{image.alt}</span>;
  };
  const output = renderToStaticMarkup(
    <Markdown renderImage={renderImage}>{`![My chart](artifact:${id})`}</Markdown>,
  );
  expect(images).toEqual([{ src: `artifact:${id}`, alt: "My chart" }]);
  expect(output).toContain('data-image="retained"');
  expect(renderToStaticMarkup(<Markdown>{`![My chart](artifact:${id})`}</Markdown>)).not.toContain(
    'src="artifact:',
  );
  renderToStaticMarkup(
    <Markdown renderImage={renderImage}>{"![Bad](artifact:../other)"}</Markdown>,
  );
  expect(images).toHaveLength(1);
});
