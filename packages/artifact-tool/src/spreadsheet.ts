import {
  EXCEL_MAX_COLUMNS,
  EXCEL_MAX_ROWS,
  assertRange,
  cellKey,
  formatCellAddress,
  formatRangeAddress,
  parseRangeAddress,
  type CellAddress,
  type RangeAddress,
} from "./spreadsheet-address";
import { ArtifactLimitError, UnsupportedArtifactFeatureError } from "./errors";
import { normalizeSpreadsheetImageConfig } from "./spreadsheet-image";
import {
  FormulaEvaluationBudget,
  evaluateFormula,
  formulaFromR1C1,
  formulaToR1C1,
  referencesInFormula,
  translateFormula,
  validateFormulaLimits,
  type FormulaEvaluationLimits,
} from "./spreadsheet-formula";
import type {
  CellData,
  CellFormat,
  CellValue,
  ConditionalFormatConfig,
  DataValidationConfig,
  FormulaResult,
  HelpOptions,
  InspectOptions,
  InspectResult,
  RenderSpreadsheetOptions,
  SpreadsheetChartConfig,
  SpreadsheetChartSeriesConfig,
  SpreadsheetChartType,
  SpreadsheetImageConfig,
  SpreadsheetSparklineAxisOptions,
  SpreadsheetSparklineMarkersOptions,
  SpreadsheetSparklineOptions,
  SpreadsheetSparklineType,
} from "./spreadsheet-types";
import type { FileBlob } from "./file-blob";
import { boundedUtf8ByteLength } from "./raster-image";

export { InvalidSpreadsheetImageError } from "./spreadsheet-image";

const DEFAULT_CELL: Readonly<CellData> = Object.freeze({
  value: null,
  formula: null,
  format: Object.freeze({}),
});
const normalizedCellFormats = new WeakSet<object>();
normalizedCellFormats.add(DEFAULT_CELL.format);
const STORED_CELL_ENTRIES = Symbol("storedCellEntries");
const CONNECT_CHART_POINT_COUNTER = Symbol("connectChartPointCounter");
const RESERVE_WORKBOOK_RESOURCE = Symbol("reserveWorkbookResource");
const RELEASE_WORKBOOK_RESOURCE = Symbol("releaseWorkbookResource");
const DEFAULT_COLUMN_WIDTH = 96;
const DEFAULT_ROW_HEIGHT = 24;

type Matrix<T> = T[][];
type WorkbookChangeListener = (change: WorkbookChange) => void;

export type WorkbookOptions = {
  formulaLimits?: Partial<FormulaEvaluationLimits>;
  recalculationLimits?: Partial<SpreadsheetRecalculationLimits>;
};

export type SpreadsheetRecalculationLimits = {
  maxCellReads: number;
  maxOperations: number;
};

export type RangeWritePayload =
  | { values: Matrix<CellValue>; formulas?: never; formulasR1C1?: never }
  | { values?: never; formulas: Matrix<string | null>; formulasR1C1?: never }
  | { values?: never; formulas?: never; formulasR1C1: Matrix<string | null> };

export type SparklineConfig = SpreadsheetSparklineOptions & {
  type: SpreadsheetSparklineType;
  targetRange: Range | string;
  sourceData: Range | string;
  dateAxisRange?: Range | string;
};

export type RangeSparklineConfig = SpreadsheetSparklineOptions & {
  dateAxisRange?: Range | string;
};

export type WorkbookChange = {
  revision: number;
  sheetIds: readonly string[];
  reason: "content" | "format" | "structure" | "drawing" | "comment" | "dimension";
};

export type SerializedWorkbook = {
  version: 1;
  worksheets: SerializedWorksheet[];
  comments: SerializedCommentThread[];
};

/** Hard, non-relaxable resource limits for untrusted workbook snapshots. */
export const SPREADSHEET_SNAPSHOT_LIMITS = Object.freeze({
  sheets: 1_024,
  cellsPerSheet: 1_000_000,
  cellsTotal: 1_000_000,
  mergesPerSheet: 100_000,
  mergesTotal: 100_000,
  dimensionOverridesPerSheet: 1_000_000,
  dimensionOverridesTotal: 1_000_000,
  tablesPerSheet: 1_024,
  tablesTotal: 10_000,
  chartsPerSheet: 1_024,
  chartsTotal: 10_000,
  chartSeriesTotal: 100_000,
  chartPointsTotal: 1_000_000,
  sparklineGroupsPerSheet: 1_024,
  sparklineGroupsTotal: 10_000,
  sparklineCellsPerSheet: 100_000,
  sparklineCellsTotal: 100_000,
  sparklinePointsPerSheet: 1_000_000,
  sparklinePointsTotal: 1_000_000,
  dataValidationsPerSheet: 100_000,
  dataValidationsTotal: 100_000,
  conditionalFormatsPerSheet: 100_000,
  conditionalFormatsTotal: 100_000,
  configNodesTotal: 1_000_000,
  imagesPerSheet: 10_000,
  imagesTotal: 10_000,
  imageBytesEach: 32 * 1024 * 1024,
  imageDataUrlBytesEach: 48 * 1024 * 1024,
  imageBytesTotal: 128 * 1024 * 1024,
  imageDataUrlBytesTotal: 192 * 1024 * 1024,
  commentThreads: 100_000,
  commentsPerThread: 1_000,
  commentsTotal: 500_000,
  dimensionValueMinimum: 1,
  dimensionValue: 1_000_000,
  imageOffsetPx: 1_000_000,
  imageExtentPx: 1_000_000,
  fontSize: 4_096,
  borderWeight: 4_096,
  stringBytesEach: 1024 * 1024,
  stringBytesTotal: 128 * 1024 * 1024,
});

type WorkbookResource =
  | "cells"
  | "merges"
  | "dimensionOverrides"
  | "tables"
  | "charts"
  | "chartSeries"
  | "chartPoints"
  | "sparklineGroups"
  | "sparklineCells"
  | "sparklinePoints"
  | "dataValidations"
  | "conditionalFormats"
  | "images"
  | "imageBytes"
  | "imageDataUrlBytes"
  | "commentThreads"
  | "comments";

const WORKBOOK_RESOURCE_LIMITS: Readonly<Record<WorkbookResource, number>> = {
  cells: SPREADSHEET_SNAPSHOT_LIMITS.cellsTotal,
  merges: SPREADSHEET_SNAPSHOT_LIMITS.mergesTotal,
  dimensionOverrides: SPREADSHEET_SNAPSHOT_LIMITS.dimensionOverridesTotal,
  tables: SPREADSHEET_SNAPSHOT_LIMITS.tablesTotal,
  charts: SPREADSHEET_SNAPSHOT_LIMITS.chartsTotal,
  chartSeries: SPREADSHEET_SNAPSHOT_LIMITS.chartSeriesTotal,
  chartPoints: SPREADSHEET_SNAPSHOT_LIMITS.chartPointsTotal,
  sparklineGroups: SPREADSHEET_SNAPSHOT_LIMITS.sparklineGroupsTotal,
  sparklineCells: SPREADSHEET_SNAPSHOT_LIMITS.sparklineCellsTotal,
  sparklinePoints: SPREADSHEET_SNAPSHOT_LIMITS.sparklinePointsTotal,
  dataValidations: SPREADSHEET_SNAPSHOT_LIMITS.dataValidationsTotal,
  conditionalFormats: SPREADSHEET_SNAPSHOT_LIMITS.conditionalFormatsTotal,
  images: SPREADSHEET_SNAPSHOT_LIMITS.imagesTotal,
  imageBytes: SPREADSHEET_SNAPSHOT_LIMITS.imageBytesTotal,
  imageDataUrlBytes: SPREADSHEET_SNAPSHOT_LIMITS.imageDataUrlBytesTotal,
  commentThreads: SPREADSHEET_SNAPSHOT_LIMITS.commentThreads,
  comments: SPREADSHEET_SNAPSHOT_LIMITS.commentsTotal,
};

/** Aggregate fuel for one full Workbook.recalculate() transaction. */
export const SPREADSHEET_RECALCULATION_LIMITS = Object.freeze({
  maxCellReads: 5_000_000,
  maxOperations: 10_000_000,
}) satisfies Readonly<SpreadsheetRecalculationLimits>;

type SerializedWorksheet = {
  id: string;
  name: string;
  showGridLines: boolean;
  freezePanes: { rows: number; columns: number };
  cells: Array<{
    row: number;
    col: number;
    value: SerializedCellValue;
    formula: string | null;
    format: CellFormat;
  }>;
  merges: RangeAddress[];
  columnWidths: Array<[number, number]>;
  rowHeights: Array<[number, number]>;
  tables: SerializedTable[];
  charts: SerializedChart[];
  sparklines: SerializedSparklineGroup[];
  dataValidations: SerializedDataValidation[];
  conditionalFormattings: SerializedConditionalFormatting[];
  images: SpreadsheetImageConfig[];
};

type SerializedCellValue = Exclude<CellValue, Date> | { type: "date"; value: string };

type SerializedTable = {
  id: string;
  name: string;
  range: RangeAddress;
  hasHeaders: boolean;
  style: string;
  showHeaders: boolean;
  showTotals: boolean;
  showBandedColumns: boolean;
  showFilterButton: boolean;
};

type SerializedChart = {
  id: string;
  name: string;
  type: SpreadsheetChartType;
  title: string;
  hasLegend: boolean;
  sourceRange: RangeAddress | null;
  series: SpreadsheetChartSeriesConfig[];
  position: { from: RangeAddress; to: RangeAddress } | null;
};

type SerializedRangeReference = {
  sheetId: string;
  address: RangeAddress;
};

type SerializedSparklineGroup = {
  id: string;
  type: SpreadsheetSparklineType;
  targetRange: RangeAddress;
  sourceData: SerializedRangeReference;
  dateAxisRange: SerializedRangeReference | null;
  lineWeight: number;
  displayHidden: boolean;
  displayEmptyCellsAs: 0 | 1 | 2;
  seriesColor: string | null;
  negativeColor: string | null;
  axisColor: string | null;
  markersColor: string | null;
  firstMarkerColor: string | null;
  lastMarkerColor: string | null;
  highMarkerColor: string | null;
  lowMarkerColor: string | null;
  markers: Required<SpreadsheetSparklineMarkersOptions>;
  axis: {
    showAxis: boolean;
    manualMin: number | null;
    manualMax: number | null;
    rightToLeft: boolean;
  };
};

type SerializedDataValidation = {
  range: RangeAddress;
  config: DataValidationConfig;
};

type SerializedConditionalFormatting = {
  range: RangeAddress;
  ruleType: string;
  config: ConditionalFormatConfig;
};

type SerializedCommentThread = {
  id: string;
  sheetId: string;
  cell: CellAddress;
  resolved: boolean;
  comments: Array<{ author: string; text: string; createdAt: string }>;
};

type SnapshotValidationState = {
  ids: Set<string>;
  worksheetIds: Set<string>;
  worksheetNames: Set<string>;
  stringBytes: number;
  imageBytes: number;
  imageDataUrlBytes: number;
  cells: number;
  merges: number;
  dimensionOverrides: number;
  tables: number;
  charts: number;
  chartSeries: number;
  chartPoints: number;
  sparklineGroups: number;
  sparklineCells: number;
  sparklinePoints: number;
  dataValidations: number;
  conditionalFormats: number;
  configNodes: number;
  sparklineSheetReferences: Array<{ id: string; path: string }>;
  images: number;
  comments: number;
  normalizedImages: SpreadsheetImageConfig[];
};

/** Validate an untrusted snapshot completely without constructing or mutating a Workbook. */
export function validateSerializedWorkbook(input: unknown): asserts input is SerializedWorkbook {
  validateSerializedWorkbookState(input);
}

function validateSerializedWorkbookState(input: unknown): SnapshotValidationState {
  const state: SnapshotValidationState = {
    ids: new Set(),
    worksheetIds: new Set(),
    worksheetNames: new Set(),
    stringBytes: 0,
    imageBytes: 0,
    imageDataUrlBytes: 0,
    cells: 0,
    merges: 0,
    dimensionOverrides: 0,
    tables: 0,
    charts: 0,
    chartSeries: 0,
    chartPoints: 0,
    sparklineGroups: 0,
    sparklineCells: 0,
    sparklinePoints: 0,
    dataValidations: 0,
    conditionalFormats: 0,
    configNodes: 0,
    sparklineSheetReferences: [],
    images: 0,
    comments: 0,
    normalizedImages: [],
  };
  const root = snapshotRecord(input, "workbook", ["version", "worksheets", "comments"]);
  if (root.version !== 1) {
    throw new Error("Unsupported workbook model version; expected 1");
  }
  const worksheets = snapshotArray(
    root.worksheets,
    "workbook.worksheets",
    SPREADSHEET_SNAPSHOT_LIMITS.sheets,
  );
  const comments = snapshotArray(
    root.comments,
    "workbook.comments",
    SPREADSHEET_SNAPSHOT_LIMITS.commentThreads,
  );

  for (let index = 0; index < worksheets.length; index += 1) {
    validateSerializedWorksheet(worksheets[index], `workbook.worksheets[${index}]`, state);
  }
  for (const reference of state.sparklineSheetReferences) {
    if (!state.worksheetIds.has(reference.id)) {
      throw new Error(`${reference.path} references an unknown worksheet id`);
    }
  }
  for (let index = 0; index < comments.length; index += 1) {
    validateSerializedComment(comments[index], `workbook.comments[${index}]`, state);
  }
  return state;
}

function validateSerializedWorksheet(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const sheet = snapshotRecord(
    value,
    path,
    [
      "id",
      "name",
      "showGridLines",
      "freezePanes",
      "cells",
      "merges",
      "columnWidths",
      "rowHeights",
      "tables",
      "charts",
      "sparklines",
      "images",
    ],
    ["dataValidations", "conditionalFormattings"],
  );
  const id = snapshotId(sheet.id, `${path}.id`, "ws", state);
  state.worksheetIds.add(id);
  const name = snapshotString(sheet.name, `${path}.name`, state, true);
  if (name.length > 31 || name.trim() !== name || /[\\/?*[\]:]/.test(name)) {
    throw new Error(`${path}.name must be a normalized worksheet name`);
  }
  const normalizedName = name.toLowerCase();
  if (state.worksheetNames.has(normalizedName)) throw new Error(`${path}.name is duplicated`);
  state.worksheetNames.add(normalizedName);
  snapshotBoolean(sheet.showGridLines, `${path}.showGridLines`);

  const freeze = snapshotRecord(sheet.freezePanes, `${path}.freezePanes`, ["rows", "columns"]);
  snapshotInteger(freeze.rows, `${path}.freezePanes.rows`, 0, EXCEL_MAX_ROWS);
  snapshotInteger(freeze.columns, `${path}.freezePanes.columns`, 0, EXCEL_MAX_COLUMNS);

  const cells = snapshotArray(
    sheet.cells,
    `${path}.cells`,
    SPREADSHEET_SNAPSHOT_LIMITS.cellsPerSheet,
  );
  state.cells = snapshotAggregate(
    "spreadsheet snapshot cells",
    state.cells,
    cells.length,
    SPREADSHEET_SNAPSHOT_LIMITS.cellsTotal,
  );
  const cellCoordinates = new Set<number>();
  for (let index = 0; index < cells.length; index += 1) {
    const cellPath = `${path}.cells[${index}]`;
    const cell = snapshotRecord(cells[index], cellPath, [
      "row",
      "col",
      "value",
      "formula",
      "format",
    ]);
    const row = snapshotInteger(cell.row, `${cellPath}.row`, 0, EXCEL_MAX_ROWS - 1);
    const col = snapshotInteger(cell.col, `${cellPath}.col`, 0, EXCEL_MAX_COLUMNS - 1);
    const key = cellKey(row, col);
    if (cellCoordinates.has(key)) throw new Error(`Duplicate cell coordinate at ${cellPath}`);
    cellCoordinates.add(key);
    validateSnapshotCellValue(cell.value, `${cellPath}.value`, state);
    if (cell.formula !== null) {
      const formula = snapshotString(cell.formula, `${cellPath}.formula`, state);
      if (!formula.startsWith("=") || formula.trim() !== formula) {
        throw new Error(`${cellPath}.formula must be a canonical =-prefixed formula`);
      }
      validateFormulaLimits(formula);
    }
    validateSnapshotCellFormat(cell.format, `${cellPath}.format`, state);
  }

  const merges = snapshotArray(
    sheet.merges,
    `${path}.merges`,
    SPREADSHEET_SNAPSHOT_LIMITS.mergesPerSheet,
  );
  state.merges = snapshotAggregate(
    "spreadsheet snapshot merges",
    state.merges,
    merges.length,
    SPREADSHEET_SNAPSHOT_LIMITS.mergesTotal,
  );
  const mergeKeys = new Set<string>();
  const mergeRanges: Array<{ range: RangeAddress; path: string }> = [];
  for (let index = 0; index < merges.length; index += 1) {
    const mergePath = `${path}.merges[${index}]`;
    const range = validateSnapshotRange(merges[index], mergePath);
    const key = snapshotRangeKey(range);
    if (mergeKeys.has(key)) throw new Error(`Duplicate merge range at ${path}.merges[${index}]`);
    mergeKeys.add(key);
    mergeRanges.push({ range, path: mergePath });
  }
  assertSnapshotRangesDoNotOverlap(mergeRanges);

  validateSnapshotDimensions(sheet.columnWidths, `${path}.columnWidths`, true, state);
  validateSnapshotDimensions(sheet.rowHeights, `${path}.rowHeights`, false, state);
  validateSnapshotTables(sheet.tables, `${path}.tables`, state);
  validateSnapshotCharts(sheet.charts, `${path}.charts`, state);
  validateSnapshotSparklines(sheet.sparklines, `${path}.sparklines`, state);
  validateSnapshotDataValidations(sheet.dataValidations, `${path}.dataValidations`, state);
  validateSnapshotConditionalFormattings(
    sheet.conditionalFormattings,
    `${path}.conditionalFormattings`,
    state,
  );
  validateSnapshotImages(sheet.images, `${path}.images`, state);
}

function validateSnapshotDimensions(
  value: unknown,
  path: string,
  columns: boolean,
  state: SnapshotValidationState,
): void {
  const entries = snapshotArray(
    value,
    path,
    SPREADSHEET_SNAPSHOT_LIMITS.dimensionOverridesPerSheet,
  );
  state.dimensionOverrides = snapshotAggregate(
    "spreadsheet snapshot dimension overrides",
    state.dimensionOverrides,
    entries.length,
    SPREADSHEET_SNAPSHOT_LIMITS.dimensionOverridesTotal,
  );
  const indexes = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = snapshotArray(entries[index], `${path}[${index}]`, 2, 2);
    const coordinate = snapshotInteger(
      entry[0],
      `${path}[${index}][0]`,
      0,
      (columns ? EXCEL_MAX_COLUMNS : EXCEL_MAX_ROWS) - 1,
    );
    if (indexes.has(coordinate)) throw new Error(`Duplicate dimension index at ${path}[${index}]`);
    indexes.add(coordinate);
    snapshotFiniteNumber(entry[1], `${path}[${index}][1]`, {
      minimum: SPREADSHEET_SNAPSHOT_LIMITS.dimensionValueMinimum,
      maximum: SPREADSHEET_SNAPSHOT_LIMITS.dimensionValue,
    });
  }
}

function validateSnapshotTables(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const tables = snapshotArray(value, path, SPREADSHEET_SNAPSHOT_LIMITS.tablesPerSheet);
  state.tables = snapshotAggregate(
    "spreadsheet snapshot tables",
    state.tables,
    tables.length,
    SPREADSHEET_SNAPSHOT_LIMITS.tablesTotal,
  );
  const names = new Set<string>();
  const ranges: RangeAddress[] = [];
  for (let index = 0; index < tables.length; index += 1) {
    const tablePath = `${path}[${index}]`;
    const table = snapshotRecord(tables[index], tablePath, [
      "id",
      "name",
      "range",
      "hasHeaders",
      "style",
      "showHeaders",
      "showTotals",
      "showBandedColumns",
      "showFilterButton",
    ]);
    snapshotId(table.id, `${tablePath}.id`, "tb", state);
    const name = snapshotString(table.name, `${tablePath}.name`, state, true);
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`${tablePath}.name is duplicated`);
    names.add(normalizedName);
    const range = validateSnapshotRange(table.range, `${tablePath}.range`);
    if (ranges.some((existing) => rangesOverlap(existing, range))) {
      throw new Error(`Overlapping table range at ${tablePath}.range`);
    }
    ranges.push(range);
    snapshotBoolean(table.hasHeaders, `${tablePath}.hasHeaders`);
    snapshotString(table.style, `${tablePath}.style`, state);
    snapshotBoolean(table.showHeaders, `${tablePath}.showHeaders`);
    snapshotBoolean(table.showTotals, `${tablePath}.showTotals`);
    snapshotBoolean(table.showBandedColumns, `${tablePath}.showBandedColumns`);
    snapshotBoolean(table.showFilterButton, `${tablePath}.showFilterButton`);
  }
}

const SNAPSHOT_CHART_TYPES = new Set<SpreadsheetChartType>([
  "bar",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "bubble",
  "radar",
  "stock",
  "treemap",
  "sunburst",
  "histogram",
  "boxWhisker",
  "waterfall",
  "funnel",
  "map",
]);

