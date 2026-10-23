import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://app.example.test/w/1" });
const { copySelectionWithoutPageStyles, selectionClipboardContent } =
  await import("../src/lib/selection-clipboard");
afterAll(() => GlobalRegistrator.unregister());

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  root.style.background = "rgb(17, 17, 17)";
  root.style.color = "rgb(238, 238, 238)";
  document.body.appendChild(root);
});

function select(start: Node, startOffset: number, end: Node, endOffset: number): void {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectContents(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

test("a partial selection inside a tinted message copies no page styling", () => {
  root.innerHTML =
    '<div class="bubble" style="background: rgb(42, 42, 42); padding: 12px"><p class="prose">Hello <strong style="color: red">bold</strong> world</p></div>';
  const paragraph = root.querySelector("p")!;
  select(paragraph.firstChild!, 2, paragraph.lastChild!, 3);

  const content = selectionClipboardContent(root)!;
  expect(content.html).toBe("llo <strong>bold</strong> wo");
  expect(content.html).not.toContain("style");
  expect(content.html).not.toContain("class");
  expect(content.text).toBe(document.getSelection()!.toString());
});

test("structure and safe links survive, scripts and unsafe links do not", () => {
  root.innerHTML = [
    '<div class="message">',
    '<h2 id="x">Plan</h2>',
    '<p>Use <code>bun test</code> and <a href="/docs?a=1" class="link">the docs</a>',
    ' or <a href="javascript:alert(1)">this</a>.</p>',
    '<ol start="3"><li>one</li><li data-x="1">two</li></ol>',
    '<table><tbody><tr><td colspan="2" style="background: blue">cell</td></tr></tbody></table>',
    '<img src="/a.png" alt="chart" onerror="alert(1)">',
    "</div>",
  ].join("");
  selectContents(root.querySelector(".message")!);

  const html = selectionClipboardContent(root)!.html;
  expect(html).toBe(
    [
      "<h2>Plan</h2>",
      '<p>Use <code>bun test</code> and <a href="https://app.example.test/docs?a=1">the docs</a> or <a>this</a>.</p>',
      '<ol start="3"><li>one</li><li>two</li></ol>',
      '<table><tbody><tr><td colspan="2">cell</td></tr></tbody></table>',
      '<img src="https://app.example.test/a.png" alt="chart">',
    ].join(""),
  );
});

test("a selection inside one code block keeps its code block", () => {
  root.innerHTML = "<div><pre><code>line one\n  line two\nline three</code></pre></div>";
  const text = root.querySelector("code")!.firstChild!;
  select(text, 5, text, 19);

  expect(selectionClipboardContent(root)!.html).toBe("<pre><code>one\n  line two</code></pre>");
});

test("a selection across list items keeps its list", () => {
  root.innerHTML = "<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>";
  const items = root.querySelectorAll("li");
  select(items[0]!.firstChild!, 2, items[1]!.firstChild!, 2);

  expect(selectionClipboardContent(root)!.html).toBe("<ul><li>pha</li><li>be</li></ul>");
});

test("hidden, unselectable and icon content stays out, as in the browser's own text", () => {
  root.innerHTML = [
    "<p>A",
    '<span style="display: none">[none]</span>B',
    '<span style="user-select: none">[unselectable]</span>C',
    '<span style="visibility: hidden">[invisible]</span>D',
    "<svg><title>[icon]</title></svg>E",
    "<span hidden>[hidden]</span>F</p>",
  ].join("");
  selectContents(root.querySelector("p")!);

  expect(selectionClipboardContent(root)!.html).toBe("ABCDEF");
});

test("block wrappers become plain blocks so pasted lines stay separate", () => {
  root.innerHTML =
    '<div class="row" style="display: flex">first</div><span class="chip">inline</span><section>second</section>';
  selectContents(root);

  expect(selectionClipboardContent(root)!.html).toBe("<div>first</div>inline<div>second</div>");
});

test("copies outside the timeline or inside editable fields keep the default copy", () => {
  const outside = document.createElement("p");
  outside.textContent = "elsewhere";
  document.body.appendChild(outside);
  root.innerHTML = '<div contenteditable="true">draft text</div>';

  selectContents(outside);
  expect(selectionClipboardContent(root)).toBeNull();

  selectContents(root.querySelector("[contenteditable]")!);
  expect(selectionClipboardContent(root)).toBeNull();

  document.getSelection()!.removeAllRanges();
  expect(selectionClipboardContent(root)).toBeNull();
});

test("the copy handler replaces the styled copy with clean HTML and the browser's text", () => {
  root.innerHTML = '<p style="background: rgb(42, 42, 42)">Copy <em>this</em></p>';
  selectContents(root.querySelector("p")!);
  const data = new Map<string, string>();
  let prevented = false;
  const handled = copySelectionWithoutPageStyles(
    {
      clipboardData: {
        setData: (type: string, value: string) => void data.set(type, value),
      } as unknown as DataTransfer,
      preventDefault: () => {
        prevented = true;
      },
    },
    root,
  );

  expect(handled).toBe(true);
  expect(prevented).toBe(true);
  expect(data.get("text/html")).toBe("Copy <em>this</em>");
  expect(data.get("text/plain")).toBe("Copy this");
});

test("without a selection the copy handler leaves the event alone", () => {
  let prevented = false;
  const handled = copySelectionWithoutPageStyles(
    {
      clipboardData: { setData: () => {} } as unknown as DataTransfer,
      preventDefault: () => {
        prevented = true;
      },
    },
    root,
  );
  expect(handled).toBe(false);
  expect(prevented).toBe(false);
});
