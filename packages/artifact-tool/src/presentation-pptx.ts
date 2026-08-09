import { FileBlob } from "./file-blob";
import {
  presentationColorValue,
  PresentationFile,
  type Presentation,
  type PresentationChart,
  type PresentationFill,
  type PresentationImage,
  type PresentationLine,
  type PresentationPosition,
  type PresentationGroup,
  type PresentationShape,
  type PresentationTable,
} from "./presentation";
import {
  PPTX_MEDIA_TYPE,
  PresentationFidelityError,
  type PresentationPptxExportOptions,
} from "./presentation-pptx-api";
import { presentationModelDigest, sha256Hex } from "./presentation-pptx-state-digest";
import { presentationLossState } from "./presentation-pptx-state";

export { importPresentationPptx } from "./presentation-pptx-import";

const colorValue = presentationColorValue;

export async function exportPresentationPptx(
  presentation: Presentation,
  options: PresentationPptxExportOptions = {},
): Promise<FileBlob> {
  const provenance = presentationLossState(presentation);
  if (provenance) {
    const [currentModelDigest, actualSourceDigest] = await Promise.all([
      presentationModelDigest(presentation),
      sha256Hex(provenance.sourceBytes),
    ]);
    const sourceBindingValid =
      provenance.version === 1 &&
      provenance.mediaType === PPTX_MEDIA_TYPE &&
      provenance.sourceDigest === actualSourceDigest;
    if (sourceBindingValid && provenance.modelDigest === currentModelDigest) {
      return FileBlob.fromBytes(provenance.sourceBytes, {
        name: options.fileName ?? "presentation.pptx",
        type: PPTX_MEDIA_TYPE,
      });
    }
    if (!sourceBindingValid && options.unsupportedContent !== "discard") {
      throw new PresentationFidelityError(
        "PPTX source-preservation envelope is invalid or no longer matches its source bytes",
        [
          {
            code: "content-will-be-discarded",
            severity: "error",
            feature: "source-only",
            message: "The retained source package failed its digest or version binding",
            parts: [...provenance.unsupportedParts],
          },
        ],
      );
    }
  }
  const issues = PresentationFile.fidelityReport(presentation).map((issue) => ({
    ...issue,
    severity: "error" as const,
    code: "content-will-be-discarded" as const,
  }));
  if (issues.length > 0 && options.unsupportedContent !== "discard") {
    throw new PresentationFidelityError(
      'PPTX export would discard source-only presentation content; use unsupportedContent: "discard" only when that loss is intended',
      issues,
    );
  }
  const { default: PptxConstructor } = await import("pptxgenjs");
  const pptx = new PptxConstructor() as unknown as PptxRuntime;
  pptx.defineLayout({
    name: "OPENGENI_CUSTOM",
    width: presentation.slideSize.width / 96,
    height: presentation.slideSize.height / 96,
  });
  pptx.layout = "OPENGENI_CUSTOM";
  pptx.author = "OpenGeni";

  for (const slide of presentation.slides.items) {
    const target = pptx.addSlide();
    target.background = { color: pptxColor(slide.background.fill) };
    for (const element of slide.elements) {
      if ("geometry" in element && "text" in element) exportShapeToPptx(target, element);
      else if ("series" in element) exportChartToPptx(target, element);
      else if ("sourceForPptx" in element) exportImageToPptx(target, element);
      else if ("rows" in element) exportTableToPptx(target, element);
      else if ("children" in element) exportGroupToPptx(target, element);
    }
    if (slide.notes.toString().length > 0) target.addNotes(slide.notes.toString());
  }

  const output = await pptx.write({ outputType: "arraybuffer" });
  const bytes =
    output instanceof Uint8Array
      ? output
      : output instanceof ArrayBuffer
        ? new Uint8Array(output)
        : typeof output === "string"
          ? new TextEncoder().encode(output)
          : undefined;
  if (!bytes) throw new Error("PPTX writer returned an unsupported output type");
  const canonicalBytes = await canonicalizeGeneratedPptx(bytes);
  return FileBlob.fromBytes(canonicalBytes, {
    name: options.fileName ?? "presentation.pptx",
    type: PPTX_MEDIA_TYPE,
  });
}

