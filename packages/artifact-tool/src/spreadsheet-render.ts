import { FileBlob } from "./file-blob";
import { ArtifactLimitError, UnsupportedArtifactFeatureError } from "./errors";
import { formatCellAddress, parseRangeAddress, type RangeAddress } from "./spreadsheet-address";
import { spreadsheetImageSource } from "./spreadsheet-image";
import type { Workbook, Worksheet } from "./spreadsheet";
import type { CellFormat, FormulaResult, RenderSpreadsheetOptions } from "./spreadsheet-types";

const MAX_RENDER_CELLS = 250_000;
const MAX_RENDER_DIMENSION = 16_384;
const MAX_RENDER_SPARKLINE_POINTS = 250_000;
const DEFAULT_BACKGROUND = "#ffffff";
const MAX_NUMBER_FORMAT_DECIMALS = 100;
const numberFormatters = new Map<string, Intl.NumberFormat>();

/** Render the canonical workbook model without requiring Excel or LibreOffice. */
export async function renderWorkbook(
  workbook: Workbook,
  options: RenderSpreadsheetOptions = {},
): Promise<FileBlob> {
  const format = options.format ?? "png";
  if (format !== "png" && format !== "svg") {
    throw new Error("Spreadsheet render format must be png or svg");
  }
  if (format === "png" && (typeof process === "undefined" || !process.versions?.node)) {
    throw new UnsupportedArtifactFeatureError("render", "Spreadsheet PNG rasterization", "browser");
  }
  const worksheet = options.sheetName
    ? workbook.worksheets.getItem(options.sheetName)
    : workbook.worksheets.getActiveWorksheet();
  const address = renderAddress(worksheet, options);
  const scale = options.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new Error("Spreadsheet render scale must be greater than 0 and at most 8");
  }

  const svg = renderSvg(workbook, worksheet, address, {
    background: options.background ?? DEFAULT_BACKGROUND,
    scale,
  });
  if (format === "svg") {
    return new FileBlob([svg], {
      type: "image/svg+xml",
      name: `${safeFileStem(worksheet.name)}.svg`,
    });
  }

  const moduleId = "@resvg/resvg-js";
  const { Resvg } = await import(/* @vite-ignore */ moduleId);
  const rendered = new Resvg(svg, {
    background: options.background ?? DEFAULT_BACKGROUND,
  }).render();
  return FileBlob.fromBytes(rendered.asPng(), {
    type: "image/png",
    name: `${safeFileStem(worksheet.name)}.png`,
  });
}

function renderAddress(worksheet: Worksheet, options: RenderSpreadsheetOptions): RangeAddress {
  if (options.range) return parseRangeAddress(options.range);
  let used = worksheet.usedRangeAddress();
  for (const chart of worksheet.charts.items) {
    if (chart.position)
      used = unionRanges(used, drawingRange(chart.position.from, chart.position.to));
  }
  for (const sparkline of worksheet.sparklineGroups.items) {
    used = unionRanges(used, sparkline.targetRange.address);
  }
  for (const image of worksheet.images.items) {
    const { from, extent } = image.config.anchor;
    const approximate = {
      row: from.row,
      col: from.col,
      rowCount: Math.max(1, Math.ceil(extent.heightPx / worksheet.rowHeight(from.row))),
      colCount: Math.max(1, Math.ceil(extent.widthPx / worksheet.columnWidth(from.col))),
    };
    used = unionRanges(used, approximate);
  }
  return used ?? { row: 0, col: 0, rowCount: 1, colCount: 1 };
}

