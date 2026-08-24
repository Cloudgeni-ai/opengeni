import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Markdown,
  sandboxFileLocationFromHref,
  sandboxFilePathFromHref,
} from "../src/components/markdown";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

describe("sandbox markdown links", () => {
  test("preserves the exact decoded sandbox path and parses an optional positive line", () => {
    expect(sandboxFileLocationFromHref("sandbox:/workspace/reports/final.pdf")).toEqual({
      path: "/workspace/reports/final.pdf",
      line: null,
    });
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/src/app.py:12")).toEqual({
      path: "/projects/example/src/app.py",
      line: 12,
    });
    expect(sandboxFileLocationFromHref("sandbox:relative/src/app.py:12")).toEqual({
      path: "relative/src/app.py",
      line: 12,
    });
    expect(sandboxFileLocationFromHref("/workspace/src/app.py:12")).toEqual({
      path: "/workspace/src/app.py",
      line: 12,
    });
    expect(
      sandboxFileLocationFromHref(
        "sandbox:/projects/example/My%20Project/%E6%96%87%E6%A1%A3%23one%3Ftwo.md:3",
      ),
    ).toEqual({
      path: "/projects/example/My Project/文档#one?two.md",
      line: 3,
    });
    expect(sandboxFilePathFromHref("sandbox:/projects/example/report%20final.pdf")).toBe(
      "/projects/example/report final.pdf",
    );
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/reports/../final.pdf")).toEqual({
      path: "/projects/example/reports/../final.pdf",
      line: null,
    });
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/file%3A12")).toEqual({
      path: "/projects/example/file:12",
      line: null,
    });
    expect(sandboxFileLocationFromHref("sandbox:C%3A%5Crepo%5Csrc%5Capp.ts:4")).toEqual({
      path: "C:\\repo\\src\\app.ts",
      line: 4,
    });
    expect(sandboxFileLocationFromHref("sandbox:/projects//example///app.ts")).toEqual({
      path: "/projects//example///app.ts",
      line: null,
    });
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/report%2520final.pdf")).toEqual({
      path: "/projects/example/report%20final.pdf",
      line: null,
    });
  });

  test("rejects malformed or ambiguous sandbox references without inventing path policy", () => {
    expect(sandboxFileLocationFromHref("sandbox:")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app.ts:0")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app.ts:-12")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app.ts:12-20")).toBeNull();
    expect(
      sandboxFileLocationFromHref("sandbox:/projects/example/app.ts:9007199254740992"),
    ).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app%ZZ.ts")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app%00.ts")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app%0A.ts")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app.ts?raw=1")).toBeNull();
    expect(sandboxFileLocationFromHref("sandbox:/projects/example/app.ts#L12")).toBeNull();
    expect(sandboxFileLocationFromHref("https://example.com/final.pdf")).toBeNull();
    expect(sandboxFileLocationFromHref("/abs/path/app.py:12")).toBeNull();
  });

  test("renders a sandbox link as a disabled explanation without a session handler", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"[Open report](sandbox:/projects/example/reports/final.pdf)"}</Markdown>,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Open report");
    expect(html).not.toContain('href="sandbox:');
    expect(html).not.toContain('href=""');
  });

  test("opens both path-only and line links through the session callback with exact arguments", async () => {
    const opened: Array<[string, number | undefined]> = [];
    const r = await renderComponent(
      <Markdown
        onSandboxFile={(path, line) => {
          opened.push([path, line]);
        }}
      >
        {
          "[Open report](sandbox:/projects/example/reports/final%20report.pdf) [Open source](sandbox:/projects/example/src/app.py:12)"
        }
      </Markdown>,
    );
    await flush();
    const buttons = Array.from(r.container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.title).toBe("Open /projects/example/reports/final report.pdf");
    expect(buttons[1]?.title).toBe("Open /projects/example/src/app.py at line 12");
    await actRun(() => buttons[0]!.click());
    await actRun(() => buttons[1]!.click());
    expect(opened).toEqual([
      ["/projects/example/reports/final report.pdf", undefined],
      ["/projects/example/src/app.py", 12],
    ]);
    expect(r.container.querySelector('a[href=""]')).toBeNull();
    await r.unmount();
  });

  test("surfaces a rejected open and retries the same exact path", async () => {
    let attempts = 0;
    const r = await renderComponent(
      <Markdown
        onSandboxFile={() => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("unavailable"));
        }}
      >
        {"[Open source](sandbox:/projects/example/src/app.ts)"}
      </Markdown>,
    );
    const button = r.container.querySelector("button") as HTMLButtonElement;
    await actRun(() => button.click());
    await flush();
    expect(button.textContent).toContain("(retry)");
    expect(button.title).toBe("Couldn't open this file. Select to retry.");

    await actRun(() => button.click());
    await flush();
    expect(attempts).toBe(2);
    expect(button.textContent).not.toContain("(retry)");
    expect(button.title).toBe("Open /projects/example/src/app.ts");
    await r.unmount();
  });

  test("renders malformed sandbox and unsafe ordinary links as non-navigable text", () => {
    const html = renderToStaticMarkup(
      <Markdown onSandboxFile={() => undefined}>
        {"[Bad sandbox](sandbox:/projects/example/app.ts:0) [Bad web](javascript:alert(1))"}
      </Markdown>,
    );
    expect(html).toContain("Bad sandbox");
    expect(html).toContain("Bad web");
    expect(html).not.toContain('href=""');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<button");
  });

  test("keeps ordinary links safe and blocks custom schemes and sandbox image navigation", () => {
    const html = renderToStaticMarkup(
      <Markdown onSandboxFile={() => undefined}>
        {
          "[Web](https://example.com/docs) [Mail](mailto:hello@example.com) [Relative](docs/start.md) [Fragment](#start) [Custom](custom:payload) ![Sandbox image](sandbox:/projects/example/image.png)"
        }
      </Markdown>,
    );
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="mailto:hello@example.com"');
    expect(html).toContain('href="docs/start.md"');
    expect(html).toContain('href="#start"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain("Custom");
    expect(html).not.toContain("custom:payload");
    expect(html).toContain("Sandbox image");
    expect(html).not.toContain('src="sandbox:');
    expect(html).not.toContain('src=""');
  });
});
