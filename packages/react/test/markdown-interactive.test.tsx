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