function renderSvg(
  workbook: Workbook,
  worksheet: Worksheet,
  address: RangeAddress,
  options: { background: string; scale: number },
): string {
  const cellCount = address.rowCount * address.colCount;
  if (cellCount > MAX_RENDER_CELLS) {
    throw new Error(
      `Spreadsheet render range has ${cellCount.toLocaleString()} cells; maximum is ${MAX_RENDER_CELLS.toLocaleString()}`,
    );
  }

  const columns = cumulativeSizes(address.colCount, (index) =>
    worksheet.columnWidth(address.col + index),
  );
  const rows = cumulativeSizes(address.rowCount, (index) =>
    worksheet.rowHeight(address.row + index),
  );
  const logicalWidth = columns.at(-1) ?? 0;
  const logicalHeight = rows.at(-1) ?? 0;
  const width = logicalWidth * options.scale;
  const height = logicalHeight * options.scale;
  if (width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION) {
    throw new Error(
      `Spreadsheet render is ${Math.ceil(width)}x${Math.ceil(height)}px; each dimension must be at most ${MAX_RENDER_DIMENSION}px`,
    );
  }

  const definitions: string[] = [];
  const elements: string[] = [];
  elements.push(
    `<rect x="0" y="0" width="${number(width)}" height="${number(height)}" fill="${escapeAttribute(normalizeColor(options.background, DEFAULT_BACKGROUND))}"/>`,
  );
  elements.push(`<g transform="scale(${number(options.scale)})">`);

  if (worksheet.showGridLines) {
    const grid = gridPath(columns, rows);
    if (grid) {
      elements.push(
        `<path d="${grid}" fill="none" stroke="#d9dde3" stroke-width="1" vector-effect="non-scaling-stroke" shape-rendering="crispEdges"/>`,
      );
    }
  }

  const merges = worksheet.mergeRegions().filter((merge) => rangesOverlap(merge, address));
  const entries = [...worksheet.cellEntries()]
    .filter(({ row, col }) => contains(address, row, col))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const mergeIndexByCell = indexMerges(merges, address);
  const storedCellIndexes = new Set(
    entries.map(({ row, col }) => cellIndexInRange(address, row, col)),
  );

  for (const { row, col, data } of entries) {
    const mergeIndex = mergeIndexByCell[cellIndexInRange(address, row, col)] ?? -1;
    const merge = mergeIndex < 0 ? undefined : merges[mergeIndex];
    if (merge && (merge.row !== row || merge.col !== col)) continue;
    const bounds = cellBounds(
      merge ? intersect(merge, address) : { row, col, rowCount: 1, colCount: 1 },
      address,
      columns,
      rows,
    );
    if (!bounds) continue;
    renderCell(
      elements,
      definitions,
      bounds,
      data.format,
      workbook.valueAt(worksheet, { row, col }),
      `cell-${row}-${col}`,
      options.background,
    );
  }

  // A merge can exist without a stored top-left cell. Paint it over internal gridlines.
  for (const merge of merges) {
    const topLeftIndex = cellIndexInRange(address, merge.row, merge.col);
    if (topLeftIndex >= 0 && storedCellIndexes.has(topLeftIndex)) continue;
    const bounds = cellBounds(intersect(merge, address), address, columns, rows);
    if (!bounds) continue;
    elements.push(
      `<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" fill="${escapeAttribute(normalizeColor(options.background, DEFAULT_BACKGROUND))}" stroke="#d9dde3"/>`,
    );
  }

  renderSparklines(elements, worksheet, address, columns, rows);
  renderDrawings(elements, worksheet, address, columns, rows);

  elements.push("</g>");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="0 0 ${number(width)} ${number(height)}">`,
    definitions.length > 0 ? `<defs>${definitions.join("")}</defs>` : "",
    ...elements,
    "</svg>",
  ].join("");
}

/**
 * Merges are non-overlapping canonical model objects. Index only their visible
 * intersections, whose aggregate area cannot exceed the already-bounded render
 * range. This keeps lookup linear in visible cells instead of cells × merges.
 */
function indexMerges(merges: readonly RangeAddress[], viewport: RangeAddress): Int32Array {
  const indexes = new Int32Array(viewport.rowCount * viewport.colCount);
  indexes.fill(-1);
  for (let mergeIndex = 0; mergeIndex < merges.length; mergeIndex += 1) {
    const visible = intersect(merges[mergeIndex]!, viewport);
    const firstColumn = visible.col - viewport.col;
    for (let row = visible.row; row < visible.row + visible.rowCount; row += 1) {
      const start = (row - viewport.row) * viewport.colCount + firstColumn;
      indexes.fill(mergeIndex, start, start + visible.colCount);
    }
  }
  return indexes;
}

function cellIndexInRange(range: RangeAddress, row: number, col: number): number {
  if (!contains(range, row, col)) return -1;
  return (row - range.row) * range.colCount + col - range.col;
}

type Bounds = { x: number; y: number; width: number; height: number };

function renderCell(
  elements: string[],
  definitions: string[],
  bounds: Bounds,
  format: CellFormat,
  value: FormulaResult,
  id: string,
  background: string,
): void {
  const fill = normalizeColor(format.fill, background);
  const border = borderMarkup(bounds, format);
  if (format.fill || border) {
    elements.push(
      `<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" fill="${escapeAttribute(fill)}"/>`,
    );
  }
  if (border) elements.push(border);

  const text = displayValue(value, format.numberFormat);
  if (!text) return;
  const fontSize = clamp(format.font?.size ?? 12, 6, 72);
  const padding = 6;
  const contentWidth = Math.max(1, bounds.width - padding * 2);
  const lines = format.wrapText
    ? wrapLines(text, contentWidth, fontSize)
    : [text.replaceAll(/\r?\n/g, " ")];
  const lineHeight = fontSize * 1.25;
  const textHeight = lines.length * lineHeight;
  const vertical = format.verticalAlignment ?? "center";
  const startY =
    vertical === "top"
      ? bounds.y + padding + fontSize
      : vertical === "bottom"
        ? bounds.y + bounds.height - padding - textHeight + fontSize
        : bounds.y + (bounds.height - textHeight) / 2 + fontSize;
  const horizontal = format.horizontalAlignment ?? inferredAlignment(value);
  const anchor = horizontal === "center" ? "middle" : horizontal === "right" ? "end" : "start";
  const x =
    horizontal === "center"
      ? bounds.x + bounds.width / 2
      : horizontal === "right"
        ? bounds.x + bounds.width - padding
        : bounds.x + padding;
  const clipId = `clip-${id}`;
  definitions.push(
    `<clipPath id="${clipId}"><rect x="${number(bounds.x + 1)}" y="${number(bounds.y + 1)}" width="${number(Math.max(0, bounds.width - 2))}" height="${number(Math.max(0, bounds.height - 2))}"/></clipPath>`,
  );
  const decoration = format.font?.underline ? ' text-decoration="underline"' : "";
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${number(x)}" y="${number(startY + index * lineHeight)}">${escapeText(line)}</tspan>`,
    )
    .join("");
  elements.push(
    `<text clip-path="url(#${clipId})" text-anchor="${anchor}" font-family="${escapeAttribute(format.font?.name ?? "Arial, sans-serif")}" font-size="${number(fontSize)}" font-weight="${format.font?.bold ? "700" : "400"}" font-style="${format.font?.italic ? "italic" : "normal"}" fill="${escapeAttribute(normalizeColor(format.font?.color, "#111827"))}"${decoration}>${tspans}</text>`,
  );
}