function validateSnapshotCharts(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const charts = snapshotArray(value, path, SPREADSHEET_SNAPSHOT_LIMITS.chartsPerSheet);
  state.charts = snapshotAggregate(
    "spreadsheet snapshot charts",
    state.charts,
    charts.length,
    SPREADSHEET_SNAPSHOT_LIMITS.chartsTotal,
  );
  const names = new Set<string>();
  for (let index = 0; index < charts.length; index += 1) {
    const chartPath = `${path}[${index}]`;
    const chart = snapshotRecord(charts[index], chartPath, [
      "id",
      "name",
      "type",
      "title",
      "hasLegend",
      "sourceRange",
      "series",
      "position",
    ]);
    snapshotId(chart.id, `${chartPath}.id`, "ch", state);
    const name = snapshotString(chart.name, `${chartPath}.name`, state, true);
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`${chartPath}.name is duplicated`);
    names.add(normalizedName);
    const type = snapshotString(chart.type, `${chartPath}.type`, state);
    if (!SNAPSHOT_CHART_TYPES.has(type as SpreadsheetChartType)) {
      throw new Error(`${chartPath}.type is unsupported`);
    }
    snapshotString(chart.title, `${chartPath}.title`, state);
    snapshotBoolean(chart.hasLegend, `${chartPath}.hasLegend`);
    if (chart.sourceRange !== null) {
      validateSnapshotRange(chart.sourceRange, `${chartPath}.sourceRange`);
    }
    validateSnapshotChartSeries(chart.series, `${chartPath}.series`, state);
    if (chart.position !== null) {
      const position = snapshotRecord(chart.position, `${chartPath}.position`, ["from", "to"]);
      validateSnapshotRange(position.from, `${chartPath}.position.from`);
      validateSnapshotRange(position.to, `${chartPath}.position.to`);
    }
  }
}

function validateSnapshotChartSeries(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const remaining = SPREADSHEET_SNAPSHOT_LIMITS.chartSeriesTotal - state.chartSeries;
  const series = snapshotArray(value, path, Math.max(0, remaining));
  state.chartSeries = snapshotAggregate(
    "spreadsheet snapshot chart series",
    state.chartSeries,
    series.length,
    SPREADSHEET_SNAPSHOT_LIMITS.chartSeriesTotal,
  );
  for (let index = 0; index < series.length; index += 1) {
    const seriesPath = `${path}[${index}]`;
    const item = snapshotRecord(
      series[index],
      seriesPath,
      ["name"],
      ["formula", "categoryFormula", "values", "categories", "fill"],
    );
    snapshotString(item.name, `${seriesPath}.name`, state);
    for (const key of ["formula", "categoryFormula"] as const) {
      if (item[key] !== undefined) {
        const formula = snapshotString(item[key], `${seriesPath}.${key}`, state);
        validateFormulaLimits(formula);
      }
    }
    if (item.fill !== undefined) snapshotString(item.fill, `${seriesPath}.fill`, state);

    const values =
      item.values === undefined
        ? null
        : snapshotChartPointArray(item.values, `${seriesPath}.values`, state, false);
    const categories =
      item.categories === undefined
        ? null
        : snapshotChartPointArray(item.categories, `${seriesPath}.categories`, state, true);
    if (values && categories && values.length !== categories.length) {
      throw new Error(`${seriesPath} values and categories must have equal length`);
    }
  }
}

function snapshotChartPointArray(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
  allowStrings: boolean,
): unknown[] {
  const remaining = SPREADSHEET_SNAPSHOT_LIMITS.chartPointsTotal - state.chartPoints;
  const points = snapshotArray(value, path, Math.max(0, remaining));
  state.chartPoints = snapshotAggregate(
    "spreadsheet snapshot chart points",
    state.chartPoints,
    points.length,
    SPREADSHEET_SNAPSHOT_LIMITS.chartPointsTotal,
  );
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (allowStrings && typeof point === "string") {
      snapshotString(point, `${path}[${index}]`, state);
    } else {
      snapshotFiniteNumber(point, `${path}[${index}]`);
    }
  }
  return points;
}

const SNAPSHOT_SPARKLINE_TYPES = new Set<SpreadsheetSparklineType>(["line", "column", "stacked"]);

function validateSnapshotSparklines(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const groups = snapshotArray(value, path, SPREADSHEET_SNAPSHOT_LIMITS.sparklineGroupsPerSheet);
  state.sparklineGroups = snapshotAggregate(
    "spreadsheet snapshot sparkline groups",
    state.sparklineGroups,
    groups.length,
    SPREADSHEET_SNAPSHOT_LIMITS.sparklineGroupsTotal,
  );
  const targetRanges: Array<{ range: RangeAddress; path: string }> = [];
  let sheetCells = 0;
  let sheetPoints = 0;

  for (let index = 0; index < groups.length; index += 1) {
    const groupPath = `${path}[${index}]`;
    const group = snapshotRecord(groups[index], groupPath, [
      "id",
      "type",
      "targetRange",
      "sourceData",
      "dateAxisRange",
      "lineWeight",
      "displayHidden",
      "displayEmptyCellsAs",
      "seriesColor",
      "negativeColor",
      "axisColor",
      "markersColor",
      "firstMarkerColor",
      "lastMarkerColor",
      "highMarkerColor",
      "lowMarkerColor",
      "markers",
      "axis",
    ]);
    snapshotId(group.id, `${groupPath}.id`, "sp", state);
    const type = snapshotString(group.type, `${groupPath}.type`, state);
    if (!SNAPSHOT_SPARKLINE_TYPES.has(type as SpreadsheetSparklineType)) {
      throw new Error(`${groupPath}.type is unsupported`);
    }
    const targetRange = validateSnapshotRange(group.targetRange, `${groupPath}.targetRange`);
    const sourceData = validateSnapshotRangeReference(
      group.sourceData,
      `${groupPath}.sourceData`,
      state,
    );
    const dateAxisRange =
      group.dateAxisRange === null
        ? null
        : validateSnapshotRangeReference(group.dateAxisRange, `${groupPath}.dateAxisRange`, state);
    const dimensions = sparklineDimensions(
      targetRange,
      sourceData.address,
      dateAxisRange?.address ?? null,
      groupPath,
    );
    targetRanges.push({ range: targetRange, path: `${groupPath}.targetRange` });

    sheetCells = snapshotAggregate(
      "worksheet snapshot sparkline cells",
      sheetCells,
      dimensions.targetCells,
      SPREADSHEET_SNAPSHOT_LIMITS.sparklineCellsPerSheet,
    );
    state.sparklineCells = snapshotAggregate(
      "spreadsheet snapshot sparkline cells",
      state.sparklineCells,
      dimensions.targetCells,
      SPREADSHEET_SNAPSHOT_LIMITS.sparklineCellsTotal,
    );
    const readPoints =
      dimensions.sourcePoints + (dateAxisRange ? dimensions.pointsPerSparkline : 0);
    sheetPoints = snapshotAggregate(
      "worksheet snapshot sparkline source points",
      sheetPoints,
      readPoints,
      SPREADSHEET_SNAPSHOT_LIMITS.sparklinePointsPerSheet,
    );
    state.sparklinePoints = snapshotAggregate(
      "spreadsheet snapshot sparkline source points",
      state.sparklinePoints,
      readPoints,
      SPREADSHEET_SNAPSHOT_LIMITS.sparklinePointsTotal,
    );

    snapshotFiniteNumber(group.lineWeight, `${groupPath}.lineWeight`, {
      positive: true,
      maximum: 10,
    });
    snapshotBoolean(group.displayHidden, `${groupPath}.displayHidden`);
    snapshotInteger(group.displayEmptyCellsAs, `${groupPath}.displayEmptyCellsAs`, 0, 2);
    for (const key of [
      "seriesColor",
      "negativeColor",
      "axisColor",
      "markersColor",
      "firstMarkerColor",
      "lastMarkerColor",
      "highMarkerColor",
      "lowMarkerColor",
    ] as const) {
      if (group[key] === null) continue;
      const color = snapshotString(group[key], `${groupPath}.${key}`, state);
      if (!isCanonicalSparklineColor(color)) {
        throw new Error(`${groupPath}.${key} must be a safe hexadecimal color`);
      }
    }

    const markers = snapshotRecord(group.markers, `${groupPath}.markers`, [
      "show",
      "high",
      "low",
      "first",
      "last",
      "negative",
    ]);
    for (const key of ["show", "high", "low", "first", "last", "negative"] as const) {
      snapshotBoolean(markers[key], `${groupPath}.markers.${key}`);
    }
    const axis = snapshotRecord(group.axis, `${groupPath}.axis`, [
      "showAxis",
      "manualMin",
      "manualMax",
      "rightToLeft",
    ]);
    snapshotBoolean(axis.showAxis, `${groupPath}.axis.showAxis`);
    snapshotBoolean(axis.rightToLeft, `${groupPath}.axis.rightToLeft`);
    const manualMin =
      axis.manualMin === null
        ? null
        : snapshotFiniteNumber(axis.manualMin, `${groupPath}.axis.manualMin`);
    const manualMax =
      axis.manualMax === null
        ? null
        : snapshotFiniteNumber(axis.manualMax, `${groupPath}.axis.manualMax`);
    if (manualMin !== null && manualMax !== null && manualMin >= manualMax) {
      throw new Error(`${groupPath}.axis manualMin must be less than manualMax`);
    }
  }
  assertSnapshotRangesDoNotOverlap(targetRanges, "sparkline target");
}

function validateSnapshotRangeReference(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): SerializedRangeReference {
  const reference = snapshotRecord(value, path, ["sheetId", "address"]);
  const sheetId = snapshotString(reference.sheetId, `${path}.sheetId`, state, true);
  if (!sheetId.startsWith("ws/") || sheetId.length === 3) {
    throw new Error(`${path}.sheetId must use the ws/ object-id namespace`);
  }
  state.sparklineSheetReferences.push({ id: sheetId, path: `${path}.sheetId` });
  return {
    sheetId,
    address: validateSnapshotRange(reference.address, `${path}.address`),
  };
}

function validateSnapshotDataValidations(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const entries = snapshotArray(
    value === undefined ? [] : value,
    path,
    SPREADSHEET_SNAPSHOT_LIMITS.dataValidationsPerSheet,
  );
  state.dataValidations = snapshotAggregate(
    "spreadsheet snapshot data validations",
    state.dataValidations,
    entries.length,
    SPREADSHEET_SNAPSHOT_LIMITS.dataValidationsTotal,
  );
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = snapshotRecord(entries[index], entryPath, ["range", "config"]);
    validateSnapshotRange(entry.range, `${entryPath}.range`);
    const config = snapshotRecord(entry.config, `${entryPath}.config`, ["rule"]);
    validateSnapshotConfig(config.rule, `${entryPath}.config.rule`, state, true);
  }
}

function validateSnapshotConditionalFormattings(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const entries = snapshotArray(
    value === undefined ? [] : value,
    path,
    SPREADSHEET_SNAPSHOT_LIMITS.conditionalFormatsPerSheet,
  );
  state.conditionalFormats = snapshotAggregate(
    "spreadsheet snapshot conditional formats",
    state.conditionalFormats,
    entries.length,
    SPREADSHEET_SNAPSHOT_LIMITS.conditionalFormatsTotal,
  );
  for (let index = 0; index < entries.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const entry = snapshotRecord(entries[index], entryPath, ["range", "ruleType", "config"]);
    validateSnapshotRange(entry.range, `${entryPath}.range`);
    normalizeConditionalFormatRuleType(
      snapshotString(entry.ruleType, `${entryPath}.ruleType`, state, true),
    );
    validateSnapshotConfig(entry.config, `${entryPath}.config`, state, true);
  }
}

const SPREADSHEET_CONFIG_LIMITS = Object.freeze({
  depth: 32,
  nodesEach: 100_000,
  arrayItems: 10_000,
  objectProperties: 1_024,
  stringBytesEach: 1024 * 1024,
  stringBytesEachConfig: 4 * 1024 * 1024,
});

function validateSnapshotConfig(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
  requireRecord: boolean,
): void {
  const usage = { nodes: 0, stringBytes: 0 };
  canonicalizeConfigValue(value, path, usage, new WeakSet(), 0, requireRecord);
  state.configNodes = snapshotAggregate(
    "spreadsheet snapshot configuration nodes",
    state.configNodes,
    usage.nodes,
    SPREADSHEET_SNAPSHOT_LIMITS.configNodesTotal,
  );
  state.stringBytes = snapshotAggregate(
    "spreadsheet snapshot strings",
    state.stringBytes,
    usage.stringBytes,
    SPREADSHEET_SNAPSHOT_LIMITS.stringBytesTotal,
  );
}

function normalizeConfigRecord(value: unknown, path: string): Record<string, unknown> {
  return canonicalizeConfigValue(
    value,
    path,
    { nodes: 0, stringBytes: 0 },
    new WeakSet(),
    0,
    true,
  ) as Record<string, unknown>;
}

function canonicalizeConfigValue(
  value: unknown,
  path: string,
  usage: { nodes: number; stringBytes: number },
  seen: WeakSet<object>,
  depth: number,
  requireRecord = false,
): unknown {
  usage.nodes += 1;
  if (usage.nodes > SPREADSHEET_CONFIG_LIMITS.nodesEach) {
    throw new ArtifactLimitError(`${path} nodes`, usage.nodes, SPREADSHEET_CONFIG_LIMITS.nodesEach);
  }
  if (depth > SPREADSHEET_CONFIG_LIMITS.depth) {
    throw new ArtifactLimitError(`${path} depth`, depth, SPREADSHEET_CONFIG_LIMITS.depth);
  }
  if (value === null) {
    if (requireRecord) throw new TypeError(`${path} must be a plain object`);
    return null;
  }
  if (typeof value === "string") {
    if (requireRecord) throw new TypeError(`${path} must be a plain object`);
    const bytes = boundedUtf8ByteLength(value, SPREADSHEET_CONFIG_LIMITS.stringBytesEach);
    if (bytes > SPREADSHEET_CONFIG_LIMITS.stringBytesEach) {
      throw new ArtifactLimitError(
        `${path} UTF-8 bytes`,
        bytes,
        SPREADSHEET_CONFIG_LIMITS.stringBytesEach,
      );
    }
    usage.stringBytes += bytes;
    if (usage.stringBytes > SPREADSHEET_CONFIG_LIMITS.stringBytesEachConfig) {
      throw new ArtifactLimitError(
        `${path} string bytes`,
        usage.stringBytes,
        SPREADSHEET_CONFIG_LIMITS.stringBytesEachConfig,
      );
    }
    return value;
  }
  if (typeof value === "boolean") {
    if (requireRecord) throw new TypeError(`${path} must be a plain object`);
    return value;
  }
  if (typeof value === "number") {
    if (requireRecord) throw new TypeError(`${path} must be a plain object`);
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON-compatible plain data`);
  }
  if (seen.has(value)) throw new TypeError(`${path} must not contain cycles or shared aliases`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (requireRecord) throw new TypeError(`${path} must be a plain object`);
      const source = snapshotArray(value, path, SPREADSHEET_CONFIG_LIMITS.arrayItems);
      return Object.freeze(
        source.map((item, index) =>
          canonicalizeConfigValue(item, `${path}[${index}]`, usage, seen, depth + 1),
        ),
      );
    }
    const source = snapshotRecord(
      value,
      path,
      [],
      Reflect.ownKeys(value).filter((key): key is string => typeof key === "string"),
    );
    const keys = Object.keys(source).sort();
    if (keys.length > SPREADSHEET_CONFIG_LIMITS.objectProperties) {
      throw new ArtifactLimitError(
        `${path} properties`,
        keys.length,
        SPREADSHEET_CONFIG_LIMITS.objectProperties,
      );
    }
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const keyBytes = boundedUtf8ByteLength(key, SPREADSHEET_CONFIG_LIMITS.stringBytesEach);
      if (keyBytes === 0 || keyBytes > SPREADSHEET_CONFIG_LIMITS.stringBytesEach) {
        throw new TypeError(`${path} contains an invalid property name`);
      }
      usage.stringBytes += keyBytes;
      if (usage.stringBytes > SPREADSHEET_CONFIG_LIMITS.stringBytesEachConfig) {
        throw new ArtifactLimitError(
          `${path} string bytes`,
          usage.stringBytes,
          SPREADSHEET_CONFIG_LIMITS.stringBytesEachConfig,
        );
      }
      output[key] = canonicalizeConfigValue(source[key], `${path}.${key}`, usage, seen, depth + 1);
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

function validateSnapshotImages(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const images = snapshotArray(value, path, SPREADSHEET_SNAPSHOT_LIMITS.imagesPerSheet);
  state.images = snapshotAggregate(
    "spreadsheet snapshot images",
    state.images,
    images.length,
    SPREADSHEET_SNAPSHOT_LIMITS.imagesTotal,
  );
  for (let index = 0; index < images.length; index += 1) {
    const imagePath = `${path}[${index}]`;
    const image = snapshotRecord(
      images[index],
      imagePath,
      ["anchor"],
      ["dataUrl", "blob", "contentType", "alt"],
    );
    let imageBytes = 0;
    const hasDataUrl = image.dataUrl !== undefined;
    const hasBlob = image.blob !== undefined;
    if (hasDataUrl === hasBlob) {
      throw new TypeError(`${imagePath} must contain exactly one of dataUrl or blob`);
    }
    let detectedContentType: string | null = null;
    if (hasDataUrl) {
      if (typeof image.dataUrl !== "string") {
        throw new TypeError(`${imagePath}.dataUrl must be a string`);
      }
      boundedUtf8Bytes(
        image.dataUrl,
        SPREADSHEET_SNAPSHOT_LIMITS.imageDataUrlBytesEach,
        `${imagePath}.dataUrl`,
      );
      const dataUrl = image.dataUrl;
      const parsed = validateRasterDataUrl(dataUrl, `${imagePath}.dataUrl`);
      imageBytes += parsed.bytes;
      detectedContentType = parsed.contentType;
    }
    if (hasBlob) {
      if (
        !(image.blob instanceof ArrayBuffer) ||
        Object.getPrototypeOf(image.blob) !== ArrayBuffer.prototype ||
        Reflect.ownKeys(image.blob).length !== 0
      ) {
        throw new TypeError(`${imagePath}.blob must be an ArrayBuffer`);
      }
      imageBytes += image.blob.byteLength;
    }
    snapshotLimit(
      "spreadsheet snapshot image bytes",
      imageBytes,
      SPREADSHEET_SNAPSHOT_LIMITS.imageBytesEach,
    );
    state.imageBytes = snapshotAggregate(
      "spreadsheet snapshot image bytes",
      state.imageBytes,
      imageBytes,
      SPREADSHEET_SNAPSHOT_LIMITS.imageBytesTotal,
    );
    if (image.contentType === undefined) {
      if (hasBlob) throw new TypeError(`${imagePath}.contentType is required for blob images`);
    } else {
      const contentType = snapshotString(image.contentType, `${imagePath}.contentType`, state);
      if (!SNAPSHOT_RASTER_CONTENT_TYPES.has(contentType)) {
        throw new TypeError(`${imagePath}.contentType must identify a supported raster image`);
      }
      if (detectedContentType && contentType !== detectedContentType) {
        throw new TypeError(`${imagePath}.contentType does not match its dataUrl`);
      }
    }
    if (image.alt !== undefined) snapshotString(image.alt, `${imagePath}.alt`, state);

    const anchor = snapshotRecord(image.anchor, `${imagePath}.anchor`, ["from", "extent"]);
    const from = snapshotRecord(
      anchor.from,
      `${imagePath}.anchor.from`,
      ["row", "col"],
      ["rowOffsetPx", "colOffsetPx"],
    );
    snapshotInteger(from.row, `${imagePath}.anchor.from.row`, 0, EXCEL_MAX_ROWS - 1);
    snapshotInteger(from.col, `${imagePath}.anchor.from.col`, 0, EXCEL_MAX_COLUMNS - 1);
    for (const key of ["rowOffsetPx", "colOffsetPx"] as const) {
      if (from[key] !== undefined) {
        snapshotFiniteNumber(from[key], `${imagePath}.anchor.from.${key}`, {
          nonNegative: true,
          maximum: SPREADSHEET_SNAPSHOT_LIMITS.imageOffsetPx,
        });
      }
    }
    const extent = snapshotRecord(anchor.extent, `${imagePath}.anchor.extent`, [
      "widthPx",
      "heightPx",
    ]);
    snapshotFiniteNumber(extent.widthPx, `${imagePath}.anchor.extent.widthPx`, {
      positive: true,
      maximum: SPREADSHEET_SNAPSHOT_LIMITS.imageExtentPx,
    });
    snapshotFiniteNumber(extent.heightPx, `${imagePath}.anchor.extent.heightPx`, {
      positive: true,
      maximum: SPREADSHEET_SNAPSHOT_LIMITS.imageExtentPx,
    });

    // Decode and verify the actual raster signature during preflight. This guarantees malformed
    // media fails before Workbook construction, while the canonical copy can be reused by restore.
    const normalized = normalizeSpreadsheetImageConfig(image as unknown as SpreadsheetImageConfig);
    const canonicalDataUrlBytes = boundedUtf8Bytes(
      normalized.dataUrl!,
      SPREADSHEET_SNAPSHOT_LIMITS.imageDataUrlBytesEach,
      `${imagePath}.dataUrl`,
    );
    state.imageDataUrlBytes = snapshotAggregate(
      "spreadsheet snapshot canonical image data URL bytes",
      state.imageDataUrlBytes,
      canonicalDataUrlBytes,
      SPREADSHEET_SNAPSHOT_LIMITS.imageDataUrlBytesTotal,
    );
    state.normalizedImages.push(normalized);
  }
}

function validateSerializedComment(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const thread = snapshotRecord(value, path, ["id", "sheetId", "cell", "resolved", "comments"]);
  snapshotId(thread.id, `${path}.id`, "th", state);
  const sheetId = snapshotString(thread.sheetId, `${path}.sheetId`, state, true);
  if (!state.worksheetIds.has(sheetId)) throw new Error(`${path}.sheetId references no worksheet`);
  validateSnapshotCellAddress(thread.cell, `${path}.cell`);
  snapshotBoolean(thread.resolved, `${path}.resolved`);
  const comments = snapshotArray(
    thread.comments,
    `${path}.comments`,
    SPREADSHEET_SNAPSHOT_LIMITS.commentsPerThread,
    1,
  );
  state.comments = snapshotAggregate(
    "spreadsheet snapshot comments",
    state.comments,
    comments.length,
    SPREADSHEET_SNAPSHOT_LIMITS.commentsTotal,
  );
  for (let index = 0; index < comments.length; index += 1) {
    const commentPath = `${path}.comments[${index}]`;
    const comment = snapshotRecord(comments[index], commentPath, ["author", "text", "createdAt"]);
    snapshotString(comment.author, `${commentPath}.author`, state);
    snapshotString(comment.text, `${commentPath}.text`, state);
    const createdAt = snapshotString(comment.createdAt, `${commentPath}.createdAt`, state);
    const timestamp = new Date(createdAt);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== createdAt)
      throw new Error(`${commentPath}.createdAt must be canonical ISO-8601 UTC`);
  }
}

function validateSnapshotCellValue(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    snapshotString(value, path, state);
    return;
  }
  if (typeof value === "number") {
    snapshotFiniteNumber(value, path);
    return;
  }
  if (value !== null && typeof value === "object") {
    const tagged = snapshotRecord(value, path, ["type", "value"]);
    if (tagged.type !== "date") {
      throw new TypeError(`${path}.type must be date`);
    }
    const iso = snapshotString(tagged.value, `${path}.value`, state);
    const timestamp = new Date(iso);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== iso) {
      throw new TypeError(`${path}.value must be canonical ISO-8601 UTC`);
    }
    return;
  }
  throw new TypeError(`${path} must be a finite spreadsheet cell value`);
}

function validateSnapshotCellFormat(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const format = snapshotRecord(
    value,
    path,
    [],
    [
      "fill",
      "font",
      "numberFormat",
      "borders",
      "horizontalAlignment",
      "verticalAlignment",
      "wrapText",
    ],
  );
  if (format.fill !== undefined) snapshotString(format.fill, `${path}.fill`, state);
  if (format.numberFormat !== undefined) {
    snapshotString(format.numberFormat, `${path}.numberFormat`, state);
  }
  if (format.wrapText !== undefined) snapshotBoolean(format.wrapText, `${path}.wrapText`);
  if (format.horizontalAlignment !== undefined) {
    snapshotEnum(format.horizontalAlignment, `${path}.horizontalAlignment`, [
      "left",
      "center",
      "right",
      "justify",
    ]);
  }
  if (format.verticalAlignment !== undefined) {
    snapshotEnum(format.verticalAlignment, `${path}.verticalAlignment`, [
      "top",
      "center",
      "bottom",
    ]);
  }
  if (format.font !== undefined) validateSnapshotFont(format.font, `${path}.font`, state);
  if (format.borders !== undefined) {
    validateSnapshotBorders(format.borders, `${path}.borders`, state);
  }
}

function validateSnapshotFont(value: unknown, path: string, state: SnapshotValidationState): void {
  const font = snapshotRecord(
    value,
    path,
    [],
    ["name", "size", "bold", "italic", "underline", "color"],
  );
  for (const key of ["name", "color"] as const) {
    if (font[key] !== undefined) snapshotString(font[key], `${path}.${key}`, state);
  }
  if (font.size !== undefined) {
    snapshotFiniteNumber(font.size, `${path}.size`, {
      positive: true,
      maximum: SPREADSHEET_SNAPSHOT_LIMITS.fontSize,
    });
  }
  for (const key of ["bold", "italic", "underline"] as const) {
    if (font[key] !== undefined) snapshotBoolean(font[key], `${path}.${key}`);
  }
}

function validateSnapshotBorders(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
): void {
  const borders = snapshotRecord(
    value,
    path,
    [],
    [
      "preset",
      "style",
      "color",
      "top",
      "bottom",
      "left",
      "right",
      "insideHorizontal",
      "insideVertical",
    ],
  );
  if (borders.preset !== undefined) {
    snapshotEnum(borders.preset, `${path}.preset`, [
      "none",
      "outside",
      "inside",
      "all",
      "doubleBottom",
    ]);
  }
  for (const key of ["style", "color"] as const) {
    if (borders[key] !== undefined) snapshotString(borders[key], `${path}.${key}`, state);
  }
  for (const key of [
    "top",
    "bottom",
    "left",
    "right",
    "insideHorizontal",
    "insideVertical",
  ] as const) {
    if (borders[key] === undefined) continue;
    const border = snapshotRecord(borders[key], `${path}.${key}`, [], ["style", "color", "weight"]);
    if (border.style !== undefined) snapshotString(border.style, `${path}.${key}.style`, state);
    if (border.color !== undefined) snapshotString(border.color, `${path}.${key}.color`, state);
    if (border.weight !== undefined) {
      snapshotFiniteNumber(border.weight, `${path}.${key}.weight`, {
        nonNegative: true,
        maximum: SPREADSHEET_SNAPSHOT_LIMITS.borderWeight,
      });
    }
  }
}

function validateSnapshotRange(value: unknown, path: string): RangeAddress {
  const range = snapshotRecord(value, path, ["row", "col", "rowCount", "colCount"]);
  const result = {
    row: snapshotInteger(range.row, `${path}.row`, 0, EXCEL_MAX_ROWS - 1),
    col: snapshotInteger(range.col, `${path}.col`, 0, EXCEL_MAX_COLUMNS - 1),
    rowCount: snapshotInteger(range.rowCount, `${path}.rowCount`, 1, EXCEL_MAX_ROWS),
    colCount: snapshotInteger(range.colCount, `${path}.colCount`, 1, EXCEL_MAX_COLUMNS),
  };
  try {
    assertRange(result);
  } catch (cause) {
    throw new Error(`${path} exceeds XLSX bounds`, { cause });
  }
  return result;
}

function validateSnapshotCellAddress(value: unknown, path: string): CellAddress {
  const address = snapshotRecord(value, path, ["row", "col"]);
  return {
    row: snapshotInteger(address.row, `${path}.row`, 0, EXCEL_MAX_ROWS - 1),
    col: snapshotInteger(address.col, `${path}.col`, 0, EXCEL_MAX_COLUMNS - 1),
  };
}

function snapshotRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) {
      throw new TypeError(`${path} contains an unknown property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be a plain data property`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${path}.${key} is required`);
  }
  return record;
}

