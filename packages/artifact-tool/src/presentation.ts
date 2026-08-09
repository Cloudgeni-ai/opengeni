import { FileBlob } from "./file-blob";
import { presentationLossState } from "./presentation-pptx-state";
import {
  canonicalizeRasterDataUrl,
  encodeRasterBase64,
  normalizeRasterContentType,
  RasterImageValidationError,
  validateRasterImageBytes,
} from "./raster-image";
export {
  PPTX_MEDIA_TYPE,
  PresentationFidelityError,
  PresentationSecurityError,
  type PresentationFidelityIssue,
  type PresentationLossPreservationEnvelope,
  type PresentationPptxExportOptions,
  type PresentationPptxFeature,
  type PresentationPptxImportLimits,
  type PresentationPptxImportOptions,
} from "./presentation-pptx-api";
import type {
  PresentationFidelityIssue,
  PresentationLossPreservationEnvelope,
  PresentationPptxExportOptions,
  PresentationPptxImportOptions,
} from "./presentation-pptx-api";

export type PresentationPosition = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PresentationFill = string | { type?: "solid"; color: string };

export type PresentationLine = {
  style?: "solid" | "dash" | "dot" | "none";
  fill?: PresentationFill;
  width?: number;
};

export type PresentationTextStyle = {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  alignment?: "left" | "center" | "right" | "justify";
  verticalAlignment?: "top" | "middle" | "bottom";
};

export type PresentationShapeGeometry =
  | "textbox"
  | "rect"
  | "roundRect"
  | "ellipse"
  | "triangle"
  | "rightArrow"
  | "line";

export type PresentationShapeConfig = {
  geometry: PresentationShapeGeometry;
  name?: string;
  position?: Partial<PresentationPosition>;
  fill?: PresentationFill;
  line?: PresentationLine;
  text?: string;
  textStyle?: PresentationTextStyle;
  rotation?: number;
  borderRadius?: number | string;
  placeholder?: { type: string; index?: number };
};

export type PresentationChartType =
  | "bar"
  | "line"
  | "area"
  | "pie"
  | "doughnut"
  | "scatter"
  | "bubble"
  | "radar";

export type PresentationChartSeriesConfig = {
  name: string;
  categories?: string[];
  values?: number[];
  xValues?: number[];
  bubbleSizes?: number[];
  fill?: PresentationFill;
  line?: PresentationLine;
};

export type PresentationChartConfig = {
  name?: string;
  position?: Partial<PresentationPosition>;
  title?: string;
  categories?: string[];
  series?: PresentationChartSeriesConfig[];
  hasLegend?: boolean;
  legend?: { position?: "left" | "top" | "topRight" | "right" | "bottom"; overlay?: boolean };
  xAxis?: { visible?: boolean; title?: string; min?: number; max?: number };
  yAxis?: { visible?: boolean; title?: string; min?: number; max?: number };
  dataLabels?: {
    showValue?: boolean;
    showSeriesName?: boolean;
    showCategoryName?: boolean;
    showPercent?: boolean;
    position?: "center" | "inEnd" | "outEnd";
  };
};

export type PresentationTableCellConfig = {
  text: string;
  fill?: PresentationFill;
  textStyle?: PresentationTextStyle;
  rowSpan?: number;
  colSpan?: number;
};

export type PresentationTableCellInput = string | PresentationTableCellConfig | null;

export type PresentationTableConfig = {
  name?: string;
  position?: Partial<PresentationPosition>;
  /** null marks a grid position covered by an earlier rowSpan/colSpan anchor. */
  rows: ReadonlyArray<ReadonlyArray<PresentationTableCellInput>>;
  columnWidths?: readonly number[];
  rowHeights?: readonly number[];
  fill?: PresentationFill;
  line?: PresentationLine;
  textStyle?: PresentationTextStyle;
};

export type PresentationGroupChildConfig =
  | { kind: "shape"; config: PresentationShapeConfig }
  | { kind: "chart"; type: PresentationChartType; config?: PresentationChartConfig }
  | { kind: "image"; config: PresentationImageConfig }
  | { kind: "table"; config: PresentationTableConfig }
  | { kind: "group"; config: PresentationGroupConfig };

export type PresentationGroupConfig = {
  name?: string;
  position?: Partial<PresentationPosition>;
  childOffset?: { left: number; top: number };
  childExtent?: { width: number; height: number };
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  children?: readonly PresentationGroupChildConfig[];
};

export type PresentationTemplateElement = Exclude<PresentationGroupChildConfig, { kind: "group" }>;

export type PresentationMasterConfig = {
  name?: string;
  background?: PresentationFill;
  elements?: readonly PresentationTemplateElement[];
};

export type PresentationLayoutConfig = PresentationMasterConfig & {
  masterId?: string;
  /** Skill-compatible alias for masterId. */
  parentLayoutId?: string;
};

type ConcreteImageSource =
  | { blob: ArrayBuffer | Uint8Array; dataUrl?: never; uri?: never }
  | { dataUrl: string; blob?: never; uri?: never }
  | { uri: string; blob?: never; dataUrl?: never };

export type PresentationRasterImageContentType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export type PresentationImageResolution = {
  blob: ArrayBuffer | Uint8Array;
  contentType?: PresentationRasterImageContentType;
};

export type PresentationImageResolver = (reference: {
  uri: string;
  imageId: string;
  name: string;
}) => Promise<PresentationImageResolution> | PresentationImageResolution;

export type PresentationCreateOptions = {
  slideSize?: { width: number; height: number };
  /** Host-owned resolver; it is invoked only by an explicit image.resolveUri() call. */
  imageResolver?: PresentationImageResolver;
  /** URI schemes the host resolver owns, for example `["asset"]`. Empty by default. */
  allowedImageUriSchemes?: readonly string[];
};

export type PresentationImageConfig =
  | (ConcreteImageSource & PresentationImageMetadata)
  | ({ prompt: string; blob?: never; dataUrl?: never; uri?: never } & PresentationImageMetadata);

type PresentationImageMetadata = {
  name?: string;
  prompt?: string;
  contentType?: string;
  alt?: string;
  fit?: "contain" | "cover";
  position?: Partial<PresentationPosition>;
  frame?: Partial<PresentationPosition>;
  crop?: { left: number; top: number; right: number; bottom: number };
  geometry?: "rect" | "roundRect" | "ellipse";
  borderRadius?: number | string;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  lockAspectRatio?: boolean;
};

export type PresentationInspectOptions = {
  target?: { id: string; beforeLines?: number; afterLines?: number };
  kind?: string;
  include?: string;
  exclude?: string;
  search?: string;
  maxChars?: number;
};

export type PresentationInspectResult = {
  ndjson: string;
  records: Array<Record<string, unknown>>;
  truncated: boolean;
};

export type PresentationResolvedObject =
  | Presentation
  | Slide
  | PresentationShape
  | PresentationChart
  | PresentationImage
  | PresentationTable
  | PresentationGroup
  | PresentationMaster
  | PresentationLayout;

export type PresentationElement =
  | PresentationShape
  | PresentationChart
  | PresentationImage
  | PresentationTable
  | PresentationGroup;

export type PresentationExportOptions = {
  slide?: Slide;
  format: "svg" | "png" | "layout" | "webp";
  scale?: number;
  montage?: boolean;
  columns?: number;
  gap?: number;
};

export class UnsupportedPresentationFeatureError extends Error {
  readonly code = "UNSUPPORTED_PRESENTATION_FEATURE";

  constructor(feature: string, detail?: string) {
    super(`Unsupported presentation feature: ${feature}${detail ? `. ${detail}` : ""}`);
    this.name = "UnsupportedPresentationFeatureError";
  }
}

/** Untrusted presentation input was rejected before reaching a renderer or file codec. */
export class InvalidPresentationInputError extends Error {
  readonly code = "INVALID_PRESENTATION_INPUT";

  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`Invalid presentation ${field}: ${detail}`);
    this.name = "InvalidPresentationInputError";
  }
}

/**
 * Skill-compatible TypeScript reference presentation. Native production
 * presentation editing remains unsupported and must fail closed until the
 * Rust modality is feature-complete.
 */
export class Presentation {
  readonly slides: SlideCollection;
  readonly masters: PresentationMasterCollection;
  readonly layouts: PresentationLayoutCollection;
  readonly slideSize: { width: number; height: number };
  private readonly objects = new Map<string, unknown>();
  private readonly imageResolver: PresentationImageResolver | undefined;
  private readonly allowedImageUriSchemes: ReadonlySet<string>;
  private nextId = 1;

  private constructor(options: PresentationCreateOptions = {}) {
    this.slideSize = options.slideSize ?? { width: 1280, height: 720 };
    validatePosition(
      { left: 0, top: 0, width: this.slideSize.width, height: this.slideSize.height },
      "slideSize",
    );
    this.imageResolver = options.imageResolver;
    this.allowedImageUriSchemes = validateImageUriPolicy(
      options.imageResolver,
      options.allowedImageUriSchemes,
    );
    this.slides = new SlideCollection(this);
    this.masters = new PresentationMasterCollection(this);
    this.layouts = new PresentationLayoutCollection(this);
    this.register("pr", this);
  }

  static create(options: PresentationCreateOptions = {}): Presentation {
    return new Presentation(options);
  }

  assertImageUriAccepted(uri: string): void {
    assertSafeText(uri, "image uri", MAX_IMAGE_URI_LENGTH);
    const scheme = imageUriScheme(uri);
    if (!this.imageResolver || !this.allowedImageUriSchemes.has(scheme)) {
      throw new InvalidPresentationInputError(
        "image uri",
        "requires an injected resolver and an explicitly allowed URI scheme",
      );
    }
  }

  async resolveImageUri(reference: {
    uri: string;
    imageId: string;
    name: string;
  }): Promise<PresentationImageResolution> {
    this.assertImageUriAccepted(reference.uri);
    if (!this.imageResolver) {
      throw new InvalidPresentationInputError("image resolver", "is not configured");
    }
    return await this.imageResolver(reference);
  }

  allocateId(
    prefix: "sl" | "sh" | "ch" | "im" | "tb" | "gp" | "mt" | "ly",
    value: unknown,
  ): string {
    return this.register(prefix, value);
  }