function borderMarkup(bounds: Bounds, format: CellFormat): string {
  const borders = format.borders;
  if (!borders || borders.preset === "none") return "";
  const fallback: import("./spreadsheet-types").BorderConfig | undefined =
    borders.style || borders.preset
      ? {
          ...(borders.style ? { style: borders.style } : {}),
          ...(borders.color ? { color: borders.color } : {}),
        }
      : undefined;
  const sides = {
    top:
      borders.top ??
      (borders.preset === "all" || borders.preset === "outside" ? fallback : undefined),
    right:
      borders.right ??
      (borders.preset === "all" || borders.preset === "outside" ? fallback : undefined),
    bottom:
      borders.bottom ??
      (borders.preset === "all" || borders.preset === "outside" || borders.preset === "doubleBottom"
        ? fallback
        : undefined),
    left:
      borders.left ??
      (borders.preset === "all" || borders.preset === "outside" ? fallback : undefined),
  };
  const commands: string[] = [];
  const lines: string[] = [];
  const append = (
    side: keyof typeof sides,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void => {
    const config = sides[side];
    if (!config) return;
    const weight = clamp(config.weight ?? (config.style === "thick" ? 3 : 1), 0.5, 8);
    commands.push(`M${number(x1)} ${number(y1)}L${number(x2)} ${number(y2)}`);
    lines.push(
      `<path d="${commands.pop()}" fill="none" stroke="${escapeAttribute(normalizeColor(config.color, borders.color ?? "#4b5563"))}" stroke-width="${number(weight)}" vector-effect="non-scaling-stroke"/>`,
    );
    if (config.style === "double" || (side === "bottom" && borders.preset === "doubleBottom")) {
      const offset = 3;
      const vertical = x1 === x2;
      lines.push(
        `<path d="M${number(x1 + (vertical ? offset : 0))} ${number(y1 + (vertical ? 0 : -offset))}L${number(x2 + (vertical ? offset : 0))} ${number(y2 + (vertical ? 0 : -offset))}" fill="none" stroke="${escapeAttribute(normalizeColor(config.color, borders.color ?? "#4b5563"))}" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
      );
    }
  };
  append("top", bounds.x, bounds.y, bounds.x + bounds.width, bounds.y);
  append(
    "right",
    bounds.x + bounds.width,
    bounds.y,
    bounds.x + bounds.width,
    bounds.y + bounds.height,
  );
  append(
    "bottom",
    bounds.x,
    bounds.y + bounds.height,
    bounds.x + bounds.width,
    bounds.y + bounds.height,
  );
  append("left", bounds.x, bounds.y, bounds.x, bounds.y + bounds.height);
  return lines.join("");
}

function gridPath(columns: readonly number[], rows: readonly number[]): string {
  const width = columns.at(-1) ?? 0;
  const height = rows.at(-1) ?? 0;
  const commands: string[] = [];
  for (const x of columns) commands.push(`M${number(x)} 0V${number(height)}`);
  for (const y of rows) commands.push(`M0 ${number(y)}H${number(width)}`);
  return commands.join("");
}

function cumulativeSizes(count: number, sizeAt: (index: number) => number): number[] {
  const values = new Array<number>(count + 1);
  values[0] = 0;
  for (let index = 0; index < count; index += 1) {
    values[index + 1] = values[index]! + clamp(sizeAt(index), 1, MAX_RENDER_DIMENSION);
  }
  return values;
}

function cellBounds(
  cell: RangeAddress,
  viewport: RangeAddress,
  columns: readonly number[],
  rows: readonly number[],
): Bounds | null {
  const relativeCol = cell.col - viewport.col;
  const relativeRow = cell.row - viewport.row;
  const endCol = relativeCol + cell.colCount;
  const endRow = relativeRow + cell.rowCount;
  const x = columns[relativeCol];
  const y = rows[relativeRow];
  const endX = columns[endCol];
  const endY = rows[endRow];
  if (x === undefined || y === undefined || endX === undefined || endY === undefined) return null;
  return { x, y, width: endX - x, height: endY - y };
}

function displayValue(value: FormulaResult, numberFormat?: string): string {
  if (value === null) return "";
  if (value instanceof Date) {
    if (numberFormat?.includes("h") || numberFormat?.includes("s")) return value.toISOString();
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    const decimals = decimalPlaces(numberFormat);
    const useGrouping = numberFormat?.includes(",") ?? false;
    const formatted = (numericValue: number): string =>
      formatNumber(numericValue, decimals, useGrouping);
    if (numberFormat?.includes("%")) return `${formatted(value * 100)}%`;
    if (numberFormat?.includes("$")) return `$${formatted(value)}`;
    if (numberFormat?.includes("€")) return `€${formatted(value)}`;
    if (numberFormat?.includes("£")) return `£${formatted(value)}`;
    return formatted(value);
  }
  return String(value);
}

function formatNumber(value: number, decimals?: number, useGrouping = false): string {
  if (!Number.isFinite(value)) return String(value);
  const normalizedDecimals =
    decimals === undefined
      ? undefined
      : Math.max(0, Math.min(MAX_NUMBER_FORMAT_DECIMALS, Math.floor(decimals)));
  const key = `${normalizedDecimals ?? "auto"}:${useGrouping ? 1 : 0}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      ...(normalizedDecimals === undefined
        ? { maximumFractionDigits: 12 }
        : {
            minimumFractionDigits: normalizedDecimals,
            maximumFractionDigits: normalizedDecimals,
          }),
      useGrouping,
    });
    numberFormatters.set(key, formatter);
  }
  return formatter.format(value);
}

function decimalPlaces(numberFormat: string | undefined): number | undefined {
  if (!numberFormat) return undefined;
  const decimal = /\.([0#]+)/.exec(numberFormat);
  if (!decimal) return 0;
  return decimal[1]?.length ?? 0;
}

function renderDrawings(
  elements: string[],
  worksheet: Worksheet,
  viewport: RangeAddress,
  columns: readonly number[],
  rows: readonly number[],
): void {
  for (const image of worksheet.images.items) {
    const { from, extent } = image.config.anchor;
    if (!contains(viewport, from.row, from.col)) continue;
    const x = columns[from.col - viewport.col];
    const y = rows[from.row - viewport.row];
    if (x === undefined || y === undefined) continue;
    const source = spreadsheetImageSource(image.config);
    elements.push(
      `<image x="${number(x)}" y="${number(y)}" width="${number(extent.widthPx)}" height="${number(extent.heightPx)}" href="${escapeAttribute(source)}" preserveAspectRatio="xMidYMid meet">${image.config.alt ? `<title>${escapeText(image.config.alt)}</title>` : ""}</image>`,
    );
  }

  for (const chart of worksheet.charts.items) {
    if (!chart.position) continue;
    const range = drawingRange(chart.position.from, chart.position.to);
    if (!rangesOverlap(range, viewport)) continue;
    const visible = intersect(range, viewport);
    const bounds = cellBounds(visible, viewport, columns, rows);
    if (!bounds || bounds.width < 40 || bounds.height < 40) continue;
    renderChart(elements, bounds, chart);
  }
}

function renderSparklines(
  elements: string[],
  worksheet: Worksheet,
  viewport: RangeAddress,
  columns: readonly number[],
  rows: readonly number[],
): void {
  let renderedPoints = 0;
  for (const group of worksheet.sparklineGroups.items) {
    const visible = intersect(group.targetRange.address, viewport);
    if (visible.rowCount <= 0 || visible.colCount <= 0) continue;
    const groupPoints =
      visible.rowCount * visible.colCount * group.resourceUsage.pointsPerSparkline;
    renderedPoints += groupPoints;
    if (renderedPoints > MAX_RENDER_SPARKLINE_POINTS) {
      throw new ArtifactLimitError(
        "spreadsheet rendered sparkline points",
        renderedPoints,
        MAX_RENDER_SPARKLINE_POINTS,
      );
    }
    const dateAxis = group.dateAxisValues();
    const axis = group.axis;
    const markers = group.markers;
    const colors = {
      series: normalizeColor(group.seriesColor, "#2563eb"),
      negative: normalizeColor(group.negativeColor, "#dc2626"),
      axis: normalizeColor(group.axisColor, "#64748b"),
      markers: normalizeColor(group.markersColor, group.seriesColor ?? "#2563eb"),
      first: normalizeColor(group.firstMarkerColor, group.seriesColor ?? "#2563eb"),
      last: normalizeColor(group.lastMarkerColor, group.seriesColor ?? "#2563eb"),
      high: normalizeColor(group.highMarkerColor, "#16a34a"),
      low: normalizeColor(group.lowMarkerColor, "#dc2626"),
    };
    for (let row = visible.row; row < visible.row + visible.rowCount; row += 1) {
      for (let col = visible.col; col < visible.col + visible.colCount; col += 1) {
        const bounds = cellBounds({ row, col, rowCount: 1, colCount: 1 }, viewport, columns, rows);
        if (!bounds || bounds.width < 8 || bounds.height < 8) continue;
        const values = group.valuesForTargetCell(row, col);
        if (!values.some((value) => value !== null)) continue;
        const plot = {
          x: bounds.x + 4,
          y: bounds.y + 4,
          width: Math.max(1, bounds.width - 8),
          height: Math.max(1, bounds.height - 8),
        };
        elements.push(
          `<g data-opengeni-sparkline="${escapeAttribute(group.id)}" data-target="${escapeAttribute(formatCellAddress({ row, col }))}">`,
        );
        renderSparkline(elements, plot, values, dateAxis, group.type, {
          axis,
          markers,
          colors,
          lineWeight: group.lineWeight,
          connectEmpty: group.displayEmptyCellsAs === 2,
        });
        elements.push("</g>");
      }
    }
  }
}

function renderSparkline(
  elements: string[],
  plot: Bounds,
  inputValues: readonly (number | null)[],
  dateAxis: readonly (number | null)[] | null,
  type: "line" | "column" | "stacked",
  options: {
    axis: Readonly<{
      showAxis?: boolean;
      manualMin?: number;
      manualMax?: number;
      rightToLeft?: boolean;
    }>;
    markers: Readonly<{
      show: boolean;
      high: boolean;
      low: boolean;
      first: boolean;
      last: boolean;
      negative: boolean;
    }>;
    colors: {
      series: string;
      negative: string;
      axis: string;
      markers: string;
      first: string;
      last: string;
      high: string;
      low: string;
    };
    lineWeight: number;
    connectEmpty: boolean;
  },
): void {
  const values = options.axis.rightToLeft ? [...inputValues].reverse() : [...inputValues];
  const dates = options.axis.rightToLeft && dateAxis ? [...dateAxis].reverse() : dateAxis;
  const numeric = numericSparklineExtent(values);
  if (numeric.count === 0) return;

  if (type === "stacked") {
    renderStackedSparkline(elements, plot, values, options);
    return;
  }

  const includeZero = type === "column" || options.axis.showAxis;
  let minimum = options.axis.manualMin ?? (includeZero ? Math.min(0, numeric.min) : numeric.min);
  let maximum = options.axis.manualMax ?? (includeZero ? Math.max(0, numeric.max) : numeric.max);
  if (minimum >= maximum) {
    const padding = Math.max(1, Math.abs(minimum) * 0.05);
    minimum -= padding;
    maximum += padding;
  }
  const span = maximum - minimum;
  const baseline = plot.y + ((maximum - clamp(0, minimum, maximum)) / span) * plot.height;
  if (options.axis.showAxis && minimum <= 0 && maximum >= 0) {
    elements.push(
      `<path d="M${number(plot.x)} ${number(baseline)}H${number(plot.x + plot.width)}" fill="none" stroke="${escapeAttribute(options.colors.axis)}" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
    );
  }

  if (type === "column") {
    const slot = plot.width / Math.max(1, values.length);
    const width = Math.max(1, slot * 0.62);
    values.forEach((value, index) => {
      if (value === null) return;
      const y = plot.y + ((maximum - clamp(value, minimum, maximum)) / span) * plot.height;
      const top = Math.min(y, baseline);
      const height = Math.max(0.75, Math.abs(baseline - y));
      elements.push(
        `<rect x="${number(plot.x + index * slot + (slot - width) / 2)}" y="${number(top)}" width="${number(width)}" height="${number(height)}" fill="${escapeAttribute(value < 0 ? options.colors.negative : options.colors.series)}"/>`,
      );
    });
    return;
  }

  const xPositions = sparklineXPositions(values.length, dates, plot);
  const points = values.map((value, index) =>
    value === null
      ? null
      : {
          x: xPositions[index]!,
          y: plot.y + ((maximum - clamp(value, minimum, maximum)) / span) * plot.height,
          value,
          index,
        },
  );
  const segments: Array<Array<NonNullable<(typeof points)[number]>>> = [];
  let segment: Array<NonNullable<(typeof points)[number]>> = [];
  for (const point of points) {
    if (point) {
      segment.push(point);
      continue;
    }
    if (!options.connectEmpty && segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
  }
  if (segment.length > 0) segments.push(segment);
  for (const line of segments) {
    if (line.length === 1) {
      elements.push(
        `<circle cx="${number(line[0]!.x)}" cy="${number(line[0]!.y)}" r="${number(Math.max(1, options.lineWeight))}" fill="${escapeAttribute(options.colors.series)}"/>`,
      );
    } else {
      elements.push(
        `<polyline points="${line.map((point) => `${number(point.x)},${number(point.y)}`).join(" ")}" fill="none" stroke="${escapeAttribute(options.colors.series)}" stroke-width="${number(options.lineWeight)}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`,
      );
    }
  }

  const firstIndex = points.findIndex((point) => point !== null);
  let lastIndex = -1;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (points[index] !== null) {
      lastIndex = index;
      break;
    }
  }
  const high = numeric.max;
  const low = numeric.min;
  for (const point of points) {
    if (!point) continue;
    const special =
      options.markers.show ||
      (options.markers.first && point.index === firstIndex) ||
      (options.markers.last && point.index === lastIndex) ||
      (options.markers.high && point.value === high) ||
      (options.markers.low && point.value === low) ||
      (options.markers.negative && point.value < 0);
    if (!special) continue;
    const color =
      options.markers.negative && point.value < 0
        ? options.colors.negative
        : options.markers.high && point.value === high
          ? options.colors.high
          : options.markers.low && point.value === low
            ? options.colors.low
            : options.markers.first && point.index === firstIndex
              ? options.colors.first
              : options.markers.last && point.index === lastIndex
                ? options.colors.last
                : options.colors.markers;
    elements.push(
      `<circle cx="${number(point.x)}" cy="${number(point.y)}" r="${number(Math.max(1.5, options.lineWeight + 0.5))}" fill="${escapeAttribute(color)}"/>`,
    );
  }
}

function renderStackedSparkline(
  elements: string[],
  plot: Bounds,
  values: readonly (number | null)[],
  options: {
    colors: { series: string; negative: string; axis: string };
    axis: Readonly<{ showAxis?: boolean }>;
  },
): void {
  const baseline = plot.y + plot.height / 2;
  if (options.axis.showAxis) {
    elements.push(
      `<path d="M${number(plot.x)} ${number(baseline)}H${number(plot.x + plot.width)}" fill="none" stroke="${escapeAttribute(options.colors.axis)}" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
    );
  }
  const slot = plot.width / Math.max(1, values.length);
  const width = Math.max(1, slot * 0.62);
  const height = Math.max(1, plot.height * 0.42);
  values.forEach((value, index) => {
    if (value === null || value === 0) return;
    elements.push(
      `<rect x="${number(plot.x + index * slot + (slot - width) / 2)}" y="${number(value > 0 ? baseline - height : baseline)}" width="${number(width)}" height="${number(height)}" fill="${escapeAttribute(value < 0 ? options.colors.negative : options.colors.series)}"/>`,
    );
  });
}

function sparklineXPositions(
  count: number,
  dateAxis: readonly (number | null)[] | null,
  plot: Bounds,
): number[] {
  if (count === 1) return [plot.x + plot.width / 2];
  if (
    dateAxis &&
    dateAxis.length === count &&
    dateAxis.every((value): value is number => value !== null)
  ) {
    const extent = numericSparklineExtent(dateAxis);
    const minimum = extent.min;
    const maximum = extent.max;
    if (minimum < maximum) {
      return dateAxis.map(
        (value) => plot.x + ((value - minimum) / (maximum - minimum)) * plot.width,
      );
    }
  }
  return Array.from(
    { length: count },
    (_, index) => plot.x + (index / Math.max(1, count - 1)) * plot.width,
  );
}

function numericSparklineExtent(values: readonly (number | null)[]): {
  min: number;
  max: number;
  count: number;
} {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const value of values) {
    if (value === null) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    count += 1;
  }
  return { min, max, count };
}

function renderChart(
  elements: string[],
  bounds: Bounds,
  chart: Worksheet["charts"]["items"][number],
): void {
  const titleHeight = chart.title ? 30 : 12;
  const plot = {
    x: bounds.x + 40,
    y: bounds.y + titleHeight + 8,
    width: Math.max(1, bounds.width - 56),
    height: Math.max(1, bounds.height - titleHeight - 34),
  };
  elements.push(
    `<g data-opengeni-chart="${escapeAttribute(chart.id)}"><rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" rx="6" fill="#ffffff" stroke="#cbd5e1"/>`,
  );
  if (chart.title) {
    elements.push(
      `<text x="${number(bounds.x + bounds.width / 2)}" y="${number(bounds.y + 20)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="700" fill="#0f172a">${escapeText(chart.title)}</text>`,
    );
  }

  const series = chart.series.items.filter((item) => item.values && item.values.length > 0);
  const values = series.flatMap((item) => item.values ?? []);
  if (series.length === 0 || values.length === 0) {
    elements.push(
      `<text x="${number(bounds.x + bounds.width / 2)}" y="${number(bounds.y + bounds.height / 2)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#64748b">${escapeText(chart.type)} chart</text></g>`,
    );
    return;
  }

  if (chart.type === "pie" || chart.type === "doughnut") {
    renderPie(elements, plot, series[0]!.values ?? [], chart.type === "doughnut");
  } else if (
    chart.type === "bar" ||
    chart.type === "histogram" ||
    chart.type === "waterfall" ||
    chart.type === "funnel"
  ) {
    renderBars(elements, plot, series);
  } else {
    renderLines(elements, plot, series, chart.type === "area");
  }
  elements.push("</g>");
}

function renderBars(
  elements: string[],
  plot: Bounds,
  series: Worksheet["charts"]["items"][number]["series"]["items"],
): void {
  const values = series.flatMap((item) => item.values ?? []);
  const maximum = Math.max(0, ...values);
  const minimum = Math.min(0, ...values);
  const span = maximum - minimum || 1;
  const categories = Math.max(...series.map((item) => item.values?.length ?? 0));
  const groupWidth = plot.width / Math.max(1, categories);
  const barWidth = Math.max(1, (groupWidth * 0.72) / series.length);
  const baseline = plot.y + (maximum / span) * plot.height;
  elements.push(
    `<path d="M${number(plot.x)} ${number(baseline)}H${number(plot.x + plot.width)}" stroke="#94a3b8" fill="none"/>`,
  );
  series.forEach((item, seriesIndex) => {
    (item.values ?? []).forEach((value, categoryIndex) => {
      const height = Math.abs(value / span) * plot.height;
      const x = plot.x + categoryIndex * groupWidth + groupWidth * 0.14 + seriesIndex * barWidth;
      const y = value >= 0 ? baseline - height : baseline;
      elements.push(
        `<rect x="${number(x)}" y="${number(y)}" width="${number(Math.max(1, barWidth - 1))}" height="${number(height)}" fill="${escapeAttribute(chartColor(item.fill, seriesIndex))}"/>`,
      );
    });
  });
}

function renderLines(
  elements: string[],
  plot: Bounds,
  series: Worksheet["charts"]["items"][number]["series"]["items"],
  area: boolean,
): void {
  const all = series.flatMap((item) => item.values ?? []);
  const maximum = Math.max(...all);
  const minimum = Math.min(...all);
  const span = maximum - minimum || 1;
  series.forEach((item, seriesIndex) => {
    const values = item.values ?? [];
    const points = values.map((value, index) => {
      const x = plot.x + (index / Math.max(1, values.length - 1)) * plot.width;
      const y = plot.y + ((maximum - value) / span) * plot.height;
      return { x, y };
    });
    if (points.length === 0) return;
    const color = chartColor(item.fill, seriesIndex);
    const pointText = points.map((point) => `${number(point.x)},${number(point.y)}`).join(" ");
    if (area) {
      elements.push(
        `<polygon points="${number(points[0]!.x)},${number(plot.y + plot.height)} ${pointText} ${number(points.at(-1)!.x)},${number(plot.y + plot.height)}" fill="${escapeAttribute(color)}" fill-opacity="0.22"/>`,
      );
    }
    elements.push(
      `<polyline points="${pointText}" fill="none" stroke="${escapeAttribute(color)}" stroke-width="2"/>`,
    );
    for (const point of points) {
      elements.push(
        `<circle cx="${number(point.x)}" cy="${number(point.y)}" r="2.5" fill="${escapeAttribute(color)}"/>`,
      );
    }
  });
}

function renderPie(
  elements: string[],
  plot: Bounds,
  values: readonly number[],
  doughnut: boolean,
): void {
  const positive = values.map((value) => Math.max(0, value));
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return;
  const radius = Math.max(1, Math.min(plot.width, plot.height) / 2);
  const centerX = plot.x + plot.width / 2;
  const centerY = plot.y + plot.height / 2;
  let angle = -Math.PI / 2;
  positive.forEach((value, index) => {
    if (value <= 0) return;
    const next = angle + (value / total) * Math.PI * 2;
    const start = polar(centerX, centerY, radius, angle);
    const end = polar(centerX, centerY, radius, next);
    const large = next - angle > Math.PI ? 1 : 0;
    elements.push(
      `<path d="M${number(centerX)} ${number(centerY)}L${number(start.x)} ${number(start.y)}A${number(radius)} ${number(radius)} 0 ${large} 1 ${number(end.x)} ${number(end.y)}Z" fill="${chartColor(undefined, index)}"/>`,
    );
    angle = next;
  });
  if (doughnut) {
    elements.push(
      `<circle cx="${number(centerX)}" cy="${number(centerY)}" r="${number(radius * 0.52)}" fill="#ffffff"/>`,
    );
  }
}

function polar(x: number, y: number, radius: number, angle: number): { x: number; y: number } {
  return { x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius };
}

function chartColor(value: string | undefined, index: number): string {
  if (value) return normalizeColor(value, "#2563eb");
  return ["#2563eb", "#0d9488", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"][index % 6]!;
}

function drawingRange(from: RangeAddress, to: RangeAddress): RangeAddress {
  return {
    row: from.row,
    col: from.col,
    rowCount: Math.max(1, to.row + to.rowCount - from.row),
    colCount: Math.max(1, to.col + to.colCount - from.col),
  };
}

function unionRanges(a: RangeAddress | null, b: RangeAddress): RangeAddress {
  if (!a) return { ...b };
  const row = Math.min(a.row, b.row);
  const col = Math.min(a.col, b.col);
  const endRow = Math.max(a.row + a.rowCount, b.row + b.rowCount);
  const endCol = Math.max(a.col + a.colCount, b.col + b.colCount);
  return { row, col, rowCount: endRow - row, colCount: endCol - col };
}

function wrapLines(value: string, width: number, fontSize: number): string[] {
  const maxCharacters = Math.max(1, Math.floor(width / Math.max(1, fontSize * 0.56)));
  const lines: string[] = [];
  for (const explicitLine of value.split(/\r?\n/)) {
    const words = explicitLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (word.length > maxCharacters) {
        if (line) lines.push(line);
        for (let index = 0; index < word.length; index += maxCharacters) {
          lines.push(word.slice(index, index + maxCharacters));
        }
        line = "";
      } else if (!line) {
        line = word;
      } else if (line.length + word.length + 1 <= maxCharacters) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.slice(0, 512);
}

function intersect(a: RangeAddress, b: RangeAddress): RangeAddress {
  const row = Math.max(a.row, b.row);
  const col = Math.max(a.col, b.col);
  const endRow = Math.min(a.row + a.rowCount, b.row + b.rowCount);
  const endCol = Math.min(a.col + a.colCount, b.col + b.colCount);
  return { row, col, rowCount: endRow - row, colCount: endCol - col };
}

function rangesOverlap(a: RangeAddress, b: RangeAddress): boolean {
  return (
    a.row < b.row + b.rowCount &&
    b.row < a.row + a.rowCount &&
    a.col < b.col + b.colCount &&
    b.col < a.col + a.colCount
  );
}

function contains(address: RangeAddress, row: number, col: number): boolean {
  return (
    row >= address.row &&
    col >= address.col &&
    row < address.row + address.rowCount &&
    col < address.col + address.colCount
  );
}

function inferredAlignment(value: FormulaResult): "left" | "right" {
  return typeof value === "number" || value instanceof Date ? "right" : "left";
}

function normalizeColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  if (/^#[0-9a-f]{6}$/i.test(color) || /^#[0-9a-f]{3}$/i.test(color)) return color;
  if (/^[0-9a-f]{6}$/i.test(color)) return `#${color}`;
  if (/^[0-9a-f]{8}$/i.test(color)) return `#${color.slice(2)}`;
  if (/^(?:rgb|hsl)a?\(/i.test(color) || /^[a-z]+$/i.test(color)) return color;
  return fallback;
}

function safeFileStem(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "sheet";
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

function number(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