function snapshotArray(value: unknown, path: string, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} must be an array`);
  }
  snapshotLimit(`${path} length`, value.length, maximum);
  if (value.length < minimum) throw new TypeError(`${path} must contain ${minimum} items`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key === "symbol")) {
    throw new TypeError(`${path} must be a dense plain array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${path}[${index}] must be a plain data element`);
    }
  }
  return value;
}

function snapshotId(
  value: unknown,
  path: string,
  prefix: "ws" | "tb" | "ch" | "sp" | "th",
  state: SnapshotValidationState,
): string {
  const id = snapshotString(value, path, state, true);
  if (!id.startsWith(`${prefix}/`) || id.length === prefix.length + 1) {
    throw new Error(`${path} must use the ${prefix}/ object-id namespace`);
  }
  if (state.ids.has(id)) throw new Error(`${path} duplicates another object id`);
  state.ids.add(id);
  return id;
}

function snapshotString(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
  nonEmpty = false,
): string {
  return snapshotStringWithLimit(
    value,
    path,
    state,
    SPREADSHEET_SNAPSHOT_LIMITS.stringBytesEach,
    nonEmpty,
  );
}

function snapshotStringWithLimit(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
  maximum: number,
  nonEmpty = false,
): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  if (nonEmpty && value.length === 0) throw new TypeError(`${path} must not be empty`);
  const bytes = boundedUtf8Bytes(value, maximum, path);
  state.stringBytes = snapshotAggregate(
    "spreadsheet snapshot string bytes",
    state.stringBytes,
    bytes,
    SPREADSHEET_SNAPSHOT_LIMITS.stringBytesTotal,
  );
  return value;
}

function boundedUtf8Bytes(value: string, maximum: number, label: string): number {
  const bytes = boundedUtf8ByteLength(value, maximum);
  if (bytes > maximum) {
    throw new ArtifactLimitError(`${label} UTF-8 bytes`, bytes, maximum);
  }
  return bytes;
}

function snapshotAggregate(label: string, current: number, added: number, maximum: number): number {
  if (!Number.isSafeInteger(added) || added < 0 || current > Number.MAX_SAFE_INTEGER - added) {
    throw new ArtifactLimitError(label, Number.MAX_SAFE_INTEGER, maximum);
  }
  const total = current + added;
  snapshotLimit(label, total, maximum);
  return total;
}

function snapshotLimit(label: string, actual: number, maximum: number): void {
  if (actual > maximum) throw new ArtifactLimitError(label, actual, maximum);
}

function snapshotInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function snapshotFiniteNumber(
  value: unknown,
  path: string,
  options: {
    positive?: boolean;
    nonNegative?: boolean;
    minimum?: number;
    maximum?: number;
  } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  if (options.positive && value <= 0) throw new TypeError(`${path} must be positive`);
  if (options.nonNegative && value < 0) throw new TypeError(`${path} must be non-negative`);
  if (options.minimum !== undefined && value < options.minimum) {
    throw new TypeError(`${path} must be at least ${options.minimum}`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    throw new TypeError(`${path} must not exceed ${options.maximum}`);
  }
  return value;
}

function snapshotBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function snapshotEnum(value: unknown, path: string, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function snapshotRangeKey(range: RangeAddress): string {
  return `${range.row}:${range.col}:${range.rowCount}:${range.colCount}`;
}

/**
 * Reject overlapping merge rectangles in O(n log C), where C is the fixed XLSX column bound.
 * Row-end events run before row-start events so merely adjacent ranges remain valid.
 */
function assertSnapshotRangesDoNotOverlap(
  ranges: readonly { range: RangeAddress; path: string }[],
  label = "merge",
): void {
  if (ranges.length < 2) return;
  const events: Array<{
    row: number;
    delta: -1 | 1;
    col: number;
    endCol: number;
    path: string;
  }> = [];
  for (const { range, path } of ranges) {
    events.push({
      row: range.row,
      delta: 1,
      col: range.col,
      endCol: range.col + range.colCount - 1,
      path,
    });
    events.push({
      row: range.row + range.rowCount,
      delta: -1,
      col: range.col,
      endCol: range.col + range.colCount - 1,
      path,
    });
  }
  events.sort((left, right) => left.row - right.row || left.delta - right.delta);

  let treeSize = 1;
  while (treeSize < EXCEL_MAX_COLUMNS) treeSize *= 2;
  const maximum = new Int32Array(treeSize * 2);
  const lazy = new Int32Array(treeSize * 2);

  const add = (
    node: number,
    nodeStart: number,
    nodeEnd: number,
    start: number,
    end: number,
    delta: number,
  ): void => {
    if (start <= nodeStart && nodeEnd <= end) {
      maximum[node] = maximum[node]! + delta;
      lazy[node] = lazy[node]! + delta;
      return;
    }
    const middle = (nodeStart + nodeEnd) >>> 1;
    if (start <= middle) add(node * 2, nodeStart, middle, start, end, delta);
    if (end > middle) add(node * 2 + 1, middle + 1, nodeEnd, start, end, delta);
    maximum[node] = lazy[node]! + Math.max(maximum[node * 2]!, maximum[node * 2 + 1]!);
  };

  const query = (
    node: number,
    nodeStart: number,
    nodeEnd: number,
    start: number,
    end: number,
    inherited: number,
  ): number => {
    if (start <= nodeStart && nodeEnd <= end) return inherited + maximum[node]!;
    const nextInherited = inherited + lazy[node]!;
    const middle = (nodeStart + nodeEnd) >>> 1;
    let result = 0;
    if (start <= middle) result = query(node * 2, nodeStart, middle, start, end, nextInherited);
    if (end > middle) {
      result = Math.max(
        result,
        query(node * 2 + 1, middle + 1, nodeEnd, start, end, nextInherited),
      );
    }
    return result;
  };

  for (const event of events) {
    if (event.delta === 1 && query(1, 0, treeSize - 1, event.col, event.endCol, 0) > 0) {
      throw new Error(`Overlapping ${label} range at ${event.path}`);
    }
    add(1, 0, treeSize - 1, event.col, event.endCol, event.delta);
  }
}

const SNAPSHOT_RASTER_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function validateRasterDataUrl(
  dataUrl: string,
  path: string,
): { contentType: string; bytes: number } {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new TypeError(`${path} must be a base64 raster data URL`);
  const prefix = dataUrl.slice(0, comma);
  const contentType = prefix.slice("data:".length, -";base64".length).toLowerCase();
  if (
    !prefix.toLowerCase().endsWith(";base64") ||
    !prefix.toLowerCase().startsWith("data:image/") ||
    !SNAPSHOT_RASTER_CONTENT_TYPES.has(contentType)
  ) {
    throw new TypeError(`${path} must be a supported base64 raster data URL`);
  }
  const payload = dataUrl.slice(comma + 1);
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new TypeError(`${path} contains invalid base64 image data`);
  }
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return { contentType, bytes: (payload.length / 4) * 3 - padding };
}

function canonicalImageUsage(config: SpreadsheetImageConfig): {
  imageBytes: number;
  dataUrlBytes: number;
} {
  const dataUrl = config.dataUrl!;
  const comma = dataUrl.indexOf(",");
  const payloadLength = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
  return {
    imageBytes: (payloadLength / 4) * 3 - padding,
    // Canonical raster URLs contain ASCII only, so code units equal UTF-8 bytes.
    dataUrlBytes: dataUrl.length,
  };
}

/**
 * Skill-compatible TypeScript reference workbook used by conformance tests,
 * codecs, and local development. It is not selected as a production kernel
 * fallback; production editing must use the native or Worker/WASM session.
 */
export class Workbook {
  readonly worksheets: WorksheetCollection;
  readonly comments: WorkbookComments;
  private revisionValue = 0;
  private transactionDepth = 0;
  private changedSheets = new Set<string>();
  private pendingReason: WorkbookChange["reason"] = "content";
  private readonly listeners = new Set<WorkbookChangeListener>();
  private calculationRevision = -1;
  private readonly calculationCache = new Map<Worksheet, Map<number, FormulaResult>>();
  private readonly calculationStack = new Map<Worksheet, Set<number>>();
  private readonly objects = new Map<string, unknown>();
  private nextObjectId = 1;
  private readonly resourceCounts: Record<WorkbookResource, number> = {
    cells: 0,
    merges: 0,
    dimensionOverrides: 0,
    tables: 0,
    charts: 0,
    chartSeries: 0,
    chartPoints: 0,
    sparklineGroups: 0,
    sparklineCells: 0,
    sparklinePoints: 0,
    dataValidations: 0,
    conditionalFormats: 0,
    images: 0,
    imageBytes: 0,
    imageDataUrlBytes: 0,
    commentThreads: 0,
    comments: 0,
  };
  readonly formulaLimits: Readonly<FormulaEvaluationLimits>;
  readonly recalculationLimits: Readonly<SpreadsheetRecalculationLimits>;

  private constructor(options: WorkbookOptions = {}) {
    this.formulaLimits = new FormulaEvaluationBudget(options.formulaLimits).limits;
    this.recalculationLimits = resolveRecalculationLimits(options.recalculationLimits);
    this.worksheets = new WorksheetCollection(this);
    this.comments = new WorkbookComments(this);
  }

  static create(options: WorkbookOptions = {}): Workbook {
    return new Workbook(options);
  }

  static async fromCSV(
    csvText: string,
    options: { sheetName?: string; delimiter?: string } = {},
  ): Promise<Workbook> {
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add(options.sheetName ?? "Sheet1");
    const rows = parseCsv(csvText, options.delimiter ?? ",");
    if (rows.length > 0) sheet.getRange("A1").writeValues(rectangularize(rows, null));
    return workbook;
  }

  get revision(): number {
    return this.revisionValue;
  }

  transact<T>(callback: () => T): T {
    this.transactionDepth += 1;
    try {
      return callback();
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0 && this.changedSheets.size > 0) this.commit();
    }
  }

  onChange(listener: WorkbookChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recalculate(): void {
    this.calculationCache.clear();
    this.calculationStack.clear();
    this.calculationRevision = this.revisionValue;
    // These are independent root evaluations. Reuse their scratch state while resetting fuel so
    // every root retains exactly the same limits as a freshly allocated budget and stack.
    const budget = new FormulaEvaluationBudget(this.formulaLimits);
    let rootSheet: Worksheet | undefined;
    const rootAddress: CellAddress = { row: 0, col: 0 };
    const evaluateRoot = (rootBudget: FormulaEvaluationBudget): FormulaResult =>
      this.evaluateCell(rootSheet!, rootAddress, rootBudget, 0);
    let calculationOperations = 0;
    let calculationCellReads = 0;
    try {
      budget.runIsolatedRoots((runRoot) => {
        for (const sheet of this.worksheets.items) {
          for (const [key, data] of sheet[STORED_CELL_ENTRIES]()) {
            if (data.formula) {
              rootSheet = sheet;
              const row = Math.floor(key / EXCEL_MAX_COLUMNS);
              rootAddress.row = row;
              rootAddress.col = key - row * EXCEL_MAX_COLUMNS;
              runRoot(evaluateRoot);
              calculationOperations += budget.operationCount;
              calculationCellReads += budget.cellReadCount;
              if (calculationOperations > this.recalculationLimits.maxOperations) {
                throw new ArtifactLimitError(
                  "spreadsheet recalculation operations",
                  calculationOperations,
                  this.recalculationLimits.maxOperations,
                );
              }
              if (calculationCellReads > this.recalculationLimits.maxCellReads) {
                throw new ArtifactLimitError(
                  "spreadsheet recalculation cell reads",
                  calculationCellReads,
                  this.recalculationLimits.maxCellReads,
                );
              }
            }
          }
        }
      });
    } catch (cause) {
      // Derived values are one transaction: never retain dependency cache writes from a failed
      // root or let repeated retries launder work around the fuel limits.
      this.calculationCache.clear();
      this.calculationStack.clear();
      this.calculationRevision = -1;
      throw cause;
    }
  }

  trace(reference: string): {
    root: string;
    nodes: Array<Record<string, unknown>>;
  } {
    const separator = reference.lastIndexOf("!");
    const sheetName =
      separator >= 0
        ? unquoteSheetName(reference.slice(0, separator))
        : this.worksheets.getActiveWorksheet().name;
    const addressText = separator >= 0 ? reference.slice(separator + 1) : reference;
    const rootSheet = this.worksheets.getItem(sheetName);
    const rootAddress = parseRangeAddress(addressText);
    const root = `${quoteSheetName(rootSheet.name)}!${formatCellAddress(rootAddress)}`;
    const nodes: Array<Record<string, unknown>> = [];
    const visited = new Set<string>();
    const budget = new FormulaEvaluationBudget(this.formulaLimits);

    const visit = (sheet: Worksheet, address: CellAddress, depth: number): void => {
      budget.assertDependencyDepth(depth);
      const id = `${sheet.id}:${address.row}:${address.col}`;
      if (visited.has(id)) return;
      visited.add(id);
      const data = sheet.cellData(address.row, address.col);
      const ref = `${quoteSheetName(sheet.name)}!${formatCellAddress(address)}`;
      nodes.push({
        id: ref,
        depth,
        formula: data.formula,
        value: this.valueAt(sheet, address),
      });
      if (!data.formula) return;
      for (const dependency of referencesInFormula(data.formula)) {
        const dependencySheet = dependency.sheetName
          ? this.worksheets.getItem(dependency.sheetName)
          : sheet;
        const dependencyCells =
          (dependency.end.row - dependency.start.row + 1) *
          (dependency.end.col - dependency.start.col + 1);
        budget.consumeCellReads(dependencyCells);
        for (let row = dependency.start.row; row <= dependency.end.row; row += 1) {
          for (let col = dependency.start.col; col <= dependency.end.col; col += 1) {
            visit(dependencySheet, { row, col }, depth + 1);
          }
        }
      }
    };

    visit(rootSheet, rootAddress, 0);
    return { root, nodes };
  }

  async inspect(options: InspectOptions): Promise<InspectResult> {
    const kinds = new Set(
      options.kind
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean),
    );
    const records: Array<Record<string, unknown>> = [];
    const selectedRange = options.range ? parseQualifiedRange(options.range) : null;
    const selectedSheet = options.sheetId
      ? this.worksheets.getItem(options.sheetId)
      : selectedRange?.sheetName
        ? this.worksheets.getItem(selectedRange.sheetName)
        : null;
    if (
      selectedSheet &&
      selectedRange?.sheetName &&
      selectedSheet.name.toLowerCase() !== selectedRange.sheetName.toLowerCase()
    ) {
      throw new Error(
        `Inspect range sheet ${selectedRange.sheetName} conflicts with sheetId ${options.sheetId}`,
      );
    }
    const sheets = selectedSheet ? [selectedSheet] : this.worksheets.items;
    const maxResults = options.options?.maxResults ?? options.maxResults ?? 1_000;
    const search = options.search?.toLowerCase();
    const includes = new Set(
      (options.include ?? "values")
        .split(",")
        .map((include) => include.trim())
        .filter(Boolean),
    );

    if (kinds.has("workbook")) {
      records.push({
        kind: "workbook",
        revision: this.revisionValue,
        sheetCount: this.worksheets.items.length,
        formulaCount: this.worksheets.items.reduce(
          (count, sheet) => count + sheet.formulaCount(),
          0,
        ),
      });
    }
    for (const sheet of sheets) {
      if (records.length >= maxResults) break;
      if (kinds.has("sheet")) {
        const used = sheet.usedRangeAddress();
        records.push({
          kind: "sheet",
          id: sheet.id,
          name: sheet.name,
          usedRange: used ? formatRangeAddress(used) : null,
        });
      }
      if (kinds.has("region") || kinds.has("table")) {
        const address = selectedRange?.address ?? sheet.usedRangeAddress();
        if (address) {
          const tableMaxRows = Math.min(address.rowCount, options.tableMaxRows ?? 20);
          const tableMaxCols = Math.min(address.colCount, options.tableMaxCols ?? 20);
          const inspectedRange = sheet.getRangeByIndexes(
            address.row,
            address.col,
            tableMaxRows,
            tableMaxCols,
          );
          const values = inspectedRange.values.map((row) =>
            row.map((value) => truncateCell(value, options.tableMaxCellChars ?? 200)),
          );
          const record: Record<string, unknown> = {
            kind: kinds.has("table") ? "table" : "region",
            sheetId: sheet.id,
            sheetName: sheet.name,
            range: formatRangeAddress(address),
          };
          if (includes.has("values")) record.values = values;
          if (includes.has("formulas")) record.formulas = inspectedRange.formulas;
          records.push(record);
        }
        if (kinds.has("table") && !selectedRange) {
          for (const table of sheet.tables.items) records.push(table.inspectRecord());
        }
      }
      if (kinds.has("formula") || kinds.has("computedStyle") || kinds.has("match")) {
        const bounded = selectedRange?.address ?? sheet.usedRangeAddress();
        if (bounded) {
          for (let row = bounded.row; row < bounded.row + bounded.rowCount; row += 1) {
            for (let col = bounded.col; col < bounded.col + bounded.colCount; col += 1) {
              if (records.length >= maxResults) break;
              const data = sheet.cellData(row, col);
              const value = this.valueAt(sheet, { row, col });
              const haystack = `${data.formula ?? ""} ${String(value ?? "")}`.toLowerCase();
              if (search && !haystack.includes(search)) continue;
              const address = formatCellAddress({ row, col });
              if (kinds.has("formula") && data.formula) {
                records.push({
                  kind: "formula",
                  sheetId: sheet.id,
                  sheetName: sheet.name,
                  address,
                  formula: data.formula,
                  value,
                });
              }
              if (kinds.has("computedStyle") && Object.keys(data.format).length > 0) {
                records.push({
                  kind: "computedStyle",
                  sheetId: sheet.id,
                  sheetName: sheet.name,
                  address,
                  format: data.format,
                });
              }
              if (kinds.has("match") && (search || haystack.trim())) {
                records.push({
                  kind: "match",
                  sheetId: sheet.id,
                  sheetName: sheet.name,
                  address,
                  formula: data.formula,
                  value,
                });
              }
            }
          }
        }
      }
      if (kinds.has("drawing")) {
        for (const chart of sheet.charts.items) records.push(chart.inspectRecord());
        for (const sparkline of sheet.sparklineGroups.items)
          records.push(sparkline.inspectRecord());
        for (const image of sheet.images.items) records.push(image.inspectRecord());
      }
      if (kinds.has("sparkline") && !kinds.has("drawing")) {
        for (const sparkline of sheet.sparklineGroups.items)
          records.push(sparkline.inspectRecord());
      }
    }
    if (kinds.has("thread")) {
      for (const thread of this.comments.items) records.push(thread.inspectRecord());
    }

    const filtered = options.target
      ? records.filter((record) => record.id === options.target?.id)
      : records;
    const bounded = boundNdjson(filtered, options.maxChars ?? 20_000);
    return bounded;
  }

  help(query: string, options: HelpOptions = {}): InspectResult {
    const normalized = query.toLowerCase();
    const entries = HELP_ENTRIES.filter((entry) => {
      const content = `${entry.path} ${entry.summary} ${entry.examples.join(" ")}`.toLowerCase();
      const exact = normalized === "*" || content.includes(normalized.replace("fx.", ""));
      if (!options.search) return exact;
      try {
        return exact && new RegExp(options.search, "i").test(content);
      } catch {
        return exact && content.includes(options.search.toLowerCase());
      }
    });
    return boundNdjson(entries, options.maxChars ?? 6_000);
  }

  async render(options: RenderSpreadsheetOptions = {}): Promise<FileBlob> {
    const { renderWorkbook } = await import("@opengeni/artifact-tool/spreadsheet/render");
    return await renderWorkbook(this, options);
  }

  resolve(id: string): unknown {
    const value = this.objects.get(id);
    if (!value) throw new Error(`Unknown workbook object id: ${id}`);
    return value;
  }

  toJSON(): SerializedWorkbook {
    return structuredClone({
      version: 1,
      worksheets: this.worksheets.items.map((sheet) => sheet.serialize()),
      comments: this.comments.items.map((thread) => thread.serialize()),
    });
  }

  static fromJSON(input: unknown): Workbook {
    const validation = validateSerializedWorkbookState(input);
    const accepted = input as SerializedWorkbook;
    // Images were already copied into canonical, deeply frozen configs during preflight. Excluding
    // caller blobs from this clone avoids a second full raw-image allocation during restoration.
    const snapshot = structuredClone({
      version: accepted.version,
      worksheets: accepted.worksheets.map((worksheet) => ({
        ...worksheet,
        images: [],
      })),
      comments: accepted.comments,
    }) as SerializedWorkbook;
    let imageIndex = 0;
    for (let worksheetIndex = 0; worksheetIndex < snapshot.worksheets.length; worksheetIndex += 1) {
      snapshot.worksheets[worksheetIndex]!.images = accepted.worksheets[worksheetIndex]!.images.map(
        () => validation.normalizedImages[imageIndex++]!,
      );
    }
    const workbook = Workbook.create();
    workbook.transact(() => {
      for (const serialized of snapshot.worksheets) workbook.worksheets.restore(serialized);
      for (const serialized of snapshot.worksheets) {
        workbook.worksheets.getItem(serialized.id).restoreSparklines(serialized.sparklines);
      }
      for (const thread of snapshot.comments) workbook.comments.restore(thread);
    });
    return workbook;
  }

  valueAt(sheet: Worksheet, address: CellAddress): FormulaResult {
    if (this.calculationRevision !== this.revisionValue) {
      this.calculationCache.clear();
      this.calculationStack.clear();
      this.calculationRevision = this.revisionValue;
    }
    try {
      return detachCellValue(
        this.evaluateCell(sheet, address, new FormulaEvaluationBudget(this.formulaLimits), 0),
      );
    } catch (cause) {
      this.calculationCache.clear();
      this.calculationStack.clear();
      this.calculationRevision = -1;
      throw cause;
    }
  }

  markChanged(sheetId: string, reason: WorkbookChange["reason"]): void {
    this.changedSheets.add(sheetId);
    if (REASON_PRIORITY[reason] > REASON_PRIORITY[this.pendingReason]) this.pendingReason = reason;
    if (this.transactionDepth === 0) this.commit();
  }

  allocateId(prefix: string, value: unknown): string {
    const id = `${prefix}/${this.nextObjectId++}`;
    this.objects.set(id, value);
    return id;
  }

  registerId(id: string, value: unknown): void {
    if (this.objects.has(id)) throw new Error(`Duplicate workbook object id: ${id}`);
    this.objects.set(id, value);
    const suffix = id.slice(id.lastIndexOf("/") + 1);
    const numeric = suffix.length <= 16 && /^\d+$/.test(suffix) ? Number(suffix) : NaN;
    if (Number.isSafeInteger(numeric)) {
      this.nextObjectId = Math.max(this.nextObjectId, numeric + 1);
    }
  }

  [RESERVE_WORKBOOK_RESOURCE](resource: WorkbookResource, count = 1): void {
    const current = this.resourceCounts[resource];
    const maximum = WORKBOOK_RESOURCE_LIMITS[resource];
    if (!Number.isSafeInteger(count) || count < 0 || current > Number.MAX_SAFE_INTEGER - count) {
      throw new ArtifactLimitError(`workbook ${resource}`, Number.MAX_SAFE_INTEGER, maximum);
    }
    const next = current + count;
    if (next > maximum) {
      throw new ArtifactLimitError(`workbook ${resource}`, next, maximum);
    }
    this.resourceCounts[resource] = next;
  }

  [RELEASE_WORKBOOK_RESOURCE](resource: WorkbookResource, count = 1): void {
    const next = this.resourceCounts[resource] - count;
    if (!Number.isSafeInteger(count) || count < 0 || next < 0) {
      throw new Error(`Workbook ${resource} accounting underflow`);
    }
    this.resourceCounts[resource] = next;
  }

  private evaluateCell(
    sheet: Worksheet,
    address: CellAddress,
    budget: FormulaEvaluationBudget,
    depth: number,
  ): FormulaResult {
    const key = cellKey(address.row, address.col);
    budget.assertDependencyDepth(depth);
    const data = sheet.cellData(address.row, address.col);
    const sheetCache = this.calculationCache.get(sheet);
    const cached = sheetCache?.get(key);
    // Dependency formulas must be traversed under this root. Reusing a result computed at a
    // shallower depth would hide structural depth and launder the root's evaluation fuel.
    if (cached !== undefined && (depth === 0 || !data.formula)) return cached;
    let activeCells = this.calculationStack.get(sheet);
    if (activeCells?.has(key)) return "#CYCLE!";
    if (!data.formula) return data.value;
    if (!activeCells) {
      activeCells = new Set();
      this.calculationStack.set(sheet, activeCells);
    }
    activeCells.add(key);
    let result: FormulaResult;
    try {
      result = evaluateFormula(data.formula, {
        currentSheetName: sheet.name,
        budget,
        getCell: (sheetName, dependencyAddress) => {
          let dependencySheet: Worksheet;
          if (sheetName === sheet.name) {
            dependencySheet = sheet;
          } else {
            try {
              dependencySheet = this.worksheets.getItem(sheetName);
            } catch {
              return "#REF!";
            }
          }
          return this.evaluateCell(dependencySheet, dependencyAddress, budget, depth + 1);
        },
      });
    } finally {
      activeCells.delete(key);
    }
    if (sheetCache) sheetCache.set(key, result);
    else this.calculationCache.set(sheet, new Map([[key, result]]));
    return result;
  }

  private commit(): void {
    this.revisionValue += 1;
    this.calculationRevision = -1;
    const change: WorkbookChange = {
      revision: this.revisionValue,
      sheetIds: [...this.changedSheets].sort(),
      reason: this.pendingReason,
    };
    this.changedSheets.clear();
    this.pendingReason = "content";
    for (const listener of this.listeners) listener(change);
  }
}

const REASON_PRIORITY: Record<WorkbookChange["reason"], number> = {
  content: 0,
  format: 1,
  comment: 2,
  drawing: 3,
  dimension: 4,
  structure: 5,
};

export class WorksheetCollection {
  readonly items: Worksheet[] = [];
  private activeIndex = 0;

  constructor(private readonly workbook: Workbook) {}

  add(name: string): Worksheet {
    snapshotLimit(
      "workbook worksheet count",
      this.items.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.sheets,
    );
    const normalized = validateSheetName(name);
    if (this.items.some((sheet) => sheet.name.toLowerCase() === normalized.toLowerCase())) {
      throw new Error(`Worksheet already exists: ${name}`);
    }
    const sheet = new Worksheet(this.workbook, normalized);
    this.items.push(sheet);
    this.workbook.markChanged(sheet.id, "structure");
    return sheet;
  }

  getItem(nameOrId: string): Worksheet {
    const item = this.items.find(
      (sheet) => sheet.id === nameOrId || sheet.name.toLowerCase() === nameOrId.toLowerCase(),
    );
    if (!item) throw new Error(`Worksheet not found: ${nameOrId}`);
    return item;
  }

  getOrAdd(name: string, options: { renameFirstIfOnlyNewSpreadsheet?: boolean } = {}): Worksheet {
    const existing = this.items.find((sheet) => sheet.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    if (
      options.renameFirstIfOnlyNewSpreadsheet &&
      this.items.length === 1 &&
      this.items[0]?.usedRangeAddress() === null
    ) {
      this.items[0]!.name = validateSheetName(name);
      return this.items[0]!;
    }
    return this.add(name);
  }

  getItemAt(index: number): Worksheet {
    const sheet = this.items[index];
    if (!sheet) throw new Error(`Worksheet index out of range: ${index}`);
    return sheet;
  }

  getActiveWorksheet(): Worksheet {
    const sheet = this.items[this.activeIndex];
    if (!sheet) throw new Error("Workbook has no worksheets");
    return sheet;
  }

  setActiveWorksheet(sheet: Worksheet): void {
    const index = this.items.indexOf(sheet);
    if (index < 0) throw new Error("Worksheet belongs to another workbook");
    this.activeIndex = index;
  }

  restore(serialized: SerializedWorksheet): Worksheet {
    if (this.items.some((sheet) => sheet.name.toLowerCase() === serialized.name.toLowerCase())) {
      throw new Error(`Worksheet already exists: ${serialized.name}`);
    }
    const sheet = new Worksheet(this.workbook, serialized.name, serialized.id);
    this.items.push(sheet);
    sheet.restore(serialized);
    this.workbook.markChanged(sheet.id, "structure");
    return sheet;
  }
}

export class Worksheet {
  readonly id: string;
  showGridLines = true;
  readonly freezePanes: FreezePanes;
  readonly tables: TableCollection;
  readonly charts: ChartCollection;
  readonly sparklineGroups: SparklineGroupCollection;
  /** Skill-compatible alias. */
  readonly sparklines: SparklineGroupCollection;
  readonly shapes: ShapeCollection;
  readonly images: ImageCollection;
  readonly dataValidations: DataValidationCollection;
  readonly conditionalFormattings: ConditionalFormattingCollection;
  private readonly cells = new Map<number, CellData>();
  private readonly merges: RangeAddress[] = [];
  private readonly columnWidths = new Map<number, number>();
  private readonly rowHeights = new Map<number, number>();
  private nameValue: string;

  constructor(
    readonly workbook: Workbook,
    name: string,
    existingId?: string,
  ) {
    this.nameValue = validateSheetName(name);
    this.id = existingId ?? workbook.allocateId("ws", this);
    if (existingId) workbook.registerId(existingId, this);
    this.freezePanes = new FreezePanes(this);
    this.tables = new TableCollection(this);
    this.charts = new ChartCollection(this);
    this.sparklineGroups = new SparklineGroupCollection(this);
    this.sparklines = this.sparklineGroups;
    this.shapes = new ShapeCollection(this);
    this.images = new ImageCollection(this);
    this.dataValidations = new DataValidationCollection(this);
    this.conditionalFormattings = new ConditionalFormattingCollection(this);
  }

  get name(): string {
    return this.nameValue;
  }

  set name(name: string) {
    const normalized = validateSheetName(name);
    if (
      this.workbook.worksheets.items.some(
        (sheet) => sheet !== this && sheet.name.toLowerCase() === normalized.toLowerCase(),
      )
    ) {
      throw new Error(`Worksheet already exists: ${normalized}`);
    }
    if (normalized === this.nameValue) return;
    this.nameValue = normalized;
    this.workbook.markChanged(this.id, "structure");
  }

  getRange(address: string): Range {
    return new Range(this, parseRangeAddress(address));
  }

  getRangeByIndexes(startRow: number, startCol: number, rowCount: number, colCount: number): Range {
    const address = { row: startRow, col: startCol, rowCount, colCount };
    assertRange(address);
    return new Range(this, address);
  }

  getCell(row: number, col: number): Range {
    return this.getRangeByIndexes(row, col, 1, 1);
  }

  getUsedRange(valuesOnly = false): Range | null {
    const address = this.usedRangeAddress(valuesOnly);
    return address ? new Range(this, address) : null;
  }

  mergeCells(address: string): void {
    this.getRange(address).merge();
  }

  unmergeCells(address: string): void {
    this.getRange(address).unmerge();
  }

  deleteAllDrawings(): void {
    this.workbook.transact(() => {
      this.charts.deleteAll();
      this.shapes.deleteAll();
      this.images.deleteAll();
    });
  }

  async fromCSV(
    csvText: string,
    options: { sheetName?: string; delimiter?: string } = {},
  ): Promise<void> {
    if (options.sheetName && options.sheetName !== this.name)
      this.name = validateSheetName(options.sheetName);
    const rows = parseCsv(csvText, options.delimiter ?? ",");
    if (rows.length > 0) this.getRange("A1").writeValues(rectangularize(rows, null));
  }

  cellData(row: number, col: number): Readonly<CellData> {
    return detachCellData(this.cells.get(cellKey(row, col)) ?? DEFAULT_CELL);
  }

  setCell(
    row: number,
    col: number,
    update: Partial<CellData>,
    reason: WorkbookChange["reason"],
  ): void {
    snapshotInteger(row, "cell row", 0, EXCEL_MAX_ROWS - 1);
    snapshotInteger(col, "cell column", 0, EXCEL_MAX_COLUMNS - 1);
    const key = cellKey(row, col);
    const current = this.cells.get(key) ?? DEFAULT_CELL;
    const next = Object.freeze({
      value: update.value === undefined ? current.value : normalizeCellValue(update.value),
      formula:
        update.formula === undefined
          ? current.formula
          : update.formula === null
            ? null
            : normalizeFormula(update.formula, this.workbook.formulaLimits),
      format: update.format === undefined ? current.format : normalizeCellFormat(update.format),
    }) satisfies CellData;
    const empty =
      next.value === null &&
      next.formula === null &&
      (next.format === DEFAULT_CELL.format || Object.keys(next.format).length === 0);
    if (!empty && !this.cells.has(key)) {
      if (this.cells.size >= SPREADSHEET_SNAPSHOT_LIMITS.cellsPerSheet) {
        throw new ArtifactLimitError(
          "worksheet cell count",
          this.cells.size + 1,
          SPREADSHEET_SNAPSHOT_LIMITS.cellsPerSheet,
        );
      }
      this.workbook[RESERVE_WORKBOOK_RESOURCE]("cells");
    }
    if (empty) {
      if (this.cells.delete(key)) {
        this.workbook[RELEASE_WORKBOOK_RESOURCE]("cells");
      }
    } else this.cells.set(key, next);
    this.workbook.markChanged(this.id, reason);
  }

  *cellEntries(): IterableIterator<{
    row: number;
    col: number;
    data: CellData;
  }> {
    for (const [key, data] of this.cells) {
      yield {
        row: Math.floor(key / 16_384),
        col: key % 16_384,
        data: detachCellData(data),
      };
    }
  }

  [STORED_CELL_ENTRIES](): IterableIterator<[number, CellData]> {
    return this.cells.entries();
  }

  usedRangeAddress(valuesOnly = false): RangeAddress | null {
    let minRow = Number.POSITIVE_INFINITY;
    let minCol = Number.POSITIVE_INFINITY;
    let maxRow = -1;
    let maxCol = -1;
    for (const { row, col, data } of this.cellEntries()) {
      if (valuesOnly && data.value === null && data.formula === null) continue;
      minRow = Math.min(minRow, row);
      minCol = Math.min(minCol, col);
      maxRow = Math.max(maxRow, row);
      maxCol = Math.max(maxCol, col);
    }
    if (maxRow < 0) return null;
    return {
      row: minRow,
      col: minCol,
      rowCount: maxRow - minRow + 1,
      colCount: maxCol - minCol + 1,
    };
  }

  formulaCount(): number {
    let count = 0;
    for (const { data } of this.cellEntries()) if (data.formula) count += 1;
    return count;
  }

  addMerge(address: RangeAddress): void {
    assertRange(address);
    snapshotLimit(
      "worksheet merge count",
      this.merges.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.mergesPerSheet,
    );
    if (this.merges.some((merge) => rangesOverlap(merge, address))) {
      throw new Error(`Merge overlaps an existing merge: ${formatRangeAddress(address)}`);
    }
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("merges");
    this.merges.push({ ...address });
    this.workbook.markChanged(this.id, "structure");
  }

  removeMergesOverlapping(address: RangeAddress): void {
    let write = 0;
    for (const merge of this.merges) {
      if (!rangesOverlap(merge, address)) this.merges[write++] = merge;
    }
    if (write !== this.merges.length) {
      this.workbook[RELEASE_WORKBOOK_RESOURCE]("merges", this.merges.length - write);
      this.merges.length = write;
      this.workbook.markChanged(this.id, "structure");
    }
  }

  mergeRegions(): readonly RangeAddress[] {
    return this.merges.map((merge) => ({ ...merge }));
  }

  setColumnWidth(col: number, width: number): void {
    snapshotInteger(col, "column index", 0, EXCEL_MAX_COLUMNS - 1);
    snapshotFiniteNumber(width, "column width", {
      minimum: SPREADSHEET_SNAPSHOT_LIMITS.dimensionValueMinimum,
      maximum: SPREADSHEET_SNAPSHOT_LIMITS.dimensionValue,
    });
    if (!this.columnWidths.has(col)) this.assertDimensionCapacity();
    this.columnWidths.set(col, width);
    this.workbook.markChanged(this.id, "dimension");
  }

  columnWidth(col: number): number {
    return this.columnWidths.get(col) ?? DEFAULT_COLUMN_WIDTH;
  }

  get defaultColumnWidth(): number {
    return DEFAULT_COLUMN_WIDTH;
  }

  *columnWidthEntries(): IterableIterator<readonly [number, number]> {
    for (const [col, width] of this.columnWidths) yield [col, width] as const;
  }

  setRowHeight(row: number, height: number): void {
    snapshotInteger(row, "row index", 0, EXCEL_MAX_ROWS - 1);
    snapshotFiniteNumber(height, "row height", {
      minimum: SPREADSHEET_SNAPSHOT_LIMITS.dimensionValueMinimum,
      maximum: SPREADSHEET_SNAPSHOT_LIMITS.dimensionValue,
    });
    if (!this.rowHeights.has(row)) this.assertDimensionCapacity();
    this.rowHeights.set(row, height);
    this.workbook.markChanged(this.id, "dimension");
  }

  rowHeight(row: number): number {
    return this.rowHeights.get(row) ?? DEFAULT_ROW_HEIGHT;
  }

  get defaultRowHeight(): number {
    return DEFAULT_ROW_HEIGHT;
  }

  *rowHeightEntries(): IterableIterator<readonly [number, number]> {
    for (const [row, height] of this.rowHeights) yield [row, height] as const;
  }

  private assertDimensionCapacity(): void {
    snapshotLimit(
      "worksheet dimension override count",
      this.columnWidths.size + this.rowHeights.size + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.dimensionOverridesPerSheet,
    );
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("dimensionOverrides");
  }

  serialize(): SerializedWorksheet {
    return {
      id: this.id,
      name: this.name,
      showGridLines: this.showGridLines,
      freezePanes: this.freezePanes.snapshot(),
      cells: [...this.cellEntries()].map(({ row, col, data }) => ({
        row,
        col,
        value: serializeCellValue(data.value),
        formula: data.formula,
        format: data.format,
      })),
      merges: this.merges.map((merge) => ({ ...merge })),
      columnWidths: [...this.columnWidths],
      rowHeights: [...this.rowHeights],
      tables: this.tables.items.map((table) => table.serialize()),
      charts: this.charts.items.map((chart) => chart.serialize()),
      sparklines: this.sparklineGroups.items.map((group) => group.serialize()),
      dataValidations: this.dataValidations.serialize(),
      conditionalFormattings: this.conditionalFormattings.serialize(),
      images: this.images.items.map((image) => image.config),
    };
  }

  restore(serialized: SerializedWorksheet): void {
    this.showGridLines = serialized.showGridLines;
    this.freezePanes.restore(serialized.freezePanes);
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("cells", serialized.cells.length);
    for (const cell of serialized.cells) {
      this.cells.set(
        cellKey(cell.row, cell.col),
        Object.freeze({
          value: reviveValue(cell.value),
          formula: cell.formula
            ? normalizeFormula(cell.formula, this.workbook.formulaLimits)
            : null,
          format: normalizeCellFormat(cell.format),
        }),
      );
    }
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("merges", serialized.merges.length);
    this.merges.push(...serialized.merges.map((merge) => ({ ...merge })));
    this.workbook[RESERVE_WORKBOOK_RESOURCE](
      "dimensionOverrides",
      serialized.columnWidths.length + serialized.rowHeights.length,
    );
    for (const [col, width] of serialized.columnWidths) this.columnWidths.set(col, width);
    for (const [row, height] of serialized.rowHeights) this.rowHeights.set(row, height);
    for (const table of serialized.tables) this.tables.restore(table);
    for (const chart of serialized.charts) this.charts.restore(chart);
    this.dataValidations.restore(serialized.dataValidations ?? []);
    this.conditionalFormattings.restore(serialized.conditionalFormattings ?? []);
    for (const image of serialized.images) this.images.add(image);
  }

  restoreSparklines(serialized: readonly SerializedSparklineGroup[]): void {
    for (const group of serialized) this.sparklineGroups.restore(group);
  }
}

export class Range {
  readonly address: RangeAddress;
  readonly conditionalFormats: RangeConditionalFormats;
  readonly sparklines: RangeSparklines;

  constructor(
    readonly worksheet: Worksheet,
    address: RangeAddress,
  ) {
    assertRange(address);
    this.address = Object.freeze({ ...address });
    this.conditionalFormats = new RangeConditionalFormats(this);
    this.sparklines = new RangeSparklines(this);
  }

  get values(): Matrix<FormulaResult> {
    return matrix(this.address.rowCount, this.address.colCount, (relativeRow, relativeCol) =>
      this.worksheet.workbook.valueAt(this.worksheet, {
        row: this.address.row + relativeRow,
        col: this.address.col + relativeCol,
      }),
    );
  }

  set values(values: Matrix<CellValue>) {
    assertMatrixShape(values, this.address.rowCount, this.address.colCount);
    // Validate the complete batch before mutation. Stored values are copied again at the boundary,
    // avoiding a second full matrix allocation for large primitive writes.
    for (const row of values) {
      for (const value of row) normalizeCellValue(value);
    }
    this.worksheet.workbook.transact(() => {
      eachCell(this.address, (row, col, relativeRow, relativeCol) => {
        this.worksheet.setCell(
          row,
          col,
          {
            value: values[relativeRow]![relativeCol]!,
            formula: null,
          },
          "content",
        );
      });
    });
  }

  get formulas(): Matrix<string | null> {
    return matrix(
      this.address.rowCount,
      this.address.colCount,
      (relativeRow, relativeCol) =>
        this.worksheet.cellData(this.address.row + relativeRow, this.address.col + relativeCol)
          .formula,
    );
  }

  set formulas(formulas: Matrix<string | null>) {
    assertMatrixShape(formulas, this.address.rowCount, this.address.colCount);
    // Validate the full batch before the first mutation so a later rejected formula cannot leave
    // a partially written range.
    const normalized = formulas.map((row) =>
      row.map((formula) =>
        formula ? normalizeFormula(formula, this.worksheet.workbook.formulaLimits) : null,
      ),
    );
    this.worksheet.workbook.transact(() => {
      eachCell(this.address, (row, col, relativeRow, relativeCol) => {
        const formula = normalized[relativeRow]![relativeCol]!;
        this.worksheet.setCell(row, col, { formula, value: null }, "content");
      });
    });
  }

  get formulasR1C1(): Matrix<string | null> {
    return this.formulas.map((row, relativeRow) =>
      row.map((formula, relativeCol) =>
        formula
          ? formulaToR1C1(formula, {
              row: this.address.row + relativeRow,
              col: this.address.col + relativeCol,
            })
          : null,
      ),
    );
  }

  set formulasR1C1(formulas: Matrix<string | null>) {
    assertMatrixShape(formulas, this.address.rowCount, this.address.colCount);
    const converted = formulas.map((row, relativeRow) =>
      row.map((formula, relativeCol) =>
        formula
          ? formulaFromR1C1(formula, {
              row: this.address.row + relativeRow,
              col: this.address.col + relativeCol,
            })
          : null,
      ),
    );
    this.formulas = converted;
  }

  get displayFormulas(): Matrix<string | null> {
    return this.formulas;
  }

  get formulaInfos(): Matrix<Record<string, unknown> | null> {
    return this.formulas.map((row) =>
      row.map((formula) =>
        formula ? { formula, references: referencesInFormula(formula) } : null,
      ),
    );
  }

  get format(): RangeFormat {
    return new RangeFormat(this);
  }

  set format(value: CellFormat) {
    this.applyFormat(value);
  }

  get dataValidation(): DataValidationConfig | null {
    return this.worksheet.dataValidations.get(this.address);
  }

  set dataValidation(config: DataValidationConfig | null) {
    if (config)
      this.worksheet.dataValidations.add({
        range: formatRangeAddress(this.address),
        rule: config.rule,
      });
    else this.worksheet.dataValidations.remove(this.address);
  }

  write(input: Matrix<CellValue> | RangeWritePayload): Range {
    if (Array.isArray(input)) return this.writeValues(input);
    const fields = (["values", "formulas", "formulasR1C1"] as const).filter(
      (field) => input[field] !== undefined,
    );
    if (fields.length !== 1) {
      throw new Error("Range.write expects exactly one of: values, formulas, formulasR1C1");
    }
    const field = fields[0]!;
    const data = input[field]!;
    const rowCount = data.length;
    const colCount = assertRectangularMatrix(data);
    if (rowCount === 0 || colCount === 0) return this;
    const target = this.resize(rowCount, colCount);
    if (field === "values") target.values = data as Matrix<CellValue>;
    else if (field === "formulas") target.formulas = data as Matrix<string | null>;
    else target.formulasR1C1 = data as Matrix<string | null>;
    return target;
  }

  writeValues(values: Matrix<CellValue>): Range {
    const colCount = assertRectangularMatrix(values);
    if (values.length === 0 || colCount === 0) return this;
    const target = this.resize(values.length, colCount);
    target.values = values;
    return target;
  }

  fillDown(): void {
    this.worksheet.workbook.transact(() => {
      for (let col = 0; col < this.address.colCount; col += 1) {
        const source = this.worksheet.cellData(this.address.row, this.address.col + col);
        for (let row = 1; row < this.address.rowCount; row += 1) {
          this.worksheet.setCell(
            this.address.row + row,
            this.address.col + col,
            {
              value: source.formula ? null : source.value,
              formula: source.formula ? translateFormula(source.formula, row, 0) : null,
              format: structuredClone(source.format),
            },
            "content",
          );
        }
      }
    });
  }

  fillRight(): void {
    this.worksheet.workbook.transact(() => {
      for (let row = 0; row < this.address.rowCount; row += 1) {
        const source = this.worksheet.cellData(this.address.row + row, this.address.col);
        for (let col = 1; col < this.address.colCount; col += 1) {
          this.worksheet.setCell(
            this.address.row + row,
            this.address.col + col,
            {
              value: source.formula ? null : source.value,
              formula: source.formula ? translateFormula(source.formula, 0, col) : null,
              format: structuredClone(source.format),
            },
            "content",
          );
        }
      }
    });
  }

  clear(options: { applyTo?: "contents" | "formats" | "all" } = {}): void {
    const applyTo = options.applyTo ?? "all";
    this.worksheet.workbook.transact(() => {
      eachCell(this.address, (row, col) => {
        const data = this.worksheet.cellData(row, col);
        this.worksheet.setCell(
          row,
          col,
          {
            value: applyTo === "formats" ? data.value : null,
            formula: applyTo === "formats" ? data.formula : null,
            format: applyTo === "contents" ? data.format : {},
          },
          applyTo === "formats" ? "format" : "content",
        );
      });
    });
  }

  copyFrom(source: Range, mode: "values" | "formulas" | "all" = "all"): void {
    assertSameShape(this.address, source.address);
    const sourceCells = matrix(
      this.address.rowCount,
      this.address.colCount,
      (relativeRow, relativeCol) =>
        source.worksheet.cellData(
          source.address.row + relativeRow,
          source.address.col + relativeCol,
        ),
    );
    const sourceValues =
      mode === "values"
        ? matrix(this.address.rowCount, this.address.colCount, (relativeRow, relativeCol) =>
            source.worksheet.workbook.valueAt(source.worksheet, {
              row: source.address.row + relativeRow,
              col: source.address.col + relativeCol,
            }),
          )
        : null;
    const rowDelta = this.address.row - source.address.row;
    const colDelta = this.address.col - source.address.col;
    this.worksheet.workbook.transact(() => {
      eachCell(this.address, (row, col, relativeRow, relativeCol) => {
        const sourceCell = sourceCells[relativeRow]![relativeCol]!;
        const current = this.worksheet.cellData(row, col);
        const translatedFormula = sourceCell.formula
          ? translateFormula(sourceCell.formula, rowDelta, colDelta)
          : null;
        this.worksheet.setCell(
          row,
          col,
          mode === "values"
            ? {
                value: sourceValues![relativeRow]![relativeCol]!,
                formula: null,
              }
            : mode === "formulas"
              ? {
                  value: translatedFormula ? null : current.value,
                  formula: translatedFormula,
                }
              : {
                  value: sourceCell.value,
                  formula: translatedFormula,
                  format: structuredClone(sourceCell.format),
                },
          mode === "all" ? "format" : "content",
        );
      });
    });
  }

  copyTo(destination: Range, mode: "values" | "formulas" | "all" = "all"): void {
    destination.copyFrom(this, mode);
  }

  offset(rowOffset: number, colOffset: number): Range {
    return this.worksheet.getRangeByIndexes(
      this.address.row + rowOffset,
      this.address.col + colOffset,
      this.address.rowCount,
      this.address.colCount,
    );
  }

  resize(rowCount: number, colCount: number): Range {
    return this.worksheet.getRangeByIndexes(this.address.row, this.address.col, rowCount, colCount);
  }

  getCurrentRegion(): Range {
    const used = this.worksheet.usedRangeAddress();
    return used ? new Range(this.worksheet, used) : this;
  }

  getRow(index: number): Range {
    return this.worksheet.getRangeByIndexes(
      this.address.row + index,
      this.address.col,
      1,
      this.address.colCount,
    );
  }

  getColumn(index: number): Range {
    return this.worksheet.getRangeByIndexes(
      this.address.row,
      this.address.col + index,
      this.address.rowCount,
      1,
    );
  }

  getRangeByIndexes(startRow: number, startCol: number, rowCount: number, colCount: number): Range {
    return this.worksheet.getRangeByIndexes(
      this.address.row + startRow,
      this.address.col + startCol,
      rowCount,
      colCount,
    );
  }

  getCell(row: number, col: number): Range {
    return this.getRangeByIndexes(row, col, 1, 1);
  }

  merge(across = false): void {
    if (!across) {
      this.worksheet.addMerge(this.address);
      return;
    }
    this.worksheet.workbook.transact(() => {
      for (let row = 0; row < this.address.rowCount; row += 1) {
        this.worksheet.addMerge({
          row: this.address.row + row,
          col: this.address.col,
          rowCount: 1,
          colCount: this.address.colCount,
        });
      }
    });
  }

  unmerge(): void {
    this.worksheet.removeMergesOverlapping(this.address);
  }

  setNumberFormat(format: string): void {
    this.format.numberFormat = format;
  }

  applyFormat(format: CellFormat): void {
    this.worksheet.workbook.transact(() => {
      eachCell(this.address, (row, col) => {
        const current = this.worksheet.cellData(row, col);
        this.worksheet.setCell(
          row,
          col,
          { format: mergeCellFormat(current.format, format) },
          "format",
        );
      });
    });
  }
}

export class RangeFormat {
  constructor(private readonly range: Range) {}

  set fill(value: string | undefined) {
    this.range.applyFormat(value === undefined ? {} : { fill: value });
  }
  set font(value: CellFormat["font"]) {
    this.range.applyFormat(value === undefined ? {} : { font: value });
  }
  set numberFormat(value: string | Matrix<string>) {
    if (typeof value === "string") {
      this.range.applyFormat({ numberFormat: value });
      return;
    }
    assertMatrixShape(value, this.range.address.rowCount, this.range.address.colCount);
    this.range.worksheet.workbook.transact(() => {
      eachCell(this.range.address, (row, col, relativeRow, relativeCol) => {
        const data = this.range.worksheet.cellData(row, col);
        this.range.worksheet.setCell(
          row,
          col,
          {
            format: mergeCellFormat(data.format, {
              numberFormat: value[relativeRow]![relativeCol]!,
            }),
          },
          "format",
        );
      });
    });
  }
  set borders(value: CellFormat["borders"]) {
    this.range.applyFormat(value === undefined ? {} : { borders: value });
  }
  set horizontalAlignment(value: CellFormat["horizontalAlignment"]) {
    this.range.applyFormat(value === undefined ? {} : { horizontalAlignment: value });
  }
  set verticalAlignment(value: CellFormat["verticalAlignment"]) {
    this.range.applyFormat(value === undefined ? {} : { verticalAlignment: value });
  }
  set wrapText(value: boolean | undefined) {
    this.range.applyFormat(value === undefined ? {} : { wrapText: value });
  }

  set columnWidth(value: number) {
    for (
      let col = this.range.address.col;
      col < this.range.address.col + this.range.address.colCount;
      col += 1
    ) {
      this.range.worksheet.setColumnWidth(col, value * 7);
    }
  }

  set columnWidthPx(value: number) {
    for (
      let col = this.range.address.col;
      col < this.range.address.col + this.range.address.colCount;
      col += 1
    ) {
      this.range.worksheet.setColumnWidth(col, value);
    }
  }

  set rowHeight(value: number) {
    for (
      let row = this.range.address.row;
      row < this.range.address.row + this.range.address.rowCount;
      row += 1
    ) {
      this.range.worksheet.setRowHeight(row, value * (4 / 3));
    }
  }

  set rowHeightPx(value: number) {
    for (
      let row = this.range.address.row;
      row < this.range.address.row + this.range.address.rowCount;
      row += 1
    ) {
      this.range.worksheet.setRowHeight(row, value);
    }
  }

  autofitColumns(): void {
    for (
      let col = this.range.address.col;
      col < this.range.address.col + this.range.address.colCount;
      col += 1
    ) {
      let maxLength = 1;
      for (
        let row = this.range.address.row;
        row < this.range.address.row + this.range.address.rowCount;
        row += 1
      ) {
        const value = this.range.worksheet.workbook.valueAt(this.range.worksheet, { row, col });
        maxLength = Math.max(maxLength, String(value ?? "").length);
      }
      this.range.worksheet.setColumnWidth(col, Math.min(480, Math.max(48, maxLength * 7.6 + 20)));
    }
  }

  autofitRows(): void {
    for (
      let row = this.range.address.row;
      row < this.range.address.row + this.range.address.rowCount;
      row += 1
    ) {
      this.range.worksheet.setRowHeight(row, 24);
    }
  }
}

export class FreezePanes {
  private rows = 0;
  private columns = 0;
  constructor(private readonly worksheet: Worksheet) {}
  freezeRows(count: number): void {
    this.rows = snapshotInteger(count, "frozen row count", 0, EXCEL_MAX_ROWS);
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
  }
  freezeColumns(count: number): void {
    this.columns = snapshotInteger(count, "frozen column count", 0, EXCEL_MAX_COLUMNS);
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
  }
  unfreeze(): void {
    this.rows = 0;
    this.columns = 0;
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
  }
  snapshot(): { rows: number; columns: number } {
    return { rows: this.rows, columns: this.columns };
  }
  restore(value: { rows: number; columns: number }): void {
    this.rows = snapshotInteger(value.rows, "restored frozen row count", 0, EXCEL_MAX_ROWS);
    this.columns = snapshotInteger(
      value.columns,
      "restored frozen column count",
      0,
      EXCEL_MAX_COLUMNS,
    );
  }
}

export class TableCollection {
  readonly items: Table[] = [];
  constructor(private readonly worksheet: Worksheet) {}
  add(range: string | Range, hasHeaders: boolean, name: string): Table {
    snapshotLimit(
      "worksheet table count",
      this.items.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.tablesPerSheet,
    );
    const normalizedName = validateTableName(name);
    const address = typeof range === "string" ? parseRangeAddress(range) : range.address;
    if (this.items.some((table) => rangesOverlap(table.range.address, address)))
      throw new Error("Table overlaps an existing table");
    if (this.items.some((table) => table.name.toLowerCase() === normalizedName.toLowerCase()))
      throw new Error(`Duplicate table name: ${normalizedName}`);
    this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("tables");
    let table: Table;
    try {
      table = new Table(this.worksheet, normalizedName, address, hasHeaders);
    } catch (cause) {
      this.worksheet.workbook[RELEASE_WORKBOOK_RESOURCE]("tables");
      throw cause;
    }
    this.items.push(table);
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
    return table;
  }
  remove(table: Table): void {
    const index = this.items.indexOf(table);
    if (index >= 0) {
      this.items.splice(index, 1);
      this.worksheet.workbook[RELEASE_WORKBOOK_RESOURCE]("tables");
      this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
    }
  }
  restore(serialized: SerializedTable): void {
    this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("tables");
    this.items.push(
      new Table(
        this.worksheet,
        serialized.name,
        serialized.range,
        serialized.hasHeaders,
        serialized,
      ),
    );
  }
}

export class Table {
  readonly id: string;
  private rangeValue: Range;
  private nameValue: string;
  private styleValue = "TableStyleMedium2";
  showHeaders = true;
  showTotals = false;
  showBandedColumns = false;
  showFilterButton = true;
  readonly rows: {
    add: (index: number | null, rows: Matrix<CellValue>) => void;
  };

  constructor(
    private readonly worksheet: Worksheet,
    name: string,
    address: RangeAddress,
    readonly hasHeaders: boolean,
    restore?: SerializedTable,
  ) {
    this.nameValue = validateTableName(name);
    this.rangeValue = new Range(worksheet, address);
    this.id = restore?.id ?? worksheet.workbook.allocateId("tb", this);
    if (restore) {
      worksheet.workbook.registerId(restore.id, this);
      this.styleValue = normalizeLiveString(restore.style, "table style");
      this.showHeaders = restore.showHeaders;
      this.showTotals = restore.showTotals;
      this.showBandedColumns = restore.showBandedColumns;
      this.showFilterButton = restore.showFilterButton;
    }
    this.rows = { add: (_index, rows) => this.addRows(rows) };
  }

  get name(): string {
    return this.nameValue;
  }
  set name(value: string) {
    const normalized = validateTableName(value);
    if (
      this.worksheet.tables.items.some(
        (table) => table !== this && table.name.toLowerCase() === normalized.toLowerCase(),
      )
    ) {
      throw new Error(`Duplicate table name: ${normalized}`);
    }
    if (normalized === this.nameValue) return;
    this.nameValue = normalized;
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
  }
  get range(): Range {
    return this.rangeValue;
  }
  set range(value: Range) {
    if (!(value instanceof Range) || value.worksheet !== this.worksheet) {
      throw new Error("Table range must belong to its worksheet");
    }
    if (
      this.worksheet.tables.items.some(
        (table) => table !== this && rangesOverlap(table.range.address, value.address),
      )
    ) {
      throw new Error("Table overlaps an existing table");
    }
    this.rangeValue = value;
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
  }
  get style(): string {
    return this.styleValue;
  }
  set style(value: string) {
    const normalized = normalizeLiveString(value, "table style");
    if (normalized === this.styleValue) return;
    this.styleValue = normalized;
    this.worksheet.workbook.markChanged(this.worksheet.id, "format");
  }

  getDataRows(): Range {
    const headerRows = this.hasHeaders ? 1 : 0;
    const totalRows = this.showTotals ? 1 : 0;
    return this.worksheet.getRangeByIndexes(
      this.range.address.row + headerRows,
      this.range.address.col,
      Math.max(1, this.range.address.rowCount - headerRows - totalRows),
      this.range.address.colCount,
    );
  }
  getHeaderRowRange(): Range {
    return this.worksheet.getRangeByIndexes(
      this.range.address.row,
      this.range.address.col,
      1,
      this.range.address.colCount,
    );
  }
  delete(): void {
    this.worksheet.tables.remove(this);
  }
  inspectRecord(): Record<string, unknown> {
    return {
      kind: "table",
      id: this.id,
      sheetId: this.worksheet.id,
      name: this.name,
      range: formatRangeAddress(this.range.address),
      style: this.style,
    };
  }
  serialize(): SerializedTable {
    return {
      id: this.id,
      name: this.name,
      range: this.range.address,
      hasHeaders: this.hasHeaders,
      style: this.style,
      showHeaders: this.showHeaders,
      showTotals: this.showTotals,
      showBandedColumns: this.showBandedColumns,
      showFilterButton: this.showFilterButton,
    };
  }
  private addRows(rows: Matrix<CellValue>): void {
    if (rows.length === 0) return;
    assertMatrixShape(rows, rows.length, this.range.address.colCount);
    const insertionRow =
      this.range.address.row + this.range.address.rowCount - (this.showTotals ? 1 : 0);
    this.worksheet.getRangeByIndexes(
      insertionRow,
      this.range.address.col,
      rows.length,
      this.range.address.colCount,
    ).values = rows;
    this.rangeValue = this.worksheet.getRangeByIndexes(
      this.range.address.row,
      this.range.address.col,
      this.range.address.rowCount + rows.length,
      this.range.address.colCount,
    );
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
  }
}

export class ChartCollection {
  readonly items: SpreadsheetChart[] = [];
  constructor(private readonly worksheet: Worksheet) {}
  add(
    type: SpreadsheetChartType,
    sourceOrConfig?: Range | SpreadsheetChartConfig,
  ): SpreadsheetChart {
    snapshotLimit(
      "worksheet chart count",
      this.items.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.chartsPerSheet,
    );
    this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("charts");
    let chart: SpreadsheetChart;
    try {
      chart = new SpreadsheetChart(this.worksheet, type, sourceOrConfig);
      chart.series.attach();
    } catch (cause) {
      this.worksheet.workbook[RELEASE_WORKBOOK_RESOURCE]("charts");
      throw cause;
    }
    this.items.push(chart);
    this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
    return chart;
  }
  getItemOrNullObject(name: string): SpreadsheetChart | null {
    return this.items.find((chart) => chart.name === name) ?? null;
  }
  deleteAll(): void {
    if (this.items.length > 0) {
      for (const chart of this.items) chart.series.detach();
      this.worksheet.workbook[RELEASE_WORKBOOK_RESOURCE]("charts", this.items.length);
      this.items.length = 0;
      this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
    }
  }
  restore(serialized: SerializedChart): void {
    this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("charts");
    const chart = new SpreadsheetChart(this.worksheet, serialized.type, serialized);
    chart.series.attach();
    this.items.push(chart);
  }
}

export class SpreadsheetChart {
  readonly id: string;
  readonly name: string;
  type: SpreadsheetChartType;
  private titleValue = "";
  hasLegend = true;
  xAxis: Record<string, unknown> = {};
  yAxis: Record<string, unknown> = {};
  readonly titleTextStyle: Record<string, unknown> = {};
  readonly series: ChartSeriesCollection;
  sourceRange: Range | null = null;
  private positionValue: {
    from: RangeAddress;
    to: RangeAddress;
  } | null = null;

  constructor(
    private readonly worksheet: Worksheet,
    type: SpreadsheetChartType,
    sourceOrConfig?: Range | SpreadsheetChartConfig | SerializedChart,
  ) {
    this.type = type;
    const restored = isSerializedChart(sourceOrConfig) ? sourceOrConfig : null;
    this.id = restored?.id ?? worksheet.workbook.allocateId("ch", this);
    if (restored) worksheet.workbook.registerId(restored.id, this);
    this.name = restored?.name ?? `Chart ${worksheet.charts.items.length + 1}`;
    this.series = new ChartSeriesCollection(worksheet.workbook);
    if (sourceOrConfig instanceof Range) this.setData(sourceOrConfig);
    else if (restored) {
      this.titleValue = normalizeLiveString(restored.title, "chart title");
      this.hasLegend = restored.hasLegend;
      this.sourceRange = restored.sourceRange ? new Range(worksheet, restored.sourceRange) : null;
      this.positionValue = normalizeChartPosition(restored.position);
      for (const series of restored.series) this.series.add(series.name, series);
    } else if (sourceOrConfig) {
      this.titleValue = normalizeLiveString(sourceOrConfig.title ?? "", "chart title");
      this.hasLegend = sourceOrConfig.hasLegend ?? true;
      for (const series of sourceOrConfig.series ?? []) this.series.add(series.name, series);
    }
  }

  get title(): string {
    return this.titleValue;
  }
  set title(value: string) {
    const normalized = normalizeLiveString(value, "chart title");
    if (normalized === this.titleValue) return;
    this.titleValue = normalized;
    this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
  }
  get position(): { from: RangeAddress; to: RangeAddress } | null {
    return this.positionValue
      ? {
          from: { ...this.positionValue.from },
          to: { ...this.positionValue.to },
        }
      : null;
  }
  set position(value: { from: RangeAddress; to: RangeAddress } | null) {
    this.positionValue = normalizeChartPosition(value);
    this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
  }

  setPosition(from: string, to: string): void {
    this.positionValue = {
      from: parseRangeAddress(from),
      to: parseRangeAddress(to),
    };
    this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
  }
  setData(range: Range): void {
    this.sourceRange = range;
    this.series.clear();
    this.inferSeries(range);
    this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
  }
  inspectRecord(): Record<string, unknown> {
    return {
      kind: "drawing",
      objectKind: "chart",
      id: this.id,
      sheetId: this.worksheet.id,
      name: this.name,
      chartType: this.type,
      title: this.titleValue,
      sourceRange: this.sourceRange ? formatRangeAddress(this.sourceRange.address) : null,
    };
  }
  serialize(): SerializedChart {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      title: this.titleValue,
      hasLegend: this.hasLegend,
      sourceRange: this.sourceRange?.address ?? null,
      series: this.series.items.map((series) => series.toJSON()),
      position: this.position,
    };
  }

  private inferSeries(range: Range): void {
    const values = range.values;
    if (values.length < 2 || (values[0]?.length ?? 0) < 2) return;
    const firstRow = values[0]!;
    for (let col = 1; col < firstRow.length; col += 1) {
      const name = String(firstRow[col] ?? `Series ${col}`);
      const series = this.series.add(name);
      series.categoryFormula = `${quoteSheetName(range.worksheet.name)}!$${formatCellAddress({ row: range.address.row + 1, col: range.address.col }).replace(/([A-Z]+)(\d+)/, "$1$$$2")}:$${formatCellAddress({ row: range.address.row + range.address.rowCount - 1, col: range.address.col }).replace(/([A-Z]+)(\d+)/, "$1$$$2")}`;
      series.formula = `${quoteSheetName(range.worksheet.name)}!$${formatCellAddress({ row: range.address.row + 1, col: range.address.col + col }).replace(/([A-Z]+)(\d+)/, "$1$$$2")}:$${formatCellAddress({ row: range.address.row + range.address.rowCount - 1, col: range.address.col + col }).replace(/([A-Z]+)(\d+)/, "$1$$$2")}`;
      series.categories = values.slice(1).map((row) => String(row[0] ?? ""));
      series.values = values.slice(1).map((row) => {
        const value = Number(row[col] ?? 0);
        return Number.isFinite(value) ? value : 0;
      });
    }
  }
}

export class ChartSeriesCollection {
  readonly items: SpreadsheetChartSeries[] = [];
  private attached = false;
  constructor(private readonly workbook: Workbook) {}
  add(name: string, config: Partial<SpreadsheetChartSeriesConfig> = {}): SpreadsheetChartSeries {
    const series = new SpreadsheetChartSeries(name, config);
    if (this.attached) {
      this.workbook[RESERVE_WORKBOOK_RESOURCE]("chartSeries");
      try {
        this.workbook[RESERVE_WORKBOOK_RESOURCE]("chartPoints", series.pointCount);
      } catch (cause) {
        this.workbook[RELEASE_WORKBOOK_RESOURCE]("chartSeries");
        throw cause;
      }
    }
    series[CONNECT_CHART_POINT_COUNTER]((delta) => this.adjustPoints(delta));
    this.items.push(series);
    return series;
  }
  clear(): void {
    if (this.attached && this.items.length > 0) {
      this.workbook[RELEASE_WORKBOOK_RESOURCE]("chartSeries", this.items.length);
      this.workbook[RELEASE_WORKBOOK_RESOURCE](
        "chartPoints",
        this.items.reduce((count, series) => count + series.pointCount, 0),
      );
    }
    this.items.length = 0;
  }
  attach(): void {
    if (this.attached) return;
    const points = this.items.reduce((count, series) => count + series.pointCount, 0);
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("chartSeries", this.items.length);
    try {
      this.workbook[RESERVE_WORKBOOK_RESOURCE]("chartPoints", points);
    } catch (cause) {
      this.workbook[RELEASE_WORKBOOK_RESOURCE]("chartSeries", this.items.length);
      throw cause;
    }
    this.attached = true;
  }
  detach(): void {
    if (!this.attached) return;
    this.workbook[RELEASE_WORKBOOK_RESOURCE]("chartSeries", this.items.length);
    this.workbook[RELEASE_WORKBOOK_RESOURCE](
      "chartPoints",
      this.items.reduce((count, series) => count + series.pointCount, 0),
    );
    this.attached = false;
  }
  private adjustPoints(delta: number): void {
    if (!this.attached || delta === 0) return;
    if (delta > 0) {
      this.workbook[RESERVE_WORKBOOK_RESOURCE]("chartPoints", delta);
    } else {
      this.workbook[RELEASE_WORKBOOK_RESOURCE]("chartPoints", -delta);
    }
  }
}

export class SpreadsheetChartSeries {
  private nameValue = "";
  private formulaValue: string | undefined;
  private categoryFormulaValue: string | undefined;
  private valuesValue: number[] | undefined;
  private categoriesValue: Array<string | number> | undefined;
  private fillValue: string | undefined;
  private onPointCountChange: (delta: number) => void = () => {};

  constructor(name: string, config: Partial<SpreadsheetChartSeriesConfig> = {}) {
    const record = snapshotRecord(
      config,
      "chart series",
      [],
      ["name", "formula", "categoryFormula", "values", "categories", "fill"],
    );
    this.name = name;
    if (record.formula !== undefined) this.formula = record.formula as string;
    if (record.categoryFormula !== undefined) {
      this.categoryFormula = record.categoryFormula as string;
    }
    if (record.values !== undefined) this.values = record.values as number[];
    if (record.categories !== undefined) {
      this.categories = record.categories as Array<string | number>;
    }
    if (record.fill !== undefined) this.fill = record.fill as string;
  }

  get name(): string {
    return this.nameValue;
  }
  set name(value: string) {
    this.nameValue = normalizeLiveString(value, "chart series name");
  }
  get formula(): string | undefined {
    return this.formulaValue;
  }
  set formula(value: string | undefined) {
    this.formulaValue = normalizeLiveFormula(value, "chart series formula");
  }
  get categoryFormula(): string | undefined {
    return this.categoryFormulaValue;
  }
  set categoryFormula(value: string | undefined) {
    this.categoryFormulaValue = normalizeLiveFormula(value, "chart series category formula");
  }
  get values(): number[] | undefined {
    return this.valuesValue?.slice();
  }
  set values(value: number[] | undefined) {
    if (value === undefined) {
      this.onPointCountChange(-(this.valuesValue?.length ?? 0));
      this.valuesValue = undefined;
      return;
    }
    const entries = snapshotArray(
      value,
      "chart series values",
      SPREADSHEET_SNAPSHOT_LIMITS.chartPointsTotal,
    );
    const normalized = entries.map((entry, index) =>
      snapshotFiniteNumber(entry, `chart series values[${index}]`),
    );
    if (this.categoriesValue && normalized.length !== this.categoriesValue.length) {
      throw new Error("Chart series values and categories must have equal length");
    }
    this.onPointCountChange(normalized.length - (this.valuesValue?.length ?? 0));
    this.valuesValue = normalized;
  }
  get categories(): Array<string | number> | undefined {
    return this.categoriesValue?.slice();
  }
  set categories(value: Array<string | number> | undefined) {
    if (value === undefined) {
      this.onPointCountChange(-(this.categoriesValue?.length ?? 0));
      this.categoriesValue = undefined;
      return;
    }
    const entries = snapshotArray(
      value,
      "chart series categories",
      SPREADSHEET_SNAPSHOT_LIMITS.chartPointsTotal,
    );
    const normalized = entries.map((entry, index) => {
      if (typeof entry === "string") {
        return normalizeLiveString(entry, `chart series categories[${index}]`);
      }
      return snapshotFiniteNumber(entry, `chart series categories[${index}]`);
    });
    if (this.valuesValue && normalized.length !== this.valuesValue.length) {
      throw new Error("Chart series values and categories must have equal length");
    }
    this.onPointCountChange(normalized.length - (this.categoriesValue?.length ?? 0));
    this.categoriesValue = normalized;
  }
  get fill(): string | undefined {
    return this.fillValue;
  }
  set fill(value: string | undefined) {
    this.fillValue =
      value === undefined ? undefined : normalizeLiveString(value, "chart series fill");
  }

  get pointCount(): number {
    return (this.valuesValue?.length ?? 0) + (this.categoriesValue?.length ?? 0);
  }

  [CONNECT_CHART_POINT_COUNTER](counter: (delta: number) => void): void {
    this.onPointCountChange = counter;
  }

  toJSON(): SpreadsheetChartSeriesConfig {
    return {
      name: this.nameValue,
      ...(this.formulaValue ? { formula: this.formulaValue } : {}),
      ...(this.categoryFormulaValue ? { categoryFormula: this.categoryFormulaValue } : {}),
      ...(this.valuesValue ? { values: [...this.valuesValue] } : {}),
      ...(this.categoriesValue ? { categories: [...this.categoriesValue] } : {}),
      ...(this.fillValue ? { fill: this.fillValue } : {}),
    };
  }
}

export class ShapeCollection {
  readonly items: SpreadsheetShape[] = [];
  constructor(private readonly worksheet: Worksheet) {}
  add(_config: Record<string, unknown>): SpreadsheetShape {
    throw new UnsupportedArtifactFeatureError(
      "spreadsheet",
      "Spreadsheet shapes",
      "current spreadsheet engine",
    );
  }
  deleteAll(): void {
    if (this.items.length > 0) {
      this.items.length = 0;
      this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
    }
  }
}
export class SpreadsheetShape {
  readonly id: string;
  constructor(
    readonly worksheet: Worksheet,
    readonly config: Record<string, unknown>,
  ) {
    this.id = worksheet.workbook.allocateId("sh", this);
  }
}

export class ImageCollection {
  readonly items: SpreadsheetImage[] = [];
  constructor(private readonly worksheet: Worksheet) {}
  add(config: SpreadsheetImageConfig): SpreadsheetImage {
    snapshotLimit(
      "worksheet image count",
      this.items.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.imagesPerSheet,
    );
    const normalized = normalizeSpreadsheetImageConfig(config);
    const usage = canonicalImageUsage(normalized);
    const workbook = this.worksheet.workbook;
    workbook[RESERVE_WORKBOOK_RESOURCE]("images");
    try {
      workbook[RESERVE_WORKBOOK_RESOURCE]("imageBytes", usage.imageBytes);
      try {
        workbook[RESERVE_WORKBOOK_RESOURCE]("imageDataUrlBytes", usage.dataUrlBytes);
      } catch (cause) {
        workbook[RELEASE_WORKBOOK_RESOURCE]("imageBytes", usage.imageBytes);
        throw cause;
      }
    } catch (cause) {
      workbook[RELEASE_WORKBOOK_RESOURCE]("images");
      throw cause;
    }
    const image = new SpreadsheetImage(this.worksheet, normalized);
    this.items.push(image);
    this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
    return image;
  }
  deleteAll(): void {
    if (this.items.length > 0) {
      let imageBytes = 0;
      let dataUrlBytes = 0;
      for (const image of this.items) {
        const usage = canonicalImageUsage(image.config);
        imageBytes += usage.imageBytes;
        dataUrlBytes += usage.dataUrlBytes;
      }
      const workbook = this.worksheet.workbook;
      workbook[RELEASE_WORKBOOK_RESOURCE]("images", this.items.length);
      workbook[RELEASE_WORKBOOK_RESOURCE]("imageBytes", imageBytes);
      workbook[RELEASE_WORKBOOK_RESOURCE]("imageDataUrlBytes", dataUrlBytes);
      this.items.length = 0;
      this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
    }
  }
}
export class SpreadsheetImage {
  readonly id: string;
  constructor(
    private readonly worksheet: Worksheet,
    readonly config: SpreadsheetImageConfig,
  ) {
    this.id = worksheet.workbook.allocateId("im", this);
  }
  inspectRecord(): Record<string, unknown> {
    return {
      kind: "drawing",
      objectKind: "image",
      id: this.id,
      sheetId: this.worksheet.id,
      alt: this.config.alt ?? null,
      anchor: this.config.anchor,
    };
  }
}

export class DataValidationCollection {
  private readonly entries: Array<{
    range: RangeAddress;
    config: DataValidationConfig;
  }> = [];
  constructor(private readonly worksheet: Worksheet) {}
  add(input: { range: string; rule: Record<string, unknown> }): void {
    const range = parseRangeAddress(input.range);
    const config = Object.freeze({
      rule: normalizeConfigRecord(input.rule, "data validation rule"),
    });
    const index = this.entries.findIndex((entry) => sameRange(entry.range, range));
    if (index < 0) {
      snapshotLimit(
        "worksheet data validation count",
        this.entries.length + 1,
        SPREADSHEET_SNAPSHOT_LIMITS.dataValidationsPerSheet,
      );
      this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("dataValidations");
      this.entries.push({ range: Object.freeze({ ...range }), config });
    } else {
      this.entries[index] = { range: Object.freeze({ ...range }), config };
    }
    this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
  }
  get(range: RangeAddress): DataValidationConfig | null {
    const config = this.entries.find((entry) => sameRange(entry.range, range))?.config;
    return config ? structuredClone(config) : null;
  }
  remove(range: RangeAddress): void {
    const index = this.entries.findIndex((entry) => sameRange(entry.range, range));
    if (index >= 0) {
      this.entries.splice(index, 1);
      this.worksheet.workbook[RELEASE_WORKBOOK_RESOURCE]("dataValidations");
      this.worksheet.workbook.markChanged(this.worksheet.id, "structure");
    }
  }
  all(): readonly { range: RangeAddress; config: DataValidationConfig }[] {
    return this.entries.map((entry) => ({
      range: { ...entry.range },
      config: structuredClone(entry.config),
    }));
  }
  serialize(): SerializedDataValidation[] {
    return this.entries.map((entry) => ({
      range: { ...entry.range },
      config: structuredClone(entry.config),
    }));
  }
  restore(entries: readonly SerializedDataValidation[]): void {
    this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("dataValidations", entries.length);
    for (const entry of entries) {
      this.entries.push({
        range: Object.freeze({ ...entry.range }),
        config: Object.freeze({
          rule: normalizeConfigRecord(entry.config.rule, "restored data validation rule"),
        }),
      });
    }
  }
}

export class ConditionalFormattingCollection {
  private readonly entries: Array<{
    range: RangeAddress;
    ruleType: string;
    config: ConditionalFormatConfig;
  }> = [];
  constructor(private readonly worksheet: Worksheet) {}
  add(range: RangeAddress, ruleType: string, config: ConditionalFormatConfig): void {
    snapshotLimit(
      "worksheet conditional format count",
      this.entries.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.conditionalFormatsPerSheet,
    );
    const normalizedRuleType = normalizeConditionalFormatRuleType(ruleType);
    const normalizedConfig = normalizeConfigRecord(config, "conditional format config");
    this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("conditionalFormats");
    this.entries.push({
      range: Object.freeze({ ...range }),
      ruleType: normalizedRuleType,
      config: normalizedConfig,
    });
    this.worksheet.workbook.markChanged(this.worksheet.id, "format");
  }
  clear(range?: RangeAddress): void {
    let removed = 0;
    if (!range) {
      removed = this.entries.length;
      this.entries.length = 0;
    } else {
      let write = 0;
      for (const entry of this.entries)
        if (!sameRange(entry.range, range)) this.entries[write++] = entry;
        else removed += 1;
      this.entries.length = write;
    }
    if (removed === 0) return;
    this.worksheet.workbook[RELEASE_WORKBOOK_RESOURCE]("conditionalFormats", removed);
    this.worksheet.workbook.markChanged(this.worksheet.id, "format");
  }
  all(): readonly {
    range: RangeAddress;
    ruleType: string;
    config: ConditionalFormatConfig;
  }[] {
    return this.entries.map((entry) => ({
      range: { ...entry.range },
      ruleType: entry.ruleType,
      config: structuredClone(entry.config),
    }));
  }
  serialize(): SerializedConditionalFormatting[] {
    return this.entries.map((entry) => ({
      range: { ...entry.range },
      ruleType: entry.ruleType,
      config: structuredClone(entry.config),
    }));
  }
  restore(entries: readonly SerializedConditionalFormatting[]): void {
    this.worksheet.workbook[RESERVE_WORKBOOK_RESOURCE]("conditionalFormats", entries.length);
    for (const entry of entries) {
      this.entries.push({
        range: Object.freeze({ ...entry.range }),
        ruleType: normalizeConditionalFormatRuleType(entry.ruleType),
        config: normalizeConfigRecord(entry.config, "restored conditional format config"),
      });
    }
  }
}

const CONDITIONAL_FORMAT_RULE_TYPES = new Map<string, string>([
  ["cellis", "cellIs"],
  ["cellvalue", "cellIs"],
  ["custom", "expression"],
  ["expression", "expression"],
  ["colorscale", "colorScale"],
  ["databar", "dataBar"],
  ["iconset", "iconSet"],
  ["containstext", "containsText"],
  ["notcontainstext", "notContainsText"],
  ["beginswith", "beginsWith"],
  ["endswith", "endsWith"],
  ["containsblanks", "containsBlanks"],
  ["notcontainsblanks", "notContainsBlanks"],
  ["containserrors", "containsErrors"],
  ["notcontainserrors", "notContainsErrors"],
  ["duplicatevalues", "duplicateValues"],
  ["uniquevalues", "uniqueValues"],
  ["timeperiod", "timePeriod"],
  ["top10", "top10"],
  ["aboveaverage", "aboveAverage"],
]);

function normalizeConditionalFormatRuleType(value: unknown): string {
  const raw = normalizeLiveString(value, "conditional format rule type");
  const normalized = CONDITIONAL_FORMAT_RULE_TYPES.get(raw.toLowerCase());
  if (!normalized) throw new TypeError(`Unsupported conditional format rule type: ${raw}`);
  return normalized;
}

export class RangeConditionalFormats {
  constructor(private readonly range: Range) {}
  add(ruleType: string, config: ConditionalFormatConfig): void {
    this.range.worksheet.conditionalFormattings.add(this.range.address, ruleType, config);
  }
  addCustom(expression: string, format: ConditionalFormatConfig): void {
    this.add("expression", { formula: expression, format });
  }
  deleteAll(): void {
    this.range.worksheet.conditionalFormattings.clear(this.range.address);
  }
  clear(): void {
    this.deleteAll();
  }
}

export class RangeSparklines {
  constructor(private readonly range: Range) {}

  add(
    type: SpreadsheetSparklineType,
    sourceRange: Range | string,
    config: RangeSparklineConfig = {},
  ): SparklineGroup {
    return this.range.worksheet.sparklineGroups.add({
      ...config,
      type,
      targetRange: this.range,
      sourceData: sourceRange,
    });
  }

  deleteAll(): void {
    this.range.worksheet.sparklineGroups.removeInRange(this.range.address);
  }

  clear(): void {
    this.deleteAll();
  }
}

export class SparklineGroupCollection {
  readonly items: SparklineGroup[] = [];
  private targetCellCount = 0;
  private sourcePointCount = 0;

  constructor(private readonly worksheet: Worksheet) {}

  add(config: SparklineConfig): SparklineGroup {
    const normalized = normalizeSparklineConfig(this.worksheet, config);
    return this.insert(normalized, true);
  }

  deleteAll(): void {
    if (this.items.length === 0) return;
    const workbook = this.worksheet.workbook;
    workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineGroups", this.items.length);
    workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineCells", this.targetCellCount);
    workbook[RELEASE_WORKBOOK_RESOURCE]("sparklinePoints", this.sourcePointCount);
    this.items.length = 0;
    this.targetCellCount = 0;
    this.sourcePointCount = 0;
    workbook.markChanged(this.worksheet.id, "drawing");
  }

  removeInRange(range: RangeAddress): void {
    const matches = this.items.filter((group) => rangesOverlap(group.targetRange.address, range));
    if (matches.length === 0) return;
    this.worksheet.workbook.transact(() => {
      for (const group of matches) this.remove(group);
    });
  }

  remove(group: SparklineGroup): void {
    const index = this.items.indexOf(group);
    if (index < 0) return;
    const usage = group.resourceUsage;
    this.items.splice(index, 1);
    this.targetCellCount -= usage.targetCells;
    this.sourcePointCount -= usage.readPoints;
    const workbook = this.worksheet.workbook;
    workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineGroups");
    workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineCells", usage.targetCells);
    workbook[RELEASE_WORKBOOK_RESOURCE]("sparklinePoints", usage.readPoints);
    workbook.markChanged(this.worksheet.id, "drawing");
  }

  restore(serialized: SerializedSparklineGroup): void {
    const sourceSheet = this.worksheet.workbook.worksheets.getItem(serialized.sourceData.sheetId);
    const dateAxisSheet = serialized.dateAxisRange
      ? this.worksheet.workbook.worksheets.getItem(serialized.dateAxisRange.sheetId)
      : null;
    this.insert(
      {
        existingId: serialized.id,
        type: serialized.type,
        targetRange: new Range(this.worksheet, serialized.targetRange),
        sourceData: new Range(sourceSheet, serialized.sourceData.address),
        dateAxisRange: serialized.dateAxisRange
          ? new Range(dateAxisSheet!, serialized.dateAxisRange.address)
          : null,
        lineWeight: serialized.lineWeight,
        displayHidden: serialized.displayHidden,
        displayEmptyCellsAs: serialized.displayEmptyCellsAs,
        seriesColor: serialized.seriesColor,
        negativeColor: serialized.negativeColor,
        axisColor: serialized.axisColor,
        markersColor: serialized.markersColor,
        firstMarkerColor: serialized.firstMarkerColor,
        lastMarkerColor: serialized.lastMarkerColor,
        highMarkerColor: serialized.highMarkerColor,
        lowMarkerColor: serialized.lowMarkerColor,
        markers: Object.freeze({ ...serialized.markers }),
        axis: Object.freeze({ ...serialized.axis }),
      },
      false,
    );
  }

  private insert(state: NormalizedSparklineGroup, markChanged: boolean): SparklineGroup {
    snapshotLimit(
      "worksheet sparkline group count",
      this.items.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.sparklineGroupsPerSheet,
    );
    if (
      this.items.some((group) =>
        rangesOverlap(group.targetRange.address, state.targetRange.address),
      )
    ) {
      throw new Error("Sparkline target range overlaps an existing sparkline group");
    }
    const dimensions = sparklineDimensions(
      state.targetRange.address,
      state.sourceData.address,
      state.dateAxisRange?.address ?? null,
      "sparkline",
    );
    const readPoints =
      dimensions.sourcePoints + (state.dateAxisRange ? dimensions.pointsPerSparkline : 0);
    snapshotLimit(
      "worksheet sparkline cell count",
      this.targetCellCount + dimensions.targetCells,
      SPREADSHEET_SNAPSHOT_LIMITS.sparklineCellsPerSheet,
    );
    snapshotLimit(
      "worksheet sparkline source point count",
      this.sourcePointCount + readPoints,
      SPREADSHEET_SNAPSHOT_LIMITS.sparklinePointsPerSheet,
    );

    const workbook = this.worksheet.workbook;
    workbook[RESERVE_WORKBOOK_RESOURCE]("sparklineGroups");
    try {
      workbook[RESERVE_WORKBOOK_RESOURCE]("sparklineCells", dimensions.targetCells);
      try {
        workbook[RESERVE_WORKBOOK_RESOURCE]("sparklinePoints", readPoints);
      } catch (cause) {
        workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineCells", dimensions.targetCells);
        throw cause;
      }
    } catch (cause) {
      workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineGroups");
      throw cause;
    }

    let group: SparklineGroup;
    try {
      group = new SparklineGroup(this, this.worksheet, state, {
        targetCells: dimensions.targetCells,
        readPoints,
        pointsPerSparkline: dimensions.pointsPerSparkline,
      });
    } catch (cause) {
      workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineGroups");
      workbook[RELEASE_WORKBOOK_RESOURCE]("sparklineCells", dimensions.targetCells);
      workbook[RELEASE_WORKBOOK_RESOURCE]("sparklinePoints", readPoints);
      throw cause;
    }
    this.items.push(group);
    this.targetCellCount += dimensions.targetCells;
    this.sourcePointCount += readPoints;
    if (markChanged) workbook.markChanged(this.worksheet.id, "drawing");
    return group;
  }
}

type NormalizedSparklineGroup = {
  existingId?: string;
  type: SpreadsheetSparklineType;
  targetRange: Range;
  sourceData: Range;
  dateAxisRange: Range | null;
  lineWeight: number;
  displayHidden: boolean;
  displayEmptyCellsAs: 0 | 1 | 2;
  seriesColor: string | null;
  negativeColor: string | null;
  axisColor: string | null;
  markersColor: string | null;
  firstMarkerColor: string | null;
  lastMarkerColor: string | null;
  highMarkerColor: string | null;
  lowMarkerColor: string | null;
  markers: Readonly<Required<SpreadsheetSparklineMarkersOptions>>;
  axis: Readonly<{
    showAxis: boolean;
    manualMin: number | null;
    manualMax: number | null;
    rightToLeft: boolean;
  }>;
};

export class SparklineGroup {
  readonly id: string;
  readonly targetRange: Range;
  readonly sourceData: Range;
  readonly dateAxisRange: Range | null;
  readonly resourceUsage: Readonly<{
    targetCells: number;
    readPoints: number;
    pointsPerSparkline: number;
  }>;
  private typeValue: SpreadsheetSparklineType;
  private lineWeightValue: number;
  private displayHiddenValue: boolean;
  private displayEmptyCellsAsValue: 0 | 1 | 2;
  private seriesColorValue: string | null;
  private negativeColorValue: string | null;
  private axisColorValue: string | null;
  private markersColorValue: string | null;
  private firstMarkerColorValue: string | null;
  private lastMarkerColorValue: string | null;
  private highMarkerColorValue: string | null;
  private lowMarkerColorValue: string | null;
  private markersValue: Readonly<Required<SpreadsheetSparklineMarkersOptions>>;
  private axisValue: Readonly<{
    showAxis: boolean;
    manualMin: number | null;
    manualMax: number | null;
    rightToLeft: boolean;
  }>;

  constructor(
    private readonly collection: SparklineGroupCollection,
    private readonly worksheet: Worksheet,
    state: NormalizedSparklineGroup,
    usage: { targetCells: number; readPoints: number; pointsPerSparkline: number },
  ) {
    this.id = state.existingId ?? worksheet.workbook.allocateId("sp", this);
    if (state.existingId) worksheet.workbook.registerId(state.existingId, this);
    this.typeValue = state.type;
    this.targetRange = state.targetRange;
    this.sourceData = state.sourceData;
    this.dateAxisRange = state.dateAxisRange;
    this.lineWeightValue = state.lineWeight;
    this.displayHiddenValue = state.displayHidden;
    this.displayEmptyCellsAsValue = state.displayEmptyCellsAs;
    this.seriesColorValue = state.seriesColor;
    this.negativeColorValue = state.negativeColor;
    this.axisColorValue = state.axisColor;
    this.markersColorValue = state.markersColor;
    this.firstMarkerColorValue = state.firstMarkerColor;
    this.lastMarkerColorValue = state.lastMarkerColor;
    this.highMarkerColorValue = state.highMarkerColor;
    this.lowMarkerColorValue = state.lowMarkerColor;
    this.markersValue = state.markers;
    this.axisValue = state.axis;
    this.resourceUsage = Object.freeze({ ...usage });
  }

  get type(): SpreadsheetSparklineType {
    return this.typeValue;
  }
  set type(value: SpreadsheetSparklineType) {
    const normalized = normalizeSparklineType(value);
    if (normalized === this.typeValue) return;
    this.typeValue = normalized;
    this.changed();
  }
  get lineWeight(): number {
    return this.lineWeightValue;
  }
  set lineWeight(value: number) {
    const normalized = normalizeSparklineLineWeight(value);
    if (normalized === this.lineWeightValue) return;
    this.lineWeightValue = normalized;
    this.changed();
  }
  get displayHidden(): boolean {
    return this.displayHiddenValue;
  }
  set displayHidden(value: boolean) {
    if (typeof value !== "boolean") throw new TypeError("sparkline displayHidden must be boolean");
    if (value === this.displayHiddenValue) return;
    this.displayHiddenValue = value;
    this.changed();
  }
  get displayEmptyCellsAs(): 0 | 1 | 2 {
    return this.displayEmptyCellsAsValue;
  }
  set displayEmptyCellsAs(value: 0 | 1 | 2) {
    const normalized = snapshotInteger(value, "sparkline displayEmptyCellsAs", 0, 2) as 0 | 1 | 2;
    if (normalized === this.displayEmptyCellsAsValue) return;
    this.displayEmptyCellsAsValue = normalized;
    this.changed();
  }

  get seriesColor(): string | undefined {
    return this.seriesColorValue ?? undefined;
  }
  set seriesColor(value: string | undefined) {
    this.setColor("seriesColorValue", value, "series color");
  }
  get negativeColor(): string | undefined {
    return this.negativeColorValue ?? undefined;
  }
  set negativeColor(value: string | undefined) {
    this.setColor("negativeColorValue", value, "negative color");
  }
  get axisColor(): string | undefined {
    return this.axisColorValue ?? undefined;
  }
  set axisColor(value: string | undefined) {
    this.setColor("axisColorValue", value, "axis color");
  }
  get markersColor(): string | undefined {
    return this.markersColorValue ?? undefined;
  }
  set markersColor(value: string | undefined) {
    this.setColor("markersColorValue", value, "markers color");
  }
  get firstMarkerColor(): string | undefined {
    return this.firstMarkerColorValue ?? undefined;
  }
  set firstMarkerColor(value: string | undefined) {
    this.setColor("firstMarkerColorValue", value, "first marker color");
  }
  get lastMarkerColor(): string | undefined {
    return this.lastMarkerColorValue ?? undefined;
  }
  set lastMarkerColor(value: string | undefined) {
    this.setColor("lastMarkerColorValue", value, "last marker color");
  }
  get highMarkerColor(): string | undefined {
    return this.highMarkerColorValue ?? undefined;
  }
  set highMarkerColor(value: string | undefined) {
    this.setColor("highMarkerColorValue", value, "high marker color");
  }
  get lowMarkerColor(): string | undefined {
    return this.lowMarkerColorValue ?? undefined;
  }
  set lowMarkerColor(value: string | undefined) {
    this.setColor("lowMarkerColorValue", value, "low marker color");
  }
  get markers(): Readonly<Required<SpreadsheetSparklineMarkersOptions>> {
    return this.markersValue;
  }
  set markers(value: SpreadsheetSparklineMarkersOptions) {
    this.markersValue = normalizeSparklineMarkers(value);
    this.changed();
  }
  get axis(): Readonly<SpreadsheetSparklineAxisOptions> {
    return Object.freeze({
      showAxis: this.axisValue.showAxis,
      ...(this.axisValue.manualMin === null ? {} : { manualMin: this.axisValue.manualMin }),
      ...(this.axisValue.manualMax === null ? {} : { manualMax: this.axisValue.manualMax }),
      rightToLeft: this.axisValue.rightToLeft,
    });
  }
  set axis(value: SpreadsheetSparklineAxisOptions) {
    this.axisValue = normalizeSparklineAxis(value);
    this.changed();
  }

  delete(): void {
    this.collection.remove(this);
  }

  valuesForTargetCell(row: number, col: number): readonly (number | null)[] {
    const target = this.targetRange.address;
    if (
      row < target.row ||
      col < target.col ||
      row >= target.row + target.rowCount ||
      col >= target.col + target.colCount
    ) {
      return [];
    }
    const source = this.sourceData.address;
    const targetIndex =
      target.rowCount > 1 ? row - target.row : target.colCount > 1 ? col - target.col : 0;
    const values: Array<number | null> = [];
    if (this.resourceUsage.targetCells === 1) {
      if (source.rowCount === 1) {
        for (let offset = 0; offset < source.colCount; offset += 1) {
          values.push(this.numericValueAt(source.row, source.col + offset));
        }
      } else {
        for (let offset = 0; offset < source.rowCount; offset += 1) {
          values.push(this.numericValueAt(source.row + offset, source.col));
        }
      }
    } else if (target.rowCount > 1) {
      for (let offset = 0; offset < source.colCount; offset += 1) {
        values.push(this.numericValueAt(source.row + targetIndex, source.col + offset));
      }
    } else {
      for (let offset = 0; offset < source.rowCount; offset += 1) {
        values.push(this.numericValueAt(source.row + offset, source.col + targetIndex));
      }
    }
    if (this.displayEmptyCellsAsValue === 1) {
      return values.map((value) => value ?? 0);
    }
    return values;
  }

  dateAxisValues(): readonly (number | null)[] | null {
    if (!this.dateAxisRange) return null;
    const address = this.dateAxisRange.address;
    const values: Array<number | null> = [];
    const append = (row: number, col: number): void => {
      const value = this.dateAxisRange!.worksheet.workbook.valueAt(this.dateAxisRange!.worksheet, {
        row,
        col,
      });
      values.push(
        typeof value === "number" && Number.isFinite(value)
          ? value
          : value instanceof Date
            ? Date.prototype.getTime.call(value)
            : null,
      );
    };
    if (address.rowCount === 1) {
      for (let offset = 0; offset < address.colCount; offset += 1)
        append(address.row, address.col + offset);
    } else {
      for (let offset = 0; offset < address.rowCount; offset += 1)
        append(address.row + offset, address.col);
    }
    return values;
  }

  inspectRecord(): Record<string, unknown> {
    return {
      kind: "drawing",
      objectKind: "sparklineGroup",
      id: this.id,
      sheetId: this.worksheet.id,
      type: this.typeValue,
      targetRange: formatRangeAddress(this.targetRange.address),
      sourceData: {
        sheetId: this.sourceData.worksheet.id,
        sheetName: this.sourceData.worksheet.name,
        range: formatRangeAddress(this.sourceData.address),
      },
      dateAxisRange: this.dateAxisRange
        ? {
            sheetId: this.dateAxisRange.worksheet.id,
            sheetName: this.dateAxisRange.worksheet.name,
            range: formatRangeAddress(this.dateAxisRange.address),
          }
        : null,
      targetCells: this.resourceUsage.targetCells,
      pointsPerSparkline: this.resourceUsage.pointsPerSparkline,
      lineWeight: this.lineWeightValue,
      displayHidden: this.displayHiddenValue,
      displayEmptyCellsAs: this.displayEmptyCellsAsValue,
      colors: {
        series: this.seriesColorValue,
        negative: this.negativeColorValue,
        axis: this.axisColorValue,
        markers: this.markersColorValue,
        first: this.firstMarkerColorValue,
        last: this.lastMarkerColorValue,
        high: this.highMarkerColorValue,
        low: this.lowMarkerColorValue,
      },
      markers: this.markersValue,
      axis: this.axis,
    };
  }

  serialize(): SerializedSparklineGroup {
    return {
      id: this.id,
      type: this.typeValue,
      targetRange: { ...this.targetRange.address },
      sourceData: {
        sheetId: this.sourceData.worksheet.id,
        address: { ...this.sourceData.address },
      },
      dateAxisRange: this.dateAxisRange
        ? {
            sheetId: this.dateAxisRange.worksheet.id,
            address: { ...this.dateAxisRange.address },
          }
        : null,
      lineWeight: this.lineWeightValue,
      displayHidden: this.displayHiddenValue,
      displayEmptyCellsAs: this.displayEmptyCellsAsValue,
      seriesColor: this.seriesColorValue,
      negativeColor: this.negativeColorValue,
      axisColor: this.axisColorValue,
      markersColor: this.markersColorValue,
      firstMarkerColor: this.firstMarkerColorValue,
      lastMarkerColor: this.lastMarkerColorValue,
      highMarkerColor: this.highMarkerColorValue,
      lowMarkerColor: this.lowMarkerColorValue,
      markers: { ...this.markersValue },
      axis: { ...this.axisValue },
    };
  }

  private numericValueAt(row: number, col: number): number | null {
    const value = this.sourceData.worksheet.workbook.valueAt(this.sourceData.worksheet, {
      row,
      col,
    });
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private setColor(
    key:
      | "seriesColorValue"
      | "negativeColorValue"
      | "axisColorValue"
      | "markersColorValue"
      | "firstMarkerColorValue"
      | "lastMarkerColorValue"
      | "highMarkerColorValue"
      | "lowMarkerColorValue",
    value: string | undefined,
    label: string,
  ): void {
    const normalized = value === undefined ? null : normalizeSparklineColor(value, label);
    if (this[key] === normalized) return;
    this[key] = normalized;
    this.changed();
  }

  private changed(): void {
    this.worksheet.workbook.markChanged(this.worksheet.id, "drawing");
  }
}

export class WorkbookComments {
  readonly items: CommentThread[] = [];
  private displayName = "User";
  constructor(private readonly workbook: Workbook) {}
  setSelf(input: { displayName: string }): void {
    const name = normalizeLiveString(input.displayName, "comment display name").trim();
    if (!name) throw new Error("Comment display name is required");
    this.displayName = name;
  }
  addThread(target: { cell: Range }, text: string): CommentThread {
    const normalizedText = normalizeLiveString(text, "comment text");
    snapshotLimit(
      "workbook comment thread count",
      this.items.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.commentThreads,
    );
    if (target.cell.worksheet.workbook !== this.workbook) {
      throw new Error("Comment target belongs to another workbook");
    }
    if (target.cell.address.rowCount !== 1 || target.cell.address.colCount !== 1)
      throw new Error("Comments must target one cell");
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("commentThreads");
    try {
      this.workbook[RESERVE_WORKBOOK_RESOURCE]("comments");
    } catch (cause) {
      this.workbook[RELEASE_WORKBOOK_RESOURCE]("commentThreads");
      throw cause;
    }
    const thread = new CommentThread(
      this.workbook,
      target.cell.worksheet,
      { row: target.cell.address.row, col: target.cell.address.col },
      this.displayName,
      normalizedText,
    );
    this.items.push(thread);
    this.workbook.markChanged(target.cell.worksheet.id, "comment");
    return thread;
  }
  restore(serialized: SerializedCommentThread): void {
    const worksheet = this.workbook.worksheets.getItem(serialized.sheetId);
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("commentThreads");
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("comments", serialized.comments.length);
    this.items.push(CommentThread.restore(this.workbook, worksheet, serialized));
  }
}

export class CommentThread {
  readonly id: string;
  private resolvedValue = false;
  readonly comments: Array<{
    author: string;
    text: string;
    createdAt: string;
  }> = [];
  private readonly cell: CellAddress;
  constructor(
    private readonly workbook: Workbook,
    private readonly worksheet: Worksheet,
    cell: CellAddress,
    author: string,
    text: string,
    existingId?: string,
  ) {
    this.cell = { row: cell.row, col: cell.col };
    this.id = existingId ?? workbook.allocateId("th", this);
    if (existingId) workbook.registerId(existingId, this);
    this.comments.push({
      author: normalizeLiveString(author, "comment author"),
      text: normalizeLiveString(text, "comment text"),
      createdAt: new Date().toISOString(),
    });
  }
  addReply(text: string): void {
    snapshotLimit(
      "comment thread reply count",
      this.comments.length + 1,
      SPREADSHEET_SNAPSHOT_LIMITS.commentsPerThread,
    );
    this.workbook[RESERVE_WORKBOOK_RESOURCE]("comments");
    this.comments.push({
      author: "User",
      text: normalizeLiveString(text, "comment reply"),
      createdAt: new Date().toISOString(),
    });
    this.workbook.markChanged(this.worksheet.id, "comment");
  }
  resolve(): void {
    this.resolvedValue = true;
    this.workbook.markChanged(this.worksheet.id, "comment");
  }
  reopen(): void {
    this.resolvedValue = false;
    this.workbook.markChanged(this.worksheet.id, "comment");
  }
  inspectRecord(): Record<string, unknown> {
    return {
      kind: "thread",
      id: this.id,
      sheetId: this.worksheet.id,
      cell: formatCellAddress(this.cell),
      resolved: this.resolvedValue,
      comments: this.comments,
    };
  }
  serialize(): SerializedCommentThread {
    return {
      id: this.id,
      sheetId: this.worksheet.id,
      cell: this.cell,
      resolved: this.resolvedValue,
      comments: this.comments.map((comment) => ({ ...comment })),
    };
  }
  static restore(
    workbook: Workbook,
    worksheet: Worksheet,
    serialized: SerializedCommentThread,
  ): CommentThread {
    const first = serialized.comments[0] ?? {
      author: "User",
      text: "",
      createdAt: new Date(0).toISOString(),
    };
    const thread = new CommentThread(
      workbook,
      worksheet,
      serialized.cell,
      first.author,
      first.text,
      serialized.id,
    );
    thread.comments.length = 0;
    thread.comments.push(...serialized.comments.map((comment) => ({ ...comment })));
    thread.resolvedValue = serialized.resolved;
    return thread;
  }
}

function normalizeCellValue(value: CellValue | undefined): CellValue {
  if (value === undefined || value === null || typeof value === "boolean") {
    return value ?? null;
  }
  if (typeof value === "string") return normalizeLiveString(value, "cell value");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cell numbers must be finite");
    return value;
  }
  if (value instanceof Date) {
    const timestamp = Date.prototype.getTime.call(value);
    if (!Number.isFinite(timestamp)) throw new TypeError("Cell dates must be valid");
    return new Date(timestamp);
  }
  throw new TypeError("Unsupported spreadsheet cell value");
}

function normalizeLiveString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  boundedUtf8Bytes(value, SPREADSHEET_SNAPSHOT_LIMITS.stringBytesEach, label);
  return value;
}

function normalizeSparklineConfig(
  worksheet: Worksheet,
  input: SparklineConfig,
): NormalizedSparklineGroup {
  const config = snapshotRecord(
    input,
    "sparkline config",
    ["type", "targetRange", "sourceData"],
    [
      "dateAxisRange",
      "lineWeight",
      "displayHidden",
      "displayEmptyCellsAs",
      "seriesColor",
      "negativeColor",
      "axisColor",
      "markersColor",
      "firstMarkerColor",
      "lastMarkerColor",
      "highMarkerColor",
      "lowMarkerColor",
      "markers",
      "axis",
    ],
  );
  const targetRange = resolveSparklineRange(worksheet, config.targetRange, "sparkline targetRange");
  if (targetRange.worksheet !== worksheet) {
    throw new Error("Sparkline targetRange must belong to the target worksheet");
  }
  const sourceData = resolveSparklineRange(worksheet, config.sourceData, "sparkline sourceData");
  const dateAxisRange =
    config.dateAxisRange === undefined
      ? null
      : resolveSparklineRange(worksheet, config.dateAxisRange, "sparkline dateAxisRange");
  sparklineDimensions(
    targetRange.address,
    sourceData.address,
    dateAxisRange?.address ?? null,
    "sparkline config",
  );

  return {
    type: normalizeSparklineType(config.type),
    targetRange,
    sourceData,
    dateAxisRange,
    lineWeight:
      config.lineWeight === undefined ? 1 : normalizeSparklineLineWeight(config.lineWeight),
    displayHidden:
      config.displayHidden === undefined
        ? false
        : snapshotBoolean(config.displayHidden, "sparkline displayHidden"),
    displayEmptyCellsAs:
      config.displayEmptyCellsAs === undefined
        ? 0
        : (snapshotInteger(config.displayEmptyCellsAs, "sparkline displayEmptyCellsAs", 0, 2) as
            | 0
            | 1
            | 2),
    seriesColor: normalizeOptionalSparklineColor(config.seriesColor, "sparkline series color"),
    negativeColor: normalizeOptionalSparklineColor(
      config.negativeColor,
      "sparkline negative color",
    ),
    axisColor: normalizeOptionalSparklineColor(config.axisColor, "sparkline axis color"),
    markersColor: normalizeOptionalSparklineColor(config.markersColor, "sparkline markers color"),
    firstMarkerColor: normalizeOptionalSparklineColor(
      config.firstMarkerColor,
      "sparkline first marker color",
    ),
    lastMarkerColor: normalizeOptionalSparklineColor(
      config.lastMarkerColor,
      "sparkline last marker color",
    ),
    highMarkerColor: normalizeOptionalSparklineColor(
      config.highMarkerColor,
      "sparkline high marker color",
    ),
    lowMarkerColor: normalizeOptionalSparklineColor(
      config.lowMarkerColor,
      "sparkline low marker color",
    ),
    markers: normalizeSparklineMarkers(config.markers),
    axis: normalizeSparklineAxis(config.axis),
  };
}

function resolveSparklineRange(defaultWorksheet: Worksheet, value: unknown, label: string): Range {
  if (value instanceof Range) {
    if (value.worksheet.workbook !== defaultWorksheet.workbook) {
      throw new Error(`${label} belongs to another workbook`);
    }
    return new Range(value.worksheet, value.address);
  }
  const input = normalizeLiveString(value, label);
  const parsed = parseQualifiedRange(input);
  const worksheet = parsed.sheetName
    ? defaultWorksheet.workbook.worksheets.getItem(parsed.sheetName)
    : defaultWorksheet;
  return new Range(worksheet, parsed.address);
}

function normalizeSparklineType(value: unknown): SpreadsheetSparklineType {
  if (value === "line" || value === "column" || value === "stacked") return value;
  throw new TypeError("sparkline type must be line, column, or stacked");
}

function normalizeSparklineLineWeight(value: unknown): number {
  return snapshotFiniteNumber(value, "sparkline lineWeight", {
    positive: true,
    maximum: 10,
  });
}

function normalizeSparklineMarkers(
  value: unknown,
): Readonly<Required<SpreadsheetSparklineMarkersOptions>> {
  const markers =
    value === undefined
      ? {}
      : snapshotRecord(
          value,
          "sparkline markers",
          [],
          ["show", "high", "low", "first", "last", "negative"],
        );
  const boolean = (key: keyof SpreadsheetSparklineMarkersOptions): boolean =>
    markers[key] === undefined ? false : snapshotBoolean(markers[key], `sparkline markers.${key}`);
  return Object.freeze({
    show: boolean("show"),
    high: boolean("high"),
    low: boolean("low"),
    first: boolean("first"),
    last: boolean("last"),
    negative: boolean("negative"),
  });
}

function normalizeSparklineAxis(value: unknown): Readonly<{
  showAxis: boolean;
  manualMin: number | null;
  manualMax: number | null;
  rightToLeft: boolean;
}> {
  const axis =
    value === undefined
      ? {}
      : snapshotRecord(
          value,
          "sparkline axis",
          [],
          ["showAxis", "manualMin", "manualMax", "rightToLeft"],
        );
  const manualMin =
    axis.manualMin === undefined
      ? null
      : snapshotFiniteNumber(axis.manualMin, "sparkline axis.manualMin");
  const manualMax =
    axis.manualMax === undefined
      ? null
      : snapshotFiniteNumber(axis.manualMax, "sparkline axis.manualMax");
  if (manualMin !== null && manualMax !== null && manualMin >= manualMax) {
    throw new TypeError("sparkline axis.manualMin must be less than manualMax");
  }
  return Object.freeze({
    showAxis:
      axis.showAxis === undefined
        ? false
        : snapshotBoolean(axis.showAxis, "sparkline axis.showAxis"),
    manualMin,
    manualMax,
    rightToLeft:
      axis.rightToLeft === undefined
        ? false
        : snapshotBoolean(axis.rightToLeft, "sparkline axis.rightToLeft"),
  });
}

function normalizeOptionalSparklineColor(value: unknown, label: string): string | null {
  return value === undefined ? null : normalizeSparklineColor(value, label);
}

function normalizeSparklineColor(value: unknown, label: string): string {
  const raw = normalizeLiveString(value, label);
  if (raw.trim() !== raw) throw new TypeError(`${label} must not contain surrounding whitespace`);
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${[...hex].map((character) => `${character}${character}`).join("")}`.toUpperCase();
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toUpperCase()}`;
  if (!raw.startsWith("#") && /^[0-9a-f]{8}$/i.test(hex)) {
    return `#${hex.slice(2).toUpperCase()}`;
  }
  throw new TypeError(`${label} must be a hexadecimal RGB color`);
}

