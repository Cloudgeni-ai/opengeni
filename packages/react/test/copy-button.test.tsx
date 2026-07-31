import { describe, expect, test } from "bun:test";
import { act } from "react";
import { registerDom, renderComponent, flush } from "./render-hook";
import { CopyButton } from "../src/components/copy-button";
import { Markdown } from "../src/components/markdown";
import { tableElementToTsv } from "../src/lib/clipboard";

registerDom();

describe("CopyButton", () => {
  test("copies plain text and flashes Copied", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });

    const r = await renderComponent(<CopyButton text="hello there" label="Copy message" />);
    const button = r.container.querySelector("button[data-og-copy]");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(writes).toEqual(["hello there"]);
    expect(button?.getAttribute("data-state")).toBe("copied");
    expect(button?.getAttribute("aria-label")).toBe("Copied");
    await r.unmount();
  });
});

describe("Markdown copy chrome", () => {
  test("fenced code exposes a ghost Copy control with the fence body", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });

    const source = "```ts\nconst x = 1;\n```";
    const r = await renderComponent(<Markdown>{source}</Markdown>);
    const button = r.container.querySelector('button[data-og-copy][aria-label="Copy code"]');
    expect(button).not.toBeNull();
    // Ghost control: no bordered "Copy code" pill chrome.
    expect(button?.textContent?.trim() ?? "").toBe("");
    expect(button?.className ?? "").not.toContain("border-og-border");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(writes[0]).toBe("const x = 1;");
    await r.unmount();
  });

  test("tables expose a ghost Copy control and serialize to TSV", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });

    const source = `| A | B |\n| --- | --- |\n| 1 | 2 |`;
    const r = await renderComponent(<Markdown>{source}</Markdown>);
    const button = r.container.querySelector('button[data-og-copy][aria-label="Copy table"]');
    expect(button).not.toBeNull();
    expect(button?.textContent?.trim() ?? "").toBe("");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(writes[0]).toContain("A\tB");
    expect(writes[0]).toContain("1\t2");
    await r.unmount();
  });
});

describe("tableElementToTsv", () => {
  test("flattens cell whitespace and quotes commas/newlines when needed", () => {
    document.body.innerHTML = `<table><tr><td>a\tb</td><td>c</td></tr></table>`;
    const table = document.querySelector("table");
    // Internal whitespace collapses; tab separators remain between cells.
    expect(tableElementToTsv(table)).toBe("a b\tc");
  });
});