  resolve<T extends PresentationResolvedObject = PresentationResolvedObject>(id: string): T {
    const value = this.objects.get(id);
    if (value === undefined) throw new Error(`Unknown presentation object id: ${id}`);
    return value as T;
  }

  async inspect(options: PresentationInspectOptions = {}): Promise<PresentationInspectResult> {
    const requested = new Set(
      (options.kind ?? "deck,master,layout,slide,textbox,shape,image,chart,table,group,notes")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (value === "comments" ? "thread" : value)),
    );
    const records: Array<Record<string, unknown>> = [];
    if (requested.has("deck")) {
      records.push({
        kind: "deck",
        id: "pr/1",
        slides: this.slides.items.length,
        width: this.slideSize.width,
        height: this.slideSize.height,
      });
    }
    if (requested.has("master")) {
      for (const master of this.masters.items) records.push(master.inspectRecord());
    }
    if (requested.has("layout")) {
      for (const layout of this.layouts.items) records.push(layout.inspectRecord());
    }
    for (const [index, slide] of this.slides.items.entries()) {
      if (requested.has("slide")) records.push(slide.inspectRecord(index));
      for (const shape of slide.shapes.items) {
        const kind = shape.geometry === "textbox" ? "textbox" : "shape";
        if (requested.has(kind) || (kind === "textbox" && requested.has("shape"))) {
          records.push(shape.inspectRecord(index));
        }
      }
      if (requested.has("chart")) {
        for (const chart of slide.charts.items) records.push(chart.inspectRecord(index));
      }
      if (requested.has("image")) {
        for (const image of slide.images.items) records.push(image.inspectRecord(index));
      }
      if (requested.has("table")) {
        for (const table of slide.tables.items) records.push(table.inspectRecord(index));
      }
      if (requested.has("group")) {
        for (const group of slide.groups.items) records.push(group.inspectRecord(index));
      }
      if (requested.has("notes") && slide.notes.toString().length > 0) {
        records.push({
          kind: "notes",
          id: `${slide.id}/notes`,
          slide: index + 1,
          text: slide.notes.toString(),
        });
      }
    }

    const search = options.search?.toLocaleLowerCase();
    let filtered = search
      ? records.filter((record) => JSON.stringify(record).toLocaleLowerCase().includes(search))
      : records;
    if (options.target) filtered = filtered.filter((record) => record.id === options.target!.id);
    filtered = filtered.map((record) => projectRecord(record, options.include, options.exclude));
    return boundRecords(filtered, options.maxChars ?? 20_000);
  }

  async export(options: PresentationExportOptions): Promise<FileBlob> {
    if (!options || typeof options !== "object") {
      throw new InvalidPresentationInputError("export options", "must be an object");
    }
    if (!(["svg", "png", "layout", "webp"] as const).includes(options.format)) {
      throw new InvalidPresentationInputError("export format", "is not supported");
    }
    validatePresentation(this, options.format !== "layout");
    if (options.format === "layout") {
      if (options.slide) {
        this.assertOwns(options.slide);
        return jsonBlob(
          options.slide.layoutSnapshot(this.slides.items.indexOf(options.slide)),
          `slide-${this.slides.items.indexOf(options.slide) + 1}.layout.json`,
        );
      }
      return jsonBlob(this.layoutSnapshot(), "presentation.layout.json");
    }
    const scale = options.scale ?? 1;
    validateRenderScale(scale);
    if (options.montage) {
      const dimensions = montageDimensions(this, options.columns, options.gap);
      if (options.format !== "svg") {
        assertRenderPixelBudget(dimensions.width, dimensions.height, scale);
      }
      const { executePresentationRender } =
        await import("@opengeni/artifact-tool/presentation/render");
      return await executePresentationRender({
        kind: "montage",
        presentation: this,
        format: options.format,
        scale,
        name: `presentation-montage.${options.format}`,
        dimensions,
      });
    }
    const slide =
      options.slide ?? (this.slides.items.length === 1 ? this.slides.items[0] : undefined);
    if (!slide) {
      throw new Error(
        "A slide is required when exporting a multi-slide presentation without montage: true",
      );
    }
    this.assertOwns(slide);
    if (options.format !== "svg") {
      assertRenderPixelBudget(this.slideSize.width, this.slideSize.height, scale);
    }
    const { executePresentationRender } =
      await import("@opengeni/artifact-tool/presentation/render");
    return await executePresentationRender({
      kind: "slide",
      slide,
      format: options.format,
      scale,
      name: `slide-${this.slides.items.indexOf(slide) + 1}.${options.format}`,
      dimensions: this.slideSize,
    });
  }

  layoutSnapshot(): Record<string, unknown> {
    return {
      kind: "presentation-layout",
      slideSize: { ...this.slideSize },
      masters: this.masters.items.map((master) => master.toProto()),
      layouts: this.layouts.items.map((layout) => layout.toProto()),
      slides: this.slides.items.map((slide, index) => slide.layoutSnapshot(index)),
    };
  }

  private register(prefix: string, value: unknown): string {
    const id = `${prefix}/${this.nextId++}`;
    this.objects.set(id, value);
    return id;
  }

  private assertOwns(slide: Slide): void {
    if (slide.presentation !== this) throw new Error("Slide belongs to another presentation");
  }
}

class PresentationPlaceholderCollection {
  constructor(private readonly elements: readonly PresentationTemplateElement[]) {}

  summary(): { count: number; names: string[] } {
    const names = this.elements
      .filter(
        (element): element is Extract<PresentationTemplateElement, { kind: "shape" }> =>
          element.kind === "shape" && element.config.placeholder !== undefined,
      )
      .map((element) => element.config.name ?? element.config.placeholder?.type ?? "Placeholder");
    return { count: names.length, names };
  }
}

export class PresentationMaster {
  readonly id: string;
  name: string;
  background: PresentationFill;
  readonly elements: PresentationTemplateElement[];
  readonly placeholders: PresentationPlaceholderCollection;

  constructor(
    readonly presentation: Presentation,
    config: PresentationMasterConfig = {},
  ) {
    this.id = presentation.allocateId("mt", this);
    this.name = config.name ?? this.id;
    assertSafeText(this.name, "master name", 512);
    this.background = config.background ?? "white";
    colorValue(this.background);
    this.elements = (config.elements ?? []).map(cloneTemplateElement);
    this.placeholders = new PresentationPlaceholderCollection(this.elements);
  }

  inspectRecord(): Record<string, unknown> {
    return {
      kind: "master",
      id: this.id,
      name: this.name,
      elements: this.elements.length,
      placeholders: this.placeholders.summary(),
    };
  }

  toProto(): Record<string, unknown> {
    return {
      id: this.id,
      type: "master",
      name: this.name,
      background: this.background,
      elements: this.elements.map(cloneTemplateElement),
    };
  }
}

export class PresentationLayout {
  readonly id: string;
  name: string;
  masterId: string | undefined;
  background: PresentationFill;
  readonly elements: PresentationTemplateElement[];
  readonly placeholders: PresentationPlaceholderCollection;

  get parentLayoutId(): string | undefined {
    return this.masterId;
  }

  constructor(
    readonly presentation: Presentation,
    config: PresentationLayoutConfig = {},
  ) {
    this.id = presentation.allocateId("ly", this);
    this.name = config.name ?? this.id;
    assertSafeText(this.name, "layout name", 512);
    if (
      config.masterId !== undefined &&
      config.parentLayoutId !== undefined &&
      config.masterId !== config.parentLayoutId
    ) {
      throw new InvalidPresentationInputError(
        "layout masterId",
        "conflicts with the parentLayoutId compatibility alias",
      );
    }
    this.masterId = config.masterId ?? config.parentLayoutId;
    if (this.masterId !== undefined) assertSafeText(this.masterId, "layout master id", 512);
    this.background = config.background ?? "white";
    colorValue(this.background);
    this.elements = (config.elements ?? []).map(cloneTemplateElement);
    this.placeholders = new PresentationPlaceholderCollection(this.elements);
  }

  inspectRecord(): Record<string, unknown> {
    return {
      kind: "layout",
      id: this.id,
      name: this.name,
      masterId: this.masterId,
      parentLayoutId: this.masterId,
      elements: this.elements.length,
      placeholders: this.placeholders.summary(),
    };
  }

  toProto(): Record<string, unknown> {
    return {
      id: this.id,
      type: "layout",
      name: this.name,
      masterId: this.masterId,
      parentLayoutId: this.masterId,
      background: this.background,
      elements: this.elements.map(cloneTemplateElement),
    };
  }
}

export class PresentationMasterCollection {
  readonly items: PresentationMaster[] = [];

  constructor(private readonly presentation: Presentation) {}

  add(config: PresentationMasterConfig = {}): PresentationMaster {
    const master = new PresentationMaster(this.presentation, config);
    this.items.push(master);
    return master;
  }

  getItem(index: number): PresentationMaster {
    const master = this.items[index];
    if (!master) throw new Error(`Presentation master index out of range: ${index}`);
    return master;
  }
}

export class PresentationLayoutCollection {
  readonly items: PresentationLayout[] = [];

  constructor(private readonly presentation: Presentation) {}

  add(config: PresentationLayoutConfig = {}): PresentationLayout {
    if (
      (config.masterId ?? config.parentLayoutId) !== undefined &&
      !this.presentation.masters.items.some(
        (master) => master.id === (config.masterId ?? config.parentLayoutId),
      )
    ) {
      throw new InvalidPresentationInputError(
        "layout parentLayoutId",
        "must reference a master in the same presentation",
      );
    }
    const layout = new PresentationLayout(this.presentation, config);
    this.items.push(layout);
    return layout;
  }

  getItem(index: number): PresentationLayout {
    const layout = this.items[index];
    if (!layout) throw new Error(`Presentation layout index out of range: ${index}`);
    return layout;
  }
}

export class SlideCollection {
  readonly items: Slide[] = [];

  constructor(private readonly presentation: Presentation) {}

  add(): Slide {
    const slide = new Slide(this.presentation);
    this.items.push(slide);
    return slide;
  }

  getItem(index: number): Slide {
    const slide = this.items[index];
    if (!slide) throw new Error(`Slide index out of range: ${index}`);
    return slide;
  }
}