function isCanonicalSparklineColor(value: string): boolean {
  return /^#[0-9A-F]{6}$/.test(value);
}

function sparklineDimensions(
  target: RangeAddress,
  source: RangeAddress,
  dateAxis: RangeAddress | null,
  label: string,
): {
  targetCells: number;
  sourcePoints: number;
  pointsPerSparkline: number;
} {
  if (target.rowCount > 1 && target.colCount > 1) {
    throw new Error(`${label} targetRange must be one row or one column`);
  }
  const targetCells = target.rowCount * target.colCount;
  let pointsPerSparkline: number;
  if (targetCells === 1) {
    if (source.rowCount > 1 && source.colCount > 1) {
      throw new Error(`${label} sourceData for one sparkline must be one row or one column`);
    }
    pointsPerSparkline = source.rowCount * source.colCount;
  } else if (target.rowCount > 1) {
    if (source.rowCount !== targetCells) {
      throw new Error(`${label} sourceData must have one row for each vertical target cell`);
    }
    pointsPerSparkline = source.colCount;
  } else {
    if (source.colCount !== targetCells) {
      throw new Error(`${label} sourceData must have one column for each horizontal target cell`);
    }
    pointsPerSparkline = source.rowCount;
  }
  if (dateAxis) {
    if (dateAxis.rowCount > 1 && dateAxis.colCount > 1) {
      throw new Error(`${label} dateAxisRange must be one row or one column`);
    }
    if (dateAxis.rowCount * dateAxis.colCount !== pointsPerSparkline) {
      throw new Error(`${label} dateAxisRange must match the points per sparkline`);
    }
  }
  return {
    targetCells,
    sourcePoints: source.rowCount * source.colCount,
    pointsPerSparkline,
  };
}

