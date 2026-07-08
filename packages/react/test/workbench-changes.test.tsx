/* ----------------------------------------------------------------------------
   Changes tab (`WorkbenchChanges`) — the D2 windowing proof + rail grouping,
   source badge, and per-file guard. The diff pane windows whole file sections
   (manual, risk-#6 safe); this asserts REAL behavior — the count of MOUNTED
   `[data-diff-section]` nodes is bounded (not the file count) and SHIFTS on
   scroll (driven by a real scrollTop + a measured viewport). Not a proxy metric.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import type { GitFileDiff } from "@opengeni/sdk";
import { registerDom, renderComponent, flush } from "./render-hook";
import { fakeFileDiff } from "./sandbox-fixtures";
import { WorkbenchChanges, buildRail } from "../src/components/workbench-changes";

registerDom();

/** N modified files under `dir`, each with a handful of diff lines so the
 *  height estimate is non-trivial (the windowing math needs real spans). */
function manyFiles(n: number, dir = "src"): GitFileDiff[] {
  return Array.from({ length: n }, (_, i) =>
    fakeFileDiff({ path: `${dir}/file-${String(i).padStart(3, "0")}.ts`, additions: 3, deletions: 1 }),
  );
}

/** Give the pane a real viewport + scroll offset (happy-dom reports 0 by
 *  default), then let the rAF-coalesced recompute run. */
async function drivePane(pane: HTMLElement, scrollTop: number, viewport = 600) {
  Object.defineProperty(pane, "clientHeight", { value: viewport, configurable: true });
  pane.scrollTop = scrollTop;
  pane.dispatchEvent(new Event("scroll"));
  await flush(60);
}

function mountedIndices(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll("[data-diff-section]"))
    .map((el) => Number(el.getAttribute("data-diff-index")))
    .sort((a, b) => a - b);
}

describe("WorkbenchChanges — windowing (D2)", () => {
  test("a 40-file change set mounts a BOUNDED window, not all 40 sections", async () => {
    const r = await renderComponent(<WorkbenchChanges diff={manyFiles(40)} source="live" capturedAt={null} />);
    await flush();
    const mounted = container(r).querySelectorAll("[data-diff-section]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(40); // windowed — the whole point of D2
    await r.unmount();
  });

  test("the window SHIFTS to later sections when the pane scrolls", async () => {
    const r = await renderComponent(<WorkbenchChanges diff={manyFiles(40)} source="live" capturedAt={null} />);
    await flush();
    const pane = container(r).querySelector<HTMLElement>("[data-opengeni-changes-pane]");
    expect(pane).not.toBeNull();

    const atTop = mountedIndices(container(r));
    expect(atTop[0]).toBe(0); // top of the list is mounted at rest

    await drivePane(pane!, 4000, 600);
    const scrolled = mountedIndices(container(r));

    // The window moved DOWN: its first mounted index advanced, and it's still bounded.
    expect(scrolled[0]).toBeGreaterThan(atTop[0]!);
    expect(scrolled.length).toBeLessThan(40);
    // No section 0 in the scrolled window (we scrolled well past it).
    expect(scrolled).not.toContain(0);
    await r.unmount();
  });
});

describe("WorkbenchChanges — rail, badge, guard", () => {
  test("buildRail groups by top-level dir past the threshold, flat below it", async () => {
    const flat = buildRail(manyFiles(5));
    expect(flat.rows.every((row) => row.kind === "file")).toBe(true);
    expect(flat.orderedFiles).toHaveLength(5);

    const mixed = [...manyFiles(15, "api"), ...manyFiles(15, "web")];
    const grouped = buildRail(mixed);
    const groupRows = grouped.rows.filter((row) => row.kind === "group");
    expect(groupRows.map((g) => (g.kind === "group" ? g.label : ""))).toEqual(["api", "web"]);
    // Ordering the files by group keeps rail index == pane section index.
    expect(grouped.orderedFiles).toHaveLength(30);
    grouped.rows.forEach((row) => {
      if (row.kind === "file") expect(grouped.orderedFiles[row.index]).toBe(row.file);
    });
  });

  test("renders group headers in the rail for a large change set", async () => {
    const r = await renderComponent(
      <WorkbenchChanges diff={[...manyFiles(15, "api"), ...manyFiles(15, "web")]} source="live" capturedAt={null} />,
    );
    await flush();
    expect(container(r).querySelectorAll("[data-rail-group]").length).toBeGreaterThanOrEqual(2);
    await r.unmount();
  });

  test("source badge reads 'as of turn N · <time>' for a capture", async () => {
    const capturedAt = new Date().toISOString();
    const r = await renderComponent(
      <WorkbenchChanges diff={manyFiles(3)} source="capture" capturedAt={capturedAt} captureRevision={7} />,
    );
    await flush();
    expect(container(r).textContent).toContain("as of turn 7");
    await r.unmount();
  });

  test("source badge reads 'live' for the live source", async () => {
    const r = await renderComponent(<WorkbenchChanges diff={manyFiles(3)} source="live" capturedAt={null} />);
    await flush();
    expect(container(r).textContent).toContain("live");
    await r.unmount();
  });

  test("a binary file's section shows the open-live guard, not a diff body", async () => {
    const diff = [fakeFileDiff({ path: "assets/logo.png", isBinary: true, hunks: [], additions: 0, deletions: 0 })];
    const r = await renderComponent(<WorkbenchChanges diff={diff} source="live" capturedAt={null} />);
    await flush();
    expect(container(r).textContent).toContain("Binary file");
    expect(container(r).textContent).toContain("open it on the machine");
    await r.unmount();
  });

  test("an over-cap (truncated) diff shows the open-live guard", async () => {
    const diff = [fakeFileDiff({ path: "src/huge.ts", truncated: true, hunks: [] })];
    const r = await renderComponent(<WorkbenchChanges diff={diff} source="live" capturedAt={null} />);
    await flush();
    expect(container(r).textContent).toContain("Diff too large");
    await r.unmount();
  });
});

function container(r: { container: HTMLElement }): HTMLElement {
  return r.container;
}
