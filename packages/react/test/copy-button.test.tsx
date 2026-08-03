import { describe, expect, test } from "bun:test";
import { act } from "react";
import { registerDom, renderComponent, flush } from "./render-hook";
import { CopyButton } from "../src/components/copy-button";
import { Markdown } from "../src/components/markdown";
import { tableElementToTsv } from "../src/lib/clipboard";
import { TooltipProvider } from "../src/components/tooltip";

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

    const r = await renderComponent(
      <TooltipProvider delayDuration={400}>
        <CopyButton text="hello there" label="Copy message" />
      </TooltipProvider>,
    );
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

  test("resets Copied after the flash even when clipboard write is async", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          await writeGate;
        },
      },
    });

    const r = await renderComponent(
      <TooltipProvider delayDuration={400}>
        <CopyButton text="async copy" label="Copy message" />
      </TooltipProvider>,
    );
    const button = r.container.querySelector("button[data-og-copy]") as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    // Pointer click (detail > 0) exercises the post-await blur path that used
    // to throw when currentTarget was already cleared.
    await act(async () => {
      button?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    await flush();
    expect(button?.getAttribute("data-state")).toBe("idle");

    await act(async () => {
      releaseWrite();
      await writeGate;
      // Let the click handler's continuation (setState + timer) flush.
      await Promise.resolve();
    });
    await flush();
    expect(button?.getAttribute("data-state")).toBe("copied");
    expect(button?.getAttribute("aria-label")).toBe("Copied");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1700));
    });
    await flush();
    expect(button?.getAttribute("data-state")).toBe("idle");
    expect(button?.getAttribute("aria-label")).toBe("Copy message");
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
    const codeBlock = r.container.querySelector("pre");
    expect(button).not.toBeNull();
    expect(codeBlock?.getAttribute("tabindex")).toBe("0");
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
    const scrollRegion = r.container.querySelector("table")?.parentElement;
    expect(button).not.toBeNull();
    expect(scrollRegion?.getAttribute("tabindex")).toBe("0");
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
