import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitFileDiff } from "@opengeni/sdk";
import { PierreDiff } from "../src/components/pierre-diff";
import { registerPierreDiffs } from "../src/lib/pierre-diffs-loader";
import { act } from "react";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
afterEach(() => registerPierreDiffs(null));

const diff = [
  {
    path: "src/app.ts",
    status: "modified",
    hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "add", content: "const b = 3;" }] }],
  },
] as unknown as GitFileDiff[];

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("optional @pierre/diffs peer", () => {
  test("only the opt-in diffs entry names the peer in an import", async () => {
    const root = join(import.meta.dir, "../src");
    const offenders: string[] = [];
    for (const file of await sourceFiles(root)) {
      if (file.endsWith("/src/diffs.ts")) continue;
      if (/import\(\s*["']@pierre\/diffs/.test(await readFile(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("without a registered loader, diffs render the plain-text degrade", async () => {
    const view = await renderComponent(<PierreDiff diff={diff} />);
    await flush(50);
    expect(view.container.textContent).toContain("src/app.ts");
    expect(view.container.querySelector("[data-opengeni-plain-diff]")).not.toBeNull();
    await view.unmount();
  });

  test("a registered loader is used for the rich renderer", async () => {
    let loads = 0;
    registerPierreDiffs(async () => {
      loads += 1;
      return { PatchDiff: () => <div data-test-rich-diff /> };
    });
    const view = await renderComponent(<PierreDiff diff={diff} />);
    await flush(50);
    expect(loads).toBeGreaterThan(0);
    // React.lazy caches the first resolved module per page, so another test file
    // may already have supplied the real renderer; either way it is not plain.
    expect(view.container.querySelector("[data-opengeni-plain-diff]")).toBeNull();
    expect(view.container.querySelector("[data-opengeni-pierre-diff]")).not.toBeNull();
    await view.unmount();
  });

  test("a view already showing plain text upgrades when a host registers the peer later", async () => {
    const view = await renderComponent(<PierreDiff diff={diff} />);
    try {
      await flush(50);
      expect(view.container.querySelector("[data-opengeni-plain-diff]")).not.toBeNull();
      await act(async () => {
        registerPierreDiffs(async () => ({ PatchDiff: () => <div data-test-late-diff /> }));
      });
      await flush(50);
      expect(view.container.querySelector("[data-opengeni-plain-diff]")).toBeNull();
      expect(view.container.querySelector("[data-opengeni-pierre-diff]")).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });
});
