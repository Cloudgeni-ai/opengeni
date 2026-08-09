import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExpandIcon,
  FilePlus2Icon,
  MinusIcon,
  PlusIcon,
  Trash2Icon,
  TypeIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Presentation,
  PresentationChart,
  PresentationElement,
  PresentationFill,
  PresentationGroup,
  PresentationGroupChild,
  PresentationImage,
  PresentationLine,
  PresentationPosition,
  PresentationShape,
  PresentationTable,
  PresentationTextStyle,
  Slide,
} from "@opengeni/artifact-tool/reference";

import { cn } from "../../lib/cn";
import { ArtifactSurface } from "./artifact-surface";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const RAIL_ITEM_HEIGHT = 116;
const RAIL_OVERSCAN = 3;
const DEFAULT_RAIL_HEIGHT = 640;
const DEFAULT_VIEWPORT = { width: 960, height: 640 };
const SPATIAL_TILE = 256;
const MAX_SPATIAL_BUCKETS_PER_OBJECT = 1_024;
const CANVAS_OVERSCAN_PX = 96;
const MAX_CANVAS_EDGE = 8_192;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_EDITOR_GEOMETRY = 1_000_000;
const MAX_TABLE_CELLS_PER_PAINT = 20_000;
const MAX_PROJECTION_SLIDES = 100_000;
const MAX_PROJECTION_ELEMENTS_PER_SLIDE = 100_000;
const MAX_PROJECTION_GROUP_DEPTH = 16;
const MAX_PROJECTION_TABLE_CELLS = 1_000_000;
const MAX_PROJECTION_TEXT = 1_000_000;

type PresentationObject = PresentationElement;
type PresentationObjectKind = "shape" | "chart" | "image" | "table" | "group";

type DisplayObject = {
  id: string;
  kind: PresentationObjectKind;
  object: PresentationObject;
  readOnly: boolean;
};

export type PresentationCommit =
  | {
      kind: "slide-insert";
      slideId: string;
      index: number;
      revision?: string | number;
    }
  | {
      kind: "slide-delete";
      slideId: string;
      index: number;
      revision?: string | number;
    }
  | {
      kind: "object-insert";
      slideId: string;
      objectId: string;
      index: number;
      position: PresentationPosition;
      revision?: string | number;
    }
  | {
      kind: "object-delete";
      slideId: string;
      objectId: string;
      revision?: string | number;
    }
  | {
      kind: "move" | "resize";
      slideId: string;
      objectId: string;
      before: PresentationPosition;
      after: PresentationPosition;
      revision?: string | number;
    }
  | {
      kind: "text";
      slideId: string;
      objectId: string;
      before: string;
      after: string;
      revision?: string | number;
    };

export type PresentationCommitHandler =
  | ((commit: PresentationCommit) => void)
  | ((commit: PresentationCommit) => Promise<void>);

export type PresentationProjectionPosition = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type PresentationProjectionFill = string | Readonly<{ type?: "solid"; color: string }>;

export type PresentationProjectionLine = Readonly<{
  style?: "solid" | "dash" | "dot" | "none";
  fill?: PresentationProjectionFill;
  width?: number;
}>;

export type PresentationProjectionTextStyle = Readonly<{
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  alignment?: "left" | "center" | "right" | "justify";
  verticalAlignment?: "top" | "middle" | "bottom";
}>;

export type PresentationProjectionTextRun = Readonly<{
  text: string;
  style: PresentationProjectionTextStyle;
  language?: string | null;
}>;

export type PresentationProjectionTextParagraph = Readonly<{
  runs: readonly PresentationProjectionTextRun[];
  alignment: "left" | "center" | "right" | "justify";
}>;

export type PresentationProjectionRichText = Readonly<{
  paragraphs: readonly PresentationProjectionTextParagraph[];
  verticalAlignment: "top" | "middle" | "bottom";
}>;

export type PresentationProjectionElementMetadata = Readonly<{
  nodeSource?: Readonly<{ kind: "master" | "layout" | "slide"; id: string }>;
  inherited?: boolean;
  parentId?: string | null;
  order?: number;
  /** Inherited master/layout nodes remain visible but cannot be edited in slide mode. */
  readOnly?: boolean;
}>;

export type PresentationProjectionShape = Readonly<{
  kind: "shape";
  id: string;
  name: string;
  geometry: "textbox" | "rect" | "roundRect" | "ellipse" | "triangle" | "rightArrow" | "line";
  position: PresentationProjectionPosition;
  fill?: PresentationProjectionFill;
  line?: PresentationProjectionLine;
  rotation?: number;
  borderRadius?: number | string;
  text: string;
  textStyle?: PresentationProjectionTextStyle;
  richText?: PresentationProjectionRichText;
}> &
  PresentationProjectionElementMetadata;

export type PresentationProjectionChartSeries = Readonly<{
  name: string;
  categories?: readonly string[];
  values: readonly number[];
  xValues?: readonly number[];
  bubbleSizes?: readonly number[];
  fill?: PresentationProjectionFill;
  line?: PresentationProjectionLine;
}>;

export type PresentationProjectionChart = Readonly<{
  kind: "chart";
  id: string;
  name: string;
  type: "bar" | "line" | "area" | "pie" | "doughnut" | "scatter" | "bubble" | "radar";
  position: PresentationProjectionPosition;
  title?: string;
  titleRichText?: PresentationProjectionRichText;
  hasLegend?: boolean;
  series: readonly PresentationProjectionChartSeries[];
  xAxis?: Readonly<{ visible?: boolean; title?: string; min?: number; max?: number }>;
  yAxis?: Readonly<{ visible?: boolean; title?: string; min?: number; max?: number }>;
  dataLabels?: Readonly<{
    showValue?: boolean;
    showSeriesName?: boolean;
    showCategoryName?: boolean;
    showPercent?: boolean;
    position?: "center" | "inEnd" | "outEnd";
  }>;
}> &
  PresentationProjectionElementMetadata;

export type PresentationProjectionImage = Readonly<{
  kind: "image";
  id: string;
  name: string;
  position: PresentationProjectionPosition;
  /** Host-resolved data/blob/same-origin URL. Arbitrary remote URLs are ignored. */
  source?: string;
  alt?: string;
  prompt?: string;
  fit?: "contain" | "cover";
  crop?: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  geometry?: "rect" | "roundRect" | "ellipse";
  borderRadius?: number | string;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  digest?: string;
  contentType?: string;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
}> &
  PresentationProjectionElementMetadata;

export type PresentationProjectionTableCell = Readonly<{
  text: string;
  richText?: PresentationProjectionRichText;
  fill?: PresentationProjectionFill;
  textStyle?: PresentationProjectionTextStyle;
  rowSpan?: number;
  colSpan?: number;
}>;

export type PresentationProjectionTable = Readonly<{
  kind: "table";
  id: string;
  name: string;
  position: PresentationProjectionPosition;
  rows: readonly (readonly (PresentationProjectionTableCell | null)[])[];
  columnWidths?: readonly number[];
  rowHeights?: readonly number[];
  fill?: PresentationProjectionFill;
  line?: PresentationProjectionLine;
  textStyle?: PresentationProjectionTextStyle;
}> &
  PresentationProjectionElementMetadata;

export type PresentationProjectionGroup = Readonly<{
  kind: "group";
  id: string;
  name: string;
  position: PresentationProjectionPosition;
  childOffset: Readonly<{ left: number; top: number }>;
  childExtent: Readonly<{ width: number; height: number }>;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  children: readonly PresentationProjectionElement[];
}> &
  PresentationProjectionElementMetadata;

export type PresentationProjectionConnector = Readonly<{
  kind: "connector";
  id: string;
  name: string;
  connectorKind: "straight" | "elbow" | "curved";
  position: PresentationProjectionPosition;
  start: Readonly<{ nodeId: string | null; x: number; y: number }>;
  end: Readonly<{ nodeId: string | null; x: number; y: number }>;
  line?: PresentationProjectionLine;
}> &
  PresentationProjectionElementMetadata;

export type PresentationProjectionElement =
  | PresentationProjectionShape
  | PresentationProjectionChart
  | PresentationProjectionImage
  | PresentationProjectionTable
  | PresentationProjectionGroup
  | PresentationProjectionConnector;

export type PresentationSlideProjection = Readonly<{
  id: string;
  title?: string;
  background?: PresentationProjectionFill;
  elements: readonly PresentationProjectionElement[];
  layout?: Readonly<{
    id: string;
    name: string;
    masterId: string | null;
    background: PresentationProjectionFill;
  }> | null;
  notes?: PresentationProjectionRichText | null;
}>;

/** Immutable render/edit projection; the host keeps the canonical deck off the React thread. */
export type PresentationEditorProjection = Readonly<{
  revision: string | number;
  slideSize: Readonly<{ width: number; height: number }>;
  slides: readonly PresentationSlideProjection[];
}>;

export type PresentationProjectionEditorProps = Omit<
  PresentationEditorProps,
  "presentation" | "revision" | "onSlideChange" | "onSelectionChange" | "onCommit"
> & {
  projection: PresentationEditorProjection;
  commit?: PresentationCommitHandler | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  onSlideChange?: ((slide: PresentationSlideProjection, index: number) => void) | undefined;
  onSelectionChange?:
    | ((object: PresentationProjectionElement | null, slide: PresentationSlideProjection) => void)
    | undefined;
};

export type PresentationProjectionArtifactSurfaceProps = PresentationProjectionEditorProps & {
  title?: string | undefined;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  busy?: boolean | undefined;
};

export type PresentationEditorProps = {
  presentation: Presentation;
  /** Increment/change after a host applies an out-of-band model mutation. */
  revision?: string | number | undefined;
  activeSlideId?: string | undefined;
  defaultActiveSlideId?: string | undefined;
  selectedObjectId?: string | null | undefined;
  defaultSelectedObjectId?: string | null | undefined;
  zoom?: number | undefined;
  defaultZoom?: number | undefined;
  readOnly?: boolean | undefined;
  className?: string | undefined;
  onSlideChange?: ((slide: Slide, index: number) => void) | undefined;
  onSelectionChange?: ((object: PresentationObject | null, slide: Slide) => void) | undefined;
  onCommit?: PresentationCommitHandler | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  onZoomChange?: ((zoom: number) => void) | undefined;
};

export type PresentationArtifactSurfaceProps = PresentationEditorProps & {
  title?: string | undefined;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  busy?: boolean | undefined;
};

type ViewportMetrics = {
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
  stageLeft: number;
  stageTop: number;
};

type DragState = {
  pointerId: number;
  mode: "move" | "resize";
  object: PresentationObject;
  rotation: number;
  start: { x: number; y: number };
  before: PresentationPosition;
};

type TextEdit = {
  slideId: string;
  shape: PresentationShape;
  before: string;
};

type DraftPosition = {
  objectId: string;
  position: PresentationPosition;
};

type SpatialIndex = {
  objects: DisplayObject[];
  bounds: PresentationPosition[];
  buckets: Map<string, number[]>;
  overflowObjects: number[];
};

type CanvasImageEntry = {
  image: HTMLImageElement;
  ready: boolean;
};

/** Compatibility adapter for the public authoring model. */
export function PresentationEditor(props: PresentationEditorProps) {
  return <PresentationEditorCore {...props} />;
}

/**
 * Projection-first editor. It creates only a disposable render view; all
 * durable mutations leave through the async command port.
 */
export function PresentationProjectionEditor({
  projection,
  commit,
  onCommandError,
  onSlideChange,
  onSelectionChange,
  readOnly = false,
  ...props
}: PresentationProjectionEditorProps) {
  const view = useMemo(() => presentationViewFromProjection(projection), [projection]);
  return (
    <PresentationEditorCore
      {...props}
      presentation={view.presentation}
      revision={projection.revision}
      readOnly={readOnly || !commit}
      onCommit={
        commit
          ? (command) => commit({ ...command, revision: projection.revision } as PresentationCommit)
          : undefined
      }
      onCommandError={onCommandError}
      onSlideChange={(slide, index) => {
        const projected = view.slideById.get(slide.id);
        if (projected) onSlideChange?.(projected, index);
      }}
      onSelectionChange={(object, slide) => {
        const projectedSlide = view.slideById.get(slide.id);
        if (!projectedSlide) return;
        onSelectionChange?.(
          object ? (view.elementById.get(object.id) ?? null) : null,
          projectedSlide,
        );
      }}
    />
  );
}