export class Slide {
  readonly id: string;
  readonly shapes: PresentationShapeCollection;
  readonly charts: PresentationChartCollection;
  readonly images: PresentationImageCollection;
  readonly tables: PresentationTableCollection;
  readonly groups: PresentationGroupCollection;
  readonly notes = new PresentationText();
  readonly placeholders: SlidePlaceholderCollection;
  /** Canonical cross-type z-order. Typed collections are filtered indexes over this list. */
  readonly elements: PresentationElement[] = [];
  readonly background: { fill: PresentationFill } = { fill: "white" };
  title = "";
  layout: PresentationLayout | undefined;

  constructor(readonly presentation: Presentation) {
    this.id = presentation.allocateId("sl", this);
    this.shapes = new PresentationShapeCollection(this);
    this.charts = new PresentationChartCollection(this);
    this.images = new PresentationImageCollection(this);
    this.tables = new PresentationTableCollection(this);
    this.groups = new PresentationGroupCollection(this);
    this.placeholders = new SlidePlaceholderCollection(this);
  }

  get speakerNotes(): PresentationText {
    return this.notes;
  }

  setLayout(layout: PresentationLayout | undefined): void {
    if (layout && layout.presentation !== this.presentation) {
      throw new InvalidPresentationInputError("slide layout", "belongs to another presentation");
    }
    this.layout = layout;
  }

  appendElement(element: PresentationElement): void {
    if (element.slide !== this) {
      throw new InvalidPresentationInputError("slide element", "belongs to another slide");
    }
    this.elements.push(element);
  }

  async export(options: Omit<PresentationExportOptions, "slide" | "montage">): Promise<FileBlob> {
    return await this.presentation.export({ ...options, slide: this });
  }

  inspectRecord(index: number): Record<string, unknown> {
    const textShapes = this.shapes.items.filter((shape) => shape.text.toString().length > 0);
    return {
      kind: "slide",
      id: this.id,
      slide: index + 1,
      title: this.title,
      textShapes: textShapes.length,
      charts: this.charts.items.length,
      images: this.images.items.length,
      tables: this.tables.items.length,
      groups: this.groups.items.length,
      layoutId: this.layout?.id,
      notesChars: this.notes.toString().length,
    };
  }

  layoutSnapshot(index: number): Record<string, unknown> {
    return {
      id: this.id,
      slide: index + 1,
      background: { ...this.background },
      layoutId: this.layout?.id,
      notes: this.notes.toString(),
      elements: [...this.elements.map((element) => element.layoutSnapshot())],
    };
  }
}

export class SlidePlaceholderCollection {
  constructor(private readonly slide: Slide) {}

  get items(): PresentationShape[] {
    return this.slide.shapes.items.filter((shape) => shape.placeholder !== undefined);
  }

  summary(): { count: number; types: Record<string, number> } {
    const types: Record<string, number> = {};
    for (const shape of this.items) {
      const type = shape.placeholder?.type ?? "unknown";
      types[type] = (types[type] ?? 0) + 1;
    }
    return { count: this.items.length, types };
  }
}

export class PresentationText {
  private value = "";
  private styleValue: PresentationTextStyle = {};

  constructor(initialValue = "", style: PresentationTextStyle = {}) {
    this.set(initialValue);
    this.style = style;
  }

  get style(): PresentationTextStyle {
    return this.styleValue;
  }

  set style(value: PresentationTextStyle) {
    validateTextStyle(value, "textStyle");
    this.styleValue = { ...value };
  }

  set(value: string): void {
    assertSafeText(value, "text");
    this.value = value;
  }

  replace(searchValue: string | RegExp, replaceValue: string): number {
    const before = this.value;
    let next: string;
    if (typeof searchValue === "string") {
      if (searchValue.length === 0) throw new Error("Text replacement search cannot be empty");
      next = this.value.split(searchValue).join(replaceValue);
    } else {
      next = this.value.replace(searchValue, replaceValue);
    }
    assertSafeText(next, "text");
    this.value = next;
    return before === next ? 0 : 1;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}

export class PresentationShape {
  readonly id: string;
  readonly geometry: PresentationShapeGeometry;
  name: string;
  position: PresentationPosition;
  fill: PresentationFill;
  line: PresentationLine;
  rotation: number;
  borderRadius: number | string | undefined;
  placeholder: { type: string; index?: number } | undefined;
  private readonly textValue: PresentationText;

  constructor(
    readonly slide: Slide,
    config: PresentationShapeConfig,
  ) {
    if (!PRESENTATION_GEOMETRIES.has(config.geometry)) {
      throw new InvalidPresentationInputError("shape geometry", "is not supported");
    }
    this.id = slide.presentation.allocateId("sh", this);
    this.geometry = config.geometry;
    this.name = config.name ?? this.id;
    assertSafeText(this.name, "shape name");
    this.position = normalizePosition(config.position);
    this.fill =
      config.fill ??
      (config.geometry === "textbox" || config.geometry === "line" ? "none" : "white");
    this.line = {
      style: "solid",
      fill: config.geometry === "textbox" ? "none" : "slate-900",
      width: 1,
      ...config.line,
    };
    colorValue(this.fill);
    validateLine(this.line, "shape line");
    this.rotation = finiteOr(config.rotation, 0);
    validateRotation(this.rotation, "shape rotation");
    this.borderRadius = config.borderRadius;
    validateBorderRadius(this.borderRadius, "shape borderRadius");
    this.placeholder = normalizePlaceholder(config.placeholder);
    this.textValue = new PresentationText(config.text, config.textStyle);
  }

  get text(): PresentationText {
    return this.textValue;
  }

  set text(value: string | PresentationText) {
    this.textValue.set(value.toString());
    if (value instanceof PresentationText) this.textValue.style = value.style;
  }

  inspectRecord(slideIndex: number): Record<string, unknown> {
    const text = this.text.toString();
    return {
      kind: this.geometry === "textbox" ? "textbox" : "shape",
      id: this.id,
      slide: slideIndex + 1,
      name: this.name,
      geometry: this.geometry,
      text,
      textPreview: truncate(text, 240),
      textChars: text.length,
      textLines: text.length === 0 ? 0 : text.split("\n").length,
      bbox: positionTuple(this.position),
      bboxUnit: "px",
    };
  }

  layoutSnapshot(): Record<string, unknown> {
    return {
      kind: this.geometry === "textbox" ? "textbox" : "shape",
      id: this.id,
      name: this.name,
      geometry: this.geometry,
      position: { ...this.position },
      fill: this.fill,
      line: { ...this.line },
      rotation: this.rotation,
      text: this.text.toString(),
      textStyle: { ...this.text.style },
      placeholder: this.placeholder ? { ...this.placeholder } : undefined,
    };
  }
}

export class PresentationShapeCollection {
  readonly items: PresentationShape[] = [];

  constructor(private readonly slide: Slide) {}

  add(config: PresentationShapeConfig): PresentationShape {
    const shape = new PresentationShape(this.slide, config);
    this.items.push(shape);
    this.slide.appendElement(shape);
    return shape;
  }
}

export class PresentationChartSeries {
  name: string;
  categories: string[];
  values: number[];
  xValues: number[];
  bubbleSizes: number[];
  fill: PresentationFill | undefined;
  line: PresentationLine | undefined;

  constructor(config: PresentationChartSeriesConfig) {
    this.name = config.name;
    assertSafeText(this.name, "chart series name");
    this.categories = [...(config.categories ?? [])];
    for (const category of this.categories) assertSafeText(category, "chart series category");
    this.values = [...(config.values ?? [])];
    this.xValues = [...(config.xValues ?? [])];
    this.bubbleSizes = [...(config.bubbleSizes ?? [])];
    this.fill = config.fill;
    this.line = config.line ? { ...config.line } : undefined;
    validateFiniteArray(this.values, "chart series values");
    validateFiniteArray(this.xValues, "chart series xValues");
    validateFiniteArray(this.bubbleSizes, "chart series bubbleSizes");
    if (this.fill !== undefined) colorValue(this.fill);
    if (this.line !== undefined) validateLine(this.line, "chart series line");
  }
}

export class PresentationChartSeriesCollection {
  readonly items: PresentationChartSeries[];

  constructor(series: PresentationChartSeriesConfig[]) {
    this.items = series.map((config) => new PresentationChartSeries(config));
  }

  getItemAt(index: number): PresentationChartSeries {
    const series = this.items[index];
    if (!series) throw new Error(`Chart series index out of range: ${index}`);
    return series;
  }
}

export class PresentationChart {
  readonly id: string;
  readonly type: PresentationChartType;
  name: string;
  position: PresentationPosition;
  title: string;
  categories: string[];
  readonly series: PresentationChartSeriesCollection;
  hasLegend: boolean;
  legend: PresentationChartConfig["legend"];
  xAxis: PresentationChartConfig["xAxis"];
  yAxis: PresentationChartConfig["yAxis"];
  dataLabels: PresentationChartConfig["dataLabels"];

  constructor(
    readonly slide: Slide,
    type: PresentationChartType,
    config: PresentationChartConfig,
  ) {
    if (!CHART_TYPES.has(type)) {
      throw new InvalidPresentationInputError("chart type", "is not supported");
    }
    this.id = slide.presentation.allocateId("ch", this);
    this.type = type;
    this.name = config.name ?? this.id;
    assertSafeText(this.name, "chart name");
    this.position = normalizePosition(config.position, {
      left: 72,
      top: 120,
      width: 640,
      height: 360,
    });
    this.title = config.title ?? "";
    assertSafeText(this.title, "chart title");
    this.categories = [...(config.categories ?? [])];
    for (const category of this.categories) assertSafeText(category, "chart category");
    this.series = new PresentationChartSeriesCollection(config.series ?? []);
    this.hasLegend = config.hasLegend ?? this.series.items.length > 1;
    this.legend = config.legend ? { ...config.legend } : undefined;
    this.xAxis = config.xAxis ? { ...config.xAxis } : undefined;
    this.yAxis = config.yAxis ? { ...config.yAxis } : undefined;
    validateOptionalFinite(this.xAxis?.min, "chart xAxis.min");
    validateOptionalFinite(this.xAxis?.max, "chart xAxis.max");
    validateOptionalFinite(this.yAxis?.min, "chart yAxis.min");
    validateOptionalFinite(this.yAxis?.max, "chart yAxis.max");
    this.dataLabels = config.dataLabels ? { ...config.dataLabels } : undefined;
  }

