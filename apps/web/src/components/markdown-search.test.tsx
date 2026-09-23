import { expect, test } from "bun:test";
import { act } from "react";
import { MarkdownText } from "./markdown";
import { registerDom, renderComponent } from "../../../../packages/react/test/render-hook";

registerDom();

test("closing Find retains a huge message's source window until explicit formatted restore", async () => {
  const text = "**paragraph**\n\n".repeat(2000) + "needle";
  const view = await renderComponent(
    <MarkdownText
      text={text}
      searchTarget={{ sequence: 4, query: "needle", offset: text.indexOf("needle") }}
    />,
  );
  const sourceWindow = view.container.querySelector("mark")!.parentElement!.textContent;
  await view.rerender(<MarkdownText text={text} searchTarget={null} />);
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.querySelector("[data-og-search-offset]")!.parentElement!.textContent).toBe(
    sourceWindow,
  );
  expect(view.container.querySelectorAll("strong").length).toBe(0);
  const restore = view.container.querySelector<HTMLButtonElement>("button")!;
  expect(restore.textContent).toBe("Show formatted message");
  await act(async () => restore.click());
  expect(view.container.querySelectorAll("strong").length).toBe(2000);
  expect(view.container.querySelector("[data-og-search-offset]")).toBeNull();
  await view.unmount();
});

test("repeated occurrence ordinals and UTF-16 excerpt boundaries retain exact source", async () => {
  const view = await renderComponent(
    <MarkdownText
      text="**a**testtest"
      searchTarget={{ sequence: 4, query: "test", occurrence: 1 }}
    />,
  );
  expect(view.container.querySelector("mark")?.dataset.ogSearchOffset).toBe("9");
  expect(view.container.querySelector("mark")?.previousSibling?.textContent).toBe("**a**test");
  const text = "😀" + "x".repeat(239) + "needle" + "x".repeat(239) + "😀";
  await view.rerender(
    <MarkdownText text={text} searchTarget={{ sequence: 4, query: "needle", offset: 241 }} />,
  );
  const mark = view.container.querySelector("mark")!;
  expect(mark.previousSibling?.textContent).toBe("😀" + "x".repeat(239));
  expect(mark.nextSibling?.textContent).toBe("x".repeat(239) + "😀");
  await view.unmount();
});

test("actual app Markdown targets raw source, not a coincidentally matching rendered offset", async () => {
  for (const [text, query] of [
    ["**bold** needle", "needle"],
    ["**a**testtest", "test"],
    ["😀 **a**testtest", "test"],
    ["[label](https://example.com/needle)\n\nneedle", "needle"],
    ["first\n\nsecond", "first\n\nsecond"],
    ["x".repeat(2_000_000) + "😀 **a**testtest", "test"],
  ] as const) {
    const offset = text.indexOf(query);
    const view = await renderComponent(
      <MarkdownText text={text} searchTarget={{ sequence: 4, query, offset }} />,
    );
    const mark = view.container.querySelector("mark")!;
    expect(mark.textContent).toBe(query);
    expect(mark.dataset.ogSearchOffset).toBe(String(offset));
    expect(mark.previousSibling?.textContent ?? "").toBe(
      text.slice(Math.max(0, offset - 240), offset),
    );
    expect(view.container.textContent).toContain("Match in message source");
    expect(view.container.textContent!.length).toBeLessThan(1000);
    await view.rerender(<MarkdownText text="**bold** needle" />);
    const restore = view.container.querySelector<HTMLButtonElement>("button");
    if (restore) await act(async () => restore.click());
    expect(view.container.querySelector("strong")?.textContent).toBe("bold");
    expect(view.container.querySelector("mark")).toBeNull();
    await view.unmount();
  }
});

test("stale source offsets do not mark a different occurrence", async () => {
  const view = await renderComponent(
    <MarkdownText text="**a**testtest" searchTarget={{ sequence: 4, query: "test", offset: 1 }} />,
  );
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.textContent).toContain("no longer");
  await view.unmount();
});