function PresentationEditorCore({
  presentation,
  revision,
  activeSlideId: controlledSlideId,
  defaultActiveSlideId,
  selectedObjectId: controlledSelectionId,
  defaultSelectedObjectId = null,
  zoom: controlledZoom,
  defaultZoom = 0.75,
  readOnly = false,
  className,
  onSlideChange,
  onSelectionChange,
  onCommit,
  onCommandError,
  onZoomChange,
}: PresentationEditorProps) {
  const slides = presentation.slides.items;
  const firstSlideId = slides[0]?.id ?? null;
  const [localSlideId, setLocalSlideId] = useState(
    defaultActiveSlideId ?? controlledSlideId ?? firstSlideId,
  );
  const requestedSlideId = controlledSlideId ?? localSlideId;
  const activeSlide = slides.find((slide) => slide.id === requestedSlideId) ?? slides[0] ?? null;
  const activeIndex = activeSlide ? slides.indexOf(activeSlide) : -1;

  const [localSelectionId, setLocalSelectionId] = useState<string | null>(defaultSelectedObjectId);
  const selectedId = controlledSelectionId === undefined ? localSelectionId : controlledSelectionId;
  const [localZoom, setLocalZoom] = useState(() => clampZoom(defaultZoom));
  const zoom = clampZoom(controlledZoom ?? localZoom);
  const [fitMode, setFitMode] = useState(false);
  const [viewportMeasured, setViewportMeasured] = useState(false);
  const [modelEpoch, setModelEpoch] = useState(0);
  const [pendingCommands, setPendingCommands] = useState(0);
  const [commandFailure, setCommandFailure] = useState<{
    message: string;
    retry: () => void;
  } | null>(null);
  const [rail, setRail] = useState({
    scrollTop: 0,
    height: DEFAULT_RAIL_HEIGHT,
  });
  const [viewport, setViewport] = useState<ViewportMetrics>({
    scrollLeft: 0,
    scrollTop: 0,
    ...DEFAULT_VIEWPORT,
    stageLeft: 0,
    stageTop: 0,
  });
  const [draftPosition, setDraftPosition] = useState<DraftPosition | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [paintEpoch, setPaintEpoch] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const textEditRef = useRef<TextEdit | null>(null);
  const imageCacheRef = useRef(new Map<string, CanvasImageEntry>());
  const mountedRef = useRef(true);
  const commandScopeRef = useRef(0);
  const commandVersionsRef = useRef(new Map<string, number>());
  const pendingSlideIdRef = useRef<string | null>(null);
  const pendingObjectIdRef = useRef<string | null>(null);
  const domId = useId().replaceAll(":", "");
  const selectionProxyId = `${domId}-presentation-selection`;
  const instructionsId = `${domId}-presentation-instructions`;

  const objects = useMemo(
    () => (activeSlide ? listSlideObjects(activeSlide) : []),
    // revision is a deliberate host invalidation token; modelEpoch covers local commits.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [activeSlide, modelEpoch, revision],
  );
  const objectById = useMemo(
    () => new Map(objects.map((entry) => [entry.id, entry] as const)),
    [objects],
  );
  const objectIndexById = useMemo(
    () => new Map(objects.map((entry, index) => [entry.id, index] as const)),
    [objects],
  );
  const selected = selectedId ? (objectById.get(selectedId) ?? null) : null;
  const spatialIndex = useMemo(
    () => buildSpatialIndex(objects, presentation.slideSize),
    [objects, presentation.slideSize],
  );
  const effectiveSelectedPosition =
    selected && draftPosition?.objectId === selected.id
      ? draftPosition.position
      : selected
        ? copyPosition(selected.object.position)
        : null;

  useEffect(() => {
    const pendingSlideId = pendingSlideIdRef.current;
    if (
      pendingSlideId &&
      controlledSlideId === undefined &&
      slides.some((slide) => slide.id === pendingSlideId)
    ) {
      pendingSlideIdRef.current = null;
      setLocalSlideId(pendingSlideId);
      return;
    }
    if (
      activeSlide &&
      requestedSlideId !== activeSlide.id &&
      controlledSlideId === undefined &&
      pendingSlideId === null
    ) {
      setLocalSlideId(activeSlide.id);
    }
  }, [activeSlide, controlledSlideId, requestedSlideId, slides]);

  useEffect(() => {
    if (selectedId && !objectById.has(selectedId) && controlledSelectionId === undefined) {
      setLocalSelectionId(null);
    }
  }, [controlledSelectionId, objectById, selectedId]);

  useEffect(() => {
    const pendingObjectId = pendingObjectIdRef.current;
    if (pendingObjectId && controlledSelectionId === undefined && objectById.has(pendingObjectId)) {
      pendingObjectIdRef.current = null;
      setLocalSelectionId(pendingObjectId);
    }
  }, [controlledSelectionId, objectById]);

  useLayoutEffect(() => {
    const element = railRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setRail((current) => ({
        scrollTop: element.scrollTop,
        height: element.clientHeight || current.height,
      }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const stage = stageRef.current;
      const measuredWidth = element.clientWidth;
      const measuredHeight = element.clientHeight;
      const next: ViewportMetrics = {
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        width: measuredWidth || DEFAULT_VIEWPORT.width,
        height: measuredHeight || DEFAULT_VIEWPORT.height,
        stageLeft: stage?.offsetLeft ?? 0,
        stageTop: stage?.offsetTop ?? 0,
      };
      setViewport((current) => (sameViewport(current, next) ? current : next));
      if (measuredWidth > 0 && measuredHeight > 0) setViewportMeasured(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [activeSlide?.id, presentation.slideSize.height, presentation.slideSize.width, zoom]);

  useLayoutEffect(() => {
    const imageCache = imageCacheRef.current;
    return () => disposeCanvasImageCache(imageCache);
  }, [activeSlide]);

  useEffect(() => {
    const edit = textEditRef.current;
    const currentEntry = edit ? objectById.get(edit.shape.id) : null;
    if (
      edit &&
      activeSlide?.id === edit.slideId &&
      currentEntry?.kind === "shape" &&
      !currentEntry.readOnly &&
      (currentEntry.object as PresentationShape).geometry !== "line"
    ) {
      const rebound = {
        ...edit,
        shape: currentEntry.object as PresentationShape,
      };
      textEditRef.current = rebound;
      setTextEdit(rebound);
    } else {
      textEditRef.current = null;
      setTextEdit(null);
    }
  }, [activeSlide?.id, objectById]);

  useEffect(() => {
    dragRef.current = null;
    setDraftPosition(null);
    commandScopeRef.current += 1;
    commandVersionsRef.current.clear();
    setPendingCommands(0);
    setCommandFailure(null);
  }, [activeSlide?.id, revision]);

  useEffect(() => {
    const edit = textEditRef.current;
    if (edit && edit.shape.id !== selectedId) {
      textEditRef.current = null;
      setTextEdit(null);
    }
    const drag = dragRef.current;
    if (drag && drag.object.id !== selectedId) {
      dragRef.current = null;
      setDraftPosition(null);
    }
  }, [selectedId]);

  useEffect(() => {
    if (!readOnly) return;
    dragRef.current = null;
    setDraftPosition(null);
    textEditRef.current = null;
    setTextEdit(null);
  }, [readOnly]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dragRef.current = null;
      textEditRef.current = null;
    };
  }, []);

  useEffect(() => {
    const element = railRef.current;
    if (!element || activeIndex < 0) return;
    const top = activeIndex * RAIL_ITEM_HEIGHT;
    const bottom = top + RAIL_ITEM_HEIGHT;
    const height = element.clientHeight || rail.height;
    if (top >= element.scrollTop && bottom <= element.scrollTop + height) return;
    const nextTop = Math.max(0, top - height / 2);
    element.scrollTop = nextTop;
    setRail((current) => ({ ...current, scrollTop: nextTop }));
  }, [activeIndex, rail.height]);

  const visibleSlideRegion = useMemo<PresentationPosition>(() => {
    const slideWidth = presentation.slideSize.width;
    const slideHeight = presentation.slideSize.height;
    const stageWidth = slideWidth * zoom;
    const stageHeight = slideHeight * zoom;
    if (stageWidth <= viewport.width && stageHeight <= viewport.height) {
      return { left: 0, top: 0, width: slideWidth, height: slideHeight };
    }
    const overscan = CANVAS_OVERSCAN_PX / zoom;
    const visibleLeft = Math.max(0, (viewport.scrollLeft - viewport.stageLeft) / zoom);
    const visibleTop = Math.max(0, (viewport.scrollTop - viewport.stageTop) / zoom);
    const left = Math.max(0, visibleLeft - overscan);
    const top = Math.max(0, visibleTop - overscan);
    return {
      left,
      top,
      width: Math.max(0, Math.min(slideWidth - left, viewport.width / zoom + overscan * 2)),
      height: Math.max(0, Math.min(slideHeight - top, viewport.height / zoom + overscan * 2)),
    };
  }, [presentation.slideSize.height, presentation.slideSize.width, viewport, zoom]);

  const visibleObjectIndexes = useMemo(() => {
    if (!activeSlide) return [];
    if (
      visibleSlideRegion.left === 0 &&
      visibleSlideRegion.top === 0 &&
      visibleSlideRegion.width === presentation.slideSize.width &&
      visibleSlideRegion.height === presentation.slideSize.height
    ) {
      return objects.map((_, index) => index);
    }
    const visible = querySpatialIndex(spatialIndex, visibleSlideRegion);
    const selectedIndex = selectedId ? (objectIndexById.get(selectedId) ?? -1) : -1;
    if (selectedIndex >= 0 && !visible.includes(selectedIndex)) visible.push(selectedIndex);
    const draftIndex = draftPosition ? (objectIndexById.get(draftPosition.objectId) ?? -1) : -1;
    if (draftIndex >= 0 && !visible.includes(draftIndex)) visible.push(draftIndex);
    return visible.sort((a, b) => a - b);
  }, [
    activeSlide,
    objects,
    objectIndexById,
    presentation.slideSize,
    draftPosition,
    selectedId,
    spatialIndex,
    visibleSlideRegion,
  ]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSlide) return;
    paintSlideCanvas({
      canvas,
      slide: activeSlide,
      slideSize: presentation.slideSize,
      zoom,
      objects,
      objectIndexes: visibleObjectIndexes,
      renderRegion: visibleSlideRegion,
      draftPosition,
      imageCache: imageCacheRef.current,
      requestRepaint: () => setPaintEpoch((value) => value + 1),
    });
  }, [
    activeSlide,
    draftPosition,
    objects,
    paintEpoch,
    presentation.slideSize,
    visibleObjectIndexes,
    visibleSlideRegion,
    zoom,
  ]);

  const selectObject = useCallback(
    (entry: DisplayObject | null) => {
      textEditRef.current = null;
      setTextEdit(null);
      setDraftPosition(null);
      if (controlledSelectionId === undefined) setLocalSelectionId(entry?.id ?? null);
      if (activeSlide) onSelectionChange?.(entry?.object ?? null, activeSlide);
    },
    [activeSlide, controlledSelectionId, onSelectionChange],
  );

  const selectSlide = useCallback(
    (slide: Slide, index: number) => {
      if (controlledSlideId === undefined) setLocalSlideId(slide.id);
      selectObject(null);
      onSlideChange?.(slide, index);
    },
    [controlledSlideId, onSlideChange, selectObject],
  );

  const changeZoom = useCallback(
    (next: number) => {
      const clamped = clampZoom(next);
      setFitMode(false);
      if (clamped === zoom) return;
      if (controlledZoom === undefined) setLocalZoom(clamped);
      onZoomChange?.(clamped);
    },
    [controlledZoom, onZoomChange, zoom],
  );

  const applyFittedZoom = useCallback(() => {
    const next = fittedPresentationZoom(viewport, presentation.slideSize);
    if (next === zoom) return;
    if (controlledZoom === undefined) setLocalZoom(next);
    onZoomChange?.(next);
  }, [controlledZoom, onZoomChange, presentation.slideSize, viewport, zoom]);

  const fitSlide = useCallback(() => {
    setFitMode(true);
    applyFittedZoom();
  }, [applyFittedZoom]);

  useLayoutEffect(() => {
    if (!viewportMeasured || controlledZoom !== undefined) return;
    const fitted = fittedPresentationZoom(viewport, presentation.slideSize);
    if (!fitMode && zoom <= fitted) return;
    if (!fitMode) setFitMode(true);
    applyFittedZoom();
  }, [
    applyFittedZoom,
    controlledZoom,
    fitMode,
    presentation.slideSize,
    viewport,
    viewportMeasured,
    zoom,
  ]);

  const runCommit = useCallback(
    (key: string, command: PresentationCommit, rollback: () => void, retry: () => void) => {
      if (!onCommit) return;
      const version = (commandVersionsRef.current.get(key) ?? 0) + 1;
      commandVersionsRef.current.set(key, version);
      const scope = commandScopeRef.current;
      setCommandFailure(null);
      let result: void | Promise<void>;
      try {
        result = onCommit(command);
      } catch (cause) {
        if (
          !mountedRef.current ||
          commandScopeRef.current !== scope ||
          commandVersionsRef.current.get(key) !== version
        ) {
          return;
        }
        rollback();
        const error = asPresentationError(cause);
        setCommandFailure({ message: error.message, retry });
        onCommandError?.(error);
        return;
      }
      if (!result || typeof result.then !== "function") return;
      setPendingCommands((current) => current + 1);
      void Promise.resolve(result).then(
        () => {
          if (!mountedRef.current || commandScopeRef.current !== scope) return;
          setPendingCommands((current) => Math.max(0, current - 1));
        },
        (cause) => {
          if (!mountedRef.current || commandScopeRef.current !== scope) return;
          setPendingCommands((current) => Math.max(0, current - 1));
          if (commandVersionsRef.current.get(key) !== version) return;
          rollback();
          const error = asPresentationError(cause);
          setCommandFailure({ message: error.message, retry });
          onCommandError?.(error);
        },
      );
    },
    [onCommandError, onCommit],
  );

  const commitPosition = useCallback(
    (entry: DisplayObject, kind: "move" | "resize", next: PresentationPosition) => {
      if (!activeSlide || readOnly || entry.readOnly) return;
      const before = copyPosition(entry.object.position);
      const after = normalizeEditorPosition(next);
      if (samePosition(before, after)) return;
      entry.object.position = after;
      setModelEpoch((value) => value + 1);
      const command: PresentationCommit = {
        kind,
        slideId: activeSlide.id,
        objectId: entry.id,
        before,
        after,
      };
      const submit = () =>
        runCommit(
          `position:${activeSlide.id}:${entry.id}`,
          command,
          () => {
            entry.object.position = before;
            setModelEpoch((value) => value + 1);
          },
          () => {
            entry.object.position = after;
            setModelEpoch((value) => value + 1);
            submit();
          },
        );
      submit();
    },
    [activeSlide, readOnly, runCommit],
  );

  const insertSlide = useCallback(() => {
    if (readOnly) return;
    const slideId = randomPresentationId();
    const index = activeIndex < 0 ? slides.length : activeIndex + 1;
    const command: PresentationCommit = { kind: "slide-insert", slideId, index };
    const submit = () => {
      pendingSlideIdRef.current = slideId;
      runCommit(
        `slide-insert:${slideId}`,
        command,
        () => {
          if (pendingSlideIdRef.current === slideId) pendingSlideIdRef.current = null;
        },
        submit,
      );
    };
    submit();
  }, [activeIndex, readOnly, runCommit, slides.length]);

  const deleteSlide = useCallback(() => {
    if (readOnly || !activeSlide) return;
    const command: PresentationCommit = {
      kind: "slide-delete",
      slideId: activeSlide.id,
      index: activeIndex,
    };
    const submit = () =>
      runCommit(`slide-delete:${activeSlide.id}`, command, () => undefined, submit);
    submit();
  }, [activeIndex, activeSlide, readOnly, runCommit]);

  const insertTextBox = useCallback(() => {
    if (readOnly || !activeSlide) return;
    const objectId = randomPresentationId();
    const position = nextTextBoxPosition(objects, presentation.slideSize);
    const command: PresentationCommit = {
      kind: "object-insert",
      slideId: activeSlide.id,
      objectId,
      index: activeSlide.elements.length,
      position,
    };
    const submit = () => {
      pendingObjectIdRef.current = objectId;
      runCommit(
        `object-insert:${activeSlide.id}:${objectId}`,
        command,
        () => {
          if (pendingObjectIdRef.current === objectId) pendingObjectIdRef.current = null;
        },
        submit,
      );
    };
    submit();
  }, [activeSlide, objects, presentation.slideSize, readOnly, runCommit]);

  const deleteObject = useCallback(() => {
    if (readOnly || !activeSlide || !selected || selected.readOnly) return;
    const command: PresentationCommit = {
      kind: "object-delete",
      slideId: activeSlide.id,
      objectId: selected.id,
    };
    const submit = () =>
      runCommit(`object-delete:${activeSlide.id}:${selected.id}`, command, () => undefined, submit);
    submit();
  }, [activeSlide, readOnly, runCommit, selected]);

  const startTextEdit = useCallback(
    (entry: DisplayObject | null) => {
      if (readOnly || !entry || entry.readOnly || entry.kind !== "shape") return;
      const shape = entry.object as PresentationShape;
      if (shape.geometry === "line") return;
      const before = shape.text.toString();
      if (!activeSlide) return;
      const edit = { slideId: activeSlide.id, shape, before };
      textEditRef.current = edit;
      setTextEdit(edit);
      setTextDraft(before);
    },
    [activeSlide, readOnly],
  );

  useEffect(() => {
    if (!textEdit) return;
    editorRef.current?.focus();
    editorRef.current?.select();
  }, [textEdit]);

  const finishTextEdit = useCallback(
    (cancel = false) => {
      const edit = textEditRef.current;
      if (!edit) return;
      textEditRef.current = null;
      setTextEdit(null);
      const { shape, before, slideId } = edit;
      if (!activeSlide || activeSlide.id !== slideId) return;
      if (cancel || readOnly || before === textDraft) return;
      shape.text.set(textDraft);
      setModelEpoch((value) => value + 1);
      const command: PresentationCommit = {
        kind: "text",
        slideId,
        objectId: shape.id,
        before,
        after: textDraft,
      };
      const submit = () =>
        runCommit(
          `text:${slideId}:${shape.id}`,
          command,
          () => {
            shape.text.set(before);
            setModelEpoch((value) => value + 1);
          },
          () => {
            shape.text.set(textDraft);
            setModelEpoch((value) => value + 1);
            submit();
          },
        );
      submit();
    },
    [activeSlide, readOnly, runCommit, textDraft],
  );

  const cycleObject = useCallback(
    (direction: -1 | 1) => {
      if (objects.length === 0) return;
      const current = selected ? objects.indexOf(selected) : direction === 1 ? -1 : 0;
      const next = (current + direction + objects.length) % objects.length;
      selectObject(objects[next] ?? null);
    },
    [objects, selectObject, selected],
  );

  const changeSlideBy = useCallback(
    (amount: -1 | 1) => {
      if (activeIndex < 0) return;
      const nextIndex = Math.max(0, Math.min(slides.length - 1, activeIndex + amount));
      const next = slides[nextIndex];
      if (next && next !== activeSlide) selectSlide(next, nextIndex);
    },
    [activeIndex, activeSlide, selectSlide, slides],
  );

  const handleCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>) => {
      if (event.metaKey || event.ctrlKey) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          changeZoom(zoom * 1.15);
        } else if (event.key === "-") {
          event.preventDefault();
          changeZoom(zoom / 1.15);
        } else if (event.key === "0") {
          event.preventDefault();
          fitSlide();
        }
        return;
      }
      if (event.key === "]") {
        event.preventDefault();
        cycleObject(1);
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        cycleObject(-1);
        return;
      }
      if (event.key === "PageDown") {
        event.preventDefault();
        changeSlideBy(1);
        return;
      }
      if (event.key === "PageUp") {
        event.preventDefault();
        changeSlideBy(-1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        selectObject(null);
        return;
      }
      if (event.key === "Enter" || event.key === "F2") {
        if (selected?.kind === "shape") {
          event.preventDefault();
          startTextEdit(selected);
        }
        return;
      }
      if (!selected || !event.key.startsWith("Arrow")) return;
      event.preventDefault();
      if (readOnly || selected.readOnly) return;
      const amount = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
      const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
      const before = selected.object.position;
      commitPosition(
        selected,
        event.altKey ? "resize" : "move",
        event.altKey
          ? {
              ...before,
              width: Math.max(8, before.width + dx),
              height: Math.max(8, before.height + dy),
            }
          : { ...before, left: before.left + dx, top: before.top + dy },
      );
    },
    [
      changeSlideBy,
      changeZoom,
      commitPosition,
      cycleObject,
      fitSlide,
      readOnly,
      selectObject,
      selected,
      startTextEdit,
      zoom,
    ],
  );

  const pointFromPointer = useCallback(
    (event: ReactPointerEvent<SVGElement>): { x: number; y: number } => {
      const rect =
        overlayRef.current?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
      const width = rect.width || presentation.slideSize.width * zoom;
      const height = rect.height || presentation.slideSize.height * zoom;
      return {
        x: ((event.clientX - rect.left) / Math.max(1, width)) * presentation.slideSize.width,
        y: ((event.clientY - rect.top) / Math.max(1, height)) * presentation.slideSize.height,
      };
    },
    [presentation.slideSize.height, presentation.slideSize.width, zoom],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<SVGElement>, entry: DisplayObject, mode: "move" | "resize") => {
      event.preventDefault();
      event.stopPropagation();
      selectObject(entry);
      if (readOnly || entry.readOnly) return;
      const start = pointFromPointer(event);
      const before = copyPosition(entry.object.position);
      dragRef.current = {
        pointerId: event.pointerId,
        mode,
        object: entry.object,
        rotation: objectRotation(entry),
        start,
        before,
      };
      setDraftPosition({ objectId: entry.id, position: before });
      overlayRef.current?.setPointerCapture?.(event.pointerId);
    },
    [pointFromPointer, readOnly, selectObject],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      const point = pointFromPointer(event);
      const hit = hitTest(spatialIndex, point.x, point.y);
      if (!hit) {
        selectObject(null);
        return;
      }
      beginDrag(event, hit, "move");
    },
    [beginDrag, pointFromPointer, selectObject, spatialIndex],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const point = pointFromPointer(event);
      setDraftPosition({ objectId: drag.object.id, position: positionFromDrag(drag, point) });
    },
    [pointFromPointer],
  );

  const finishDrag = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>, cancel = false) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      const captureTarget = overlayRef.current;
      if (captureTarget?.hasPointerCapture?.(event.pointerId)) {
        captureTarget.releasePointerCapture(event.pointerId);
      }
      setDraftPosition(null);
      if (cancel) return;
      const entry = objectById.get(drag.object.id);
      if (!entry) return;
      const point = pointFromPointer(event);
      commitPosition(entry, drag.mode, positionFromDrag(drag, point));
    },
    [commitPosition, objectById, pointFromPointer],
  );

  const handleLostPointerCapture = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraftPosition(null);
  }, []);

  const railStart = Math.max(0, Math.floor(rail.scrollTop / RAIL_ITEM_HEIGHT) - RAIL_OVERSCAN);
  const railEnd = Math.min(
    slides.length,
    Math.ceil((rail.scrollTop + rail.height) / RAIL_ITEM_HEIGHT) + RAIL_OVERSCAN,
  );
  const stageWidth = presentation.slideSize.width * zoom;
  const stageHeight = presentation.slideSize.height * zoom;

  return (
    <div
      className={cn("flex size-full min-w-0 flex-col bg-og-surface-1", className)}
      style={{ minHeight: "22rem" }}
      data-og-presentation-editor
      data-og-painted-object-count={visibleObjectIndexes.length}
      data-og-command-state={commandFailure ? "error" : pendingCommands > 0 ? "pending" : "idle"}
      aria-busy={pendingCommands > 0 ? "true" : undefined}
    >
      <div
        role="toolbar"
        aria-label="Presentation controls"
        className="flex h-10 shrink-0 items-center border-b border-og-border bg-og-surface-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            aria-label="Previous slide"
            disabled={activeIndex <= 0}
            onClick={() => changeSlideBy(-1)}
            className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg disabled:opacity-35 [&>svg]:size-3.5"
          >
            <ChevronLeftIcon />
          </button>
          <span className="min-w-16 shrink-0 text-center text-og-xs tabular-nums text-og-fg-muted">
            {activeIndex >= 0 ? `${activeIndex + 1} / ${slides.length}` : `0 / ${slides.length}`}
          </span>
          <button
            type="button"
            aria-label="Next slide"
            disabled={activeIndex < 0 || activeIndex >= slides.length - 1}
            onClick={() => changeSlideBy(1)}
            className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg disabled:opacity-35 [&>svg]:size-3.5"
          >
            <ChevronRightIcon />
          </button>
          <button
            type="button"
            aria-label="Add slide"
            disabled={readOnly}
            onClick={insertSlide}
            className="ml-0.5 grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg disabled:opacity-35 [&>svg]:size-3.5"
          >
            <FilePlus2Icon />
          </button>
          <button
            type="button"
            aria-label="Delete slide"
            disabled={readOnly || !activeSlide}
            onClick={deleteSlide}
            className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-status-failed disabled:opacity-35 [&>svg]:size-3.5"
          >
            <Trash2Icon />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-og-border" />
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => changeZoom(zoom / 1.15)}
            className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg [&>svg]:size-3.5"
          >
            <MinusIcon />
          </button>
          <span className="min-w-11 shrink-0 text-center text-og-xs tabular-nums text-og-fg-muted">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => changeZoom(zoom * 1.15)}
            className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg [&>svg]:size-3.5"
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            aria-label="Fit slide"
            onClick={fitSlide}
            className="ml-0.5 grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg [&>svg]:size-3.5"
          >
            <ExpandIcon />
          </button>
          <span className="mx-1 h-4 w-px shrink-0 bg-og-border" />
          <button
            type="button"
            aria-label="Add text box"
            disabled={readOnly || !activeSlide}
            onClick={insertTextBox}
            className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-fg disabled:opacity-35 [&>svg]:size-3.5"
          >
            <TypeIcon />
          </button>
          <button
            type="button"
            aria-label="Delete selected object"
            disabled={readOnly || !selected || selected.readOnly}
            onClick={deleteObject}
            className="grid size-7 shrink-0 place-items-center rounded-og-sm text-og-fg-muted hover:bg-og-surface-3 hover:text-og-status-failed disabled:opacity-35 [&>svg]:size-3.5"
          >
            <Trash2Icon />
          </button>
        </div>
        <span
          className="hidden max-w-44 shrink-0 truncate border-l border-og-border px-2 text-og-xs text-og-fg-subtle sm:block"
          title={
            commandFailure
              ? "Change not saved"
              : pendingCommands > 0
                ? "Saving…"
                : readOnly
                  ? "View only"
                  : selected
                    ? `${objectLabel(selected)}${selected.readOnly ? " · View only" : ""}`
                    : "Select an object to edit"
          }
        >
          {commandFailure
            ? "Change not saved"
            : pendingCommands > 0
              ? "Saving…"
              : readOnly
                ? "View only"
                : selected
                  ? `${objectLabel(selected)}${selected.readOnly ? " · View only" : ""}`
                  : "Select an object to edit"}
        </span>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {commandFailure?.message ?? (pendingCommands > 0 ? "Saving presentation changes" : "")}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          ref={railRef}
          role="listbox"
          tabIndex={0}
          aria-label="Slides"
          aria-orientation="vertical"
          aria-activedescendant={
            activeSlide && activeIndex >= railStart && activeIndex < railEnd
              ? `${domId}-slide-${safeDomId(activeSlide.id)}`
              : undefined
          }
          className="relative hidden w-40 shrink-0 overflow-y-auto border-r border-og-border bg-og-surface-2/70 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent sm:block"
          data-og-slide-rail
          data-og-window-start={railStart}
          data-og-window-end={railEnd}
          onScroll={(event) => {
            const scrollTop = event.currentTarget.scrollTop;
            const height = event.currentTarget.clientHeight;
            setRail((current) => ({
              scrollTop,
              height: height || current.height,
            }));
          }}
          onKeyDown={(event) => {
            if (slides.length === 0) return;
            let nextIndex: number | null = null;
            if (event.key === "ArrowDown") nextIndex = Math.min(slides.length - 1, activeIndex + 1);
            else if (event.key === "ArrowUp") nextIndex = Math.max(0, activeIndex - 1);
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = slides.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            const next = slides[nextIndex];
            if (next && next !== activeSlide) selectSlide(next, nextIndex);
          }}
        >
          <div className="relative w-full" style={{ height: slides.length * RAIL_ITEM_HEIGHT }}>
            {slides.slice(railStart, railEnd).map((slide, offset) => {
              const index = railStart + offset;
              const active = slide === activeSlide;
              return (
                <button
                  key={slide.id}
                  id={`${domId}-slide-${safeDomId(slide.id)}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={active}
                  aria-label={`Slide ${index + 1}${slide.title ? `: ${slide.title}` : ""}`}
                  onClick={() => selectSlide(slide, index)}
                  className={cn(
                    "absolute left-0 flex w-full items-start gap-2 px-2 py-2 text-left transition-colors",
                    active
                      ? "bg-og-surface-3 text-og-fg"
                      : "text-og-fg-muted hover:bg-og-surface-3/70",
                  )}
                  style={{ top: index * RAIL_ITEM_HEIGHT, height: 116 }}
                  data-og-slide-index={index}
                >
                  <span className="w-5 shrink-0 pt-0.5 text-right text-og-xs tabular-nums text-og-fg-subtle">
                    {index + 1}
                  </span>
                  <span
                    className={cn(
                      "block min-w-0 flex-1 overflow-hidden border bg-white shadow-og-sm",
                      active ? "border-og-accent" : "border-og-border",
                    )}
                    style={{ aspectRatio: "16 / 9", borderRadius: 3 }}
                  >
                    <SlideThumbnail
                      slide={slide}
                      width={presentation.slideSize.width}
                      height={presentation.slideSize.height}
                      paintRevision={`${String(revision ?? "")}:${modelEpoch}`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={viewportRef}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-og-surface-3/60 p-6"
          onScroll={(event) => {
            const element = event.currentTarget;
            const width = element.clientWidth || viewport.width;
            const height = element.clientHeight || viewport.height;
            const next: ViewportMetrics = {
              scrollLeft: element.scrollLeft,
              scrollTop: element.scrollTop,
              width,
              height,
              stageLeft: stageRef.current?.offsetLeft ?? 0,
              stageTop: stageRef.current?.offsetTop ?? 0,
            };
            setViewport((current) => (sameViewport(current, next) ? current : next));
            if (element.clientWidth > 0 && element.clientHeight > 0) setViewportMeasured(true);
          }}
          data-og-presentation-viewport
        >
          {commandFailure ? (
            <div
              role="alert"
              className="absolute left-2 top-2 z-30 flex w-fit items-center gap-2 rounded-og-sm border border-og-status-failed/30 bg-og-surface-1/95 px-2 py-1 text-og-xs text-og-status-failed shadow-og-sm"
              style={{ maxWidth: "calc(100% - 1rem)" }}
            >
              <span className="truncate">{commandFailure.message}</span>
              <button
                type="button"
                onClick={commandFailure.retry}
                className="shrink-0 rounded-og-xs px-1.5 py-0.5 font-medium outline-hidden hover:bg-og-surface-3 focus-visible:ring-2 focus-visible:ring-og-accent"
              >
                Retry
              </button>
            </div>
          ) : null}
          {activeSlide ? (
            <div
              ref={stageRef}
              className="relative mx-auto shrink-0 overflow-hidden shadow-og-lg"
              style={{ width: stageWidth, height: stageHeight, backgroundColor: "#fff" }}
              data-og-presentation-stage
            >
              <canvas
                ref={canvasRef}
                aria-hidden
                className="absolute inset-0 size-full"
                style={{ width: stageWidth, height: stageHeight }}
              />
              <svg
                ref={overlayRef}
                role="application"
                tabIndex={0}
                aria-label={`Slide ${activeIndex + 1} editor`}
                aria-describedby={
                  selected ? `${instructionsId} ${selectionProxyId}` : instructionsId
                }
                aria-readonly={readOnly || selected?.readOnly || undefined}
                viewBox={`0 0 ${presentation.slideSize.width} ${presentation.slideSize.height}`}
                className="absolute inset-0 size-full touch-none outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent"
                onKeyDown={handleCanvasKeyDown}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => finishDrag(event)}
                onPointerCancel={(event) => finishDrag(event, true)}
                onLostPointerCapture={handleLostPointerCapture}
                onDoubleClick={() => startTextEdit(selected)}
              >
                {selected && effectiveSelectedPosition ? (
                  <g
                    data-og-presentation-object={selected.id}
                    transform={selectionTransform(selected, effectiveSelectedPosition)}
                  >
                    <rect
                      x={effectiveSelectedPosition.left}
                      y={effectiveSelectedPosition.top}
                      width={effectiveSelectedPosition.width}
                      height={effectiveSelectedPosition.height}
                      fill="transparent"
                      stroke="var(--og-accent, #3b82f6)"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                    {!readOnly && !selected.readOnly ? (
                      <circle
                        cx={effectiveSelectedPosition.left + effectiveSelectedPosition.width}
                        cy={effectiveSelectedPosition.top + effectiveSelectedPosition.height}
                        r={6 / zoom}
                        fill="var(--og-accent, #3b82f6)"
                        stroke="white"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        className="cursor-nwse-resize"
                        onPointerDown={(event) => beginDrag(event, selected, "resize")}
                      />
                    ) : null}
                  </g>
                ) : null}
              </svg>

              {selected ? (
                <span id={selectionProxyId} role="status" aria-live="polite" className="sr-only">
                  {accessibleObjectLabel(selected)}
                </span>
              ) : null}

              <span id={instructionsId} className="sr-only">
                Use bracket keys to select objects, arrows to move, Alt plus arrows to resize, Enter
                to edit text, and Page Up or Page Down to change slides.
              </span>

              {textEdit && selected?.id === textEdit.shape.id && effectiveSelectedPosition ? (
                <textarea
                  ref={editorRef}
                  aria-label={`Edit ${textEdit.shape.name}`}
                  value={textDraft}
                  maxLength={1_000_000}
                  onChange={(event) => setTextDraft(event.currentTarget.value)}
                  onInput={(event) => setTextDraft(event.currentTarget.value)}
                  onBlur={() => finishTextEdit()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      finishTextEdit(true);
                    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      finishTextEdit();
                    }
                  }}
                  className="absolute resize-none overflow-hidden border-2 border-og-accent p-1 outline-hidden"
                  style={{
                    left: effectiveSelectedPosition.left * zoom,
                    top: effectiveSelectedPosition.top * zoom,
                    width: effectiveSelectedPosition.width * zoom,
                    height: effectiveSelectedPosition.height * zoom,
                    backgroundColor: "#fffffff2",
                    color: resolveColor(textEdit.shape.text.style.color ?? "slate-950"),
                    fontFamily: textEdit.shape.text.style.fontFamily ?? "Arial, sans-serif",
                    fontSize: Math.max(8, (textEdit.shape.text.style.fontSize ?? 18) * zoom),
                    fontWeight: textEdit.shape.text.style.bold ? 700 : 400,
                    fontStyle: textEdit.shape.text.style.italic ? "italic" : "normal",
                    textAlign: textEdit.shape.text.style.alignment ?? "left",
                    transform:
                      textEdit.shape.rotation === 0
                        ? undefined
                        : `rotate(${textEdit.shape.rotation}deg)`,
                    transformOrigin: "center",
                  }}
                />
              ) : null}
            </div>
          ) : (
            <div className="grid size-full min-h-72 place-items-center text-og-sm text-og-fg-muted">
              This presentation has no slides.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Artifact chrome plus the editor, for drop-in SDK embedding. */
export function PresentationArtifactSurface({
  presentation,
  title = "Presentation",
  subtitle,
  actions,
  busy,
  className,
  ...editorProps
}: PresentationArtifactSurfaceProps) {
  const count = presentation.slides.items.length;
  return (
    <ArtifactSurface
      modality="presentation"
      title={title}
      subtitle={subtitle ?? `${count} slide${count === 1 ? "" : "s"}`}
      actions={actions}
      busy={busy}
      className={className}
    >
      <PresentationEditor {...editorProps} presentation={presentation} />
    </ArtifactSurface>
  );
}

/** Artifact chrome over the projection-first editor. */
export function PresentationProjectionArtifactSurface({
  projection,
  title = "Presentation",
  subtitle,
  actions,
  busy,
  className,
  ...editorProps
}: PresentationProjectionArtifactSurfaceProps) {
  const count = projection.slides.length;
  return (
    <ArtifactSurface
      modality="presentation"
      title={title}
      subtitle={subtitle ?? `${count} slide${count === 1 ? "" : "s"}`}
      actions={actions}
      busy={busy}
      className={className}
    >
      <PresentationProjectionEditor {...editorProps} projection={projection} />
    </ArtifactSurface>
  );
}

function SlideThumbnail({
  slide,
  width,
  height,
  paintRevision,
}: {
  slide: Slide;
  width: number;
  height: number;
  paintRevision: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCacheRef = useRef(new Map<string, CanvasImageEntry>());
  const [paintEpoch, setPaintEpoch] = useState(0);
  useLayoutEffect(() => {
    const imageCache = imageCacheRef.current;
    return () => disposeCanvasImageCache(imageCache);
  }, []);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const displayWidth = 112;
    const scale = displayWidth / width;
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = resolveColor(slide.background.fill);
    context.fillRect(0, 0, width, height);
    const objects = listSlideObjects(slide);
    const usedImageSources = new Set<string>();
    for (const entry of objects) {
      drawObject(
        context,
        entry,
        entry.object.position,
        imageCacheRef.current,
        () => setPaintEpoch((value) => value + 1),
        { left: 0, top: 0, width, height },
        scale,
        usedImageSources,
      );
    }
    disposeUnusedCanvasImages(imageCacheRef.current, usedImageSources);
  }, [height, paintEpoch, paintRevision, slide, width]);
  return <canvas ref={canvasRef} aria-hidden className="block size-full" />;
}

type PresentationProjectionView = {
  presentation: Presentation;
  slideById: Map<string, PresentationSlideProjection>;
  elementById: Map<string, PresentationProjectionElement>;
};

function presentationViewFromProjection(
  projection: PresentationEditorProjection,
): PresentationProjectionView {
  if (projection.slides.length > MAX_PROJECTION_SLIDES) {
    throw new Error(`Presentation projection exceeds ${MAX_PROJECTION_SLIDES} slides`);
  }
  const slideById = new Map<string, PresentationSlideProjection>();
  const elementById = new Map<string, PresentationProjectionElement>();
  const slideSize = {
    width: Math.min(MAX_EDITOR_GEOMETRY, Math.max(1, finite(projection.slideSize.width, 1))),
    height: Math.min(MAX_EDITOR_GEOMETRY, Math.max(1, finite(projection.slideSize.height, 1))),
  };
  const slides = projection.slides.map((slideProjection) => {
    if (slideProjection.elements.length > MAX_PROJECTION_ELEMENTS_PER_SLIDE) {
      throw new Error(
        `Slide ${slideProjection.id} exceeds ${MAX_PROJECTION_ELEMENTS_PER_SLIDE} projected objects`,
      );
    }
    slideById.set(slideProjection.id, slideProjection);
    const elements = slideProjection.elements.map((element) =>
      presentationElementView(element, elementById, 0),
    );
    return {
      id: slideProjection.id,
      title: boundedProjectionText(slideProjection.title ?? ""),
      background: { fill: cloneProjectionFill(slideProjection.background ?? "white") },
      elements,
    } as unknown as Slide;
  });
  return {
    presentation: {
      slideSize,
      slides: { items: slides },
    } as unknown as Presentation,
    slideById,
    elementById,
  };
}

function presentationElementView(
  element: PresentationProjectionElement,
  byId: Map<string, PresentationProjectionElement>,
  depth: number,
): PresentationElement {
  if (depth > MAX_PROJECTION_GROUP_DEPTH) {
    throw new Error(`Presentation group depth exceeds ${MAX_PROJECTION_GROUP_DEPTH}`);
  }
  byId.set(element.id, element);
  const position = normalizeEditorPosition(element.position);
  switch (element.kind) {
    case "shape": {
      const text = mutableProjectionText(element.text, element.textStyle);
      return {
        id: element.id,
        name: boundedProjectionText(element.name),
        __projectionReadOnly: element.readOnly ?? false,
        geometry: element.geometry,
        position,
        fill: cloneProjectionFill(
          element.fill ?? (element.geometry === "textbox" ? "none" : "white"),
        ),
        line: cloneProjectionLine(element.line),
        rotation: finite(element.rotation ?? 0, 0),
        borderRadius: element.borderRadius,
        text,
      } as unknown as PresentationShape;
    }
    case "chart":
      return {
        id: element.id,
        name: boundedProjectionText(element.name),
        __projectionReadOnly: element.readOnly ?? false,
        type: element.type,
        position,
        title: boundedProjectionText(element.title ?? ""),
        series: {
          items: element.series.map((series) => ({
            name: boundedProjectionText(series.name),
            categories: (series.categories ?? []).map(boundedProjectionText),
            values: series.values.map((value) => finite(value, 0)),
            xValues: (series.xValues ?? []).map((value) => finite(value, 0)),
            bubbleSizes: (series.bubbleSizes ?? []).map((value) => finite(value, 0)),
            fill: series.fill ? cloneProjectionFill(series.fill) : undefined,
            line: cloneProjectionLine(series.line),
          })),
        },
        xAxis: element.xAxis ? { ...element.xAxis } : undefined,
        yAxis: element.yAxis ? { ...element.yAxis } : undefined,
        dataLabels: element.dataLabels ? { ...element.dataLabels } : undefined,
      } as unknown as PresentationChart;
    case "image": {
      const source = safeProjectionImageSource(element.source);
      return {
        id: element.id,
        name: boundedProjectionText(element.name),
        __projectionReadOnly: element.readOnly ?? false,
        position,
        alt: boundedProjectionText(element.alt ?? ""),
        prompt: element.prompt ? boundedProjectionText(element.prompt) : undefined,
        fit: element.fit ?? "contain",
        crop: element.crop ? { ...element.crop } : undefined,
        geometry: element.geometry ?? "rect",
        borderRadius: element.borderRadius,
        rotation: finite(element.rotation ?? 0, 0),
        flipHorizontal: element.flipHorizontal ?? false,
        flipVertical: element.flipVertical ?? false,
        sourceForSvg: () => source,
      } as unknown as PresentationImage;
    }
    case "table": {
      const columns = element.rows[0]?.length ?? 0;
      if (
        columns <= 0 ||
        element.rows.some((row) => row.length !== columns) ||
        element.rows.length * columns > MAX_PROJECTION_TABLE_CELLS
      ) {
        throw new Error(`Table ${element.id} has an invalid or oversized projected grid`);
      }
      return {
        id: element.id,
        name: boundedProjectionText(element.name),
        __projectionReadOnly: element.readOnly ?? false,
        position,
        rows: element.rows.map((row) =>
          row.map((cell) =>
            cell
              ? {
                  text: mutableProjectionText(cell.text, cell.textStyle),
                  fill: cloneProjectionFill(cell.fill ?? "white"),
                  rowSpan: boundedSpan(cell.rowSpan),
                  colSpan: boundedSpan(cell.colSpan),
                }
              : null,
          ),
        ),
        columnWidths: [...(element.columnWidths ?? [])],
        rowHeights: [...(element.rowHeights ?? [])],
        fill: cloneProjectionFill(element.fill ?? "white"),
        line: cloneProjectionLine(element.line),
        textStyle: { ...(element.textStyle ?? {}) },
      } as unknown as PresentationTable;
    }
    case "group":
      return {
        id: element.id,
        name: boundedProjectionText(element.name),
        __projectionReadOnly: element.readOnly ?? false,
        position,
        childOffset: {
          left: finite(element.childOffset.left, 0),
          top: finite(element.childOffset.top, 0),
        },
        childExtent: {
          width: Math.max(1, finite(element.childExtent.width, 1)),
          height: Math.max(1, finite(element.childExtent.height, 1)),
        },
        rotation: finite(element.rotation ?? 0, 0),
        flipHorizontal: element.flipHorizontal ?? false,
        flipVertical: element.flipVertical ?? false,
        children: element.children.map((child) => presentationElementView(child, byId, depth + 1)),
      } as unknown as PresentationGroup;
    case "connector":
      return {
        id: element.id,
        name: boundedProjectionText(element.name),
        __projectionReadOnly: element.readOnly ?? false,
        geometry: "line",
        position,
        fill: "none",
        line: cloneProjectionLine(element.line),
        rotation: 0,
        text: mutableProjectionText("", undefined),
      } as unknown as PresentationShape;
  }
}

function mutableProjectionText(
  initial: string,
  style: PresentationProjectionTextStyle | undefined,
): PresentationShape["text"] {
  let value = boundedProjectionText(initial);
  return {
    style: { ...(style ?? {}) },
    set(next: string) {
      value = boundedProjectionText(next);
    },
    toString() {
      return value;
    },
  } as PresentationShape["text"];
}

function cloneProjectionFill(fill: PresentationProjectionFill): PresentationFill {
  return typeof fill === "string" ? fill : { ...fill };
}

function cloneProjectionLine(line: PresentationProjectionLine | undefined): PresentationLine {
  return {
    style: line?.style ?? "solid",
    fill: line?.fill ? cloneProjectionFill(line.fill) : "slate-900",
    width: Math.max(0, finite(line?.width ?? 1, 1)),
  };
}

function boundedProjectionText(value: string): string {
  return value.slice(0, MAX_PROJECTION_TEXT);
}

function boundedSpan(value: number | undefined): number {
  return Math.max(1, Math.min(10_000, Math.floor(finite(value ?? 1, 1))));
}

function safeProjectionImageSource(source: string | undefined): string | undefined {
  if (!source || source.length > 64 * 1024 * 1024) return undefined;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source) || source.startsWith("blob:")) {
    return source;
  }
  try {
    const base = globalThis.location?.href;
    if (!base) return undefined;
    const url = new URL(source, base);
    return url.origin === globalThis.location.origin && /^https?:$/.test(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function asPresentationError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Presentation change failed");
}

function listSlideObjects(slide: Slide): DisplayObject[] {
  return slide.elements.map(displayObjectFromElement);
}

function displayObjectFromElement(
  object: PresentationElement | PresentationGroupChild,
): DisplayObject {
  const readOnly =
    (object as PresentationElement & { __projectionReadOnly?: boolean }).__projectionReadOnly ===
    true;
  if ("geometry" in object && "text" in object)
    return { id: object.id, kind: "shape", object, readOnly };
  if ("series" in object) return { id: object.id, kind: "chart", object, readOnly };
  if ("sourceForSvg" in object) return { id: object.id, kind: "image", object, readOnly };
  if ("rows" in object) return { id: object.id, kind: "table", object, readOnly };
  return { id: object.id, kind: "group", object, readOnly };
}

function buildSpatialIndex(
  objects: DisplayObject[],
  slideSize: { width: number; height: number },
): SpatialIndex {
  const buckets = new Map<string, number[]>();
  const overflowObjects: number[] = [];
  const bounds = objects.map(objectBounds);
  const maxX = Math.max(0, Math.ceil(slideSize.width / SPATIAL_TILE) - 1);
  const maxY = Math.max(0, Math.ceil(slideSize.height / SPATIAL_TILE) - 1);
  for (const [index, entry] of objects.entries()) {
    const objectBound = bounds[index] ?? entry.object.position;
    if (!intersects(objectBound, { left: 0, top: 0, ...slideSize })) continue;
    const left = Math.max(0, Math.floor(objectBound.left / SPATIAL_TILE));
    const top = Math.max(0, Math.floor(objectBound.top / SPATIAL_TILE));
    const right = Math.min(maxX, Math.floor((objectBound.left + objectBound.width) / SPATIAL_TILE));
    const bottom = Math.min(
      maxY,
      Math.floor((objectBound.top + objectBound.height) / SPATIAL_TILE),
    );
    const bucketCount = (right - left + 1) * (bottom - top + 1);
    if (!Number.isSafeInteger(bucketCount) || bucketCount > MAX_SPATIAL_BUCKETS_PER_OBJECT) {
      overflowObjects.push(index);
      continue;
    }
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const key = `${x}:${y}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(index);
        else buckets.set(key, [index]);
      }
    }
  }
  return { objects, bounds, buckets, overflowObjects };
}

function querySpatialIndex(index: SpatialIndex, viewport: PresentationPosition): number[] {
  const seen = new Set<number>(index.overflowObjects);
  const left = Math.floor(viewport.left / SPATIAL_TILE);
  const top = Math.floor(viewport.top / SPATIAL_TILE);
  const right = Math.floor((viewport.left + viewport.width) / SPATIAL_TILE);
  const bottom = Math.floor((viewport.top + viewport.height) / SPATIAL_TILE);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      for (const objectIndex of index.buckets.get(`${x}:${y}`) ?? []) {
        if (intersects(index.bounds[objectIndex], viewport)) seen.add(objectIndex);
      }
    }
  }
  return [...seen]
    .filter((objectIndex) => {
      return !!index.objects[objectIndex] && intersects(index.bounds[objectIndex], viewport);
    })
    .sort((a, b) => a - b);
}

