import { expect, test } from "bun:test";
import { fitDockTabs, type DockTabFitInput } from "../src/components/workspace-dock-fit";

const order = ["artifacts", "changes", "files", "terminal", "browser", "settings"];
const base: DockTabFitInput = {
  order,
  required: new Set(["artifacts"]),
  fillable: new Set(["changes", "files", "terminal", "browser"]),
  // Tabs kept in the menu are never measured.
  widths: { artifacts: 90, changes: 90, files: 70, terminal: 90, browser: 90 },
  available: 400,
  gap: 2,
  closeWidth: 16,
};

test("optional tabs fill the strip in order while they fit", () => {
  const fit = fitDockTabs(base);
  // 90 + 92 + 72 + 92 = 346; the browser's 92 more would pass 400.
  expect([...fit.filled]).toEqual(["changes", "files", "terminal"]);
  expect([...fit.natural]).toEqual(["changes", "files", "terminal"]);
});

test("a wide strip shows every fillable tab, never one kept in the menu", () => {
  const fit = fitDockTabs({ ...base, available: 2000 });
  expect([...fit.filled]).toEqual(["changes", "files", "terminal", "browser"]);
  expect(fit.filled.has("settings")).toBe(false);
});

test("an opened tab that wouldn't fit by itself keeps its room and its close button", () => {
  const fit = fitDockTabs({
    ...base,
    required: new Set(["artifacts", "browser"]),
  });
  expect(fit.natural.has("browser")).toBe(false);
  // Artifacts 90 + browser 92+16 = 198, leaving room for changes and files.
  expect([...fit.filled]).toEqual(["changes", "files"]);
});

test("nothing fills before the strip is measured", () => {
  expect(fitDockTabs({ ...base, available: 0 }).filled.size).toBe(0);
  expect(fitDockTabs({ ...base, widths: { ...base.widths, files: 0 } }).filled.size).toBe(0);
});

test("the first tab that doesn't fit ends the strip", () => {
  const fit = fitDockTabs({
    ...base,
    widths: { ...base.widths, changes: 300 },
    available: 300,
  });
  expect(fit.filled.size).toBe(0);
});