async function canonicalizeGeneratedPptx(bytes: Uint8Array): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const source = await JSZip.loadAsync(bytes);
  const chartIds = Object.keys(source.files)
    .map((name) => /^ppt\/charts\/chart(\d+)\.xml$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right);
  const chartIdMap = new Map(chartIds.map((id, index) => [id, index + 1]));
  const rename = (value: string): string =>
    value
      .replace(/chart(\d+)\.xml/g, (match, raw: string) => {
        const replacement = chartIdMap.get(Number(raw));
        return replacement === undefined ? match : `chart${replacement}.xml`;
      })
      .replace(/Microsoft_Excel_Worksheet(\d+)\.xlsx/g, (match, raw: string) => {
        const replacement = chartIdMap.get(Number(raw));
        return replacement === undefined ? match : `Microsoft_Excel_Worksheet${replacement}.xlsx`;
      });
  return await canonicalizeGeneratedZip(source, rename, true);
}

async function canonicalizeGeneratedZip(
  source: GeneratedZip,
  rename: (value: string) => string,
  canonicalizeNestedWorkbooks: boolean,
): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const output = new JSZip();
  const entries = Object.values(source.files)
    .filter((entry) => !entry.dir)
    .sort((left, right) => rename(left.name).localeCompare(rename(right.name)));
  for (const entry of entries) {
    let data = await entry.async("uint8array");
    if (canonicalizeNestedWorkbooks && /^ppt\/embeddings\/[^/]+\.xlsx$/i.test(entry.name)) {
      data = await canonicalizeGeneratedZip(await JSZip.loadAsync(data), (value) => value, false);
    } else if (/(?:\.xml|\.rels)$/i.test(entry.name) || entry.name === "[Content_Types].xml") {
      const xml = new TextDecoder().decode(data);
      data = new TextEncoder().encode(
        rename(xml).replace(
          /(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
          "$11980-01-01T00:00:00Z$2",
        ),
      );
    }
    output.file(rename(entry.name), data, {
      binary: true,
      createFolders: false,
      date: DETERMINISTIC_ZIP_DATE,
    });
  }
  return await output.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  });
}

type GeneratedZip = {
  files: Record<string, GeneratedZipEntry>;
};

type GeneratedZipEntry = {
  name: string;
  dir: boolean;
  async(type: "uint8array"): Promise<Uint8Array>;
};

const DETERMINISTIC_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");

type PptxRuntime = {
  layout: string;
  author: string;
  defineLayout(options: { name: string; width: number; height: number }): void;
  addSlide(): PptxSlideRuntime;
  write(options: { outputType: "arraybuffer" }): Promise<unknown>;
};

type PptxSlideRuntime = {
  background: { color: string };
  addShape(type: string, options: Record<string, unknown>): void;
  addText(text: string, options: Record<string, unknown>): void;
  addChart(
    type: string,
    data: Array<Record<string, unknown>>,
    options: Record<string, unknown>,
  ): void;
  addImage(options: Record<string, unknown>): void;
  addTable(rows: unknown[][], options: Record<string, unknown>): void;
  addNotes(notes: string): void;
};