function paintSlideCanvas(options: {
  canvas: HTMLCanvasElement;
  slide: Slide;
  slideSize: { width: number; height: number };
  zoom: number;
  objects: DisplayObject[];
  objectIndexes: number[];
  renderRegion: PresentationPosition;
  draftPosition: DraftPosition | null;
  imageCache: Map<string, CanvasImageEntry>;
  requestRepaint: () => void;
}): void {
  const { canvas, slide, slideSize, zoom } = options;
  const context = canvas.getContext("2d");
  if (!context) return;
  const cssWidth = slideSize.width * zoom;
  const cssHeight = slideSize.height * zoom;
  const ratio = Math.max(
    0.0001,
    Math.min(
      2,
      Math.max(1, globalThis.devicePixelRatio || 1),
      MAX_CANVAS_EDGE / Math.max(1, cssWidth),
      MAX_CANVAS_EDGE / Math.max(1, cssHeight),
      Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cssWidth * cssHeight)),
    ),
  );
  const pixelWidth = Math.max(1, Math.round(slideSize.width * zoom * ratio));
  const pixelHeight = Math.max(1, Math.round(slideSize.height * zoom * ratio));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(zoom * ratio, 0, 0, zoom * ratio, 0, 0);
  context.clearRect(0, 0, slideSize.width, slideSize.height);
  context.fillStyle = resolveColor(slide.background.fill);
  context.fillRect(0, 0, slideSize.width, slideSize.height);
  const usedImageSources = new Set<string>();
  for (const index of options.objectIndexes) {
    const entry = options.objects[index];
    if (!entry) continue;
    const position =
      entry.id === options.draftPosition?.objectId
        ? options.draftPosition.position
        : entry.object.position;
    drawObject(
      context,
      entry,
      position,
      options.imageCache,
      options.requestRepaint,
      options.renderRegion,
      zoom * ratio,
      usedImageSources,
    );
  }
  disposeUnusedCanvasImages(options.imageCache, usedImageSources);
}

