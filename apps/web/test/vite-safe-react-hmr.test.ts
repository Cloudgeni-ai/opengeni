import { describe, expect, test } from "bun:test";
import { isReactModule, reactModuleNeedsFullReload } from "../vite-safe-react-hmr";

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

  test("treats only JSX-rendering modules as React modules", () => {
    expect(isReactModule("/a/view.tsx", "export function View() { return <div />; }\n")).toBe(true);
    expect(isReactModule("/a/view.tsx", "export const View = () => <>x</>;\n")).toBe(true);
    expect(isReactModule("/a/helpers.tsx", "export function pick<T>(items: T[]) {}\n")).toBe(false);
    expect(isReactModule("/a/helpers.ts", "export const x = 1;\n")).toBe(false);
    expect(
      isReactModule("/node_modules/x/view.tsx", "export function View() { return <div />; }\n"),
    ).toBe(false);
  });
});
