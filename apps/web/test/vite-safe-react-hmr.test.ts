import { describe, expect, test } from "bun:test";
import { reactModuleNeedsFullReload } from "../vite-safe-react-hmr";

describe("safe React HMR boundary", () => {
  test("keeps component-only modules on Fast Refresh", () => {
    expect(reactModuleNeedsFullReload("export function BrowserViewer() { return null; }\n")).toBe(
      false,
    );
  });

  test("full-reloads mixed helper and constant exports", () => {
    expect(
      reactModuleNeedsFullReload(
        "export function BrowserViewer() { return null; }\nexport function browserKey() {}\n",
      ),
    ).toBe(true);
    expect(reactModuleNeedsFullReload('export const WORKBENCH_SURFACES = ["browser"];\n')).toBe(
      true,
    );
  });

  test("ignores erased type exports", () => {
    expect(
      reactModuleNeedsFullReload(
        "export type BrowserViewerProps = { id: string };\nexport function BrowserViewer() { return null; }\n",
      ),
    ).toBe(false);
  });
});