function drawObject(
  context: CanvasRenderingContext2D,
  entry: DisplayObject,
  position: PresentationPosition,
  imageCache: Map<string, CanvasImageEntry>,
  requestRepaint: () => void,
  renderRegion: PresentationPosition,
  pixelScale: number,
  usedImageSources: Set<string>,
): void {
  switch (entry.kind) {
    case "shape":
      drawShape(context, entry.object as PresentationShape, position);
      return;
    case "chart":
      drawChart(context, entry.object as PresentationChart, position);
      return;
    case "image": {
      const source = drawImage(
        context,
        entry.object as PresentationImage,
        position,
        imageCache,
        requestRepaint,
      );
      if (source) usedImageSources.add(source);
      return;
    }
    case "table":
      drawTable(context, entry.object as PresentationTable, position, renderRegion, pixelScale);
      return;
    case "group":
      drawGroup(
        context,
        entry.object as PresentationGroup,
        position,
        imageCache,
        requestRepaint,
        renderRegion,
        pixelScale,
        usedImageSources,
      );
  }
}

function drawTable(
  context: CanvasRenderingContext2D,
  table: PresentationTable,
  position: PresentationPosition,
  renderRegion: PresentationPosition,
  pixelScale: number,
): void {
  const rowCount = table.rows.length;
  const columnCount = table.rows[0]?.length ?? 0;
  if (rowCount === 0 || columnCount === 0 || !intersects(position, renderRegion)) return;
  const columnWidths = normalizeTableTracks(table.columnWidths, columnCount, position.width);
  const rowHeights = normalizeTableTracks(table.rowHeights, rowCount, position.height);
  const columnOffsets = cumulativeOffsets(columnWidths, position.left);
  const rowOffsets = cumulativeOffsets(rowHeights, position.top);
  const columnStart = visibleTrackStart(columnOffsets, renderRegion.left);
  const columnEnd = visibleTrackEnd(columnOffsets, renderRegion.left + renderRegion.width);
  const rowStart = visibleTrackStart(rowOffsets, renderRegion.top);
  const rowEnd = visibleTrackEnd(rowOffsets, renderRegion.top + renderRegion.height);
  const visibleCellCount = (rowEnd - rowStart) * (columnEnd - columnStart);
  if (visibleCellCount > MAX_TABLE_CELLS_PER_PAINT) {
    drawTableOverview(context, table, position, columnOffsets, rowOffsets, {
      columnStart,
      columnEnd,
      rowStart,
      rowEnd,
    });
    return;
  }
  context.save();
  for (let rowIndex = rowStart; rowIndex < rowEnd; rowIndex += 1) {
    const row = table.rows[rowIndex];
    if (!row) continue;
    for (let columnIndex = columnStart; columnIndex < columnEnd; columnIndex += 1) {
      const cell = row[columnIndex];
      if (!cell) continue;
      const rightIndex = Math.min(columnCount, columnIndex + cell.colSpan);
      const bottomIndex = Math.min(rowCount, rowIndex + cell.rowSpan);
      const left = columnOffsets[columnIndex] ?? position.left;
      const top = rowOffsets[rowIndex] ?? position.top;
      const right = columnOffsets[rightIndex] ?? position.left + position.width;
      const bottom = rowOffsets[bottomIndex] ?? position.top + position.height;
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      context.beginPath();
      context.rect(left, top, width, height);
      applyFillAndLine(context, cell.fill, table.line, false);
      if (width * pixelScale >= 8 && height * pixelScale >= 8) {
        drawText(context, cell.text.toString(), cell.text.style, {
          left: left + 4,
          top: top + 2,
          width: Math.max(1, width - 8),
          height: Math.max(1, height - 4),
        });
      }
    }
  }
  context.restore();
}