  inspectRecord(slideIndex: number): Record<string, unknown> {
    return {
      kind: "chart",
      id: this.id,
      slide: slideIndex + 1,
      name: this.name,
      chartType: this.type,
      title: this.title,
      series: this.series.items.map((series) => ({ name: series.name, values: series.values })),
      bbox: positionTuple(this.position),
      bboxUnit: "px",
    };
  }

  layoutSnapshot(): Record<string, unknown> {
    return {
      kind: "chart",
      id: this.id,
      name: this.name,
      chartType: this.type,
      title: this.title,
      position: { ...this.position },
      categories: [...this.categories],
      series: this.series.items.map((series) => ({
        name: series.name,
        categories: [...series.categories],
        values: [...series.values],
        xValues: [...series.xValues],
        bubbleSizes: [...series.bubbleSizes],
        fill: series.fill,
        line: series.line,
      })),
    };
  }
}

export class PresentationChartCollection {
  readonly items: PresentationChart[] = [];

  constructor(private readonly slide: Slide) {}

  add(type: PresentationChartType, config: PresentationChartConfig = {}): PresentationChart {
    const chart = new PresentationChart(this.slide, type, config);
    this.items.push(chart);
    this.slide.appendElement(chart);
    return chart;
  }
}

export class PresentationTableCell {
  readonly text: PresentationText;
  fill: PresentationFill;
  rowSpan: number;
  colSpan: number;

  constructor(
    config: string | PresentationTableCellConfig,
    defaults: Pick<PresentationTableConfig, "fill" | "textStyle">,
  ) {
    const normalized = typeof config === "string" ? { text: config } : config;
    this.text = new PresentationText(normalized.text, normalized.textStyle ?? defaults.textStyle);
    this.fill = normalized.fill ?? defaults.fill ?? "white";
    colorValue(this.fill);
    this.rowSpan = normalized.rowSpan ?? 1;
    this.colSpan = normalized.colSpan ?? 1;
    for (const [field, value] of [
      ["rowSpan", this.rowSpan],
      ["colSpan", this.colSpan],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TABLE_SPAN) {
        throw new InvalidPresentationInputError(
          `table cell ${field}`,
          `must be 1-${MAX_TABLE_SPAN}`,
        );
      }
    }
  }

  toConfig(): PresentationTableCellConfig {
    return {
      text: this.text.toString(),
      fill: this.fill,
      textStyle: { ...this.text.style },
      rowSpan: this.rowSpan,
      colSpan: this.colSpan,
    };
  }
}

export class PresentationTable {
  readonly id: string;
  name: string;
  position: PresentationPosition;
  rows: Array<Array<PresentationTableCell | null>>;
  columnWidths: number[];
  rowHeights: number[];
  fill: PresentationFill;
  line: PresentationLine;
  textStyle: PresentationTextStyle;

  constructor(
    readonly slide: Slide,
    config: PresentationTableConfig,
  ) {
    if (
      !Array.isArray(config.rows) ||
      config.rows.length === 0 ||
      config.rows.length > MAX_TABLE_ROWS
    ) {
      throw new InvalidPresentationInputError(
        "table rows",
        `must contain 1-${MAX_TABLE_ROWS} rows`,
      );
    }
    const columns = config.rows[0]?.length ?? 0;
    if (columns === 0 || columns > MAX_TABLE_COLUMNS) {
      throw new InvalidPresentationInputError(
        "table columns",
        `must contain 1-${MAX_TABLE_COLUMNS} columns`,
      );
    }
    if (config.rows.some((row) => !Array.isArray(row) || row.length !== columns)) {
      throw new InvalidPresentationInputError("table rows", "must form a rectangular matrix");
    }
    this.id = slide.presentation.allocateId("tb", this);
    this.name = config.name ?? this.id;
    assertSafeText(this.name, "table name", 512);
    this.position = normalizePosition(config.position, {
      left: 72,
      top: 120,
      width: 640,
      height: Math.max(48, config.rows.length * 36),
    });
    this.fill = config.fill ?? "white";
    colorValue(this.fill);
    this.line = { style: "solid", fill: "slate-300", width: 1, ...config.line };
    validateLine(this.line, "table line");
    this.textStyle = { fontSize: 16, ...config.textStyle };
    validateTextStyle(this.textStyle, "table textStyle");
    this.rows = config.rows.map((row: readonly PresentationTableCellInput[]) =>
      row.map((cell: PresentationTableCellInput) =>
        cell === null ? null : new PresentationTableCell(cell, this),
      ),
    );
    validateTableOccupancy(this.rows);
    this.columnWidths = normalizeTableDimensions(config.columnWidths, columns, "columnWidths");
    this.rowHeights = normalizeTableDimensions(config.rowHeights, config.rows.length, "rowHeights");
  }

  inspectRecord(slideIndex: number): Record<string, unknown> {
    return {
      kind: "table",
      id: this.id,
      slide: slideIndex + 1,
      name: this.name,
      rows: this.rows.length,
      columns: this.rows[0]?.length ?? 0,
      textPreview: truncate(
        this.rows
          .map((row) => row.map((cell) => cell?.text.toString() ?? "").join(" | "))
          .join("\n"),
        240,
      ),
      bbox: positionTuple(this.position),
      bboxUnit: "px",
    };
  }

  layoutSnapshot(): Record<string, unknown> {
    return {
      kind: "table",
      id: this.id,
      name: this.name,
      position: { ...this.position },
      rows: this.rows.map((row) => row.map((cell) => cell?.toConfig() ?? null)),
      columnWidths: [...this.columnWidths],
      rowHeights: [...this.rowHeights],
      fill: this.fill,
      line: { ...this.line },
      textStyle: { ...this.textStyle },
    };
  }
}

export class PresentationTableCollection {
  readonly items: PresentationTable[] = [];

  constructor(private readonly slide: Slide) {}

  add(config: PresentationTableConfig): PresentationTable {
    const table = new PresentationTable(this.slide, config);
    this.items.push(table);
    this.slide.appendElement(table);
    return table;
  }
}

export type PresentationGroupChild =
  | PresentationShape
  | PresentationChart
  | PresentationImage
  | PresentationTable
  | PresentationGroup;

export class PresentationGroup {
  readonly id: string;
  name: string;
  position: PresentationPosition;
  childOffset: { left: number; top: number };
  childExtent: { width: number; height: number };
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  readonly children: PresentationGroupChild[] = [];

  constructor(
    readonly slide: Slide,
    config: PresentationGroupConfig = {},
    depth = 1,
  ) {
    if (depth > MAX_GROUP_DEPTH) {
      throw new InvalidPresentationInputError("group nesting", `exceeds ${MAX_GROUP_DEPTH} levels`);
    }
    this.id = slide.presentation.allocateId("gp", this);
    this.name = config.name ?? this.id;
    assertSafeText(this.name, "group name", 512);
    this.position = normalizePosition(config.position);
    this.childOffset = config.childOffset
      ? { ...config.childOffset }
      : { left: this.position.left, top: this.position.top };
    this.childExtent = config.childExtent
      ? { ...config.childExtent }
      : { width: this.position.width, height: this.position.height };
    validatePosition(
      {
        left: this.childOffset.left,
        top: this.childOffset.top,
        width: this.childExtent.width,
        height: this.childExtent.height,
      },
      "group child coordinate system",
    );
    this.rotation = finiteOr(config.rotation, 0);
    validateRotation(this.rotation, "group rotation");
    this.flipHorizontal = config.flipHorizontal ?? false;
    this.flipVertical = config.flipVertical ?? false;
    for (const child of config.children ?? []) {
      if (this.children.length >= MAX_GROUP_CHILDREN) {
        throw new InvalidPresentationInputError(
          "group children",
          `exceeds ${MAX_GROUP_CHILDREN} children`,
        );
      }
      switch (child.kind) {
        case "shape":
          this.children.push(new PresentationShape(slide, child.config));
          break;
        case "chart":
          this.children.push(new PresentationChart(slide, child.type, child.config ?? {}));
          break;
        case "image":
          this.children.push(new PresentationImage(slide, child.config));
          break;
        case "table":
          this.children.push(new PresentationTable(slide, child.config));
          break;
        case "group":
          this.children.push(new PresentationGroup(slide, child.config, depth + 1));
          break;
      }
    }
  }

  inspectRecord(slideIndex: number): Record<string, unknown> {
    return {
      kind: "group",
      id: this.id,
      slide: slideIndex + 1,
      name: this.name,
      children: this.children.length,
      bbox: positionTuple(this.position),
      bboxUnit: "px",
    };
  }

  layoutSnapshot(): Record<string, unknown> {
    return {
      kind: "group",
      id: this.id,
      name: this.name,
      position: { ...this.position },
      childOffset: { ...this.childOffset },
      childExtent: { ...this.childExtent },
      rotation: this.rotation,
      flipHorizontal: this.flipHorizontal,
      flipVertical: this.flipVertical,
      children: this.children.map((child) => child.layoutSnapshot()),
    };
  }
}

export class PresentationGroupCollection {
  readonly items: PresentationGroup[] = [];

  constructor(private readonly slide: Slide) {}

  add(config: PresentationGroupConfig = {}): PresentationGroup {
    const group = new PresentationGroup(this.slide, config);
    this.items.push(group);
    this.slide.appendElement(group);
    return group;
  }
}

export class PresentationImage {
  readonly id: string;
  name: string;
  position: PresentationPosition;
  fit: "contain" | "cover";
  contentType: string | undefined;
  alt: string;
  prompt: string | undefined;
  crop: { left: number; top: number; right: number; bottom: number } | undefined;
  geometry: "rect" | "roundRect" | "ellipse";
  borderRadius: number | string | undefined;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  lockAspectRatio: boolean;
  private blob: Uint8Array | undefined;
  private dataUrl: string | undefined;
  private uri: string | undefined;
  private validatedContentType: PresentationRasterImageContentType | undefined;
  private cachedCanonicalDataUrl: string | undefined;

