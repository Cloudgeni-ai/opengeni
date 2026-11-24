import { expect, mock, test } from "bun:test";
import { Markdown } from "../src/components/markdown";
import { loadMathPlugins } from "../src/components/markdown-math-loader";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

test("a long formatted history keeps its parsed bodies when link handlers change during streaming", async () => {
  // Happy DOM does not implement compatMode; the web app renders in standards mode.
  Object.defineProperty(document, "compatMode", { value: "CSS1Compat", configurable: true });
  await loadMathPlugins();
  const renderImage = mock(() => <span>Retained image</span>);
  const image = "![Example](artifact:8d5e17fe-2c91-44c4-9aae-4da0c9e1f122)";
  const artifact = "[Download](artifact:8d5e17fe-2c91-44c4-9aae-4da0c9e1f122)";
  const history = Array.from({ length: 20 }, (_, i) =>
    [
      `### Report ${i}`,
      "Keep $x^2 + 2x + 1$ in the calculation.",
      "| Step | Result |\n| --- | --- |\n| Substitute | $x + 1$ |",
      "```ts\nconst value = 42;\n```",
      image,
      artifact,
    ].join("\n\n"),
  );
  const view = (revision: number, stream: string) => (
    <>
      {history.map((text) => (
        <Markdown
          key={text}
          artifactHref={(id) => `/revision-${revision}/${id}`}
          renderImage={renderImage}
        >
          {text}
        </Markdown>
      ))}
      <Markdown streaming>{stream}</Markdown>
    </>
  );
  const rendered = await renderComponent(view(0, "Streaming the first item"));
  try {
    await flush();
    expect(rendered.container.querySelectorAll(".katex")).toHaveLength(40);
    expect(rendered.container.querySelectorAll("table")).toHaveLength(20);
    expect(renderImage).toHaveBeenCalledTimes(20);
    for (let i = 1; i <= 3; i++) {
      await rendered.rerender(view(i, `Streaming item ${i}`));
    }
    expect(rendered.container.textContent).toContain("Streaming item 3");
    expect(rendered.container.querySelectorAll('a[href^="/revision-3/"]')).toHaveLength(20);
    expect(renderImage).toHaveBeenCalledTimes(20);
  } finally {
    await rendered.unmount();
  }
});