function visibleTrackStart(offsets: readonly number[], value: number): number {
  return Math.max(0, Math.min(offsets.length - 2, lowerBound(offsets, value) - 1));
}

function visibleTrackEnd(offsets: readonly number[], value: number): number {
  return Math.max(0, Math.min(offsets.length - 1, lowerBound(offsets, value) + 1));
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function drawTableOverview(
  context: CanvasRenderingContext2D,
  table: PresentationTable,
  position: PresentationPosition,
  columnOffsets: readonly number[],
  rowOffsets: readonly number[],
  visible: { columnStart: number; columnEnd: number; rowStart: number; rowEnd: number },
): void {
  context.save();
  context.beginPath();
  context.rect(position.left, position.top, position.width, position.height);
  applyFillAndLine(context, table.fill, table.line, false);
  const columnStep = Math.max(1, Math.ceil((visible.columnEnd - visible.columnStart) / 96));
  const rowStep = Math.max(1, Math.ceil((visible.rowEnd - visible.rowStart) / 96));
  context.beginPath();
  for (let index = visible.columnStart; index <= visible.columnEnd; index += columnStep) {
    const x = columnOffsets[index];
    if (x === undefined) continue;
    context.moveTo(x, position.top);
    context.lineTo(x, position.top + position.height);
  }
  for (let index = visible.rowStart; index <= visible.rowEnd; index += rowStep) {
    const y = rowOffsets[index];
    if (y === undefined) continue;
    context.moveTo(position.left, y);
    context.lineTo(position.left + position.width, y);
  }
  applyFillAndLine(context, "none", table.line, true);
  context.restore();
}

function normalizeTableTracks(values: readonly number[], count: number, total: number): number[] {
  if (values.length !== count) return Array.from({ length: count }, () => total / count);
  const sum = values.reduce((value, next) => value + next, 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    return Array.from({ length: count }, () => total / count);
  }
  return values.map((value) => (value / sum) * total);
}

function cumulativeOffsets(tracks: readonly number[], start: number): number[] {
  const offsets = [start];
  for (const track of tracks) offsets.push((offsets.at(-1) ?? start) + track);
  return offsets;
}

function drawGroup(
  context: CanvasRenderingContext2D,
  group: PresentationGroup,
  position: PresentationPosition,
  imageCache: Map<string, CanvasImageEntry>,
  requestRepaint: () => void,
  renderRegion: PresentationPosition,
  pixelScale: number,
  usedImageSources: Set<string>,
): void {
  const scaleX = position.width / group.childExtent.width;
  const scaleY = position.height / group.childExtent.height;
  const translatedX = position.left - group.childOffset.left * scaleX;
  const translatedY = position.top - group.childOffset.top * scaleY;
  const centerX = position.left + position.width / 2;
  const centerY = position.top + position.height / 2;
  context.save();
  context.translate(centerX, centerY);
  context.rotate((group.rotation * Math.PI) / 180);
  context.scale(group.flipHorizontal ? -1 : 1, group.flipVertical ? -1 : 1);
  context.translate(-centerX, -centerY);
  context.translate(translatedX, translatedY);
  context.scale(scaleX, scaleY);
  const childRenderRegion = inverseGroupRegion(group, position, renderRegion);
  for (const child of group.children) {
    const entry = displayObjectFromElement(child);
    if (!intersects(objectBounds(entry), childRenderRegion)) continue;
    drawObject(
      context,
      entry,
      child.position,
      imageCache,
      requestRepaint,
      childRenderRegion,
      pixelScale * Math.min(Math.abs(scaleX), Math.abs(scaleY)),
      usedImageSources,
    );
  }
  context.restore();
}

function inverseGroupRegion(
  group: PresentationGroup,
  position: PresentationPosition,
  region: PresentationPosition,
): PresentationPosition {
  const scaleX = position.width / group.childExtent.width;
  const scaleY = position.height / group.childExtent.height;
  const translatedX = position.left - group.childOffset.left * scaleX;
  const translatedY = position.top - group.childOffset.top * scaleY;
  const centerX = position.left + position.width / 2;
  const centerY = position.top + position.height / 2;
  const radians = (-group.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = [
    [region.left, region.top],
    [region.left + region.width, region.top],
    [region.left, region.top + region.height],
    [region.left + region.width, region.top + region.height],
  ].map(([x = 0, y = 0]) => {
    const dx = x - centerX;
    const dy = y - centerY;
    const rotatedX = dx * cos - dy * sin;
    const rotatedY = dx * sin + dy * cos;
    const unflippedX = rotatedX * (group.flipHorizontal ? -1 : 1) + centerX;
    const unflippedY = rotatedY * (group.flipVertical ? -1 : 1) + centerY;
    return {
      x: (unflippedX - translatedX) / scaleX,
      y: (unflippedY - translatedY) / scaleY,
    };
  });
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, top, width: right - left, height: bottom - top };
}

function drawShape(
  context: CanvasRenderingContext2D,
  shape: PresentationShape,
  position: PresentationPosition,
): void {
  context.save();
  context.translate(position.left + position.width / 2, position.top + position.height / 2);
  context.rotate((shape.rotation * Math.PI) / 180);
  const x = -position.width / 2;
  const y = -position.height / 2;
  context.beginPath();
  switch (shape.geometry) {
    case "ellipse":
      context.ellipse(0, 0, position.width / 2, position.height / 2, 0, 0, Math.PI * 2);
      break;
    case "triangle":
      context.moveTo(0, y);
      context.lineTo(x + position.width, y + position.height);
      context.lineTo(x, y + position.height);
      context.closePath();
      break;
    case "rightArrow": {
      const body = position.width * 0.65;
      context.moveTo(x, y + position.height * 0.25);
      context.lineTo(x + body, y + position.height * 0.25);
      context.lineTo(x + body, y);
      context.lineTo(x + position.width, 0);
      context.lineTo(x + body, y + position.height);
      context.lineTo(x + body, y + position.height * 0.75);
      context.lineTo(x, y + position.height * 0.75);
      context.closePath();
      break;
    }
    case "line":
      context.moveTo(x, y);
      context.lineTo(x + position.width, y + position.height);
      break;
    case "roundRect":
      roundedRect(
        context,
        x,
        y,
        position.width,
        position.height,
        resolveRadius(shape.borderRadius, position),
      );
      break;
    default:
      context.rect(x, y, position.width, position.height);
  }
  applyFillAndLine(context, shape.fill, shape.line, shape.geometry === "line");
  const text = shape.text.toString();
  if (text)
    drawText(context, text, shape.text.style, {
      left: x,
      top: y,
      width: position.width,
      height: position.height,
    });
  context.restore();
}

function drawChart(
  context: CanvasRenderingContext2D,
  chart: PresentationChart,
  position: PresentationPosition,
): void {
  context.save();
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#e2e8f0";
  context.lineWidth = 1;
  context.fillRect(position.left, position.top, position.width, position.height);
  context.strokeRect(position.left, position.top, position.width, position.height);
  if (chart.title) {
    drawText(
      context,
      chart.title,
      { fontSize: 18, bold: true, alignment: "center" },
      {
        left: position.left + 16,
        top: position.top + 8,
        width: Math.max(1, position.width - 32),
        height: 28,
      },
    );
  }
  const plot = {
    left: position.left + 36,
    top: position.top + (chart.title ? 46 : 20),
    width: Math.max(1, position.width - 56),
    height: Math.max(1, position.height - (chart.title ? 72 : 48)),
  };
  const values = chart.series.items.flatMap((series) => series.values).filter(Number.isFinite);
  const minValue = Math.min(0, chart.yAxis?.min ?? Math.min(...values, 0));
  const maxValue = Math.max(1, chart.yAxis?.max ?? Math.max(...values, 1));
  const valueRange = Math.max(Number.EPSILON, maxValue - minValue);
  const yForValue = (value: number) =>
    plot.top + plot.height - ((value - minValue) / valueRange) * plot.height;
  const palette = ["#2563eb", "#0f766e", "#f59e0b", "#dc2626", "#7c3aed"];
  if (chart.type === "pie" || chart.type === "doughnut") {
    const series = chart.series.items[0];
    const slices = series?.values.map((value) => Math.max(0, value)) ?? [];
    const total = slices.reduce((sum, value) => sum + value, 0);
    let angle = -Math.PI / 2;
    const radius = Math.min(plot.width, plot.height) * 0.42;
    const cx = plot.left + plot.width / 2;
    const cy = plot.top + plot.height / 2;
    slices.forEach((value, index) => {
      const next = angle + (total > 0 ? (value / total) * Math.PI * 2 : 0);
      context.beginPath();
      context.moveTo(cx, cy);
      context.arc(cx, cy, radius, angle, next);
      context.closePath();
      context.fillStyle = palette[index % palette.length] ?? "#2563eb";
      context.fill();
      angle = next;
    });
    if (chart.type === "doughnut") {
      context.beginPath();
      context.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
      context.fillStyle = "#ffffff";
      context.fill();
    }
  } else if (chart.type === "line" || chart.type === "area") {
    drawChartAxes(context, chart, plot, yForValue(0));
    chart.series.items.forEach((series, seriesIndex) => {
      if (series.values.length === 0) return;
      const points = series.values.map((value, index) => ({
        x: plot.left + (index / Math.max(1, series.values.length - 1)) * plot.width,
        y: yForValue(value),
      }));
      const color = resolveColor(
        series.line?.fill ?? series.fill ?? palette[seriesIndex % palette.length] ?? "#2563eb",
      );
      if (chart.type === "area") {
        context.beginPath();
        context.moveTo(points[0]?.x ?? plot.left, yForValue(0));
        for (const point of points) context.lineTo(point.x, point.y);
        context.lineTo(points.at(-1)?.x ?? plot.left + plot.width, yForValue(0));
        context.closePath();
        context.globalAlpha = 0.22;
        context.fillStyle = color;
        context.fill();
        context.globalAlpha = 1;
      }
      context.beginPath();
      points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.strokeStyle = color;
      context.lineWidth = series.line?.width ?? 3;
      context.stroke();
      for (const point of points) {
        context.beginPath();
        context.arc(point.x, point.y, 3, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
      }
    });
  } else if (chart.type === "scatter" || chart.type === "bubble") {
    drawChartAxes(context, chart, plot, yForValue(0));
    const xValues = chart.series.items.flatMap((series) =>
      series.values.map((_value, index) => series.xValues[index] ?? index),
    );
    const minX = chart.xAxis?.min ?? Math.min(...xValues, 0);
    const maxX = chart.xAxis?.max ?? Math.max(...xValues, 1);
    const xRange = Math.max(Number.EPSILON, maxX - minX);
    chart.series.items.forEach((series, seriesIndex) => {
      context.fillStyle = resolveColor(
        series.fill ?? palette[seriesIndex % palette.length] ?? "#2563eb",
      );
      series.values.forEach((value, index) => {
        const xValue = series.xValues[index] ?? index;
        const x = plot.left + ((xValue - minX) / xRange) * plot.width;
        const radius =
          chart.type === "bubble"
            ? Math.max(3, Math.sqrt(Math.max(0, series.bubbleSizes[index] ?? 9)))
            : 4;
        context.beginPath();
        context.arc(x, yForValue(value), radius, 0, Math.PI * 2);
        context.fill();
      });
    });
  } else if (chart.type === "radar") {
    drawRadarChart(context, chart, plot, palette);
  } else {
    drawChartAxes(context, chart, plot, yForValue(0));
    const count = Math.max(1, ...chart.series.items.map((series) => series.values.length));
    const groupWidth = plot.width / count;
    const barWidth = (groupWidth * 0.72) / Math.max(1, chart.series.items.length);
    const baseline = yForValue(0);
    chart.series.items.forEach((series, seriesIndex) => {
      series.values.forEach((value, valueIndex) => {
        const valueY = yForValue(value);
        const height = Math.abs(baseline - valueY);
        context.fillStyle = resolveColor(
          series.fill ?? palette[seriesIndex % palette.length] ?? "#2563eb",
        );
        const left =
          plot.left + valueIndex * groupWidth + groupWidth * 0.14 + seriesIndex * barWidth;
        context.fillRect(left, Math.min(baseline, valueY), Math.max(1, barWidth), height);
        if (chart.dataLabels?.showValue) {
          drawText(
            context,
            String(value),
            { fontSize: 11, alignment: "center" },
            {
              left,
              top: Math.max(plot.top, Math.min(baseline, valueY) - 14),
              width: Math.max(1, barWidth),
              height: 14,
            },
          );
        }
      });
    });
  }
  context.restore();
}

function drawChartAxes(
  context: CanvasRenderingContext2D,
  chart: PresentationChart,
  plot: PresentationPosition,
  baseline: number,
): void {
  context.save();
  context.strokeStyle = "#94a3b8";
  context.lineWidth = 1;
  if (chart.xAxis?.visible !== false) {
    context.beginPath();
    context.moveTo(plot.left, Math.max(plot.top, Math.min(plot.top + plot.height, baseline)));
    context.lineTo(
      plot.left + plot.width,
      Math.max(plot.top, Math.min(plot.top + plot.height, baseline)),
    );
    context.stroke();
  }
  if (chart.yAxis?.visible !== false) {
    context.beginPath();
    context.moveTo(plot.left, plot.top);
    context.lineTo(plot.left, plot.top + plot.height);
    context.stroke();
  }
  context.restore();
}

function drawRadarChart(
  context: CanvasRenderingContext2D,
  chart: PresentationChart,
  plot: PresentationPosition,
  palette: readonly string[],
): void {
  const count = Math.max(3, ...chart.series.items.map((series) => series.values.length));
  const maximum = Math.max(
    1,
    ...chart.series.items.flatMap((series) => series.values.map((value) => Math.max(0, value))),
  );
  const centerX = plot.left + plot.width / 2;
  const centerY = plot.top + plot.height / 2;
  const radius = Math.min(plot.width, plot.height) * 0.42;
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    const scaled = (Math.max(0, value) / maximum) * radius;
    return { x: centerX + Math.cos(angle) * scaled, y: centerY + Math.sin(angle) * scaled };
  };
  context.save();
  context.strokeStyle = "#cbd5e1";
  for (let ring = 1; ring <= 4; ring += 1) {
    context.beginPath();
    for (let index = 0; index < count; index += 1) {
      const next = point(index, (maximum * ring) / 4);
      if (index === 0) context.moveTo(next.x, next.y);
      else context.lineTo(next.x, next.y);
    }
    context.closePath();
    context.stroke();
  }
  chart.series.items.forEach((series, seriesIndex) => {
    const color = resolveColor(series.fill ?? palette[seriesIndex % palette.length] ?? "#2563eb");
    context.beginPath();
    for (let index = 0; index < count; index += 1) {
      const next = point(index, series.values[index] ?? 0);
      if (index === 0) context.moveTo(next.x, next.y);
      else context.lineTo(next.x, next.y);
    }
    context.closePath();
    context.globalAlpha = 0.18;
    context.fillStyle = color;
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = color;
    context.lineWidth = series.line?.width ?? 2;
    context.stroke();
  });
  context.restore();
}

function drawImage(
  context: CanvasRenderingContext2D,
  image: PresentationImage,
  position: PresentationPosition,
  imageCache: Map<string, CanvasImageEntry>,
  requestRepaint: () => void,
): string | undefined {
  context.save();
  applyImageTransform(context, image, position);
  imageClipPath(context, image, position);
  context.clip();
  context.fillStyle = "#f1f5f9";
  context.fillRect(position.left, position.top, position.width, position.height);
  const source = imageSourceForCanvas(image);
  if (source && typeof Image !== "undefined") {
    let cached = imageCache.get(source);
    if (!cached) {
      const element = new Image();
      cached = { image: element, ready: false };
      imageCache.set(source, cached);
      element.onload = () => {
        const current = imageCache.get(source);
        if (!current || current.image !== element) return;
        current.ready = true;
        requestRepaint();
      };
      element.onerror = () => {
        const current = imageCache.get(source);
        if (current?.image === element) current.ready = false;
      };
      element.src = source;
    }
    if (cached.ready && cached.image.naturalWidth > 0 && cached.image.naturalHeight > 0) {
      drawFittedImage(context, cached.image, image, position);
      context.restore();
      return source;
    }
  }
  context.strokeStyle = "#94a3b8";
  context.lineWidth = 1;
  context.setLineDash([8, 6]);
  imageClipPath(context, image, position);
  context.stroke();
  context.setLineDash([]);
  drawText(
    context,
    image.alt || image.prompt || "Image",
    { fontSize: 14, color: "slate-600" },
    {
      left: position.left + 12,
      top: position.top + 12,
      width: Math.max(1, position.width - 24),
      height: Math.max(1, position.height - 24),
    },
  );
  context.restore();
  return source;
}

function imageSourceForCanvas(image: PresentationImage): string | undefined {
  try {
    return image.sourceForSvg();
  } catch {
    return undefined;
  }
}

function applyImageTransform(
  context: CanvasRenderingContext2D,
  image: PresentationImage,
  position: PresentationPosition,
): void {
  const centerX = position.left + position.width / 2;
  const centerY = position.top + position.height / 2;
  context.translate(centerX, centerY);
  context.rotate((image.rotation * Math.PI) / 180);
  context.scale(image.flipHorizontal ? -1 : 1, image.flipVertical ? -1 : 1);
  context.translate(-centerX, -centerY);
}

function imageClipPath(
  context: CanvasRenderingContext2D,
  image: PresentationImage,
  position: PresentationPosition,
): void {
  context.beginPath();
  if (image.geometry === "ellipse") {
    context.ellipse(
      position.left + position.width / 2,
      position.top + position.height / 2,
      position.width / 2,
      position.height / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else if (image.geometry === "roundRect") {
    roundedRect(
      context,
      position.left,
      position.top,
      position.width,
      position.height,
      resolveRadius(image.borderRadius, position),
    );
  } else {
    context.rect(position.left, position.top, position.width, position.height);
  }
  context.closePath();
}

function drawFittedImage(
  context: CanvasRenderingContext2D,
  source: HTMLImageElement,
  image: PresentationImage,
  position: PresentationPosition,
): void {
  const crop = image.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const sourceX = source.naturalWidth * crop.left;
  const sourceY = source.naturalHeight * crop.top;
  const sourceWidth = source.naturalWidth * (1 - crop.left - crop.right);
  const sourceHeight = source.naturalHeight * (1 - crop.top - crop.bottom);
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const scale =
    image.fit === "cover"
      ? Math.max(position.width / sourceWidth, position.height / sourceHeight)
      : Math.min(position.width / sourceWidth, position.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const left = position.left + (position.width - width) / 2;
  const top = position.top + (position.height - height) / 2;
  context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, left, top, width, height);
}

function disposeCanvasImageCache(cache: Map<string, CanvasImageEntry>): void {
  for (const entry of cache.values()) disposeCanvasImageEntry(entry);
  cache.clear();
}

function disposeUnusedCanvasImages(
  cache: Map<string, CanvasImageEntry>,
  usedSources: ReadonlySet<string>,
): void {
  for (const [source, entry] of cache) {
    if (usedSources.has(source)) continue;
    disposeCanvasImageEntry(entry);
    cache.delete(source);
  }
}

function disposeCanvasImageEntry(entry: CanvasImageEntry): void {
  entry.image.onload = null;
  entry.image.onerror = null;
  entry.image.removeAttribute("src");
}

function drawText(
  context: CanvasRenderingContext2D,
  text: string,
  style: PresentationTextStyle,
  position: PresentationPosition,
): void {
  const fontSize = style.fontSize ?? 18;
  const fontStyle = style.italic ? "italic " : "";
  const fontWeight = style.bold ? "700 " : "400 ";
  context.font = `${fontStyle}${fontWeight}${fontSize}px ${style.fontFamily ?? "Arial, sans-serif"}`;
  context.fillStyle = resolveColor(style.color ?? "slate-950");
  context.textAlign =
    style.alignment === "center" ? "center" : style.alignment === "right" ? "right" : "left";
  context.textBaseline = "top";
  const x =
    style.alignment === "center"
      ? position.left + position.width / 2
      : style.alignment === "right"
        ? position.left + position.width
        : position.left;
  const lineHeight = fontSize * 1.2;
  const lines = wrapCanvasText(context, text, position.width);
  const totalHeight = lines.length * lineHeight;
  const top =
    style.verticalAlignment === "middle"
      ? position.top + (position.height - totalHeight) / 2
      : style.verticalAlignment === "bottom"
        ? position.top + position.height - totalHeight
        : position.top;
  context.save();
  context.beginPath();
  context.rect(position.left, position.top, position.width, position.height);
  context.clip();
  lines.forEach((line, index) => context.fillText(line, x, top + index * lineHeight));
  context.restore();
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      result.push("");
      continue;
    }
    let line = words[0] ?? "";
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index] ?? "";
      const candidate = `${line} ${word}`;
      if (context.measureText(candidate).width <= width || line.length === 0) line = candidate;
      else {
        result.push(line);
        line = word;
      }
    }
    result.push(line);
  }
  return result;
}

