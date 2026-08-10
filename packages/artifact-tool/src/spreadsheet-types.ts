import type { RangeAddress } from "./spreadsheet-address";

export type CellValue = string | number | boolean | Date | null;
export type FormulaResult = CellValue | FormulaErrorValue;
export type FormulaErrorValue =
  | "#DIV/0!"
  | "#N/A"
  | "#NAME?"
  | "#NUM!"
  | "#REF!"
  | "#VALUE!"
  | "#CYCLE!";

export type Color = string;
export type FontConfig = {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: Color;
};
export type BorderConfig = { style?: string; color?: Color; weight?: number };
export type RangeBordersConfig = {
  preset?: "none" | "outside" | "inside" | "all" | "doubleBottom";
  style?: string;
  color?: Color;
  top?: BorderConfig;
  bottom?: BorderConfig;
  left?: BorderConfig;
  right?: BorderConfig;
  insideHorizontal?: BorderConfig;
  insideVertical?: BorderConfig;
};
export type CellFormat = {
  fill?: Color;
  font?: FontConfig;
  numberFormat?: string;
  borders?: RangeBordersConfig;
  horizontalAlignment?: "left" | "center" | "right" | "justify";
  verticalAlignment?: "top" | "center" | "bottom";
  wrapText?: boolean;
};

export type CellData = {
  value: CellValue;
  formula: string | null;
  format: CellFormat;
};

export type FreezePaneState = { rows: number; columns: number };
export type MergeRegion = RangeAddress;
export type DataValidationConfig = { rule: Record<string, unknown> };
export type ConditionalFormatConfig = Record<string, unknown>;

export type SpreadsheetImageConfig = {
  dataUrl?: string;
  blob?: ArrayBuffer;
  contentType?: string;
  alt?: string;
  anchor: {
    from: { row: number; col: number; rowOffsetPx?: number; colOffsetPx?: number };
    extent: { widthPx: number; heightPx: number };
  };
};

export type SpreadsheetChartType =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "doughnut"
  | "scatter"
  | "bubble"
  | "radar"
  | "stock"
  | "treemap"
  | "sunburst"
  | "histogram"
  | "boxWhisker"
  | "waterfall"
  | "funnel"
  | "map";

export type SpreadsheetChartSeriesConfig = {
  name: string;
  formula?: string;
  categoryFormula?: string;
  values?: number[];
  categories?: Array<string | number>;
  fill?: Color;
};

export type SpreadsheetChartConfig = {
  chartType?: SpreadsheetChartType;
  title?: string;
  hasLegend?: boolean;
  series?: SpreadsheetChartSeriesConfig[];
};

export type SpreadsheetSparklineType = "line" | "column" | "stacked";

export type SpreadsheetSparklineMarkersOptions = {
  show?: boolean;
  high?: boolean;
  low?: boolean;
  first?: boolean;
  last?: boolean;
  negative?: boolean;
};

export type SpreadsheetSparklineAxisOptions = {
  showAxis?: boolean;
  manualMin?: number;
  manualMax?: number;
  rightToLeft?: boolean;
};

/** Style and display configuration shared by worksheet and range sparkline APIs. */
export type SpreadsheetSparklineOptions = {
  lineWeight?: number;
  displayHidden?: boolean;
  /** Skill-compatible proto enum: 0 = gaps, 1 = zero, 2 = connect. */
  displayEmptyCellsAs?: 0 | 1 | 2;
  seriesColor?: Color;
  negativeColor?: Color;
  axisColor?: Color;
  markersColor?: Color;
  firstMarkerColor?: Color;
  lastMarkerColor?: Color;
  highMarkerColor?: Color;
  lowMarkerColor?: Color;
  markers?: SpreadsheetSparklineMarkersOptions;
  axis?: SpreadsheetSparklineAxisOptions;
};

export type InspectOptions = {
  kind: string;
  include?: string;
  sheetId?: string;
  range?: string;
  search?: string;
  maxChars?: number;
  tableMaxRows?: number;
  tableMaxCols?: number;
  tableMaxCellChars?: number;
  maxResults?: number;
  options?: { maxResults?: number };
  target?: { id: string; beforeLines?: number; afterLines?: number };
};

export type InspectResult = {
  ndjson: string;
  records: readonly Record<string, unknown>[];
  truncated: boolean;
};

export type HelpOptions = {
  search?: string;
  include?: string;
  maxChars?: number;
};

export type RenderSpreadsheetOptions = {
  sheetName?: string;
  range?: string;
  autoCrop?: "all" | "content" | false;
  scale?: number;
  format?: "png" | "svg";
  background?: string;
};