  constructor(
    readonly slide: Slide,
    config: PresentationImageConfig,
  ) {
    this.id = slide.presentation.allocateId("im", this);
    this.name = config.name ?? this.id;
    assertSafeText(this.name, "image name");
    this.position = normalizePosition(config.position ?? config.frame, {
      left: 72,
      top: 120,
      width: 480,
      height: 270,
    });
    this.fit = config.fit ?? "contain";
    if (this.fit !== "contain" && this.fit !== "cover") {
      throw new InvalidPresentationInputError("image fit", "must be contain or cover");
    }
    this.contentType = config.contentType;
    this.alt = config.alt ?? "";
    assertSafeText(this.alt, "image alt");
    this.prompt = config.prompt;
    if (this.prompt !== undefined) assertSafeText(this.prompt, "image prompt");
    this.crop = config.crop ? normalizeCrop(config.crop) : undefined;
    this.geometry = config.geometry ?? "rect";
    if (!(["rect", "roundRect", "ellipse"] as const).includes(this.geometry)) {
      throw new InvalidPresentationInputError("image geometry", "is not supported");
    }
    this.borderRadius = config.borderRadius;
    validateBorderRadius(this.borderRadius, "image borderRadius");
    this.rotation = finiteOr(config.rotation, 0);
    validateRotation(this.rotation, "image rotation");
    this.flipHorizontal = config.flipHorizontal ?? false;
    this.flipVertical = config.flipVertical ?? false;
    this.lockAspectRatio = config.lockAspectRatio ?? false;
    this.assignSource(config);
  }

  get frame(): PresentationPosition {
    return this.position;
  }

  set frame(value: PresentationPosition) {
    this.position = normalizePosition(value);
  }

  replace(config: PresentationImageConfig): void {
    if (config.alt !== undefined) assertSafeText(config.alt, "image alt");
    if (config.prompt !== undefined) assertSafeText(config.prompt, "image prompt");
    if (config.fit !== undefined && config.fit !== "contain" && config.fit !== "cover") {
      throw new InvalidPresentationInputError("image fit", "must be contain or cover");
    }
    this.assignSource(config);
    if (config.alt !== undefined) this.alt = config.alt;
    if (config.fit !== undefined) this.fit = config.fit;
    if (config.prompt !== undefined) this.prompt = config.prompt;
  }

  /**
   * Explicitly materializes a host-owned URI into trusted raster bytes.
   *
   * Render and file export never invoke resolvers, fetch, or read files. A host
   * must call this method deliberately, and returned bytes still pass the same
   * MIME/signature validation as direct `blob` input.
   */
  async resolveUri(): Promise<void> {
    if (!this.uri) {
      throw new InvalidPresentationInputError(
        "image uri",
        `Image ${this.id} has no URI to resolve`,
      );
    }
    const uri = this.uri;
    assertSafeText(this.name, `image ${this.id} name`);
    let resolution: PresentationImageResolution;
    try {
      resolution = await this.slide.presentation.resolveImageUri({
        uri,
        imageId: this.id,
        name: this.name,
      });
    } catch (error) {
      const failure = new InvalidPresentationInputError(
        "image resolver",
        `failed to resolve image ${this.id}`,
      );
      Object.defineProperty(failure, "cause", { value: error, enumerable: false });
      throw failure;
    }
    if (!resolution || typeof resolution !== "object" || !("blob" in resolution)) {
      throw new InvalidPresentationInputError(
        "image resolver",
        "must return { blob, contentType? }",
      );
    }
    this.assignSource({
      blob: resolution.blob,
      ...(resolution.contentType ? { contentType: resolution.contentType } : {}),
    });
  }

  sourceForSvg(): string | undefined {
    if (this.uri) throw unresolvedImageUriError(this.id);
    if (this.dataUrl) {
      if (!this.contentType) {
        throw new InvalidPresentationInputError(
          "image contentType",
          `Image ${this.id} has no validated raster MIME type`,
        );
      }
      const contentType = normalizeRasterMime(this.contentType);
      if (
        contentType !== this.validatedContentType ||
        !this.dataUrl.startsWith(`data:${contentType};base64,`)
      ) {
        throw new InvalidPresentationInputError(
          "image contentType",
          `Image ${this.id} MIME type no longer matches its data URL`,
        );
      }
      return (this.cachedCanonicalDataUrl ??= this.dataUrl);
    }
    if (this.blob) {
      if (!this.contentType) {
        throw new InvalidPresentationInputError(
          "image contentType",
          `Image ${this.id} has no validated raster MIME type`,
        );
      }
      const contentType = normalizeRasterMime(this.contentType);
      if (contentType !== this.validatedContentType) {
        throw new InvalidPresentationInputError(
          "image contentType",
          `Image ${this.id} MIME type no longer matches its validated bytes`,
        );
      }
      return (this.cachedCanonicalDataUrl ??= `data:${contentType};base64,${encodeRasterBase64(this.blob)}`);
    }
    return undefined;
  }

  sourceForPptx(): { data: string } {
    const source = this.sourceForSvg();
    if (!source) {
      throw new UnsupportedPresentationFeatureError(
        "prompt-only image PPTX export",
        `Image ${this.id} must be regenerated to validated raster bytes or a raster data URL before export`,
      );
    }
    return { data: source };
  }

  inspectRecord(slideIndex: number): Record<string, unknown> {
    return {
      kind: "image",
      id: this.id,
      slide: slideIndex + 1,
      name: this.name,
      alt: this.alt,
      prompt: this.prompt,
      fit: this.fit,
      geometry: this.geometry,
      source: this.blob ? "blob" : this.dataUrl ? "dataUrl" : this.uri ? "uri" : "prompt",
      bbox: positionTuple(this.position),
      bboxUnit: "px",
    };
  }

  layoutSnapshot(): Record<string, unknown> {
    return {
      kind: "image",
      id: this.id,
      name: this.name,
      alt: this.alt,
      prompt: this.prompt,
      fit: this.fit,
      geometry: this.geometry,
      position: { ...this.position },
      crop: this.crop ? { ...this.crop } : undefined,
      rotation: this.rotation,
    };
  }

  private assignSource(config: PresentationImageConfig): void {
    const concrete = [
      "blob" in config && config.blob !== undefined,
      "dataUrl" in config && config.dataUrl !== undefined,
      "uri" in config && config.uri !== undefined,
    ].filter(Boolean).length;
    if (concrete > 1)
      throw new InvalidPresentationInputError(
        "image source",
        "accepts exactly one concrete source: blob, dataUrl, or uri",
      );
    if (concrete === 0 && !config.prompt)
      throw new InvalidPresentationInputError(
        "image source",
        "requires blob, dataUrl, uri, or prompt",
      );

    let blob: Uint8Array | undefined;
    let dataUrl: string | undefined;
    let uri: string | undefined;
    let contentType: PresentationRasterImageContentType | undefined;

    if ("blob" in config && config.blob !== undefined) {
      const bytes = copyImageBytes(config.blob);
      blob = bytes;
      contentType = validateRasterBytes(bytes, config.contentType, "image blob");
    } else if ("dataUrl" in config && config.dataUrl !== undefined) {
      const parsed = parseRasterDataUrl(config.dataUrl);
      if (
        config.contentType !== undefined &&
        normalizeRasterMime(config.contentType) !== parsed.type
      ) {
        throw new InvalidPresentationInputError(
          "image contentType",
          "does not match the data URL MIME type",
        );
      }
      dataUrl = parsed.canonical;
      contentType = parsed.type;
    } else if ("uri" in config && config.uri !== undefined) {
      this.slide.presentation.assertImageUriAccepted(config.uri);
      uri = config.uri;
    }

    this.blob = blob;
    this.dataUrl = dataUrl;
    this.uri = uri;
    this.contentType = contentType;
    this.validatedContentType = contentType;
    this.cachedCanonicalDataUrl = undefined;
  }
}

export class PresentationImageCollection {
  readonly items: PresentationImage[] = [];

  constructor(private readonly slide: Slide) {}

  add(config: PresentationImageConfig): PresentationImage {
    const image = new PresentationImage(this.slide, config);
    this.items.push(image);
    this.slide.appendElement(image);
    return image;
  }
}

// oxlint-disable-next-line typescript/no-extraneous-class -- skill-compatible codec facade
export class PresentationFile {
  static async exportPptx(
    presentation: Presentation,
    options: PresentationPptxExportOptions = {},
  ): Promise<FileBlob> {
    validatePresentation(presentation, true);
    const { exportPresentationPptx } = await import("@opengeni/artifact-tool/presentation/pptx");
    return await exportPresentationPptx(presentation, options);
  }

  static async importPptx(
    input: FileBlob | Blob | ArrayBuffer | Uint8Array,
    options: PresentationPptxImportOptions = {},
  ): Promise<Presentation> {
    const { importPresentationPptx } = await import("@opengeni/artifact-tool/presentation/pptx");
    return await importPresentationPptx(input, options);
  }

  static fidelityReport(presentation: Presentation): readonly PresentationFidelityIssue[] {
    const issues: PresentationFidelityIssue[] = [];
    if (
      presentation.masters.items.length > 1 ||
      presentation.masters.items.some((master) => master.elements.length > 0)
    ) {
      issues.push({
        code: "content-preserved-in-source",
        severity: "warning",
        feature: "master",
        message:
          "Master hierarchy is editable but requires the package-native PPTX writer for regeneration",
      });
    }
    if (
      presentation.layouts.items.length > 1 ||
      presentation.layouts.items.some((layout) => layout.elements.length > 0)
    ) {
      issues.push({
        code: "content-preserved-in-source",
        severity: "warning",
        feature: "layout",
        message:
          "Layout inheritance is editable but requires the package-native PPTX writer for regeneration",
      });
    }
    if (presentation.slides.items.some((slide) => slide.groups.items.length > 0)) {
      issues.push({
        code: "group-will-be-flattened",
        severity: "warning",
        feature: "group",
        message:
          "PptxGenJS cannot emit group scene nodes; explicit lossy export flattens their children",
      });
    }
    for (const slide of presentation.slides.items) {
      for (const chart of slide.charts.items) {
        if (
          (chart.type === "scatter" || chart.type === "bubble") &&
          !chartSeriesShareXValues(chart)
        ) {
          issues.push({
            code: "style-approximated",
            severity: "warning",
            feature: "unsupported-chart",
            message: `Chart ${chart.id} has different X values per series; the fallback PPTX writer only supports one shared X vector`,
          });
        }
      }
    }
    const provenance = presentationLossState(presentation);
    if (provenance?.unsupportedParts.length) {
      issues.push({
        code: "content-preserved-in-source",
        severity: "warning",
        feature: "theme",
        message: "Validated source-only OOXML parts cannot be regenerated after model edits",
        parts: [...provenance.unsupportedParts],
      });
    }
    return issues;
  }