function normalizeLiveFormula(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const formula = normalizeLiveString(value, label);
  validateFormulaLimits(formula);
  return formula;
}

function normalizeChartPosition(value: unknown): { from: RangeAddress; to: RangeAddress } | null {
  if (value === null) return null;
  const position = snapshotRecord(value, "chart position", ["from", "to"]);
  const from = Object.freeze(validateSnapshotRange(position.from, "chart position.from"));
  const to = Object.freeze(validateSnapshotRange(position.to, "chart position.to"));
  return Object.freeze({ from, to });
}

function detachCellValue<T extends FormulaResult>(value: T): T {
  return (value instanceof Date ? new Date(Date.prototype.getTime.call(value)) : value) as T;
}

function detachCellData(data: Readonly<CellData>): CellData {
  if (!(data.value instanceof Date)) return data as CellData;
  return Object.freeze({
    value: detachCellValue(data.value),
    formula: data.formula,
    format: data.format,
  });
}

function normalizeCellFormat(value: CellFormat): CellFormat {
  if (typeof value === "object" && value !== null && normalizedCellFormats.has(value)) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === 0
  ) {
    return DEFAULT_CELL.format;
  }
  const state: SnapshotValidationState = {
    ids: new Set(),
    worksheetIds: new Set(),
    worksheetNames: new Set(),
    stringBytes: 0,
    imageBytes: 0,
    imageDataUrlBytes: 0,
    cells: 0,
    merges: 0,
    dimensionOverrides: 0,
    tables: 0,
    charts: 0,
    chartSeries: 0,
    chartPoints: 0,
    sparklineGroups: 0,
    sparklineCells: 0,
    sparklinePoints: 0,
    dataValidations: 0,
    conditionalFormats: 0,
    configNodes: 0,
    sparklineSheetReferences: [],
    images: 0,
    comments: 0,
    normalizedImages: [],
  };
  validateSnapshotCellFormat(value, "cell format", state);
  const normalized = structuredClone(value);
  if (normalized.font) Object.freeze(normalized.font);
  if (normalized.borders) {
    for (const key of [
      "top",
      "bottom",
      "left",
      "right",
      "insideHorizontal",
      "insideVertical",
    ] as const) {
      if (normalized.borders[key]) Object.freeze(normalized.borders[key]);
    }
    Object.freeze(normalized.borders);
  }
  Object.freeze(normalized);
  normalizedCellFormats.add(normalized);
  return normalized;
}

