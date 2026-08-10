import type {
  Document as ReferenceDocument,
  DocumentTextStyle as ReferenceDocumentTextStyle,
} from "@opengeni/artifact-tool/reference";
import {
  BoldIcon,
  Columns2Icon,
  ItalicIcon,
  MessageSquareTextIcon,
  PilcrowIcon,
  Rows3Icon,
  UnderlineIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/cn";
import { ArtifactSurface } from "./artifact-surface";

export type DocumentLayoutMode = "paginated" | "continuous";

export type DocumentSelection = {
  blockId: string;
  start: number;
  end: number;
};

export type DocumentCommit =
  | {
      kind: "text";
      blockId: string;
      text: string;
      revision: string | number;
    }
  | {
      kind: "format";
      blockId: string;
      range: { start: number; end: number };
      style: Partial<ReferenceDocumentTextStyle>;
      revision: string | number;
    }
  | {
      kind: "insert-paragraph";
      blockId: string;
      revision: string | number;
    };

export type DocumentCommitHandler =
  | ((commit: DocumentCommit) => void)
  | ((commit: DocumentCommit) => Promise<void>);

export type DocumentProjectionPageGeometry = Readonly<{
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  headerPt?: number;
  footerPt?: number;
  gutterPt?: number;
}>;

export type DocumentProjectionTextStyle = Readonly<{
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}>;

export type DocumentProjectionParagraphStyle = Readonly<{
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  alignment?: "left" | "center" | "right" | "justify";
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineHeight?: number;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  list?: Readonly<{
    kind: "bullet" | "number";
    level?: number;
    instanceId?: string;
  }>;
}>;

export type DocumentProjectionTextRun = Readonly<{
  text: string;
  style?: DocumentProjectionTextStyle;
}>;

export type DocumentProjectionParagraph = Readonly<{
  kind: "paragraph";
  id: string;
  runs: readonly DocumentProjectionTextRun[];
  style?: DocumentProjectionParagraphStyle;
}>;

export type DocumentProjectionTable = Readonly<{
  kind: "table";
  id: string;
  rows: readonly (readonly (readonly DocumentProjectionTextRun[])[])[];
  style?: Readonly<{
    widthPt?: number;
    columnWidthsPt?: readonly number[];
    headerRows?: number;
    cellPaddingPt?: number;
    borderColor?: string;
    headerFill?: string;
    allowRowSplit?: boolean;
  }>;
}>;

export type DocumentProjectionPageBreak = Readonly<{
  kind: "pageBreak";
  id: string;
}>;

export type DocumentProjectionBlock =
  | DocumentProjectionParagraph
  | DocumentProjectionTable
  | DocumentProjectionPageBreak;

export type DocumentProjectionSection = Readonly<{
  id: string;
  startBlockIndex: number;
  page: DocumentProjectionPageGeometry;
  titlePage?: boolean;
  headerBlockCounts?: readonly [number, number, number];
  footerBlockCounts?: readonly [number, number, number];
}>;

export type DocumentProjectionComment = Readonly<{
  id: string;
  blockId: string;
  start: number;
  end: number;
  resolved: boolean;
  replies: readonly Readonly<{ author: string; text: string; createdAt: string }>[];
}>;

export type DocumentProjectionChange = Readonly<{
  id: string;
  blockId: string;
  kind: "insert" | "delete";
  start: number;
  end: number;
  author: string;
  createdAt: string;
}>;

/** Immutable render/edit projection; canonical document state stays with the host. */
export type DocumentEditorProjection = Readonly<{
  revision: string | number;
  page: DocumentProjectionPageGeometry;
  blocks: readonly DocumentProjectionBlock[];
  sections?: readonly DocumentProjectionSection[];
  comments?: readonly DocumentProjectionComment[];
  changes?: readonly DocumentProjectionChange[];
}>;

export type DocumentEditorProps = {
  document: ReferenceDocument;
  /** Controlled projection mode. Omit to let the editor own the toggle. */
  layout?: DocumentLayoutMode | undefined;
  defaultLayout?: DocumentLayoutMode | undefined;
  onLayoutChange?: ((layout: DocumentLayoutMode) => void) | undefined;
  onSelectionChange?: ((selection: DocumentSelection) => void) | undefined;
  onCommit?: DocumentCommitHandler | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  readOnly?: boolean | undefined;
  ariaLabel?: string | undefined;
  viewportHeight?: number | undefined;
  overscanPages?: number | undefined;
  className?: string | undefined;
};

export type DocumentProjectionEditorProps = Omit<
  DocumentEditorProps,
  "document" | "onSelectionChange" | "onCommit"
> & {
  projection: DocumentEditorProjection;
  commit?: DocumentCommitHandler | undefined;
  onCommandError?: ((error: Error) => void) | undefined;
  onSelectionChange?: ((selection: DocumentSelection) => void) | undefined;
};

export type DocumentProjectionArtifactSurfaceProps = Omit<
  DocumentProjectionEditorProps,
  "ariaLabel" | "className"
> & {
  title: string;
  subtitle?: ReactNode | undefined;
  busy?: boolean | undefined;
  className?: string | undefined;
  editorClassName?: string | undefined;
};

export type DocumentArtifactSurfaceProps = Omit<DocumentEditorProps, "ariaLabel" | "className"> & {
  title: string;
  subtitle?: ReactNode | undefined;
  busy?: boolean | undefined;
  className?: string | undefined;
  editorClassName?: string | undefined;
};

type DocumentViewTextRun = {
  readonly text: string;
  readonly style: DocumentProjectionTextStyle;
};

type DocumentViewParagraph = {
  readonly kind: "paragraph";
  readonly id: string;
  readonly runs: readonly DocumentViewTextRun[];
  readonly style: DocumentProjectionParagraphStyle;
  text: string;
  format(format: { start: number; end: number; style: Partial<DocumentProjectionTextStyle> }): void;
};

type DocumentViewTable = {
  readonly kind: "table";
  readonly id: string;
  readonly rows: readonly (readonly (readonly DocumentViewTextRun[])[])[];
  readonly style: NonNullable<DocumentProjectionTable["style"]>;
};

type DocumentViewPageBreak = {
  readonly kind: "pageBreak";
  readonly id: string;
};

type DocumentViewBlock = DocumentViewParagraph | DocumentViewTable | DocumentViewPageBreak;

type DocumentViewComment = DocumentProjectionComment;
type DocumentViewChange = DocumentProjectionChange;

type DocumentViewModel = {
  readonly revision: number;
  readonly page: DocumentProjectionPageGeometry;
  readonly blocks: {
    readonly items: readonly DocumentViewBlock[];
    addParagraph(text?: string): DocumentViewParagraph;
  };
  readonly sections: {
    readonly items: readonly DocumentProjectionSection[];
  };
  readonly comments: {
    readonly items: readonly DocumentViewComment[];
  };
  readonly changes: {
    readonly items: readonly DocumentViewChange[];
  };
  resolve(id: string): unknown;
};

type ProjectedBlock = {
  block: Exclude<DocumentViewBlock, DocumentViewPageBreak>;
  height: number;
  listOrdinal?: number | undefined;
};

type ProjectedPage = {
  key: string;
  blocks: ProjectedBlock[];
  height: number;
  minimumHeight: number;
  page: DocumentProjectionPageGeometry;
};

type RenderedPage = ProjectedPage & {
  naturalHeight: number;
  renderScale: number;
};

type PageAxis = {
  offsets: Float64Array;
  total: number;
};

type PageScrollAnchor = {
  axis: PageAxis;
  key: string;
  offset: number;
  scrollTop: number;
};

const POINT_TO_CSS_PIXEL = 4 / 3;
const DEFAULT_VIEWPORT_HEIGHT = 640;
const RESPONSIVE_CONTINUOUS_LAYOUT_WIDTH = 640;
const PAGINATED_GAP = 24;
const CONTINUOUS_GAP = 1;
const MAX_PLAIN_TEXT_TRANSFER = 1_000_000;
const MAX_PROJECTION_BLOCKS = 100_000;
const MAX_PROJECTION_TABLE_CELLS = 1_000_000;
const MAX_PROJECTION_ANNOTATIONS = 100_000;
const MAX_PROJECTION_TEXT = 1_000_000;
const EMPTY_COMMENTS: readonly DocumentViewComment[] = [];
const EMPTY_CHANGES: readonly DocumentViewChange[] = [];

/** Compatibility adapter for the public authoring model. */
export function DocumentEditor(props: DocumentEditorProps) {
  return <DocumentEditorCore {...props} document={asDocumentView(props.document)} />;
}

/** Projection-first document editor with one async command boundary. */
export function DocumentProjectionEditor({
  projection,
  commit,
  onCommandError,
  onSelectionChange,
  readOnly = false,
  ...props
}: DocumentProjectionEditorProps) {
  const view = useMemo(() => documentViewFromProjection(projection), [projection]);
  return (
    <DocumentEditorCore
      {...props}
      document={view.document}
      revisionToken={projection.revision}
      readOnly={readOnly || !commit}
      onCommandError={onCommandError}
      blockIdForView={(blockId) => view.externalIdByInternal.get(blockId) ?? blockId}
      onSelectionChange={(selection) =>
        onSelectionChange?.({
          ...selection,
          blockId: view.externalIdByInternal.get(selection.blockId) ?? selection.blockId,
        })
      }
      onCommit={(command) => commit?.(mapDocumentCommit(command, view.externalIdByInternal))}
    />
  );
}

type DocumentEditorCoreProps = Omit<DocumentEditorProps, "document"> & {
  document: DocumentViewModel;
  revisionToken?: string | number | undefined;
  blockIdForView?: ((blockId: string) => string) | undefined;
};

function DocumentEditorCore({
  document,
  revisionToken,
  layout: controlledLayout,
  defaultLayout,
  onLayoutChange,
  onSelectionChange,
  onCommit,
  onCommandError,
  blockIdForView = identity,
  readOnly = false,
  ariaLabel = "Document editor",
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
  overscanPages = 1,
  className,
}: DocumentEditorCoreProps) {
  const [uncontrolledLayout, setUncontrolledLayout] = useState<DocumentLayoutMode>(
    defaultLayout ?? "paginated",
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [measuredViewport, setMeasuredViewport] = useState({ width: 0, height: 0 });
  const [localRevision, setLocalRevision] = useState(document.revision);
  const [measuredPageHeights, setMeasuredPageHeights] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const selectionRef = useRef<DocumentSelection | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [pendingCommands, setPendingCommands] = useState(0);
  const [commandFailure, setCommandFailure] = useState<{
    message: string;
    retry: () => void;
  } | null>(null);
  const editorNodes = useRef(new Map<string, HTMLElement>());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollTop = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const pendingMeasurementAnchor = useRef<PageScrollAnchor | null>(null);
  const responsiveLayoutInitialized = useRef(false);
  const measuredPageHeightsRef = useRef<ReadonlyMap<string, number>>(new Map());
  const mountedRef = useRef(true);
  const commandScopeRef = useRef(0);
  const commandVersionsRef = useRef(new Map<string, number>());
  const layout = controlledLayout ?? uncontrolledLayout;
  const documentRevision = revisionToken ?? document.revision;
  const pageGap = layout === "paginated" ? PAGINATED_GAP : CONTINUOUS_GAP;

  // localRevision intentionally participates in this projection. The public
  // reference model is synchronous; hosts can still replace/rerender the same
  // document after remote changes without the editor owning persistence state.
  const basePages = useMemo(
    () => projectPages(document, layout),
    // The revision values intentionally invalidate projections over the mutable public model.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [document, documentRevision, layout, localRevision],
  );
  const naturalPages = useMemo(
    () =>
      basePages.map((page) => ({
        ...page,
        // Estimates seed unmounted pages only. Once mounted, intrinsic content
        // may correct the page in either direction while preserving paper size.
        height: measuredPageHeights.has(page.key)
          ? Math.max(page.minimumHeight, measuredPageHeights.get(page.key) ?? page.height)
          : page.height,
      })),
    [basePages, measuredPageHeights],
  );
  const pages = useMemo<RenderedPage[]>(
    () =>
      naturalPages.map((page) => {
        const renderScale =
          layout === "paginated"
            ? responsiveDocumentPageScale(page.page, measuredViewport.width)
            : 1;
        return {
          ...page,
          naturalHeight: page.height,
          renderScale,
          height: page.height * renderScale,
          minimumHeight: page.minimumHeight * renderScale,
        };
      }),
    [layout, measuredViewport.width, naturalPages],
  );
  const annotations = useMemo(
    () => indexAnnotations(document),
    // The revision values intentionally invalidate indexes over the mutable public model.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [document, documentRevision, localRevision],
  );
  const axis = useMemo(() => buildPageAxis(pages, pageGap), [pages, pageGap]);
  const pagesRef = useRef(pages);
  const axisRef = useRef(axis);
  pagesRef.current = pages;
  axisRef.current = axis;
  const blockPageIndex = useMemo(() => {
    const index = new Map<string, number>();
    pages.forEach((page, pageIndex) => {
      for (const { block } of page.blocks) index.set(block.id, pageIndex);
    });
    return index;
  }, [pages]);
  const activePage = selectedBlockId ? (blockPageIndex.get(selectedBlockId) ?? -1) : -1;
  const mountedIndexes = useMemo(
    () =>
      visiblePageIndexes(
        axis,
        pages.length,
        scrollTop,
        Math.max(1, measuredViewport.height || viewportHeight),
        Math.max(0, Math.floor(overscanPages)),
        activePage,
      ),
    [
      activePage,
      axis,
      measuredViewport.height,
      overscanPages,
      pages.length,
      scrollTop,
      viewportHeight,
    ],
  );

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width <= 0 && height <= 0) return;
      setMeasuredViewport((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };
    measure();
    const observer = globalThis.ResizeObserver ? new globalThis.ResizeObserver(measure) : null;
    observer?.observe(element);
    globalThis.addEventListener?.("resize", measure);
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener?.("resize", measure);
    };
  }, []);

  useLayoutEffect(() => {
    if (
      responsiveLayoutInitialized.current ||
      controlledLayout !== undefined ||
      defaultLayout !== undefined ||
      measuredViewport.width <= 0
    ) {
      return;
    }
    responsiveLayoutInitialized.current = true;
    if (measuredViewport.width < RESPONSIVE_CONTINUOUS_LAYOUT_WIDTH) {
      setUncontrolledLayout("continuous");
      onLayoutChange?.("continuous");
    }
  }, [controlledLayout, defaultLayout, measuredViewport.width, onLayoutChange]);

  useEffect(() => {
    commandScopeRef.current += 1;
    commandVersionsRef.current.clear();
    selectionRef.current = null;
    setSelectedBlockId(null);
    setHasTextSelection(false);
    setOpenThreadId(null);
    setLocalRevision(document.revision);
    setPendingCommands(0);
    setCommandFailure(null);
  }, [document, revisionToken]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (scrollFrame.current !== null && globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame(scrollFrame.current);
      }
    };
  }, []);

  const handleScroll = useCallback((event: ReactUIEvent<HTMLElement>) => {
    pendingScrollTop.current = event.currentTarget.scrollTop;
    if (scrollFrame.current !== null) return;
    if (!globalThis.requestAnimationFrame) {
      scrollFrame.current = -1;
      queueMicrotask(() => {
        scrollFrame.current = null;
        setScrollTop(pendingScrollTop.current);
      });
      return;
    }
    scrollFrame.current = globalThis.requestAnimationFrame(() => {
      scrollFrame.current = null;
      setScrollTop(pendingScrollTop.current);
    });
  }, []);

  const clearSelection = useCallback(() => {
    selectionRef.current = null;
    setSelectedBlockId(null);
    setHasTextSelection(false);
  }, []);

  const recordPageHeight = useCallback((key: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const rounded = Math.ceil(height);
    const current = measuredPageHeightsRef.current;
    if (Math.abs((current.get(key) ?? 0) - rounded) <= 1) return;

    const currentPages = pagesRef.current;
    if (!currentPages.some((page) => page.key === key)) return;
    const viewport = viewportRef.current;
    // Absolute positioning prevents useful native scroll anchoring. Retain the
    // visible page and its intra-page offset across the upcoming axis change.
    if (viewport && pendingMeasurementAnchor.current === null) {
      const currentAxis = axisRef.current;
      const anchorIndex = pageAtOffset(currentAxis, currentPages.length, viewport.scrollTop);
      const anchorPage = currentPages[anchorIndex];
      if (anchorPage) {
        pendingMeasurementAnchor.current = {
          axis: currentAxis,
          key: anchorPage.key,
          offset: viewport.scrollTop - currentAxis.offsets[anchorIndex]!,
          scrollTop: viewport.scrollTop,
        };
      }
    }

    // Page keys include layout, section, position, and the first stable block
    // id. Prune measurements that no longer belong to the current projection
    // here instead of clearing them in an effect: a passive reset can run after
    // a newly mounted page's layout-effect measurement and erase that report.
    const next = new Map<string, number>();
    for (const page of currentPages) {
      const measured = current.get(page.key);
      if (measured !== undefined) next.set(page.key, measured);
    }
    next.set(key, rounded);
    measuredPageHeightsRef.current = next;
    setMeasuredPageHeights(next);
  }, []);

  useLayoutEffect(() => {
    const anchor = pendingMeasurementAnchor.current;
    if (!anchor || anchor.axis === axis) return;
    pendingMeasurementAnchor.current = null;
    const viewport = viewportRef.current;
    if (!viewport || Math.abs(viewport.scrollTop - anchor.scrollTop) > 1) return;
    const anchorIndex = pages.findIndex((page) => page.key === anchor.key);
    if (anchorIndex < 0) return;
    const nextScrollTop = Math.max(0, axis.offsets[anchorIndex]! + anchor.offset);
    if (Math.abs(viewport.scrollTop - nextScrollTop) > 0.5) {
      viewport.scrollTop = nextScrollTop;
    }
    const correctedScrollTop = viewport.scrollTop;
    pendingScrollTop.current = correctedScrollTop;
    setScrollTop((current) =>
      Math.abs(current - correctedScrollTop) > 0.5 ? correctedScrollTop : current,
    );
  }, [axis, pages]);

  const publishSelection = useCallback(
    (next: DocumentSelection) => {
      selectionRef.current = next;
      setSelectedBlockId((current) => (current === next.blockId ? current : next.blockId));
      const nextHasTextSelection = next.end > next.start;
      setHasTextSelection((current) =>
        current === nextHasTextSelection ? current : nextHasTextSelection,
      );
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );

  const readDomSelection = useCallback(
    (blockId: string): DocumentSelection => {
      const node = editorNodes.current.get(blockId);
      const offsets = node ? selectionOffsets(node) : null;
      const next = {
        blockId,
        start: offsets?.start ?? 0,
        end: offsets?.end ?? 0,
      };
      publishSelection(next);
      return next;
    },
    [publishSelection],
  );

  const runCommit = useCallback(
    (command: DocumentCommit) => {
      if (!onCommit) return;
      const scope = commandScopeRef.current;
      const submit = () => {
        const key = command.blockId;
        const version = (commandVersionsRef.current.get(key) ?? 0) + 1;
        commandVersionsRef.current.set(key, version);
        setCommandFailure(null);
        const fail = (cause: unknown) => {
          if (
            !mountedRef.current ||
            commandScopeRef.current !== scope ||
            commandVersionsRef.current.get(key) !== version
          ) {
            return;
          }
          const error = asDocumentError(cause);
          setCommandFailure({ message: error.message, retry: submit });
          onCommandError?.(error);
        };
        let result: void | Promise<void>;
        try {
          result = onCommit(command);
        } catch (cause) {
          fail(cause);
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
            fail(cause);
          },
        );
      };
      submit();
    },
    [onCommandError, onCommit],
  );

  const commitText = useCallback(
    (paragraph: DocumentViewParagraph, text: string) => {
      if (readOnly || paragraph.text === text) return;
      paragraph.text = text;
      runCommit({
        kind: "text",
        blockId: paragraph.id,
        text,
        revision: revisionToken ?? document.revision,
      });
    },
    [document, readOnly, revisionToken, runCommit],
  );

  const applyFormat = useCallback(
    (property: "bold" | "italic" | "underline") => {
      const selection = selectionRef.current;
      if (readOnly || !selection) return;
      let block: unknown;
      try {
        block = document.resolve(selection.blockId);
      } catch {
        clearSelection();
        return;
      }
      if (!isDocumentParagraph(block)) return;
      const node = editorNodes.current.get(block.id);
      if (node) commitText(block, node.textContent ?? "");
      const current = selectionOffsets(node) ?? selection;
      const start = Math.max(0, Math.min(current.start, block.text.length));
      const end = Math.max(start, Math.min(current.end, block.text.length));
      if (end <= start) return;
      const effectiveEnd = end;
      const effectiveStart = start;
      const style = toggledTextStyle(block, effectiveStart, effectiveEnd, property);
      block.format({ start: effectiveStart, end: effectiveEnd, style });
      runCommit({
        kind: "format",
        blockId: block.id,
        range: { start: effectiveStart, end: effectiveEnd },
        style,
        revision: revisionToken ?? document.revision,
      });
      queueMicrotask(() => restoreSelection(editorNodes.current.get(block.id), start, end));
    },
    [clearSelection, commitText, document, readOnly, revisionToken, runCommit],
  );

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, paragraph: DocumentViewParagraph) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key !== "b" && key !== "i" && key !== "u") return;
      event.preventDefault();
      const current = readDomSelection(paragraph.id);
      selectionRef.current = current;
      const property = key === "b" ? "bold" : key === "i" ? "italic" : "underline";
      const start = current.start;
      const end = current.end;
      if (end <= start || readOnly) return;
      const effectiveStart = start;
      const effectiveEnd = end;
      const style = toggledTextStyle(paragraph, effectiveStart, effectiveEnd, property);
      paragraph.format({ start: effectiveStart, end: effectiveEnd, style });
      runCommit({
        kind: "format",
        blockId: paragraph.id,
        range: { start: effectiveStart, end: effectiveEnd },
        style,
        revision: revisionToken ?? document.revision,
      });
      queueMicrotask(() => restoreSelection(editorNodes.current.get(paragraph.id), start, end));
    },
    [document, readDomSelection, readOnly, revisionToken, runCommit],
  );

  const changeLayout = (next: DocumentLayoutMode) => {
    if (controlledLayout === undefined) setUncontrolledLayout(next);
    onLayoutChange?.(next);
  };

  const addFirstParagraph = () => {
    if (readOnly) return;
    const paragraph = document.blocks.addParagraph("");
    setLocalRevision(document.revision);
    publishSelection({ blockId: paragraph.id, start: 0, end: 0 });
    runCommit({
      kind: "insert-paragraph",
      blockId: paragraph.id,
      revision: revisionToken ?? document.revision,
    });
  };

  return (
    <div
      data-og-document-editor=""
      data-og-document-layout={layout}
      data-og-command-state={commandFailure ? "error" : pendingCommands > 0 ? "pending" : "idle"}
      aria-busy={pendingCommands > 0 ? "true" : undefined}
      className={cn("flex h-full min-h-0 min-w-0 flex-col bg-og-surface-2", className)}
    >
      <div
        role="toolbar"
        aria-label="Document formatting"
        className="flex min-h-10 shrink-0 items-center gap-1 border-b border-og-border bg-og-surface-1 px-2"
      >
        <ToolbarButton
          label="Bold"
          shortcut="⌘B"
          disabled={readOnly || !selectedBlockId || !hasTextSelection}
          onPress={() => applyFormat("bold")}
        >
          <BoldIcon className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          shortcut="⌘I"
          disabled={readOnly || !selectedBlockId || !hasTextSelection}
          onPress={() => applyFormat("italic")}
        >
          <ItalicIcon className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Underline"
          shortcut="⌘U"
          disabled={readOnly || !selectedBlockId || !hasTextSelection}
          onPress={() => applyFormat("underline")}
        >
          <UnderlineIcon className="size-4" />
        </ToolbarButton>
        <span aria-hidden className="mx-1 h-5 w-px bg-og-border" />
        <ToolbarButton
          label="Continuous layout"
          pressed={layout === "continuous"}
          onPress={() => changeLayout("continuous")}
        >
          <Rows3Icon className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Paginated layout"
          pressed={layout === "paginated"}
          onPress={() => changeLayout("paginated")}
        >
          <Columns2Icon className="size-4" />
        </ToolbarButton>
        <span className="ml-auto truncate text-og-xs text-og-fg-muted">
          {commandFailure
            ? "Change not saved"
            : pendingCommands > 0
              ? "Saving…"
              : readOnly
                ? "Read only"
                : "Editing"}{" "}
          · {document.blocks.items.length.toLocaleString()} blocks
        </span>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {commandFailure?.message ?? (pendingCommands > 0 ? "Saving document changes" : "")}
      </div>

      <div
        ref={viewportRef}
        role="document"
        aria-label={ariaLabel}
        aria-readonly={readOnly}
        tabIndex={-1}
        onPointerDown={(event) => {
          const target = event.target;
          if (target instanceof Element && !target.closest("[data-og-paragraph]")) {
            clearSelection();
          }
        }}
        onScroll={handleScroll}
        className={cn(
          "relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain outline-hidden [overflow-anchor:none]",
          layout === "paginated" ? "bg-og-surface-3" : "bg-og-surface-1",
        )}
        style={{ height: Math.max(1, viewportHeight) }}
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
        {pages.length === 0 ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div>
              <PilcrowIcon aria-hidden className="mx-auto mb-3 size-7 text-og-fg-subtle" />
              <p className="text-og-sm text-og-fg-muted">This document is empty.</p>
              {!readOnly ? (
                <button
                  type="button"
                  onClick={addFirstParagraph}
                  className="mt-3 rounded-og-md border border-og-border bg-og-surface-1 px-3 py-1.5 text-og-sm text-og-fg hover:bg-og-surface-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent"
                >
                  Start writing
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="relative min-w-full" style={{ height: axis.total }}>
            {mountedIndexes.map((pageIndex) => {
              const page = pages[pageIndex]!;
              const top = axis.offsets[pageIndex]!;
              return (
                <article
                  key={page.key}
                  aria-label={`${layout === "paginated" ? "Page" : "Section"} ${pageIndex + 1} of ${pages.length}`}
                  aria-posinset={pageIndex + 1}
                  aria-setsize={pages.length}
                  data-og-document-page={pageIndex + 1}
                  data-og-page-width-pt={page.page.widthPt}
                  data-og-page-height-pt={page.page.heightPt}
                  className={cn(
                    "absolute overflow-hidden",
                    layout === "paginated"
                      ? "left-1/2 -translate-x-1/2 border shadow-og-sm"
                      : "left-0 right-0 border-b border-og-border bg-og-surface-1 text-og-fg",
                  )}
                  style={{
                    top,
                    color: layout === "paginated" ? "#171717" : undefined,
                    backgroundColor: layout === "paginated" ? "#fff" : undefined,
                    borderColor: layout === "paginated" ? "#0000001a" : undefined,
                    width:
                      layout === "paginated"
                        ? page.page.widthPt * POINT_TO_CSS_PIXEL * page.renderScale
                        : undefined,
                    height: page.height,
                  }}
                >
                  <MeasuredPageBody
                    pageKey={page.key}
                    measureToken={documentRevision}
                    onHeight={recordPageHeight}
                    className={cn(
                      layout === "paginated" ? "absolute left-0 top-0 overflow-hidden" : "mx-auto",
                    )}
                    style={{
                      ...pageContentStyle(page.page, layout),
                      maxWidth: layout === "continuous" ? "68rem" : undefined,
                      ...(layout === "paginated"
                        ? {
                            width: page.page.widthPt * POINT_TO_CSS_PIXEL,
                            minHeight: page.naturalHeight,
                            transform: `scale(${page.renderScale})`,
                            transformOrigin: "top left",
                          }
                        : {}),
                    }}
                  >
                    {page.blocks.map(({ block, listOrdinal }) => (
                      <DocumentBlockView
                        key={block.id}
                        block={block}
                        viewBlockId={blockIdForView(block.id)}
                        comments={annotations.comments.get(block.id) ?? EMPTY_COMMENTS}
                        changes={annotations.changes.get(block.id) ?? EMPTY_CHANGES}
                        projectionRevision={localRevision}
                        listOrdinal={listOrdinal}
                        readOnly={readOnly}
                        selected={selectedBlockId === block.id}
                        openThreadId={openThreadId}
                        registerEditor={(node) => {
                          if (node) editorNodes.current.set(block.id, node);
                          else editorNodes.current.delete(block.id);
                        }}
                        onThreadToggle={(threadId) =>
                          setOpenThreadId((current) => (current === threadId ? null : threadId))
                        }
                        onInput={(paragraph, text) => commitText(paragraph, text)}
                        onBlur={() => setLocalRevision(document.revision)}
                        onSelection={(paragraph) => readDomSelection(paragraph.id)}
                        onKeyDown={handleEditorKeyDown}
                      />
                    ))}
                  </MeasuredPageBody>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Artifact chrome plus the reusable document editor. */
export function DocumentArtifactSurface({
  document,
  title,
  subtitle,
  busy,
  className,
  editorClassName,
  ...editorProps
}: DocumentArtifactSurfaceProps) {
  return (
    <ArtifactSurface
      modality="document"
      title={title}
      subtitle={subtitle}
      busy={busy}
      className={className}
    >
      <DocumentEditor
        {...editorProps}
        document={document}
        ariaLabel={`${title} document`}
        className={editorClassName}
      />
    </ArtifactSurface>
  );
}

/** Artifact chrome over the projection-first document editor. */
export function DocumentProjectionArtifactSurface({
  projection,
  title,
  subtitle,
  busy,
  className,
  editorClassName,
  ...editorProps
}: DocumentProjectionArtifactSurfaceProps) {
  return (
    <ArtifactSurface
      modality="document"
      title={title}
      subtitle={subtitle}
      busy={busy}
      className={className}
    >
      <DocumentProjectionEditor
        {...editorProps}
        projection={projection}
        ariaLabel={`${title} document`}
        className={editorClassName}
      />
    </ArtifactSurface>
  );
}

function MeasuredPageBody({
  pageKey,
  measureToken,
  onHeight,
  className,
  style,
  children,
}: {
  pageKey: string;
  measureToken: string | number;
  onHeight: (key: string, height: number) => void;
  className: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const report = () => onHeight(pageKey, Math.max(node.clientHeight, node.scrollHeight));
    report();
    if (!globalThis.ResizeObserver) return;
    const observer = new globalThis.ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measureToken, onHeight, pageKey]);
  return (
    <div ref={nodeRef} className={className} style={style}>
      {children}
    </div>
  );
}

function DocumentBlockView({
  block,
  viewBlockId,
  comments,
  changes,
  projectionRevision,
  listOrdinal,
  readOnly,
  selected,
  openThreadId,
  registerEditor,
  onThreadToggle,
  onInput,
  onBlur,
  onSelection,
  onKeyDown,
}: {
  block: Exclude<DocumentViewBlock, DocumentViewPageBreak>;
  viewBlockId: string;
  comments: readonly DocumentViewComment[];
  changes: readonly DocumentViewChange[];
  projectionRevision: number;
  listOrdinal?: number | undefined;
  readOnly: boolean;
  selected: boolean;
  openThreadId: string | null;
  registerEditor: (node: HTMLElement | null) => void;
  onThreadToggle: (threadId: string) => void;
  onInput: (paragraph: DocumentViewParagraph, text: string) => void;
  onBlur: () => void;
  onSelection: (paragraph: DocumentViewParagraph) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>, paragraph: DocumentViewParagraph) => void;
}) {
  if (isDocumentTable(block)) {
    return <DocumentTableView table={block} viewBlockId={viewBlockId} />;
  }

  const unresolved = comments.filter((thread) => !thread.resolved);
  const commentPanelOpen = comments.some((thread) => thread.id === openThreadId);
  const paragraphStyle = toParagraphStyle(block);
  const segments = annotateRuns(block, unresolved, changes);
  const marker = block.style.list
    ? block.style.list.kind === "number"
      ? `${listOrdinal ?? 1}.`
      : "•"
    : null;

  return (
    <div
      data-og-document-block={viewBlockId}
      data-og-block-kind="paragraph"
      className={cn(
        "group relative flex min-h-7 min-w-0 gap-2 rounded-sm px-1 transition-colors",
        selected && "bg-og-accent-soft ring-1 ring-inset ring-og-accent",
      )}
    >
      {marker ? (
        <span
          aria-hidden
          className="w-7 shrink-0 select-none text-right opacity-70"
          style={{
            paddingLeft: `${(block.style.list?.level ?? 0) * 12}px`,
            paddingTop: "0.1em",
          }}
        >
          {marker}
        </span>
      ) : null}
      <ParagraphLeaf
        key={`${block.id}:${projectionRevision}`}
        paragraph={block}
        viewBlockId={viewBlockId}
        segments={segments}
        paragraphStyle={paragraphStyle}
        listOrdinal={listOrdinal}
        readOnly={readOnly}
        registerEditor={registerEditor}
        onInput={onInput}
        onBlur={onBlur}
        onSelection={onSelection}
        onKeyDown={onKeyDown}
      />

      {comments.length > 0 || changes.length > 0 ? (
        <div className="relative flex w-7 shrink-0 flex-col items-center gap-1 pt-0.5">
          {comments.length > 0 ? (
            <button
              type="button"
              aria-label={
                unresolved.length > 0
                  ? `${unresolved.length} unresolved ${unresolved.length === 1 ? "comment" : "comments"}`
                  : `${comments.length} resolved ${comments.length === 1 ? "comment" : "comments"}`
              }
              aria-expanded={commentPanelOpen}
              onClick={() => onThreadToggle((unresolved[0] ?? comments[0])!.id)}
              className={cn(
                "grid size-6 place-items-center rounded-full focus-visible:outline-hidden focus-visible:ring-2",
                unresolved.length > 0
                  ? "bg-og-accent-soft text-og-status-waiting hover:bg-og-surface-3 focus-visible:ring-og-status-waiting"
                  : "bg-og-surface-3 text-og-fg-muted hover:text-og-fg focus-visible:ring-og-accent",
              )}
            >
              <MessageSquareTextIcon className="size-3.5" />
            </button>
          ) : null}
          {changes.length > 0 ? (
            <span
              role="img"
              aria-label={`${changes.length} tracked ${changes.length === 1 ? "change" : "changes"}`}
              className="mt-1 h-4 w-1 rounded-full bg-og-status-idle"
            />
          ) : null}
          {commentPanelOpen ? (
            <aside
              aria-label="Comment thread"
              className="absolute right-0 top-8 z-20 w-64 rounded-og-md border border-og-border bg-og-surface-1 p-3 text-og-xs text-og-fg shadow-og-lg"
            >
              <div className="mb-2 font-medium">
                {comments.length === 1 ? "Comment" : `${comments.length} comments`}
              </div>
              <ol className="max-h-72 space-y-3 overflow-y-auto">
                {comments.map((thread) => (
                  <li key={thread.id} className="space-y-2">
                    <div className="text-og-fg-muted">{thread.resolved ? "Resolved" : "Open"}</div>
                    {thread.replies.map((reply, index) => (
                      // Reply position is stable within the append-only comment thread.
                      // oxlint-disable-next-line react/no-array-index-key
                      <div key={`${reply.createdAt}:${index}`}>
                        <div className="text-og-fg-muted">{reply.author}</div>
                        <div className="whitespace-pre-wrap">{reply.text}</div>
                      </div>
                    ))}
                  </li>
                ))}
              </ol>
            </aside>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type ParagraphLeafProps = {
  paragraph: DocumentViewParagraph;
  viewBlockId: string;
  segments: ReturnType<typeof annotateRuns>;
  paragraphStyle: CSSProperties;
  listOrdinal?: number | undefined;
  readOnly: boolean;
  registerEditor: (node: HTMLElement | null) => void;
  onInput: (paragraph: DocumentViewParagraph, text: string) => void;
  onBlur: () => void;
  onSelection: (paragraph: DocumentViewParagraph) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>, paragraph: DocumentViewParagraph) => void;
};

/**
 * The active contentEditable leaf is memo-frozen while focused. Browser input
 * and IME therefore own its DOM until blur; host rerenders caused by onCommit
 * cannot reconcile run spans underneath the live caret. The revision key on
 * the caller remounts a normalized model projection after blur.
 */
const ParagraphLeaf = memo(
  function ParagraphLeaf({
    paragraph,
    viewBlockId,
    segments,
    paragraphStyle,
    listOrdinal,
    readOnly,
    registerEditor,
    onInput,
    onBlur,
    onSelection,
    onKeyDown,
  }: ParagraphLeafProps) {
    const composing = useRef(false);
    const Tag = headingTag(paragraph.style.headingLevel);
    const label =
      paragraph.style.list?.kind === "number"
        ? `Numbered list item ${listOrdinal ?? 1}`
        : paragraph.style.list?.kind === "bullet"
          ? "Bullet list item"
          : paragraph.style.headingLevel
            ? `Heading ${paragraph.style.headingLevel}`
            : "Paragraph";

    return (
      <Tag
        ref={registerEditor}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        tabIndex={readOnly ? 0 : undefined}
        role={!readOnly && !paragraph.style.headingLevel ? "textbox" : undefined}
        aria-label={label}
        aria-multiline={!readOnly || undefined}
        aria-readonly={readOnly}
        spellCheck={!readOnly}
        data-og-paragraph={viewBlockId}
        onFocus={() => onSelection(paragraph)}
        onSelect={() => onSelection(paragraph)}
        onKeyUp={() => onSelection(paragraph)}
        onMouseUp={() => onSelection(paragraph)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onInput(paragraph, event.currentTarget.textContent ?? "");
          onSelection(paragraph);
        }}
        onPaste={(event) => {
          if (readOnly) return;
          // contentEditable otherwise accepts HTML-only clipboard payloads,
          // including live images/links. The artifact surface is a plain-text
          // editing boundary; always suppress the browser's rich insertion.
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain").slice(0, MAX_PLAIN_TEXT_TRANSFER);
          if (!text) return;
          insertPlainText(event.currentTarget, text);
          onInput(paragraph, event.currentTarget.textContent ?? "");
          onSelection(paragraph);
        }}
        onDragOver={(event) => {
          if (!readOnly) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!readOnly) event.preventDefault();
        }}
        onKeyDown={(event) => {
          onKeyDown(event, paragraph);
          if (event.defaultPrevented || readOnly) return;
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            insertPlainText(event.currentTarget, "\n");
            onInput(paragraph, event.currentTarget.textContent ?? "");
            onSelection(paragraph);
          }
        }}
        onInput={(event) => {
          if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) {
            onInput(paragraph, event.currentTarget.textContent ?? "");
          }
        }}
        onBlur={onBlur}
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words rounded-sm outline-hidden",
          !readOnly && "cursor-text focus-visible:ring-2 focus-visible:ring-og-accent",
        )}
        style={paragraphStyle}
      >
        {segments.map((segment, index) => (
          <span
            // Segment boundaries are derived from immutable offsets, so index
            // is stable until this paragraph is intentionally edited.
            // oxlint-disable-next-line react/no-array-index-key
            key={`${segment.start}:${index}`}
            data-og-commented={segment.commented || undefined}
            data-og-change={segment.changeKind}
            style={segment.style}
          >
            {segment.text}
          </span>
        ))}
      </Tag>
    );
  },
  (previous, next) => {
    if (next.readOnly || previous.viewBlockId !== next.viewBlockId) return false;
    const active = globalThis.document?.activeElement;
    return active instanceof HTMLElement && active.dataset.ogParagraph === next.viewBlockId;
  },
);

function DocumentTableView({
  table,
  viewBlockId,
}: {
  table: DocumentViewTable;
  viewBlockId: string;
}) {
  const columnWidths = table.style.columnWidthsPt;
  return (
    <div
      data-og-document-block={viewBlockId}
      data-og-block-kind="table"
      className="overflow-x-auto py-2"
    >
      <table
        className="w-full border-collapse text-left"
        style={{
          fontSize: "0.92em",
          width: table.style.widthPt ? `${table.style.widthPt}pt` : undefined,
        }}
      >
        {columnWidths ? (
          <colgroup>
            {columnWidths.map((width, index) => (
              // Column position is its identity in the document table model.
              // oxlint-disable-next-line react/no-array-index-key
              <col key={index} style={{ width: `${width}pt` }} />
            ))}
          </colgroup>
        ) : null}
        <tbody>
          {table.rows.map((row, rowIndex) => (
            // Row position is its identity in the document table model.
            // oxlint-disable-next-line react/no-array-index-key
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => {
                const header = rowIndex < (table.style.headerRows ?? 0);
                const Cell = header ? "th" : "td";
                return (
                  <Cell
                    // Column position is its identity in the document table model.
                    // oxlint-disable-next-line react/no-array-index-key
                    key={columnIndex}
                    scope={header ? "col" : undefined}
                    className={cn("border align-middle", header && "font-semibold")}
                    style={{
                      borderColor: table.style.borderColor ?? "#d1d5db",
                      background: header ? (table.style.headerFill ?? "#f3f4f6") : undefined,
                      padding: `${table.style.cellPaddingPt ?? 6}pt`,
                    }}
                  >
                    {cell.map((run, index) => (
                      // Run position is stable within the immutable cell projection.
                      // oxlint-disable-next-line react/no-array-index-key
                      <span key={index} style={toRunStyle(run.style)}>
                        {run.text}
                      </span>
                    ))}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolbarButton({
  label,
  shortcut,
  pressed,
  disabled,
  onPress,
  children,
}: {
  label: string;
  shortcut?: string | undefined;
  pressed?: boolean | undefined;
  disabled?: boolean | undefined;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault()}
      onClick={onPress}
      className={cn(
        "grid size-7 place-items-center rounded-og-sm text-og-fg-muted outline-hidden transition-colors hover:bg-og-surface-3 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent disabled:pointer-events-none disabled:opacity-40",
        pressed && "bg-og-surface-3 text-og-fg",
      )}
    >
      {children}
    </button>
  );
}

function projectPages(document: DocumentViewModel, layout: DocumentLayoutMode): ProjectedPage[] {
  const pages: ProjectedPage[] = [];
  const sections = document.sections.items;
  let sectionIndex = 0;
  let pageGeometry = sections[0]?.page ?? document.page;
  let blocks: ProjectedBlock[] = [];
  let used = 0;
  let pageIndex = 0;
  let numberOrdinal = 0;

  const flush = (force = false) => {
    if (blocks.length === 0 && !force) return;
    const physicalPageHeight = pageGeometry.heightPt * POINT_TO_CSS_PIXEL;
    const pageVerticalChrome =
      (pageGeometry.marginTopPt + pageGeometry.marginBottomPt) * POINT_TO_CSS_PIXEL;
    pages.push({
      key: `${layout}:${sections[sectionIndex]?.id ?? "default"}:${pageIndex++}:${blocks[0]?.block.id ?? "blank"}`,
      blocks,
      height:
        layout === "paginated"
          ? Math.max(physicalPageHeight, used + pageVerticalChrome)
          : Math.max(1, used + 48),
      minimumHeight: layout === "paginated" ? physicalPageHeight : 1,
      page: { ...pageGeometry },
    });
    blocks = [];
    used = 0;
  };

  for (let blockIndex = 0; blockIndex < document.blocks.items.length; blockIndex += 1) {
    while (
      sectionIndex + 1 < sections.length &&
      sections[sectionIndex + 1]!.startBlockIndex <= blockIndex
    ) {
      flush();
      sectionIndex += 1;
      pageGeometry = sections[sectionIndex]!.page;
    }
    const block = document.blocks.items[blockIndex]!;
    if (isDocumentPageBreak(block)) {
      flush(true);
      numberOrdinal = 0;
      continue;
    }
    if (isDocumentParagraph(block) && block.style.pageBreakBefore) flush();
    const height = estimateBlockHeight(block);
    const physicalPageHeight = pageGeometry.heightPt * POINT_TO_CSS_PIXEL;
    const usableHeight = Math.max(
      120,
      physicalPageHeight -
        (pageGeometry.marginTopPt + pageGeometry.marginBottomPt) * POINT_TO_CSS_PIXEL,
    );
    const targetHeight = layout === "paginated" ? usableHeight : Math.max(560, usableHeight);
    if (blocks.length > 0 && used + height > targetHeight) flush();
    if (isDocumentParagraph(block) && block.style.list?.kind === "number") {
      numberOrdinal += 1;
    } else {
      numberOrdinal = 0;
    }
    blocks.push({
      block,
      height,
      listOrdinal:
        isDocumentParagraph(block) && block.style.list?.kind === "number"
          ? numberOrdinal
          : undefined,
    });
    used += height;
  }
  flush();
  return pages;
}

function indexAnnotations(document: DocumentViewModel): {
  comments: Map<string, DocumentViewComment[]>;
  changes: Map<string, DocumentViewChange[]>;
} {
  const comments = new Map<string, DocumentViewComment[]>();
  const changes = new Map<string, DocumentViewChange[]>();
  for (const thread of document.comments.items) {
    const items = comments.get(thread.blockId);
    if (items) items.push(thread);
    else comments.set(thread.blockId, [thread]);
  }
  for (const change of document.changes.items) {
    const items = changes.get(change.blockId);
    if (items) items.push(change);
    else changes.set(change.blockId, [change]);
  }
  return { comments, changes };
}

function estimateBlockHeight(block: Exclude<DocumentViewBlock, DocumentViewPageBreak>): number {
  if (isDocumentTable(block)) {
    return Math.max(48, block.rows.length * 38 + 16);
  }
  const fontSize = block.runs.reduce(
    (largest, run) => Math.max(largest, run.style.fontSizePt ?? 11),
    block.style.headingLevel ? Math.max(14, 26 - block.style.headingLevel * 2) : 11,
  );
  const lineHeight = fontSize * POINT_TO_CSS_PIXEL * (block.style.lineHeight ?? 1.35);
  const lines = Math.max(
    1,
    block.text
      .split("\n")
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 72)), 0),
  );
  return Math.max(
    28,
    lines * lineHeight +
      ((block.style.spaceBeforePt ?? 2) + (block.style.spaceAfterPt ?? 6)) * POINT_TO_CSS_PIXEL,
  );
}

function buildPageAxis(pages: ProjectedPage[], gap: number): PageAxis {
  const offsets = new Float64Array(pages.length + 1);
  for (let index = 0; index < pages.length; index += 1) {
    offsets[index + 1] = offsets[index]! + pages[index]!.height + gap;
  }
  return { offsets, total: Math.max(1, (offsets[pages.length] ?? 0) - gap) };
}

function pageAtOffset(axis: PageAxis, count: number, offset: number): number {
  if (count <= 1) return 0;
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (axis.offsets[middle + 1]! <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(count - 1, low));
}

function visiblePageIndexes(
  axis: PageAxis,
  count: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  required: number,
): number[] {
  if (count === 0) return [];
  const start = Math.max(0, pageAtOffset(axis, count, scrollTop) - overscan);
  const end = Math.min(count, pageAtOffset(axis, count, scrollTop + viewportHeight) + overscan + 1);
  const indexes = Array.from({ length: end - start }, (_, index) => start + index);
  if (required >= 0 && (required < start || required >= end)) indexes.push(required);
  return indexes.sort((left, right) => left - right);
}

function responsiveDocumentPageScale(
  page: DocumentProjectionPageGeometry,
  viewportWidth: number,
): number {
  if (viewportWidth <= 0) return 1;
  const naturalWidth = page.widthPt * POINT_TO_CSS_PIXEL;
  return Math.min(1, Math.max(0.1, (viewportWidth - 32) / naturalWidth));
}

function pageContentStyle(
  page: DocumentProjectionPageGeometry,
  layout: DocumentLayoutMode,
): CSSProperties {
  if (layout === "continuous") {
    return {
      padding: "24px clamp(24px, 8vw, 96px)",
    };
  }
  return {
    paddingTop: `${page.marginTopPt * POINT_TO_CSS_PIXEL}px`,
    paddingRight: `${page.marginRightPt * POINT_TO_CSS_PIXEL}px`,
    paddingBottom: `${page.marginBottomPt * POINT_TO_CSS_PIXEL}px`,
    paddingLeft: `${page.marginLeftPt * POINT_TO_CSS_PIXEL}px`,
  };
}

function headingTag(level: number | undefined): "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  if (!level) return "p";
  return `h${Math.max(1, Math.min(6, level))}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
}

function toParagraphStyle(paragraph: DocumentViewParagraph): CSSProperties {
  const firstRun = paragraph.runs[0];
  return {
    textAlign: paragraph.style.alignment,
    marginTop: `${paragraph.style.spaceBeforePt ?? 0}pt`,
    marginBottom: `${paragraph.style.spaceAfterPt ?? 0}pt`,
    lineHeight: paragraph.style.lineHeight ?? 1.35,
    breakBefore: paragraph.style.pageBreakBefore ? "page" : undefined,
    fontFamily: firstRun?.style.fontFamily,
    fontSize: firstRun?.style.fontSizePt ? `${firstRun.style.fontSizePt}pt` : undefined,
    fontWeight: paragraph.style.headingLevel ? 650 : undefined,
  };
}

function toRunStyle(style: DocumentProjectionTextStyle): CSSProperties {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSizePt ? `${style.fontSizePt}pt` : undefined,
    color: style.color,
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration:
      [style.underline ? "underline" : "", style.strike ? "line-through" : ""]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

function annotateRuns(
  paragraph: DocumentViewParagraph,
  comments: ReadonlyArray<{ start: number; end: number }>,
  changes: ReadonlyArray<{
    start: number;
    end: number;
    kind: "insert" | "delete";
  }>,
) {
  const segments: Array<{
    text: string;
    start: number;
    style: CSSProperties;
    commented: boolean;
    changeKind?: "insert" | "delete" | undefined;
  }> = [];
  let runStart = 0;
  for (const run of paragraph.runs) {
    const runEnd = runStart + run.text.length;
    const boundaries = new Set([runStart, runEnd]);
    for (const annotation of [...comments, ...changes]) {
      if (annotation.start > runStart && annotation.start < runEnd)
        boundaries.add(annotation.start);
      if (annotation.end > runStart && annotation.end < runEnd) boundaries.add(annotation.end);
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index]!;
      const end = ordered[index + 1]!;
      const commented = comments.some((comment) => comment.start < end && comment.end > start);
      const change = changes.find((item) => item.start < end && item.end > start);
      const baseStyle = toRunStyle(run.style);
      segments.push({
        text: run.text.slice(start - runStart, end - runStart),
        start,
        commented,
        changeKind: change?.kind,
        style: {
          ...baseStyle,
          backgroundColor: commented
            ? "color-mix(in oklch, var(--og-color-status-waiting) 18%, transparent)"
            : undefined,
          textDecoration:
            change?.kind === "delete"
              ? "line-through"
              : change?.kind === "insert"
                ? "underline"
                : baseStyle.textDecoration,
          textDecorationColor:
            change?.kind === "delete"
              ? "var(--og-color-status-failed)"
              : change?.kind === "insert"
                ? "var(--og-color-status-idle)"
                : undefined,
        },
      });
    }
    runStart = runEnd;
  }
  if (segments.length === 0) {
    segments.push({ text: "", start: 0, style: {}, commented: false });
  }
  return segments;
}

function selectionOffsets(root: HTMLElement | undefined): { start: number; end: number } | null {
  if (!root) return null;
  const selection = globalThis.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const beforeStart = range.cloneRange();
  beforeStart.selectNodeContents(root);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = range.cloneRange();
  beforeEnd.selectNodeContents(root);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  return {
    start: beforeStart.toString().length,
    end: beforeEnd.toString().length,
  };
}

function insertPlainText(root: HTMLElement, text: string): void {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  range.deleteContents();
  const node = globalThis.document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function restoreSelection(
  root: HTMLElement | undefined,
  requestedStart: number,
  requestedEnd: number,
): void {
  if (!root || !globalThis.getSelection) return;
  const textLength = root.textContent?.length ?? 0;
  const start = Math.max(0, Math.min(requestedStart, textLength));
  const end = Math.max(start, Math.min(requestedEnd, textLength));
  const startPoint = textPointAt(root, start);
  const endPoint = textPointAt(root, end);
  if (!startPoint || !endPoint) return;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  const domSelection = globalThis.getSelection();
  domSelection?.removeAllRanges();
  domSelection?.addRange(range);
}

function textPointAt(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = target;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return { node: root, offset: root.childNodes.length };
}

function toggledTextStyle(
  paragraph: DocumentViewParagraph,
  start: number,
  end: number,
  property: "bold" | "italic" | "underline",
): Partial<DocumentProjectionTextStyle> {
  let allEnabled = end > start;
  let offset = 0;
  for (const run of paragraph.runs) {
    const runEnd = offset + run.text.length;
    if (runEnd > start && offset < end && run.style[property] !== true) {
      allEnabled = false;
      break;
    }
    offset = runEnd;
  }
  return { [property]: !allEnabled };
}

type DocumentProjectionView = {
  document: DocumentViewModel;
  externalIdByInternal: Map<string, string>;
};

function documentViewFromProjection(projection: DocumentEditorProjection): DocumentProjectionView {
  if (projection.blocks.length > MAX_PROJECTION_BLOCKS) {
    throw new Error(`Document projection exceeds ${MAX_PROJECTION_BLOCKS} blocks`);
  }
  if (
    (projection.comments?.length ?? 0) > MAX_PROJECTION_ANNOTATIONS ||
    (projection.changes?.length ?? 0) > MAX_PROJECTION_ANNOTATIONS
  ) {
    throw new Error(`Document projection exceeds ${MAX_PROJECTION_ANNOTATIONS} annotations`);
  }
  const sections = [...(projection.sections ?? [])].sort(
    (left, right) => left.startBlockIndex - right.startBlockIndex,
  );
  if (
    sections.some(
      (section, index) =>
        section.startBlockIndex < 0 ||
        (index > 0 && section.startBlockIndex <= sections[index - 1]!.startBlockIndex),
    )
  ) {
    throw new Error("Document projection sections must have unique increasing block indexes");
  }
  const firstPage = sections[0]?.startBlockIndex === 0 ? sections[0].page : projection.page;
  validateProjectionPage(firstPage);
  const externalIdByInternal = new Map<string, string>();
  const paragraphByExternal = new Map<string, DocumentViewParagraph>();
  const objects = new Map<string, unknown>();
  const blocks: DocumentViewBlock[] = [];
  const documentSections: DocumentProjectionSection[] = [];
  const comments: DocumentViewComment[] = [];
  const changes: DocumentViewChange[] = [];
  const seenIds = new Set<string>();
  const remember = (internalId: string, externalId: string, value: unknown) => {
    if (!externalId || seenIds.has(externalId)) {
      throw new Error(`Document projection contains an invalid or duplicate id: ${externalId}`);
    }
    seenIds.add(externalId);
    externalIdByInternal.set(internalId, externalId);
    objects.set(internalId, value);
  };

  let revision = 0;
  let localParagraphId = 0;
  const changed = () => {
    revision += 1;
  };
  const document: DocumentViewModel = {
    get revision() {
      return revision;
    },
    page: copyDocumentPage(firstPage),
    blocks: {
      items: blocks,
      addParagraph(text = "") {
        let id: string;
        do {
          localParagraphId += 1;
          id = `projection-paragraph-${localParagraphId}`;
        } while (objects.has(id));
        const paragraph = new ProjectionParagraphView(id, [{ text, style: {} }], {}, changed);
        blocks.push(paragraph);
        objects.set(id, paragraph);
        changed();
        return paragraph;
      },
    },
    sections: { items: documentSections },
    comments: { items: comments },
    changes: { items: changes },
    resolve(id) {
      const value = objects.get(id);
      if (!value) throw new Error(`Unknown document object id: ${id}`);
      return value;
    },
  };

  let sectionIndex = sections[0]?.startBlockIndex === 0 ? 1 : 0;
  if (sections[0]?.startBlockIndex === 0) {
    const projectedSection = sections[0]!;
    validateProjectionPage(projectedSection.page);
    const section = {
      ...projectedSection,
      page: copyDocumentPage(projectedSection.page),
    };
    documentSections.push(section);
    remember(section.id, projectedSection.id, section);
  } else {
    documentSections.push({
      id: "projection-default-section",
      startBlockIndex: 0,
      page: copyDocumentPage(firstPage),
    });
  }
  for (let blockIndex = 0; blockIndex < projection.blocks.length; blockIndex += 1) {
    while (sections[sectionIndex]?.startBlockIndex === blockIndex) {
      const projectedSection = sections[sectionIndex]!;
      validateProjectionPage(projectedSection.page);
      const section = {
        ...projectedSection,
        page: copyDocumentPage(projectedSection.page),
      };
      documentSections.push(section);
      remember(section.id, projectedSection.id, section);
      sectionIndex += 1;
    }
    const projectedBlock = projection.blocks[blockIndex]!;
    if (projectedBlock.kind === "paragraph") {
      const paragraph = new ProjectionParagraphView(
        projectedBlock.id,
        projectedBlock.runs.length > 0
          ? projectedBlock.runs.map((run) => ({
              text: run.text.slice(0, MAX_PROJECTION_TEXT),
              style: { ...(run.style ?? {}) },
            }))
          : [{ text: "", style: {} }],
        { ...(projectedBlock.style ?? {}) },
        changed,
      );
      blocks.push(paragraph);
      remember(paragraph.id, projectedBlock.id, paragraph);
      paragraphByExternal.set(projectedBlock.id, paragraph);
    } else if (projectedBlock.kind === "table") {
      const columns = projectedBlock.rows.reduce(
        (maximum, row) => Math.max(maximum, row.length),
        0,
      );
      if (
        projectedBlock.rows.length === 0 ||
        columns === 0 ||
        projectedBlock.rows.some((row) => row.length !== columns)
      ) {
        throw new Error(`Document table ${projectedBlock.id} must be a non-empty rectangle`);
      }
      if (projectedBlock.rows.length * columns > MAX_PROJECTION_TABLE_CELLS) {
        throw new Error(`Document table ${projectedBlock.id} exceeds the projected cell limit`);
      }
      const table: DocumentViewTable = {
        kind: "table",
        id: projectedBlock.id,
        rows: projectedBlock.rows.map((row) =>
          row.map((cell) =>
            cell.length > 0
              ? cell.map((run) => ({
                  text: run.text.slice(0, MAX_PROJECTION_TEXT),
                  style: { ...(run.style ?? {}) },
                }))
              : [{ text: "", style: {} }],
          ),
        ),
        style: { ...(projectedBlock.style ?? {}) },
      };
      blocks.push(table);
      remember(table.id, projectedBlock.id, table);
    } else {
      const pageBreak: DocumentViewPageBreak = {
        kind: "pageBreak",
        id: projectedBlock.id,
      };
      blocks.push(pageBreak);
      remember(pageBreak.id, projectedBlock.id, pageBreak);
    }
  }
  while (sections[sectionIndex]?.startBlockIndex === projection.blocks.length) {
    const projectedSection = sections[sectionIndex]!;
    validateProjectionPage(projectedSection.page);
    const section = {
      ...projectedSection,
      page: copyDocumentPage(projectedSection.page),
    };
    documentSections.push(section);
    remember(section.id, projectedSection.id, section);
    sectionIndex += 1;
  }
  if (sectionIndex < sections.length) {
    throw new Error("Document projection section starts beyond the projected blocks");
  }

  for (const projected of projection.comments ?? []) {
    const paragraph = paragraphByExternal.get(projected.blockId);
    const first = projected.replies[0];
    if (!paragraph || !first) continue;
    if (
      !Number.isSafeInteger(projected.start) ||
      !Number.isSafeInteger(projected.end) ||
      projected.start < 0 ||
      projected.end < projected.start ||
      projected.end > paragraph.text.length
    ) {
      throw new Error(`Document comment ${projected.id} has an invalid range`);
    }
    const thread: DocumentViewComment = {
      ...projected,
      replies: projected.replies.map((reply) => ({ ...reply })),
    };
    comments.push(thread);
    remember(thread.id, projected.id, thread);
  }
  for (const projected of projection.changes ?? []) {
    const paragraph = paragraphByExternal.get(projected.blockId);
    if (!paragraph) continue;
    if (
      !Number.isSafeInteger(projected.start) ||
      !Number.isSafeInteger(projected.end) ||
      projected.start < 0 ||
      projected.end <= projected.start ||
      projected.end > paragraph.text.length
    ) {
      throw new Error(`Document tracked change ${projected.id} has an invalid range`);
    }
    const change: DocumentViewChange = { ...projected };
    changes.push(change);
    remember(change.id, projected.id, change);
  }
  return { document, externalIdByInternal };
}

function copyDocumentPage(page: DocumentProjectionPageGeometry): DocumentProjectionPageGeometry {
  return {
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    marginTopPt: page.marginTopPt,
    marginRightPt: page.marginRightPt,
    marginBottomPt: page.marginBottomPt,
    marginLeftPt: page.marginLeftPt,
    ...(page.headerPt === undefined ? {} : { headerPt: page.headerPt }),
    ...(page.footerPt === undefined ? {} : { footerPt: page.footerPt }),
    ...(page.gutterPt === undefined ? {} : { gutterPt: page.gutterPt }),
  };
}

class ProjectionParagraphView implements DocumentViewParagraph {
  readonly kind = "paragraph" as const;
  private runStorage: DocumentViewTextRun[];
  readonly style: DocumentProjectionParagraphStyle;

  constructor(
    readonly id: string,
    runs: readonly DocumentViewTextRun[],
    style: DocumentProjectionParagraphStyle,
    private readonly changed: () => void,
  ) {
    this.runStorage = normalizeProjectionRuns(runs);
    this.style = { ...style, ...(style.list ? { list: { ...style.list } } : {}) };
  }

  get runs(): readonly DocumentViewTextRun[] {
    return this.runStorage;
  }

  get text(): string {
    return this.runStorage.map((run) => run.text).join("");
  }

  set text(value: string) {
    const current = this.text;
    if (current === value) return;
    let start = 0;
    while (start < current.length && start < value.length && current[start] === value[start]) {
      start += 1;
    }
    let currentEnd = current.length;
    let valueEnd = value.length;
    while (
      currentEnd > start &&
      valueEnd > start &&
      current[currentEnd - 1] === value[valueEnd - 1]
    ) {
      currentEnd -= 1;
      valueEnd -= 1;
    }
    const inheritedStyle = projectionStyleAt(this.runStorage, start);
    this.runStorage = normalizeProjectionRuns([
      ...sliceProjectionRuns(this.runStorage, 0, start),
      ...(valueEnd > start ? [{ text: value.slice(start, valueEnd), style: inheritedStyle }] : []),
      ...sliceProjectionRuns(this.runStorage, currentEnd, current.length),
    ]);
    this.changed();
  }

  format({
    start,
    end,
    style,
  }: {
    start: number;
    end: number;
    style: Partial<DocumentProjectionTextStyle>;
  }): void {
    const textLength = this.text.length;
    if (start < 0 || end <= start || end > textLength || Object.keys(style).length === 0) return;
    this.runStorage = normalizeProjectionRuns([
      ...sliceProjectionRuns(this.runStorage, 0, start),
      ...sliceProjectionRuns(this.runStorage, start, end).map((run) => ({
        text: run.text,
        style: { ...run.style, ...style },
      })),
      ...sliceProjectionRuns(this.runStorage, end, textLength),
    ]);
    this.changed();
  }
}

function sliceProjectionRuns(
  runs: readonly DocumentViewTextRun[],
  start: number,
  end: number,
): DocumentViewTextRun[] {
  if (end <= start) return [];
  const result: DocumentViewTextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runEnd = offset + run.text.length;
    const overlapStart = Math.max(start, offset);
    const overlapEnd = Math.min(end, runEnd);
    if (overlapEnd > overlapStart) {
      result.push({
        text: run.text.slice(overlapStart - offset, overlapEnd - offset),
        style: { ...run.style },
      });
    }
    offset = runEnd;
    if (offset >= end) break;
  }
  return result;
}

function normalizeProjectionRuns(runs: readonly DocumentViewTextRun[]): DocumentViewTextRun[] {
  const normalized: DocumentViewTextRun[] = [];
  for (const run of runs) {
    if (!run.text && runs.length > 1) continue;
    const style = { ...run.style };
    const previous = normalized.at(-1);
    if (previous && sameProjectionStyle(previous.style, style)) {
      normalized[normalized.length - 1] = { text: previous.text + run.text, style };
    } else {
      normalized.push({ text: run.text, style });
    }
  }
  return normalized.length > 0 ? normalized : [{ text: "", style: {} }];
}

function projectionStyleAt(
  runs: readonly DocumentViewTextRun[],
  offset: number,
): DocumentProjectionTextStyle {
  let cursor = 0;
  for (const run of runs) {
    const end = cursor + run.text.length;
    if (offset <= end) return { ...run.style };
    cursor = end;
  }
  return { ...(runs.at(-1)?.style ?? {}) };
}

function sameProjectionStyle(
  left: DocumentProjectionTextStyle,
  right: DocumentProjectionTextStyle,
): boolean {
  return (
    left.fontFamily === right.fontFamily &&
    left.fontSizePt === right.fontSizePt &&
    left.color === right.color &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.strike === right.strike
  );
}

function validateProjectionPage(page: DocumentProjectionPageGeometry): void {
  const values = [
    page.widthPt,
    page.heightPt,
    page.marginTopPt,
    page.marginRightPt,
    page.marginBottomPt,
    page.marginLeftPt,
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    page.widthPt <= 0 ||
    page.heightPt <= 0 ||
    page.marginLeftPt + page.marginRightPt >= page.widthPt ||
    page.marginTopPt + page.marginBottomPt >= page.heightPt
  ) {
    throw new Error("Document projection contains invalid page geometry");
  }
}

function isDocumentParagraph(value: unknown): value is DocumentViewParagraph {
  return isDocumentBlockKind(value, "paragraph");
}

function isDocumentTable(value: unknown): value is DocumentViewTable {
  return isDocumentBlockKind(value, "table");
}

function isDocumentPageBreak(value: unknown): value is DocumentViewPageBreak {
  return isDocumentBlockKind(value, "pageBreak");
}

function isDocumentBlockKind<K extends DocumentViewBlock["kind"]>(
  value: unknown,
  kind: K,
): value is Extract<DocumentViewBlock, { kind: K }> {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind;
}

function asDocumentView(document: ReferenceDocument): DocumentViewModel {
  return document as unknown as DocumentViewModel;
}

function mapDocumentCommit(
  command: DocumentCommit,
  externalIdByInternal: ReadonlyMap<string, string>,
): DocumentCommit {
  return {
    ...command,
    blockId: externalIdByInternal.get(command.blockId) ?? command.blockId,
  };
}

function identity(value: string): string {
  return value;
}

function asDocumentError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Document change failed");
}