  static lossPreservationEnvelope(
    presentation: Presentation,
  ): PresentationLossPreservationEnvelope | null {
    const envelope = presentationLossState(presentation);
    return envelope
      ? {
          ...envelope,
          sourceBytes: envelope.sourceBytes.slice(),
          unsupportedParts: [...envelope.unsupportedParts],
        }
      : null;
  }
}

function chartSeriesShareXValues(chart: PresentationChart): boolean {
  const reference = chart.series.items[0]?.xValues ?? [];
  if (reference.length === 0) return false;
  return chart.series.items.every(
    (series) =>
      series.xValues.length === reference.length &&
      series.xValues.every((value, index) => Object.is(value, reference[index])),
  );
}

type MontageDimensions = {
  columns: number;
  rows: number;
  gap: number;
  width: number;
  height: number;
};

function montageDimensions(
  presentation: Presentation,
  requestedColumns?: number,
  requestedGap?: number,
): MontageDimensions {
  const count = presentation.slides.items.length;
  if (count === 0) {
    throw new InvalidPresentationInputError("montage", "cannot export an empty presentation");
  }
  const columns = requestedColumns ?? Math.ceil(Math.sqrt(count));
  if (!Number.isInteger(columns) || columns <= 0) {
    throw new InvalidPresentationInputError("montage columns", "must be a positive integer");
  }
  const gap = requestedGap ?? 24;
  if (!Number.isFinite(gap) || gap < 0) {
    throw new InvalidPresentationInputError("montage gap", "must be a non-negative number");
  }
  const rows = Math.ceil(count / columns);
  const width = columns * presentation.slideSize.width + (columns + 1) * gap;
  const height = rows * presentation.slideSize.height + (rows + 1) * gap;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new InvalidPresentationInputError("montage geometry", "exceeds finite numeric bounds");
  }
  return { columns, rows, gap, width, height };
}

function validateRenderScale(scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new InvalidPresentationInputError("export scale", "must be greater than 0 and at most 8");
  }
}

function assertRenderPixelBudget(width: number, height: number, scale: number): void {
  const scaledWidth = Math.ceil(width * scale);
  const scaledHeight = Math.ceil(height * scale);
  if (
    !Number.isSafeInteger(scaledWidth) ||
    !Number.isSafeInteger(scaledHeight) ||
    scaledWidth <= 0 ||
    scaledHeight <= 0
  ) {
    throw new InvalidPresentationInputError(
      "render geometry",
      "scaled dimensions must be positive safe integers",
    );
  }
  if (scaledWidth > MAX_RENDER_DIMENSION || scaledHeight > MAX_RENDER_DIMENSION) {
    throw new InvalidPresentationInputError(
      "render dimension limit",
      `${scaledWidth}x${scaledHeight} exceeds maximum dimension ${MAX_RENDER_DIMENSION}`,
    );
  }
  if (scaledWidth > Math.floor(MAX_RENDER_PIXELS / scaledHeight)) {
    throw new InvalidPresentationInputError(
      "render pixel limit",
      `${scaledWidth}x${scaledHeight} exceeds maximum ${MAX_RENDER_PIXELS} pixels`,
    );
  }
}

const MAX_GEOMETRY_VALUE = 1_000_000;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_FONT_SIZE = 4_096;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_URI_LENGTH = 4_096;
const MAX_RENDER_DIMENSION = 32_768;
const MAX_RENDER_PIXELS = 67_108_864;
const MAX_TABLE_ROWS = 10_000;
const MAX_TABLE_COLUMNS = 1_024;
const MAX_TABLE_SPAN = 1_024;
const MAX_GROUP_DEPTH = 32;
const MAX_GROUP_CHILDREN = 100_000;

const PRESENTATION_GEOMETRIES = new Set<PresentationShapeGeometry>([
  "textbox",
  "rect",
  "roundRect",
  "ellipse",
  "triangle",
  "rightArrow",
  "line",
]);
const CHART_TYPES = new Set<PresentationChartType>([
  "bar",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "bubble",
  "radar",
]);
const LINE_STYLES: ReadonlySet<unknown> = new Set(["solid", "dash", "dot", "none"]);
const TEXT_ALIGNMENTS: ReadonlySet<unknown> = new Set(["left", "center", "right", "justify"]);
const VERTICAL_ALIGNMENTS: ReadonlySet<unknown> = new Set(["top", "middle", "bottom"]);
const BORDER_RADIUS_TOKENS: Readonly<Record<string, number>> = {
  rounded: 4,
  "rounded-lg": 8,
  "rounded-xl": 12,
  "rounded-2xl": 16,
  "rounded-3xl": 24,
};
const FORBIDDEN_IMAGE_URI_SCHEMES = new Set([
  "blob",
  "data",
  "file",
  "ftp",
  "ftps",
  "http",
  "https",
  "javascript",
]);

function cloneTemplateElement(element: PresentationTemplateElement): PresentationTemplateElement {
  if (!element || typeof element !== "object") {
    throw new InvalidPresentationInputError("template element", "must be an object");
  }
  switch (element.kind) {
    case "shape":
      return {
        kind: "shape",
        config: {
          ...element.config,
          ...(element.config.position ? { position: { ...element.config.position } } : {}),
          ...(element.config.line ? { line: { ...element.config.line } } : {}),
          ...(element.config.textStyle ? { textStyle: { ...element.config.textStyle } } : {}),
        },
      };
    case "chart":
      return {
        kind: "chart",
        type: element.type,
        ...(element.config
          ? {
              config: {
                ...element.config,
                ...(element.config.position ? { position: { ...element.config.position } } : {}),
                ...(element.config.categories
                  ? { categories: [...element.config.categories] }
                  : {}),
                ...(element.config.series
                  ? {
                      series: element.config.series.map((series) => ({
                        ...series,
                        ...(series.categories ? { categories: [...series.categories] } : {}),
                        ...(series.values ? { values: [...series.values] } : {}),
                        ...(series.xValues ? { xValues: [...series.xValues] } : {}),
                        ...(series.bubbleSizes ? { bubbleSizes: [...series.bubbleSizes] } : {}),
                        ...(series.line ? { line: { ...series.line } } : {}),
                      })),
                    }
                  : {}),
                ...(element.config.legend ? { legend: { ...element.config.legend } } : {}),
                ...(element.config.xAxis ? { xAxis: { ...element.config.xAxis } } : {}),
                ...(element.config.yAxis ? { yAxis: { ...element.config.yAxis } } : {}),
                ...(element.config.dataLabels
                  ? { dataLabels: { ...element.config.dataLabels } }
                  : {}),
              },
            }
          : {}),
      };
    case "image": {
      const config = element.config;
      return {
        kind: "image",
        config: {
          ...config,
          ...(config.blob !== undefined
            ? {
                blob:
                  config.blob instanceof Uint8Array ? config.blob.slice() : config.blob.slice(0),
              }
            : {}),
          ...(config.position ? { position: { ...config.position } } : {}),
          ...(config.frame ? { frame: { ...config.frame } } : {}),
          ...(config.crop ? { crop: { ...config.crop } } : {}),
        } as PresentationImageConfig,
      };
    }
    case "table":
      return {
        kind: "table",
        config: {
          ...element.config,
          ...(element.config.position ? { position: { ...element.config.position } } : {}),
          rows: element.config.rows.map((row) =>
            row.map((cell) =>
              cell === null || typeof cell === "string"
                ? cell
                : {
                    ...cell,
                    ...(cell.textStyle ? { textStyle: { ...cell.textStyle } } : {}),
                  },
            ),
          ),
          ...(element.config.columnWidths
            ? { columnWidths: [...element.config.columnWidths] }
            : {}),
          ...(element.config.rowHeights ? { rowHeights: [...element.config.rowHeights] } : {}),
          ...(element.config.line ? { line: { ...element.config.line } } : {}),
          ...(element.config.textStyle ? { textStyle: { ...element.config.textStyle } } : {}),
        },
      };
  }
}

function normalizeTableDimensions(
  values: readonly number[] | undefined,
  expected: number,
  field: string,
): number[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length !== expected) {
    throw new InvalidPresentationInputError(`table ${field}`, `must contain ${expected} values`);
  }
  const output = [...values];
  if (output.some((value) => !Number.isFinite(value) || value <= 0 || value > MAX_GEOMETRY_VALUE)) {
    throw new InvalidPresentationInputError(
      `table ${field}`,
      "must contain bounded positive numbers",
    );
  }
  return output;
}

function validateTableOccupancy(
  rows: readonly (readonly (PresentationTableCell | null)[])[],
): void {
  const rowCount = rows.length;
  const columnCount = rows[0]?.length ?? 0;
  const covered = Array.from({ length: rowCount }, () => new Uint8Array(columnCount));
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const cell = rows[row]![column];
      if (cell === undefined) {
        throw new InvalidPresentationInputError("table rows", "must form a rectangular matrix");
      }
      if (cell === null) {
        if (covered[row]![column] === 0) {
          throw new InvalidPresentationInputError(
            "table cell occupancy",
            `uncovered null at row ${row + 1}, column ${column + 1}`,
          );
        }
        continue;
      }
      if (covered[row]![column] !== 0) {
        throw new InvalidPresentationInputError(
          "table cell occupancy",
          `spanned position at row ${row + 1}, column ${column + 1} must be null`,
        );
      }
      if (row + cell.rowSpan > rowCount || column + cell.colSpan > columnCount) {
        throw new InvalidPresentationInputError(
          "table cell span",
          `cell at row ${row + 1}, column ${column + 1} extends outside the table`,
        );
      }
      for (let coveredRow = row; coveredRow < row + cell.rowSpan; coveredRow += 1) {
        for (
          let coveredColumn = column;
          coveredColumn < column + cell.colSpan;
          coveredColumn += 1
        ) {
          if (coveredRow === row && coveredColumn === column) continue;
          if (covered[coveredRow]![coveredColumn] !== 0) {
            throw new InvalidPresentationInputError("table cell span", "overlaps another span");
          }
          covered[coveredRow]![coveredColumn] = 1;
        }
      }
    }
  }
}