function applyFillAndLine(
  context: CanvasRenderingContext2D,
  fill: PresentationFill,
  line: PresentationLine,
  lineOnly: boolean,
): void {
  if (!lineOnly && resolveColor(fill) !== "transparent") {
    context.fillStyle = resolveColor(fill);
    context.fill();
  }
  if (
    line.style !== "none" &&
    resolveColor(line.fill ?? "slate-900") !== "transparent" &&
    (line.width ?? 1) > 0
  ) {
    context.strokeStyle = resolveColor(line.fill ?? "slate-900");
    context.lineWidth = line.width ?? 1;
    context.setLineDash(line.style === "dash" ? [8, 5] : line.style === "dot" ? [2, 4] : []);
    context.stroke();
    context.setLineDash([]);
  }
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(Math.max(0, radius), width / 2, height / 2);
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function hitTest(index: SpatialIndex, x: number, y: number): DisplayObject | null {
  const candidates = querySpatialIndex(index, { left: x, top: y, width: 0, height: 0 });
  for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const entry = index.objects[candidates[candidateIndex] ?? -1];
    if (entry && objectContainsPoint(entry, x, y)) return entry;
  }
  return null;
}

function objectContainsPoint(entry: DisplayObject, x: number, y: number): boolean {
  const position = entry.object.position;
  const rotation = objectRotation(entry);
  if (rotation === 0) {
    return (
      x >= position.left &&
      x <= position.left + position.width &&
      y >= position.top &&
      y <= position.top + position.height
    );
  }
  const centerX = position.left + position.width / 2;
  const centerY = position.top + position.height / 2;
  const radians = (-rotation * Math.PI) / 180;
  const dx = x - centerX;
  const dy = y - centerY;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians) + centerX;
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians) + centerY;
  return (
    localX >= position.left &&
    localX <= position.left + position.width &&
    localY >= position.top &&
    localY <= position.top + position.height
  );
}

