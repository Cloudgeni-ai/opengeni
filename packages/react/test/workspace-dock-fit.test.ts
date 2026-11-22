import { expect, test } from "bun:test";
import { fitDockTabs, type DockTabFitInput } from "../src/components/workspace-dock-fit";

const order = ["artifacts", "changes", "files", "terminal", "browser", "settings"];
const base: DockTabFitInput = {
  order,
  required: new Set(["artifacts"]),
  fillable: new Set(["changes", "files", "terminal", "browser"]),
  optional: new Set(["changes", "files", "terminal", "browser", "settings"]),
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

test("an opened menu-only tab takes its close button's room too", () => {
  const fit = fitDockTabs({
    ...base,
    required: new Set(["artifacts", "settings"]),
    widths: { ...base.widths, settings: 90 },
    available: 360,
  });
  // Artifacts 90 + settings 92+16 = 198; changes 92 makes 290 and files 72
  // more makes 362, past 360 + 1, so only changes fits.
  expect([...fit.filled]).toEqual(["changes"]);
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