function normalizePlaceholder(
  value: PresentationShapeConfig["placeholder"],
): { type: string; index?: number } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new InvalidPresentationInputError("shape placeholder", "must be an object");
  }
  assertSafeText(value.type, "shape placeholder type", 128);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value.type)) {
    throw new InvalidPresentationInputError("shape placeholder type", "is invalid");
  }
  if (value.index !== undefined && (!Number.isSafeInteger(value.index) || value.index < 0)) {
    throw new InvalidPresentationInputError(
      "shape placeholder index",
      "must be a non-negative safe integer",
    );
  }
  return value.index === undefined
    ? { type: value.type }
    : { type: value.type, index: value.index };
}

function validateImageUriPolicy(
  resolver: PresentationImageResolver | undefined,
  schemes: readonly string[] | undefined,
): ReadonlySet<string> {
  if (schemes !== undefined && !Array.isArray(schemes)) {
    throw new InvalidPresentationInputError("allowedImageUriSchemes", "must be an array");
  }
  const normalized = new Set<string>();
  for (const value of schemes ?? []) {
    if (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*$/i.test(value)) {
      throw new InvalidPresentationInputError(
        "allowedImageUriSchemes",
        "contains an invalid URI scheme",
      );
    }
    const scheme = value.toLowerCase();
    if (FORBIDDEN_IMAGE_URI_SCHEMES.has(scheme)) {
      throw new InvalidPresentationInputError(
        "allowedImageUriSchemes",
        `${scheme}: is reserved for active, local, or remote resources`,
      );
    }
    normalized.add(scheme);
  }
  if (!resolver && normalized.size > 0) {
    throw new InvalidPresentationInputError(
      "allowedImageUriSchemes",
      "requires an injected imageResolver",
    );
  }
  return normalized;
}

function imageUriScheme(uri: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
  if (!match) {
    throw new InvalidPresentationInputError(
      "image uri",
      "must use a host-owned, explicitly allowed URI scheme",
    );
  }
  return match[1]!.toLowerCase();
}

function validatePresentation(presentation: Presentation, requireResolvedImages: boolean): void {
  validatePosition(
    {
      left: 0,
      top: 0,
      width: presentation.slideSize.width,
      height: presentation.slideSize.height,
    },
    "slideSize",
  );
  for (const master of presentation.masters.items) {
    assertSafeText(master.name, `master ${master.id} name`, 512);
    colorValue(master.background);
  }
  for (const layout of presentation.layouts.items) {
    assertSafeText(layout.name, `layout ${layout.id} name`, 512);
    colorValue(layout.background);
    if (
      layout.masterId !== undefined &&
      !presentation.masters.items.some((master) => master.id === layout.masterId)
    ) {
      throw new InvalidPresentationInputError(
        `layout ${layout.id} masterId`,
        "must reference a master in this presentation",
      );
    }
  }
  for (const [slideIndex, slide] of presentation.slides.items.entries()) {
    assertSafeText(slide.title, `slides[${slideIndex}].title`);
    assertSafeText(slide.notes.toString(), `slides[${slideIndex}].notes`);
    colorValue(slide.background.fill);
    for (const shape of slide.shapes.items) {
      if (!PRESENTATION_GEOMETRIES.has(shape.geometry)) {
        throw new InvalidPresentationInputError("shape geometry", "is not supported");
      }
      assertSafeText(shape.name, `shape ${shape.id} name`);
      validatePosition(shape.position, `shape ${shape.id} position`);
      colorValue(shape.fill);
      validateLine(shape.line, `shape ${shape.id} line`);
      validateRotation(shape.rotation, `shape ${shape.id} rotation`);
      validateBorderRadius(shape.borderRadius, `shape ${shape.id} borderRadius`);
      normalizePlaceholder(shape.placeholder);
      assertSafeText(shape.text.toString(), `shape ${shape.id} text`);
      validateTextStyle(shape.text.style, `shape ${shape.id} textStyle`);
    }
    for (const chart of slide.charts.items) {
      if (!CHART_TYPES.has(chart.type)) {
        throw new InvalidPresentationInputError("chart type", "is not supported");
      }
      assertSafeText(chart.name, `chart ${chart.id} name`);
      assertSafeText(chart.title, `chart ${chart.id} title`);
      validatePosition(chart.position, `chart ${chart.id} position`);
      for (const [index, category] of chart.categories.entries()) {
        assertSafeText(category, `chart ${chart.id} categories[${index}]`);
      }
      validateOptionalFinite(chart.xAxis?.min, `chart ${chart.id} xAxis.min`);
      validateOptionalFinite(chart.xAxis?.max, `chart ${chart.id} xAxis.max`);
      validateOptionalFinite(chart.yAxis?.min, `chart ${chart.id} yAxis.min`);
      validateOptionalFinite(chart.yAxis?.max, `chart ${chart.id} yAxis.max`);
      for (const [seriesIndex, series] of chart.series.items.entries()) {
        assertSafeText(series.name, `chart ${chart.id} series[${seriesIndex}].name`);
        for (const [index, category] of series.categories.entries()) {
          assertSafeText(category, `chart ${chart.id} series[${seriesIndex}].categories[${index}]`);
        }
        validateFiniteArray(series.values, `chart ${chart.id} series[${seriesIndex}].values`);
        validateFiniteArray(series.xValues, `chart ${chart.id} series[${seriesIndex}].xValues`);
        validateFiniteArray(
          series.bubbleSizes,
          `chart ${chart.id} series[${seriesIndex}].bubbleSizes`,
        );
        if (series.fill !== undefined) colorValue(series.fill);
        if (series.line !== undefined) {
          validateLine(series.line, `chart ${chart.id} series[${seriesIndex}].line`);
        }
      }
    }
    for (const image of slide.images.items) {
      assertSafeText(image.name, `image ${image.id} name`);
      assertSafeText(image.alt, `image ${image.id} alt`);
      if (image.prompt !== undefined) assertSafeText(image.prompt, `image ${image.id} prompt`);
      validatePosition(image.position, `image ${image.id} position`);
      if (image.fit !== "contain" && image.fit !== "cover") {
        throw new InvalidPresentationInputError(
          `image ${image.id} fit`,
          "must be contain or cover",
        );
      }
      if (!(["rect", "roundRect", "ellipse"] as const).includes(image.geometry)) {
        throw new InvalidPresentationInputError(`image ${image.id} geometry`, "is not supported");
      }
      validateRotation(image.rotation, `image ${image.id} rotation`);
      validateBorderRadius(image.borderRadius, `image ${image.id} borderRadius`);
      if (image.crop !== undefined) normalizeCrop(image.crop);
      for (const [key, value] of [
        ["flipHorizontal", image.flipHorizontal],
        ["flipVertical", image.flipVertical],
        ["lockAspectRatio", image.lockAspectRatio],
      ] as const) {
        if (typeof value !== "boolean") {
          throw new InvalidPresentationInputError(`image ${image.id} ${key}`, "must be boolean");
        }
      }
      if (requireResolvedImages) image.sourceForSvg();
    }
    for (const table of slide.tables.items) validatePresentationTable(table);
    for (const group of slide.groups.items) {
      validatePresentationGroup(group, requireResolvedImages, new Set());
    }
    const indexedElements: PresentationElement[] = [
      ...slide.shapes.items,
      ...slide.charts.items,
      ...slide.images.items,
      ...slide.tables.items,
      ...slide.groups.items,
    ];
    if (
      slide.elements.length !== indexedElements.length ||
      new Set(slide.elements).size !== slide.elements.length ||
      indexedElements.some((element) => !slide.elements.includes(element))
    ) {
      throw new InvalidPresentationInputError(
        `slides[${slideIndex}].elements`,
        "must contain each typed top-level element exactly once",
      );
    }
  }
}

function validatePresentationTable(table: PresentationTable): void {
  assertSafeText(table.name, `table ${table.id} name`, 512);
  validatePosition(table.position, `table ${table.id} position`);
  colorValue(table.fill);
  validateLine(table.line, `table ${table.id} line`);
  validateTextStyle(table.textStyle, `table ${table.id} textStyle`);
  validateTableOccupancy(table.rows);
  for (const row of table.rows) {
    for (const cell of row) {
      if (!cell) continue;
      assertSafeText(cell.text.toString(), `table ${table.id} cell text`);
      validateTextStyle(cell.text.style, `table ${table.id} cell textStyle`);
      colorValue(cell.fill);
    }
  }
  normalizeTableDimensions(
    table.columnWidths.length === 0 ? undefined : table.columnWidths,
    table.rows[0]?.length ?? 0,
    "columnWidths",
  );
  normalizeTableDimensions(
    table.rowHeights.length === 0 ? undefined : table.rowHeights,
    table.rows.length,
    "rowHeights",
  );
}

function validatePresentationGroup(
  group: PresentationGroup,
  requireResolvedImages: boolean,
  ancestors: Set<PresentationGroup>,
): void {
  if (ancestors.has(group)) {
    throw new InvalidPresentationInputError(`group ${group.id}`, "contains a cycle");
  }
  ancestors.add(group);
  assertSafeText(group.name, `group ${group.id} name`, 512);
  validatePosition(group.position, `group ${group.id} position`);
  validatePosition(
    {
      left: group.childOffset.left,
      top: group.childOffset.top,
      width: group.childExtent.width,
      height: group.childExtent.height,
    },
    `group ${group.id} child coordinate system`,
  );
  validateRotation(group.rotation, `group ${group.id} rotation`);
  for (const child of group.children) {
    if (child.slide !== group.slide) {
      throw new InvalidPresentationInputError(
        `group ${group.id}`,
        "contains an element from another slide",
      );
    }
    if (child instanceof PresentationGroup) {
      validatePresentationGroup(child, requireResolvedImages, ancestors);
    } else if (child instanceof PresentationTable) {
      validatePresentationTable(child);
    } else if (child instanceof PresentationShape) {
      validatePosition(child.position, `shape ${child.id} position`);
      assertSafeText(child.text.toString(), `shape ${child.id} text`);
      validateTextStyle(child.text.style, `shape ${child.id} textStyle`);
      colorValue(child.fill);
      validateLine(child.line, `shape ${child.id} line`);
    } else if (child instanceof PresentationChart) {
      validatePosition(child.position, `chart ${child.id} position`);
      for (const series of child.series.items)
        validateFiniteArray(series.values, `chart ${child.id} values`);
    } else if (child instanceof PresentationImage) {
      validatePosition(child.position, `image ${child.id} position`);
      if (requireResolvedImages) child.sourceForSvg();
    }
  }
  ancestors.delete(group);
}