function serializeCellValue(value: CellValue): SerializedCellValue {
  return value instanceof Date ? { type: "date", value: value.toISOString() } : value;
}
function normalizeFormula(formula: string, limits?: Partial<FormulaEvaluationLimits>): string {
  // Gate the caller-owned string before trim/prepend can allocate a second oversized copy.
  validateFormulaLimits(formula, limits);
  const trimmed = formula.trim();
  const normalized = trimmed.startsWith("=") ? trimmed : `=${trimmed}`;
  validateFormulaLimits(normalized, limits);
  return normalized;
}
function resolveRecalculationLimits(
  overrides: Partial<SpreadsheetRecalculationLimits> = {},
): Readonly<SpreadsheetRecalculationLimits> {
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(SPREADSHEET_RECALCULATION_LIMITS, name)) {
      throw new TypeError(`Unknown recalculation limit: ${name}`);
    }
  }
  const limits = { ...SPREADSHEET_RECALCULATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const hardMaximum =
      SPREADSHEET_RECALCULATION_LIMITS[name as keyof SpreadsheetRecalculationLimits];
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardMaximum) {
      throw new TypeError(`${name} must be a positive safe integer no greater than ${hardMaximum}`);
    }
  }
  return Object.freeze(limits);
}
function validateSheetName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 31 || /[\\/?*[\]:]/.test(value))
    throw new Error(`Invalid worksheet name: ${name}`);
  return value;
}
function validateTableName(name: unknown): string {
  const value = normalizeLiveString(name, "table name");
  if (value.length === 0) throw new TypeError("Table name must not be empty");
  return value;
}
function maxColumns<T>(rows: Matrix<T>): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}
function assertRectangularMatrix<T>(values: Matrix<T>): number {
  if (values.length === 0) return 0;
  const columns = values[0]?.length ?? 0;
  if (values.some((row) => row.length !== columns))
    throw new Error("Matrix rows must have equal length");
  return columns;
}
function rectangularize<T>(values: Matrix<T>, fill: T): Matrix<T> {
  const columns = maxColumns(values);
  return values.map((row) => Array.from({ length: columns }, (_, col) => row[col] ?? fill));
}
function assertMatrixShape<T>(values: Matrix<T>, rows: number, columns: number): void {
  if (values.length !== rows || values.some((row) => row.length !== columns))
    throw new Error(`Matrix must be ${rows}x${columns}`);
}
function matrix<T>(
  rows: number,
  columns: number,
  getter: (rowIndex: number, colIndex: number) => T,
): Matrix<T> {
  return Array.from({ length: rows }, (_rowValue, rowIndex) =>
    Array.from({ length: columns }, (_columnValue, colIndex) => getter(rowIndex, colIndex)),
  );
}
function eachCell(
  address: RangeAddress,
  callback: (row: number, col: number, relativeRow: number, relativeCol: number) => void,
): void {
  for (let relativeRow = 0; relativeRow < address.rowCount; relativeRow += 1)
    for (let relativeCol = 0; relativeCol < address.colCount; relativeCol += 1)
      callback(address.row + relativeRow, address.col + relativeCol, relativeRow, relativeCol);
}
function assertSameShape(a: RangeAddress, b: RangeAddress): void {
  if (a.rowCount !== b.rowCount || a.colCount !== b.colCount)
    throw new Error("Source and destination ranges must have the same shape");
}
function sameRange(a: RangeAddress, b: RangeAddress): boolean {
  return (
    a.row === b.row && a.col === b.col && a.rowCount === b.rowCount && a.colCount === b.colCount
  );
}
function rangesOverlap(a: RangeAddress, b: RangeAddress): boolean {
  return (
    a.row < b.row + b.rowCount &&
    b.row < a.row + a.rowCount &&
    a.col < b.col + b.colCount &&
    b.col < a.col + a.colCount
  );
}
function mergeCellFormat(current: CellFormat, update: CellFormat): CellFormat {
  return {
    ...current,
    ...update,
    ...(update.font ? { font: { ...current.font, ...update.font } } : {}),
    ...(update.borders ? { borders: { ...current.borders, ...update.borders } } : {}),
  };
}
function truncateCell(value: FormulaResult, maxChars: number): FormulaResult {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
function quoteSheetName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}
function unquoteSheetName(name: string): string {
  return name.startsWith("'") && name.endsWith("'")
    ? name.slice(1, -1).replaceAll("''", "'")
    : name;
}
function parseQualifiedRange(input: string): {
  sheetName: string | null;
  address: RangeAddress;
} {
  const separator = input.lastIndexOf("!");
  if (separator < 0) return { sheetName: null, address: parseRangeAddress(input) };
  const sheetName = unquoteSheetName(input.slice(0, separator).trim());
  if (!sheetName) throw new Error(`Invalid sheet-qualified range: ${input}`);
  return {
    sheetName,
    address: parseRangeAddress(input.slice(separator + 1)),
  };
}
function reviveValue(value: SerializedCellValue): CellValue {
  return value !== null && typeof value === "object" ? new Date(value.value) : value;
}
function isSerializedChart(value: unknown): value is SerializedChart {
  return Boolean(value && typeof value === "object" && "id" in value && "sourceRange" in value);
}
function boundNdjson(records: readonly Record<string, unknown>[], maxChars: number): InspectResult {
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  const accepted: Record<string, unknown>[] = [];
  for (const record of records) {
    const line = JSON.stringify(record);
    if (chars + line.length + (lines.length > 0 ? 1 : 0) > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    accepted.push(record);
    chars += line.length + (lines.length > 1 ? 1 : 0);
  }
  return { ndjson: lines.join("\n"), records: accepted, truncated };
}
function parseCsv(input: string, delimiter: string): Matrix<CellValue> {
  if (delimiter.length !== 1) throw new Error("CSV delimiter must be one character");
  if (input.length === 0) return [];
  const rows: Matrix<CellValue> = [];
  let row: CellValue[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index <= input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else if (char === undefined) throw new Error("Unterminated quoted CSV field");
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === delimiter) {
      row.push(coerceCsv(field));
      field = "";
    } else if (char === "\n" || char === undefined) {
      row.push(coerceCsv(field.replace(/\r$/, "")));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (
    rows.length > 1 &&
    rows.at(-1)?.length === 1 &&
    rows.at(-1)?.[0] === null &&
    input.endsWith("\n")
  )
    rows.pop();
  return rows;
}
function coerceCsv(value: string): CellValue {
  if (value === "") return null;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value)) return Number(value);
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return value;
}