function exportShapeToPptx(
  slide: PptxSlideRuntime,
  shape: PresentationShape,
  position: PresentationPosition = shape.position,
): void {
  const box = pptxPosition(position);
  const fill = pptxFill(shape.fill);
  const line = pptxLine(shape.line);
  const text = shape.text.toString();
  if (shape.geometry === "line" || text.length === 0) {
    if (shape.geometry !== "textbox") {
      slide.addShape(shape.geometry, {
        ...box,
        fill,
        line,
        rotate: shape.rotation,
        objectName: shape.name,
      });
    }
  }
  if (shape.geometry === "textbox" || text) {
    const style = shape.text.style;
    slide.addText(text, {
      ...box,
      margin: 0,
      breakLine: false,
      fontFace: style.fontFamily ?? "Aptos",
      fontSize: (style.fontSize ?? 18) * 0.75,
      bold: style.bold ?? false,
      italic: style.italic ?? false,
      underline: style.underline ? { style: "sng" } : undefined,
      color: pptxColor(style.color ?? "slate-950"),
      align: style.alignment ?? "left",
      valign: style.verticalAlignment ?? "top",
      shape: shape.geometry === "textbox" || shape.geometry === "line" ? undefined : shape.geometry,
      fill: shape.geometry === "line" ? { color: "FFFFFF", transparency: 100 } : fill,
      line: shape.geometry === "line" ? { color: "FFFFFF", transparency: 100 } : line,
      rotate: shape.rotation,
      objectName: shape.name,
    });
  }
}

function exportTableToPptx(
  slide: PptxSlideRuntime,
  table: PresentationTable,
  position: PresentationPosition = table.position,
): void {
  const rows = table.rows.map((row) =>
    row
      .filter((cell) => cell !== null)
      .map((cell) => ({
        text: cell.text.toString(),
        options: {
          fill: pptxFill(cell.fill),
          color: pptxColor(cell.text.style.color ?? table.textStyle.color ?? "slate-950"),
          fontFace: cell.text.style.fontFamily ?? table.textStyle.fontFamily ?? "Aptos",
          fontSize: (cell.text.style.fontSize ?? table.textStyle.fontSize ?? 16) * 0.75,
          bold: cell.text.style.bold ?? table.textStyle.bold ?? false,
          italic: cell.text.style.italic ?? table.textStyle.italic ?? false,
          align: cell.text.style.alignment ?? table.textStyle.alignment ?? "left",
          valign: cell.text.style.verticalAlignment ?? table.textStyle.verticalAlignment ?? "top",
          rowspan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
          colspan: cell.colSpan > 1 ? cell.colSpan : undefined,
        },
      })),
  );
  slide.addTable(rows, {
    ...pptxPosition(position),
    border: pptxTableBorder(table.line),
    fill: pptxFill(table.fill),
    margin: 2,
    objectName: table.name,
    ...(table.columnWidths.length > 0
      ? { colW: table.columnWidths.map((width) => width / 96) }
      : {}),
    ...(table.rowHeights.length > 0 ? { rowH: table.rowHeights.map((height) => height / 96) } : {}),
  });
}

function exportGroupToPptx(
  slide: PptxSlideRuntime,
  group: PresentationGroup,
  parentTransform: (position: PresentationPosition) => PresentationPosition = (position) =>
    position,
): void {
  // PptxGenJS has no group authoring primitive. Children retain absolute geometry;
  // the typed fidelity report explicitly records that the grouping relation flattens.
  const transform = (position: PresentationPosition): PresentationPosition =>
    parentTransform(groupChildPosition(group, position));
  for (const child of group.children) {
    if ("geometry" in child && "text" in child)
      exportShapeToPptx(slide, child, transform(child.position));
    else if ("series" in child) exportChartToPptx(slide, child, transform(child.position));
    else if ("sourceForPptx" in child) exportImageToPptx(slide, child, transform(child.position));
    else if ("rows" in child) exportTableToPptx(slide, child, transform(child.position));
    else if ("children" in child) exportGroupToPptx(slide, child, transform);
  }
}