function objectBounds(entry: DisplayObject): PresentationPosition {
  const position = entry.object.position;
  const rotation = objectRotation(entry);
  if (rotation === 0) return position;
  const radians = (rotation * Math.PI) / 180;
  const width =
    Math.abs(position.width * Math.cos(radians)) + Math.abs(position.height * Math.sin(radians));
  const height =
    Math.abs(position.width * Math.sin(radians)) + Math.abs(position.height * Math.cos(radians));
  return {
    left: position.left + (position.width - width) / 2,
    top: position.top + (position.height - height) / 2,
    width,
    height,
  };
}

function objectRotation(entry: DisplayObject): number {
  if (entry.kind === "shape") return finite((entry.object as PresentationShape).rotation, 0);
  if (entry.kind === "image") return finite((entry.object as PresentationImage).rotation, 0);
  if (entry.kind === "group") return finite((entry.object as PresentationGroup).rotation, 0);
  return 0;
}

function objectLabel(entry: DisplayObject): string {
  const object = entry.object;
  if (entry.kind === "shape") {
    const shape = object as PresentationShape;
    return shape.text.toString().trim() || shape.name || "Shape";
  }
  if (entry.kind === "chart") return (object as PresentationChart).title || object.name || "Chart";
  if (entry.kind === "image") return (object as PresentationImage).alt || object.name || "Image";
  if (entry.kind === "table") return object.name || "Table";
  return object.name || "Group";
}