function validatePosition(position: PresentationPosition, field: string): void {
  const values = [position.left, position.top, position.width, position.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new InvalidPresentationInputError(field, "values must be finite numbers");
  }
  if (position.width <= 0 || position.height <= 0) {
    throw new InvalidPresentationInputError(field, "width and height must be positive");
  }
  if (values.some((value) => Math.abs(value) > MAX_GEOMETRY_VALUE)) {
    throw new InvalidPresentationInputError(field, "values exceed the supported geometry bounds");
  }
}

function validateRotation(value: number, field: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_GEOMETRY_VALUE) {
    throw new InvalidPresentationInputError(field, "must be a bounded finite number");
  }
}

function validateBorderRadius(value: number | string | undefined, field: string): void {
  if (value === undefined) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > MAX_GEOMETRY_VALUE) {
      throw new InvalidPresentationInputError(field, "must be a bounded non-negative number");
    }
    return;
  }
  if (value !== "rounded-full" && !Object.hasOwn(BORDER_RADIUS_TOKENS, value)) {
    throw new InvalidPresentationInputError(field, "uses an unsupported radius token");
  }
}

function validateLine(line: PresentationLine, field: string): void {
  if (!line || typeof line !== "object") {
    throw new InvalidPresentationInputError(field, "must be an object");
  }
  if (line.style !== undefined && !LINE_STYLES.has(line.style)) {
    throw new InvalidPresentationInputError(field, "uses an unsupported line style");
  }
  if (line.fill !== undefined) colorValue(line.fill);
  if (
    line.width !== undefined &&
    (!Number.isFinite(line.width) || line.width < 0 || line.width > MAX_GEOMETRY_VALUE)
  ) {
    throw new InvalidPresentationInputError(field, "width must be a bounded non-negative number");
  }
}

function validateTextStyle(style: PresentationTextStyle, field: string): void {
  if (!style || typeof style !== "object") {
    throw new InvalidPresentationInputError(field, "must be an object");
  }
  if (style.fontFamily !== undefined) assertSafeText(style.fontFamily, `${field}.fontFamily`, 512);
  if (
    style.fontSize !== undefined &&
    (!Number.isFinite(style.fontSize) || style.fontSize <= 0 || style.fontSize > MAX_FONT_SIZE)
  ) {
    throw new InvalidPresentationInputError(
      `${field}.fontSize`,
      `must be greater than 0 and at most ${MAX_FONT_SIZE}`,
    );
  }
  if (style.color !== undefined) colorValue(style.color);
  if (style.alignment !== undefined && !TEXT_ALIGNMENTS.has(style.alignment)) {
    throw new InvalidPresentationInputError(`${field}.alignment`, "is not supported");
  }
  if (style.verticalAlignment !== undefined && !VERTICAL_ALIGNMENTS.has(style.verticalAlignment)) {
    throw new InvalidPresentationInputError(`${field}.verticalAlignment`, "is not supported");
  }
  for (const key of ["bold", "italic", "underline"] as const) {
    if (style[key] !== undefined && typeof style[key] !== "boolean") {
      throw new InvalidPresentationInputError(`${field}.${key}`, "must be boolean");
    }
  }
}

function validateOptionalFinite(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > MAX_GEOMETRY_VALUE)) {
    throw new InvalidPresentationInputError(field, "must be a bounded finite number");
  }
}

function validateFiniteArray(values: number[], field: string): void {
  if (!Array.isArray(values)) {
    throw new InvalidPresentationInputError(field, "must be an array");
  }
  for (const value of values) validateOptionalFinite(value, field);
}

function assertSafeText(value: string, field: string, maxLength = MAX_TEXT_LENGTH): void {
  if (typeof value !== "string") {
    throw new InvalidPresentationInputError(field, "must be a string");
  }
  if (value.length > maxLength) {
    throw new InvalidPresentationInputError(field, `exceeds ${maxLength} UTF-16 code units`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new InvalidPresentationInputError(field, "contains characters forbidden by XML 1.0");
    }
  }
}

function copyImageBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array)) {
    throw new InvalidPresentationInputError("image blob", "must be an ArrayBuffer or Uint8Array");
  }
  const bytes =
    value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new InvalidPresentationInputError(
      "image blob",
      `must contain between 1 and ${MAX_IMAGE_BYTES} bytes`,
    );
  }
  return bytes;
}

function normalizeRasterMime(value: string): PresentationRasterImageContentType {
  try {
    return normalizeRasterContentType(value);
  } catch (error) {
    if (error instanceof RasterImageValidationError) {
      throw new InvalidPresentationInputError("image contentType", error.detail);
    }
    throw error;
  }
}

function validateRasterBytes(
  bytes: Uint8Array,
  declaredType: string | undefined,
  field: string,
): PresentationRasterImageContentType {
  try {
    return validateRasterImageBytes(bytes, declaredType);
  } catch (error) {
    if (error instanceof RasterImageValidationError) {
      throw new InvalidPresentationInputError(field, error.detail);
    }
    throw error;
  }
}

function parseRasterDataUrl(value: string): {
  type: PresentationRasterImageContentType;
  canonical: string;
} {
  try {
    const result = canonicalizeRasterDataUrl(value, MAX_IMAGE_BYTES);
    return { type: result.contentType, canonical: result.canonical };
  } catch (error) {
    if (error instanceof RasterImageValidationError) {
      throw new InvalidPresentationInputError("image dataUrl", error.detail);
    }
    throw error;
  }
}

function unresolvedImageUriError(id: string): UnsupportedPresentationFeatureError {
  return new UnsupportedPresentationFeatureError(
    "unresolved image URI",
    `Image ${id} is a host reference. Call image.resolveUri() explicitly before render or export`,
  );
}

function normalizePosition(
  input: Partial<PresentationPosition> | undefined,
  defaults: PresentationPosition = { left: 0, top: 0, width: 100, height: 100 },
): PresentationPosition {
  const result = {
    left: input?.left ?? defaults.left,
    top: input?.top ?? defaults.top,
    width: input?.width ?? defaults.width,
    height: input?.height ?? defaults.height,
  };
  validatePosition(result, "position");
  return result;
}

function normalizeCrop(crop: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): typeof crop {
  const normalized = { ...crop };
  if (
    !Object.values(normalized).every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
    )
  ) {
    throw new InvalidPresentationInputError("image crop", "values must be between 0 and 1");
  }
  if (normalized.left + normalized.right >= 1 || normalized.top + normalized.bottom >= 1) {
    throw new InvalidPresentationInputError(
      "image crop",
      "cannot remove the complete source image",
    );
  }
  return normalized;
}

function colorValue(fill: PresentationFill): string {
  if (typeof fill !== "string") {
    if (!fill || typeof fill !== "object" || (fill.type !== undefined && fill.type !== "solid")) {
      throw new InvalidPresentationInputError("fill", "must be a string or a solid color object");
    }
  }
  const value = typeof fill === "string" ? fill : fill.color;
  if (typeof value !== "string") {
    throw new InvalidPresentationInputError("color", "must be a string");
  }
  if (value === "none") return "none";
  const token = COLOR_TOKENS[value];
  if (token) return token;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toLowerCase();
  }
  throw new InvalidPresentationInputError("color", "must be a known token, none, #RGB, or #RRGGBB");
}

const COLOR_TOKENS: Readonly<Record<string, string>> = {
  white: "#ffffff",
  black: "#000000",
  accent1: "#2563eb",
  accent2: "#0f766e",
  "slate-50": "#f8fafc",
  "slate-100": "#f1f5f9",
  "slate-200": "#e2e8f0",
  "slate-300": "#cbd5e1",
  "slate-400": "#94a3b8",
  "slate-500": "#64748b",
  "slate-600": "#475569",
  "slate-700": "#334155",
  "slate-800": "#1e293b",
  "slate-900": "#0f172a",
  "slate-950": "#020617",
};

function projectRecord(
  record: Record<string, unknown>,
  includeText: string | undefined,
  excludeText: string | undefined,
): Record<string, unknown> {
  const include = parseProjection(includeText);
  const exclude = parseProjection(excludeText);
  if (include.size === 0 && exclude.size === 0) return record;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((include.size === 0 || include.has(key)) && !exclude.has(key)) projected[key] = value;
  }
  return projected;
}

function parseProjection(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function boundRecords(
  records: Array<Record<string, unknown>>,
  maxChars: number,
): PresentationInspectResult {
  if (!Number.isInteger(maxChars) || maxChars <= 0)
    throw new Error("inspect maxChars must be a positive integer");
  const accepted: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let length = 0;
  for (const record of records) {
    const line = JSON.stringify(record);
    const additional = line.length + (accepted.length > 0 ? 1 : 0);
    if (length + additional > maxChars) {
      return {
        ndjson: lines.join("\n"),
        records: accepted,
        truncated: true,
      };
    }
    accepted.push(record);
    lines.push(line);
    length += additional;
  }
  return {
    ndjson: lines.join("\n"),
    records: accepted,
    truncated: false,
  };
}

function jsonBlob(value: unknown, name: string): FileBlob {
  return new FileBlob([JSON.stringify(value, null, 2)], { name, type: "application/json" });
}

function positionTuple(position: PresentationPosition): [number, number, number, number] {
  return [position.left, position.top, position.width, position.height];
}

function finiteOr(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) {
    throw new InvalidPresentationInputError("number", "must be finite");
  }
  return value;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export {
  assertRenderPixelBudget as assertPresentationRenderPixelBudget,
  colorValue as presentationColorValue,
  truncate as truncatePresentationText,
};