function exportChartToPptx(
  slide: PptxSlideRuntime,
  chart: PresentationChart,
  position: PresentationPosition = chart.position,
): void {
  const categories = chart.categories;
  // PptxGenJS models scatter/bubble input as one shared X column followed by
  // one or more Y series. The fidelity gate rejects differing per-series X
  // vectors before this fallback writer is reached.
  const data =
    chart.type === "scatter" || chart.type === "bubble"
      ? [
          {
            name: "X Values",
            values: chart.series.items[0]?.xValues ?? [],
          },
          ...chart.series.items.map((series) => ({
            name: series.name,
            values: series.values,
            sizes: series.bubbleSizes.length > 0 ? series.bubbleSizes : undefined,
          })),
        ]
      : chart.series.items.map((series) => ({
          name: series.name,
          labels: series.categories.length > 0 ? series.categories : categories,
          values: series.values,
        }));
  slide.addChart(chart.type, data, {
    ...pptxPosition(position),
    showTitle: chart.title.length > 0,
    title: chart.title,
    showLegend: chart.hasLegend,
    legendPos: pptxLegendPosition(chart.legend?.position),
    showValue: chart.dataLabels?.showValue ?? false,
    showCategoryName: chart.dataLabels?.showCategoryName ?? false,
    showPercent: chart.dataLabels?.showPercent ?? false,
    showCatName: chart.dataLabels?.showCategoryName ?? false,
    showSerName: chart.dataLabels?.showSeriesName ?? false,
    catAxisHidden: chart.xAxis?.visible === false,
    catAxisTitle: chart.xAxis?.title,
    catAxisMinVal: chart.xAxis?.min,
    catAxisMaxVal: chart.xAxis?.max,
    valAxisHidden: chart.yAxis?.visible === false,
    valAxisTitle: chart.yAxis?.title,
    valAxisMinVal: chart.yAxis?.min,
    valAxisMaxVal: chart.yAxis?.max,
  });
}

function exportImageToPptx(
  slide: PptxSlideRuntime,
  image: PresentationImage,
  position: PresentationPosition = image.position,
): void {
  slide.addImage({
    ...image.sourceForPptx(),
    ...pptxPosition(position),
    altText: image.alt,
    rotate: image.rotation,
    flipH: image.flipHorizontal,
    flipV: image.flipVertical,
    rounding: image.geometry === "ellipse" || image.geometry === "roundRect",
    objectName: image.name,
    sizing: {
      type: image.crop ? "crop" : image.fit,
      w: position.width / 96,
      h: position.height / 96,
    },
  });
}

function groupChildPosition(
  group: PresentationGroup,
  position: PresentationPosition,
): PresentationPosition {
  const scaleX = group.position.width / group.childExtent.width;
  const scaleY = group.position.height / group.childExtent.height;
  return {
    left: group.position.left + (position.left - group.childOffset.left) * scaleX,
    top: group.position.top + (position.top - group.childOffset.top) * scaleY,
    width: position.width * scaleX,
    height: position.height * scaleY,
  };
}

function pptxLegendPosition(
  position: "left" | "top" | "topRight" | "right" | "bottom" | undefined,
): "l" | "t" | "tr" | "r" | "b" {
  switch (position) {
    case "left":
      return "l";
    case "top":
      return "t";
    case "topRight":
      return "tr";
    case "right":
      return "r";
    default:
      return "b";
  }
}
function pptxPosition(position: PresentationPosition): Record<string, number> {
  return {
    x: position.left / 96,
    y: position.top / 96,
    w: position.width / 96,
    h: position.height / 96,
  };
}

function pptxColor(fill: PresentationFill): string {
  const color = colorValue(fill);
  return color === "none" ? "FFFFFF" : color.replace(/^#/, "").slice(0, 6).toUpperCase();
}

function pptxFill(fill: PresentationFill): Record<string, unknown> {
  return colorValue(fill) === "none"
    ? { color: "FFFFFF", transparency: 100 }
    : { color: pptxColor(fill), transparency: 0 };
}

function pptxLine(line: PresentationLine): Record<string, unknown> {
  const none =
    line.style === "none" || colorValue(line.fill ?? "none") === "none" || (line.width ?? 1) === 0;
  return none
    ? { color: "FFFFFF", transparency: 100, width: 0 }
    : {
        color: pptxColor(line.fill ?? "slate-900"),
        width: (line.width ?? 1) * 0.75,
        dashType: line.style,
      };
}

function pptxTableBorder(line: PresentationLine): Record<string, unknown> {
  const shapeLine = pptxLine(line);
  return {
    color: shapeLine.color,
    transparency: shapeLine.transparency,
    pt: shapeLine.width,
    type: shapeLine.dashType,
  };
}