const HELP_ENTRIES: Array<
  Record<string, unknown> & {
    path: string;
    summary: string;
    examples: string[];
  }
> = [
  {
    path: "worksheet.getRange",
    summary: "Create an A1-addressed rectangular range",
    examples: ['sheet.getRange("A1:C10")'],
  },
  {
    path: "range.values",
    summary: "Read or bulk-write a rectangular value matrix",
    examples: ["range.values = [[1, 2]]"],
  },
  {
    path: "range.formulas",
    summary: "Read or bulk-write formulas",
    examples: ['range.formulas = [["=A1*2"]]'],
  },
  {
    path: "range.format",
    summary: "Apply fills, fonts, formats, borders, alignment, and sizing",
    examples: ['range.format = { fill: "#000", font: { bold: true } }'],
  },
  {
    path: "workbook.inspect",
    summary: "Inspect workbook structure, regions, formulas, styles, drawings, and comments",
    examples: ['await workbook.inspect({ kind: "sheet,formula" })'],
  },
  {
    path: "workbook.render",
    summary: "Render a sheet or range to PNG or SVG",
    examples: ['await workbook.render({ sheetName: "Sheet1", format: "png" })'],
  },
  {
    path: "workbook.trace",
    summary: "Trace formula precedents from one cell",
    examples: ['workbook.trace("Sheet1!A1")'],
  },
  {
    path: "chart.add",
    summary: "Add a worksheet chart from a range or configuration",
    examples: ['sheet.charts.add("line", sheet.getRange("A1:B4"))'],
  },
  {
    path: "sparklineGroups.add",
    summary:
      "Add a bounded line, column, or stacked sparkline group with explicit target and source ranges",
    examples: [
      'sheet.sparklineGroups.add({ type: "line", targetRange: "E2:E4", sourceData: "B2:D4" })',
      'sheet.getRange("E2:E4").sparklines.add("line", sheet.getRange("B2:D4"))',
    ],
  },
  {
    path: "comments.addThread",
    summary: "Add a threaded comment to one cell",
    examples: ['workbook.comments.addThread({ cell: sheet.getRange("A1") }, "Note")'],
  },
  { path: "fx.SUM", summary: "Sum numeric values", examples: ["=SUM(A1:A10)"] },
  {
    path: "fx.AVERAGE",
    summary: "Average numeric values",
    examples: ["=AVERAGE(A1:A10)"],
  },
  {
    path: "fx.XLOOKUP",
    summary: "Find a key and return a corresponding value",
    examples: ['=XLOOKUP(A1,B1:B10,C1:C10,"Missing")'],
  },
];
