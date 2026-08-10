import { Workbook } from "@opengeni/artifact-tool/reference";
import { SpreadsheetGrid } from "@opengeni/react/artifacts/spreadsheet";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

const ROW_COUNT = 1_048_576;
const DEFAULT_ROW_HEIGHT = 24;
const TALL_ROW_COUNT = 65;
const TALL_ROW_HEIGHT = 1_000_000;
const HEADER_HEIGHT = 28;
const PHYSICAL_HEIGHT = 8_000_000;

/** Browser-only acceptance fixture for the public artifact packages. */
export function mountFullSpreadsheet(target: HTMLElement): void {
  const workbook = Workbook.create();
  const worksheet = workbook.worksheets.add("Full sheet");
  for (let row = 0; row < TALL_ROW_COUNT; row += 1) {
    worksheet.setRowHeight(row, TALL_ROW_HEIGHT);
  }
  createRoot(target).render(createElement(SpreadsheetGrid, { workbook, worksheet }));
}

/** One CSS-pixel rows/columns: hundreds of thousands of visible blank cells, but sparse data. */
export function mountDenseSpreadsheet(target: HTMLElement): void {
  const workbook = Workbook.create();
  const worksheet = workbook.worksheets.add("Dense sheet");
  workbook.transact(() => {
    for (let row = 0; row < 1_200; row += 1) worksheet.setRowHeight(row, 1);
    for (let column = 0; column < 1_200; column += 1) worksheet.setColumnWidth(column, 1);
    // Keep one ordinary-size cell inside the dense field for real caret/IME acceptance.
    worksheet.setRowHeight(4, 24);
    worksheet.setColumnWidth(4, 96);
    worksheet.getRange("A1").values = [["origin"]];
    worksheet.getRange("KN401").values = [["sparse target"]];
  });
  createRoot(target).render(createElement(SpreadsheetGrid, { workbook, worksheet }));
}

/** Physical position for a fixture row under the grid's index-aware projection. */
export function physicalScrollForFixtureRow(row: number, viewportHeight: number): number {
  const total =
    TALL_ROW_COUNT * TALL_ROW_HEIGHT + (ROW_COUNT - TALL_ROW_COUNT) * DEFAULT_ROW_HEIGHT;
  const logicalMax = HEADER_HEIGHT + total - viewportHeight;
  const physicalMax = PHYSICAL_HEIGHT - viewportHeight;
  const baseItemSpan = Math.min(4, (PHYSICAL_HEIGHT - HEADER_HEIGHT) / ROW_COUNT);
  const proportionalSpan = PHYSICAL_HEIGHT - HEADER_HEIGHT - baseItemSpan * ROW_COUNT;
  const logicalOffset =
    row <= TALL_ROW_COUNT
      ? row * TALL_ROW_HEIGHT
      : TALL_ROW_COUNT * TALL_ROW_HEIGHT + (row - TALL_ROW_COUNT) * DEFAULT_ROW_HEIGHT;
  const rawAt = (offset: number) => {
    const inTallRows = offset < TALL_ROW_COUNT * TALL_ROW_HEIGHT;
    const relativeOffset = inTallRows ? offset : offset - TALL_ROW_COUNT * TALL_ROW_HEIGHT;
    const itemSize = inTallRows ? TALL_ROW_HEIGHT : DEFAULT_ROW_HEIGHT;
    const itemOffset = Math.floor(relativeOffset / itemSize);
    const index = (inTallRows ? 0 : TALL_ROW_COUNT) + itemOffset;
    const fraction = (relativeOffset - itemOffset * itemSize) / itemSize;
    return index * baseItemSpan + (offset / total) * proportionalSpan + fraction * baseItemSpan;
  };
  return (rawAt(logicalOffset) / rawAt(logicalMax)) * physicalMax;
}