function accessibleObjectLabel(entry: DisplayObject): string {
  const position = entry.object.position;
  return `${objectLabel(entry)}. Position ${Math.round(position.left)}, ${Math.round(position.top)}. Size ${Math.round(position.width)} by ${Math.round(position.height)}.`;
}

function nextTextBoxPosition(
  objects: readonly DisplayObject[],
  slideSize: Readonly<{ width: number; height: number }>,
): PresentationPosition {
  const width = slideSize.width * 0.6;
  const height = Math.max(48, slideSize.height * 0.16);
  const lefts = [0.2, 0.08, 0.32].map((ratio) =>
    Math.max(0, Math.min(slideSize.width - width, slideSize.width * ratio)),
  );
  const tops = [0.2, 0.42, 0.64, 0.06].map((ratio) =>
    Math.max(0, Math.min(slideSize.height - height, slideSize.height * ratio)),
  );
  const occupied = objects.map(objectBounds);
  let best: PresentationPosition | null = null;
  let bestOverlap = Number.POSITIVE_INFINITY;
  for (const left of lefts) {
    for (const top of tops) {
      const candidate = normalizeEditorPosition({ left, top, width, height });
      const overlap = occupied.reduce(
        (total, bounds) => total + intersectionArea(candidate, bounds),
        0,
      );
      if (overlap < bestOverlap) {
        best = candidate;
        bestOverlap = overlap;
        if (overlap === 0) return candidate;
      }
    }
  }
  return best ?? normalizeEditorPosition({ left: 0, top: 0, width, height });
}

function intersectionArea(a: PresentationPosition, b: PresentationPosition): number {
  const width = Math.max(
    0,
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left),
  );
  const height = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  return width * height;
}

function normalizeEditorPosition(position: PresentationPosition): PresentationPosition {
  return {
    left: clampGeometry(finite(position.left, 0)),
    top: clampGeometry(finite(position.top, 0)),
    width: Math.min(MAX_EDITOR_GEOMETRY, Math.max(8, finite(position.width, 8))),
    height: Math.min(MAX_EDITOR_GEOMETRY, Math.max(8, finite(position.height, 8))),
  };
}

function clampGeometry(value: number): number {
  return Math.max(-MAX_EDITOR_GEOMETRY, Math.min(MAX_EDITOR_GEOMETRY, value));
}

function positionFromDrag(drag: DragState, point: { x: number; y: number }): PresentationPosition {
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  const radians = (-drag.rotation * Math.PI) / 180;
  const resizeDx = dx * Math.cos(radians) - dy * Math.sin(radians);
  const resizeDy = dx * Math.sin(radians) + dy * Math.cos(radians);
  return normalizeEditorPosition(
    drag.mode === "move"
      ? {
          ...drag.before,
          left: drag.before.left + dx,
          top: drag.before.top + dy,
        }
      : {
          ...drag.before,
          width: Math.max(8, drag.before.width + resizeDx),
          height: Math.max(8, drag.before.height + resizeDy),
        },
  );
}

function selectionTransform(
  entry: DisplayObject,
  position: PresentationPosition,
): string | undefined {
  const rotation = objectRotation(entry);
  if (rotation === 0) return undefined;
  const centerX = position.left + position.width / 2;
  const centerY = position.top + position.height / 2;
  return `rotate(${rotation} ${centerX} ${centerY})`;
}

function copyPosition(position: PresentationPosition): PresentationPosition {
  return {
    left: position.left,
    top: position.top,
    width: position.width,
    height: position.height,
  };
}

function samePosition(a: PresentationPosition, b: PresentationPosition): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function sameViewport(a: ViewportMetrics, b: ViewportMetrics): boolean {
  return (
    a.scrollLeft === b.scrollLeft &&
    a.scrollTop === b.scrollTop &&
    a.width === b.width &&
    a.height === b.height &&
    a.stageLeft === b.stageLeft &&
    a.stageTop === b.stageTop
  );
}

function intersects(a: PresentationPosition | undefined, b: PresentationPosition): boolean {
  return (
    !!a &&
    a.left <= b.left + b.width &&
    a.left + a.width >= b.left &&
    a.top <= b.top + b.height &&
    a.top + a.height >= b.top
  );
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, finite(value, 0.75)));
}

function fittedPresentationZoom(
  viewport: Pick<ViewportMetrics, "width" | "height">,
  slideSize: Readonly<{ width: number; height: number }>,
): number {
  const horizontalRoom = Math.max(1, viewport.width - 48);
  const verticalRoom = Math.max(1, viewport.height - 48);
  return clampZoom(Math.min(horizontalRoom / slideSize.width, verticalRoom / slideSize.height));
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function safeDomId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

function randomPresentationId(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    if (bytes.some((byte) => byte !== 0)) {
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
}

function resolveRadius(value: number | string | undefined, position: PresentationPosition): number {
  if (typeof value === "number") return value;
  const min = Math.min(position.width, position.height);
  const preset = value?.startsWith("rounded-") ? value.slice("rounded-".length) : undefined;
  if (preset === "full") return min / 2;
  if (preset === "2xl") return 16;
  if (preset === "xl") return 12;
  if (preset === "lg") return 8;
  return 6;
}

const COLORS: Record<string, string> = {
  none: "transparent",
  transparent: "transparent",
  white: "#ffffff",
  black: "#000000",
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

function resolveColor(fill: PresentationFill): string {
  const value = typeof fill === "string" ? fill : fill.color;
  return COLORS[value] ?? value;
}
