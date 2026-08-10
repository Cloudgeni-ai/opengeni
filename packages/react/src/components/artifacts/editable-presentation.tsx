import {
  PRESENTATION_ARTIFACT_COMMAND_VERSION,
  PRESENTATION_ARTIFACT_QUERY_MAX_NODES,
  PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES,
  PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES,
  PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
  type EditableArtifactSession,
  type EditablePresentationEditorSlideProjection,
  type PresentationArtifactCommand,
  type PresentationArtifactEditorSceneNode,
  type PresentationArtifactFill,
  type PresentationArtifactLine,
  type PresentationArtifactNodeKind,
  type PresentationArtifactRichText,
  type PresentationArtifactSlideCatalogItem,
  type PresentationArtifactTextParagraph,
  type PresentationArtifactTextStyle,
} from "@opengeni/sdk/editable-artifacts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import {
  PresentationProjectionArtifactSurface,
  type PresentationCommit,
  type PresentationCommitHandler,
  type PresentationEditorProjection,
  type PresentationProjectionArtifactSurfaceProps,
  type PresentationProjectionElement,
  type PresentationProjectionFill,
  type PresentationProjectionLine,
  type PresentationProjectionPosition,
  type PresentationProjectionRichText,
  type PresentationProjectionTextStyle,
  type PresentationSlideProjection,
} from "./presentation-editor";
import { ArtifactSurface } from "./artifact-surface";
import {
  asEditableArtifactError,
  editableArtifactAccessRevoked,
  editableArtifactProjectionKey,
  editableArtifactStatusLabel,
  EditableArtifactMessage,
  useEditableArtifactView,
} from "./editable-artifact-ui";

const EMU_PER_CSS_PIXEL = 9_525;
const PRESENTATION_CATALOG_PAGE = 128;
const PRESENTATION_MAX_INTERACTIVE_SLIDES = 256;
const PRESENTATION_MAX_INTERACTIVE_NODES = 16_384;
const PRESENTATION_MAX_INTERACTIVE_TEXT_BYTES = 4 * 1024 * 1024;
const PRESENTATION_MAX_CATALOG_PAGES = 32;
const PRESENTATION_SCENE_CONCURRENCY = 4;
const PRESENTATION_COMPOSITION_ATTEMPTS = 3;
const DEFAULT_PRESENTATION_TEXT_STYLE: PresentationArtifactTextStyle = Object.freeze({
  fontFamily: "Arial",
  fontSizeCentipoints: 1_800,
  color: 0x000000ff,
  bold: false,
  italic: false,
  underline: false,
  language: null,
});

export type EditablePresentationArtifactSurfaceProps = Omit<
  PresentationProjectionArtifactSurfaceProps,
  "projection" | "commit" | "readOnly" | "busy" | "subtitle"
> & {
  session: EditableArtifactSession;
  subtitle?: ReactNode | undefined;
  readOnly?: boolean | undefined;
  /** Called only after the durable SDK command has been accepted locally. */
  onCommit?: PresentationCommitHandler | undefined;
};

export type ComposedPresentationProjection = Readonly<{
  projection: PresentationEditorProjection;
  sceneNodes: ReadonlyMap<string, PresentationArtifactEditorSceneNode>;
}>;

type PresentationProjectionState = {
  composed: ComposedPresentationProjection | null;
  loading: boolean;
  error: Error | null;
};

/**
 * Durable presentation editor over the public SDK. The Worker owns canonical
 * state; React only receives bounded catalog and per-slide editor projections.
 */
export function EditablePresentationArtifactSurface({
  session,
  title = "Presentation",
  subtitle,
  readOnly = false,
  onCommit,
  onCommandError,
  ...surfaceProps
}: EditablePresentationArtifactSurfaceProps) {
  const view = useEditableArtifactView(session);
  const invalidator = editableArtifactProjectionKey(view);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [state, setState] = useState<PresentationProjectionState>({
    composed: null,
    loading: true,
    error: null,
  });
  const loadGeneration = useRef(0);
  const sceneNodes = useRef(new Map<string, PresentationArtifactEditorSceneNode>());

  useEffect(() => {
    const generation = ++loadGeneration.current;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void composePresentationEditorProjection(session).then(
      (composed) => {
        if (cancelled || generation !== loadGeneration.current) return;
        sceneNodes.current = new Map(composed.sceneNodes);
        setState({ composed, loading: false, error: null });
      },
      (cause) => {
        if (cancelled || generation !== loadGeneration.current) return;
        setState({
          composed: null,
          loading: false,
          error: asEditableArtifactError(cause, "Could not open this presentation"),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [invalidator, retryEpoch, session]);

  const refresh = useCallback(() => setRetryEpoch((value) => value + 1), []);
  const writable = !readOnly && view.writable;
  const applyCommit = useCallback(
    async (commit: PresentationCommit) => {
      const composed = state.composed;
      if (!composed) throw new Error("Presentation projection is not ready");
      if (!writable) throw new Error("This presentation is read only");
      if (
        commit.revision !== undefined &&
        String(commit.revision) !== String(composed.projection.revision)
      ) {
        throw new Error("The presentation changed; retry this edit on the latest version");
      }

      if (commit.kind === "slide-insert") {
        await session.createPresentationSlide({
          slideId: commit.slideId,
          index: commit.index,
        });
        notifyPresentationCommit(onCommit, onCommandError, commit);
        refresh();
        return;
      }
      if (commit.kind === "slide-delete") {
        await session.applyPresentationCommands({
          version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
          commands: [{ kind: "slide.delete", id: commit.slideId }],
        });
        notifyPresentationCommit(onCommit, onCommandError, commit);
        refresh();
        return;
      }
      if (commit.kind === "object-insert") {
        await session.applyPresentationCommands({
          version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
          commands: [
            {
              kind: "node.insert",
              owner: { kind: "slide", id: commit.slideId },
              parentId: null,
              index: commit.index,
              node: {
                id: commit.objectId,
                name: "Text box",
                bounds: {
                  x: canonicalCoordinate(commit.position.left),
                  y: canonicalCoordinate(commit.position.top),
                  width: Math.max(1, canonicalCoordinate(commit.position.width)),
                  height: Math.max(1, canonicalCoordinate(commit.position.height)),
                },
                transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
                content: {
                  kind: "shape",
                  geometry: "text-box",
                  fill: { kind: "none" },
                  line: { fill: { kind: "none" }, width: 0, dash: "solid" },
                  text: emptyPresentationText(),
                  placeholder: null,
                },
              },
            },
          ],
        });
        notifyPresentationCommit(onCommit, onCommandError, commit);
        refresh();
        return;
      }
      if (commit.kind === "object-delete") {
        await session.applyPresentationCommands({
          version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
          commands: [{ kind: "node.delete", id: commit.objectId }],
        });
        notifyPresentationCommit(onCommit, onCommandError, commit);
        refresh();
        return;
      }

      const key = sceneNodeKey(commit.slideId, commit.objectId);
      const node = sceneNodes.current.get(key);
      if (!node) throw new Error("The edited presentation object is no longer available");
      if (node.inherited || node.source.kind !== "slide" || node.source.id !== commit.slideId) {
        throw new Error("Inherited master and layout objects are view only in the slide editor");
      }

      let command: PresentationArtifactCommand;
      let nextNode: PresentationArtifactEditorSceneNode;
      if (commit.kind === "text") {
        if (node.content.kind !== "shape" || node.content.text === null) {
          throw new Error("This presentation object does not contain editable text");
        }
        if (flattenPresentationRichText(node.content.text) !== commit.before) {
          throw new Error("The presentation text changed; retry this edit");
        }
        const text = replacePresentationRichText(node.content.text, commit.before, commit.after);
        const content: PresentationArtifactNodeKind = Object.freeze({ ...node.content, text });
        command = { kind: "node.content.set", id: node.id, content };
        nextNode = Object.freeze({ ...node, content });
      } else {
        const current = normalizeProjectedEditorPosition(projectPosition(node.bounds));
        if (!sameProjectedPosition(current, commit.before)) {
          throw new Error("The presentation object changed; retry this edit");
        }
        const bounds =
          commit.kind === "move"
            ? Object.freeze({
                ...node.bounds,
                x: canonicalCoordinate(commit.after.left),
                y: canonicalCoordinate(commit.after.top),
              })
            : Object.freeze({
                ...node.bounds,
                width: Math.max(1, canonicalCoordinate(commit.after.width)),
                height: Math.max(1, canonicalCoordinate(commit.after.height)),
              });
        command = { kind: "node.bounds.set", id: node.id, bounds };
        nextNode = Object.freeze({ ...node, bounds });
      }

      await session.applyPresentationCommands({
        version: PRESENTATION_ARTIFACT_COMMAND_VERSION,
        commands: [command],
      });
      sceneNodes.current.set(key, nextNode);
      notifyPresentationCommit(onCommit, onCommandError, commit);
      refresh();
    },
    [onCommandError, onCommit, refresh, session, state.composed, writable],
  );

  const projection = state.composed?.projection ?? null;
  const status = editableArtifactStatusLabel(view);
  const accessRevoked = editableArtifactAccessRevoked(view);
  return projection && !accessRevoked ? (
    <PresentationProjectionArtifactSurface
      {...surfaceProps}
      title={title}
      subtitle={
        subtitle ??
        `${projection.slides.length} slide${projection.slides.length === 1 ? "" : "s"}${writable ? "" : " · Read only"}`
      }
      projection={projection}
      commit={writable ? applyCommit : undefined}
      readOnly={!writable}
      busy={state.loading}
      onCommandError={onCommandError}
    />
  ) : (
    <ArtifactSurface
      modality="presentation"
      title={title}
      subtitle={subtitle ?? status}
      actions={surfaceProps.actions}
      busy={!accessRevoked && !state.error}
      className={surfaceProps.className}
    >
      <EditableArtifactMessage
        title={
          accessRevoked
            ? "Access changed"
            : state.error
              ? "Could not open this presentation"
              : "Opening presentation"
        }
        detail={accessRevoked ? status : (state.error?.message ?? status)}
        retry={!accessRevoked && state.error ? refresh : undefined}
      />
    </ArtifactSurface>
  );
}

/** Builds a deterministic, bounded catalog + editor-slide projection at one revision. */
export async function composePresentationEditorProjection(
  session: EditableArtifactSession,
): Promise<ComposedPresentationProjection> {
  if (session.modality !== "presentation") {
    throw new Error("Expected a presentation artifact session");
  }
  let lastRevisionError: Error | null = null;
  for (let attempt = 0; attempt < PRESENTATION_COMPOSITION_ATTEMPTS; attempt += 1) {
    try {
      return await composePresentationAttempt(session);
    } catch (cause) {
      const error = asEditableArtifactError(cause, "Could not project this presentation");
      if (
        !isPresentationRevisionDrift(error) ||
        attempt === PRESENTATION_COMPOSITION_ATTEMPTS - 1
      ) {
        throw error;
      }
      lastRevisionError = error;
    }
  }
  throw lastRevisionError ?? new Error("Presentation changed while it was opening");
}

async function composePresentationAttempt(
  session: EditableArtifactSession,
): Promise<ComposedPresentationProjection> {
  const metadata = await session.queryPresentation({
    kind: "metadata",
    maxBytes: PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
  });
  if (metadata.kind !== "metadata") throw new Error("Presentation metadata response is malformed");
  if (metadata.slides > PRESENTATION_MAX_INTERACTIVE_SLIDES) {
    throw new Error(
      `Presentation exceeds the interactive limit of ${PRESENTATION_MAX_INTERACTIVE_SLIDES} slides`,
    );
  }
  const catalog = await collectSlideCatalog(session, metadata.revision, metadata.slides);
  const scenes: EditablePresentationEditorSlideProjection[] = [];
  for (let start = 0; start < catalog.length; start += PRESENTATION_SCENE_CONCURRENCY) {
    const batch = catalog.slice(start, start + PRESENTATION_SCENE_CONCURRENCY);
    const projected = await Promise.all(
      batch.map((slide) =>
        session.queryPresentationEditorSlide({
          kind: "editor-slide",
          slideId: slide.id,
          maxNodes: PRESENTATION_ARTIFACT_QUERY_MAX_NODES,
          maxTextBytes: PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES,
          maxBytes: PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
        }),
      ),
    );
    for (const scene of projected) {
      if (scene.revision !== metadata.revision) {
        throw new Error("Presentation projection revision drifted");
      }
      if (scene.truncated) {
        throw new Error(`Slide ${scene.slide.index + 1} exceeds the bounded editor projection`);
      }
      scenes.push(scene);
    }
  }

  const totalNodes = scenes.reduce((sum, scene) => sum + scene.nodes.length, 0);
  const totalText = scenes.reduce((sum, scene) => sum + scene.projectedTextBytes, 0);
  if (totalNodes > PRESENTATION_MAX_INTERACTIVE_NODES) {
    throw new Error(
      `Presentation exceeds the interactive limit of ${PRESENTATION_MAX_INTERACTIVE_NODES} scene nodes`,
    );
  }
  if (totalText > PRESENTATION_MAX_INTERACTIVE_TEXT_BYTES) {
    throw new Error(
      `Presentation exceeds the interactive limit of ${PRESENTATION_MAX_INTERACTIVE_TEXT_BYTES} text bytes`,
    );
  }
  if (scenes.length !== catalog.length) {
    throw new Error("Presentation slides changed while they were opening");
  }

  const sceneNodeMap = new Map<string, PresentationArtifactEditorSceneNode>();
  const slides = scenes.map((scene, index) => {
    if (scene.slide.id !== catalog[index]?.id || scene.slide.index !== index) {
      throw new Error("Presentation slide catalog changed while it was opening");
    }
    for (const node of scene.nodes) {
      sceneNodeMap.set(sceneNodeKey(scene.slide.id, node.id), node);
    }
    return projectPresentationSlide(scene);
  });
  return Object.freeze({
    projection: Object.freeze({
      revision: metadata.revision.toString(),
      slideSize: Object.freeze({
        width: displayCoordinate(metadata.slideSize.width),
        height: displayCoordinate(metadata.slideSize.height),
      }),
      slides: Object.freeze(slides),
    }),
    sceneNodes: sceneNodeMap,
  });
}

async function collectSlideCatalog(
  session: EditableArtifactSession,
  revision: bigint,
  expectedSlides: number,
): Promise<PresentationArtifactSlideCatalogItem[]> {
  const slides: PresentationArtifactSlideCatalogItem[] = [];
  let startSlide = 0;
  let projectedText = 0;
  for (let page = 0; page < PRESENTATION_MAX_CATALOG_PAGES; page += 1) {
    const response = await session.queryPresentationSlideCatalog({
      kind: "slide-catalog",
      startSlide,
      maxSlides: Math.min(
        PRESENTATION_CATALOG_PAGE,
        PRESENTATION_ARTIFACT_QUERY_MAX_SLIDES,
        Math.max(1, expectedSlides - slides.length),
      ),
      maxTextBytes: PRESENTATION_ARTIFACT_QUERY_MAX_TEXT_BYTES,
      maxBytes: PRESENTATION_ARTIFACT_QUERY_RESPONSE_MAX_BYTES,
    });
    if (response.revision !== revision) {
      throw new Error("Presentation projection revision drifted");
    }
    if (response.startSlide !== startSlide) {
      throw new Error("Presentation slide catalog cursor is malformed");
    }
    if (response.slides.some((slide, offset) => slide.index !== startSlide + offset)) {
      throw new Error("Presentation slide catalog order is malformed");
    }
    slides.push(...response.slides);
    projectedText += response.projectedTextBytes;
    if (
      slides.length > PRESENTATION_MAX_INTERACTIVE_SLIDES ||
      projectedText > PRESENTATION_MAX_INTERACTIVE_TEXT_BYTES
    ) {
      throw new Error("Presentation slide catalog exceeds its interactive limit");
    }
    if (response.nextSlide === null) {
      if (response.truncated || slides.length !== expectedSlides) {
        throw new Error("Presentation slide catalog is incomplete");
      }
      return slides;
    }
    if (
      !response.truncated ||
      response.nextSlide <= startSlide ||
      response.nextSlide !== startSlide + response.slides.length ||
      response.slides.length === 0
    ) {
      throw new Error("Presentation slide catalog did not advance");
    }
    startSlide = response.nextSlide;
  }
  throw new Error(`Presentation catalog exceeds ${PRESENTATION_MAX_CATALOG_PAGES} pages`);
}

function projectPresentationSlide(
  scene: EditablePresentationEditorSlideProjection,
): PresentationSlideProjection {
  const byId = new Map(scene.nodes.map((node) => [node.id, node] as const));
  if (byId.size !== scene.nodes.length)
    throw new Error("Presentation slide contains duplicate IDs");
  const children = new Map<string | null, PresentationArtifactEditorSceneNode[]>();
  for (const node of scene.nodes) {
    const entries = children.get(node.parentId) ?? [];
    entries.push(node);
    children.set(node.parentId, entries);
  }
  for (const entries of children.values()) {
    entries.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  const projectNode = (
    node: PresentationArtifactEditorSceneNode,
  ): PresentationProjectionElement => {
    if (stack.has(node.id)) throw new Error("Presentation group hierarchy contains a cycle");
    if (visited.has(node.id)) throw new Error("Presentation node appears more than once");
    stack.add(node.id);
    visited.add(node.id);
    const directChildren = children.get(node.id) ?? [];
    let orderedChildren = directChildren;
    if (node.content.kind === "group") {
      const directIds = new Set(directChildren.map((child) => child.id));
      if (
        node.content.children.length !== directChildren.length ||
        node.content.children.some((id) => !directIds.has(id))
      ) {
        throw new Error(`Presentation group ${node.id} hierarchy is inconsistent`);
      }
      orderedChildren = node.content.children.map((id) => byId.get(id)!);
    } else if (directChildren.length > 0) {
      throw new Error(`Presentation non-group node ${node.id} contains children`);
    }
    const result = projectPresentationNode(node, orderedChildren.map(projectNode));
    stack.delete(node.id);
    return result;
  };
  const elements = (children.get(null) ?? []).map(projectNode);
  if (visited.size !== scene.nodes.length) {
    throw new Error("Presentation slide contains orphaned hierarchy nodes");
  }
  return Object.freeze({
    id: scene.slide.id,
    title: scene.slide.title,
    background: projectFill(scene.slide.background),
    elements: Object.freeze(elements),
    layout: scene.slide.layout
      ? Object.freeze({
          id: scene.slide.layout.id,
          name: scene.slide.layout.name,
          masterId: scene.slide.layout.masterId,
          background: projectFill(scene.slide.layout.background),
        })
      : null,
    notes: scene.notes ? projectRichText(scene.notes) : null,
  });
}

function projectPresentationNode(
  node: PresentationArtifactEditorSceneNode,
  children: readonly PresentationProjectionElement[],
): PresentationProjectionElement {
  const metadata = {
    nodeSource: { ...node.source },
    inherited: node.inherited,
    parentId: node.parentId,
    order: node.order,
    readOnly: node.inherited || node.source.kind !== "slide",
  } as const;
  const position = projectPosition(node.bounds);
  const rotation = node.transform.rotation / 60_000;
  const content = node.content;
  if (content.kind === "shape") {
    const richText = content.text ? projectRichText(content.text) : undefined;
    const textStyle = richText ? firstTextStyle(richText) : undefined;
    return Object.freeze({
      ...metadata,
      kind: "shape",
      id: node.id,
      name: node.name,
      geometry: projectShapeGeometry(content.geometry),
      position,
      fill: projectFill(content.fill),
      line: projectLine(content.line),
      rotation,
      text: content.text ? flattenPresentationRichText(content.text) : "",
      ...(richText ? { richText } : {}),
      ...(textStyle ? { textStyle } : {}),
    });
  }
  if (content.kind === "group") {
    return Object.freeze({
      ...metadata,
      kind: "group",
      id: node.id,
      name: node.name,
      position,
      childOffset: Object.freeze({
        left: displayCoordinate(content.childOffsetX),
        top: displayCoordinate(content.childOffsetY),
      }),
      childExtent: Object.freeze({
        width: displayCoordinate(content.childExtentWidth),
        height: displayCoordinate(content.childExtentHeight),
      }),
      rotation,
      flipHorizontal: node.transform.flipHorizontal,
      flipVertical: node.transform.flipVertical,
      children: Object.freeze([...children]),
    });
  }
  if (content.kind === "connector") {
    return Object.freeze({
      ...metadata,
      kind: "connector",
      id: node.id,
      name: node.name,
      connectorKind: content.connectorKind,
      position,
      start: Object.freeze({
        nodeId: content.start.nodeId,
        x: displayCoordinate(content.start.x),
        y: displayCoordinate(content.start.y),
      }),
      end: Object.freeze({
        nodeId: content.end.nodeId,
        x: displayCoordinate(content.end.x),
        y: displayCoordinate(content.end.y),
      }),
      line: projectLine(content.line),
    });
  }
  if (content.kind === "chart") {
    const titleRichText = projectRichText(content.title);
    return Object.freeze({
      ...metadata,
      kind: "chart",
      id: node.id,
      name: node.name,
      type: content.chartType,
      position,
      title: flattenPresentationRichText(content.title),
      titleRichText,
      hasLegend: content.hasLegend,
      series: Object.freeze(
        content.series.map((series) => ({
          name: series.name,
          categories: Object.freeze([...series.categories]),
          values: Object.freeze([...series.values]),
          xValues: Object.freeze([...series.xValues]),
          bubbleSizes: Object.freeze([...series.bubbleSizes]),
        })),
      ),
    });
  }
  if (content.kind === "table") {
    return Object.freeze({
      ...metadata,
      kind: "table",
      id: node.id,
      name: node.name,
      position,
      rows: Object.freeze(
        content.rows.map((row) =>
          Object.freeze(
            row.map((cell) =>
              cell
                ? Object.freeze({
                    text: flattenPresentationRichText(cell.text),
                    richText: projectRichText(cell.text),
                    fill: projectFill(cell.fill),
                    rowSpan: cell.rowSpan,
                    colSpan: cell.columnSpan,
                  })
                : null,
            ),
          ),
        ),
      ),
      columnWidths: Object.freeze(content.columnWidths.map(displayCoordinate)),
      rowHeights: Object.freeze(content.rowHeights.map(displayCoordinate)),
      line: projectLine(content.line),
    });
  }
  return Object.freeze({
    ...metadata,
    kind: "image",
    id: node.id,
    name: node.name,
    position,
    alt: content.altText,
    fit: content.fit,
    rotation,
    flipHorizontal: node.transform.flipHorizontal,
    flipVertical: node.transform.flipVertical,
    digest: bytesToHex(content.digest),
    contentType: content.contentType,
    intrinsicWidth: content.intrinsicWidth,
    intrinsicHeight: content.intrinsicHeight,
  });
}

function projectRichText(text: PresentationArtifactRichText): PresentationProjectionRichText {
  return Object.freeze({
    verticalAlignment: text.verticalAlignment,
    paragraphs: Object.freeze(
      text.paragraphs.map((paragraph) =>
        Object.freeze({
          alignment: paragraph.alignment,
          runs: Object.freeze(
            paragraph.runs.map((run) =>
              Object.freeze({
                text: run.text,
                style: projectTextStyle(run.style, paragraph.alignment, text.verticalAlignment),
                language: run.style.language,
              }),
            ),
          ),
        }),
      ),
    ),
  });
}

function projectTextStyle(
  style: PresentationArtifactTextStyle,
  alignment?: PresentationArtifactTextParagraph["alignment"],
  verticalAlignment?: PresentationArtifactRichText["verticalAlignment"],
): PresentationProjectionTextStyle {
  return Object.freeze({
    fontFamily: style.fontFamily,
    fontSize: style.fontSizeCentipoints / 100,
    color: rgbaCss(style.color),
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    ...(alignment ? { alignment } : {}),
    ...(verticalAlignment ? { verticalAlignment } : {}),
  });
}

function firstTextStyle(
  text: PresentationProjectionRichText,
): PresentationProjectionTextStyle | undefined {
  return text.paragraphs[0]?.runs[0]?.style;
}

function projectFill(fill: PresentationArtifactFill): PresentationProjectionFill {
  return fill.kind === "none"
    ? "none"
    : Object.freeze({ type: "solid", color: rgbaCss(fill.color) });
}

function projectLine(line: PresentationArtifactLine): PresentationProjectionLine {
  return Object.freeze({
    style: line.dash,
    fill: projectFill(line.fill),
    width: displayCoordinate(line.width),
  });
}

function projectPosition(
  bounds: PresentationArtifactEditorSceneNode["bounds"],
): PresentationProjectionPosition {
  return Object.freeze({
    left: displayCoordinate(bounds.x),
    top: displayCoordinate(bounds.y),
    width: displayCoordinate(bounds.width),
    height: displayCoordinate(bounds.height),
  });
}

function displayCoordinate(value: number): number {
  return value / EMU_PER_CSS_PIXEL;
}

function normalizeProjectedEditorPosition(
  position: PresentationProjectionPosition,
): PresentationProjectionPosition {
  const clamp = (value: number) => Math.max(-1_000_000, Math.min(1_000_000, value));
  return {
    left: clamp(position.left),
    top: clamp(position.top),
    width: Math.min(1_000_000, Math.max(8, position.width)),
    height: Math.min(1_000_000, Math.max(8, position.height)),
  };
}

function canonicalCoordinate(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Presentation coordinate must be finite");
  const canonical = Math.round(value * EMU_PER_CSS_PIXEL);
  if (!Number.isSafeInteger(canonical)) throw new Error("Presentation coordinate is out of range");
  return canonical;
}

function sameProjectedPosition(
  left: PresentationProjectionPosition,
  right: PresentationProjectionPosition,
): boolean {
  return (
    canonicalCoordinate(left.left) === canonicalCoordinate(right.left) &&
    canonicalCoordinate(left.top) === canonicalCoordinate(right.top) &&
    canonicalCoordinate(left.width) === canonicalCoordinate(right.width) &&
    canonicalCoordinate(left.height) === canonicalCoordinate(right.height)
  );
}

function projectShapeGeometry(
  geometry: Extract<PresentationArtifactNodeKind, { kind: "shape" }>["geometry"],
) {
  return {
    "text-box": "textbox",
    rectangle: "rect",
    "rounded-rectangle": "roundRect",
    ellipse: "ellipse",
    triangle: "triangle",
    "right-arrow": "rightArrow",
    line: "line",
  }[geometry] as "textbox" | "rect" | "roundRect" | "ellipse" | "triangle" | "rightArrow" | "line";
}

function emptyPresentationText(): PresentationArtifactRichText {
  return Object.freeze({
    verticalAlignment: "middle",
    paragraphs: Object.freeze([
      Object.freeze({
        alignment: "left",
        runs: Object.freeze([Object.freeze({ text: "", style: DEFAULT_PRESENTATION_TEXT_STYLE })]),
      }),
    ]),
  });
}

export function flattenPresentationRichText(text: PresentationArtifactRichText): string {
  return text.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
    .join("\n");
}

/** Preserves unaffected run styles and paragraph alignment across one UTF-16 text edit. */
export function replacePresentationRichText(
  richText: PresentationArtifactRichText,
  before: string,
  after: string,
): PresentationArtifactRichText {
  const canonicalBefore = flattenPresentationRichText(richText);
  if (canonicalBefore !== before) throw new Error("Presentation rich text does not match its edit");
  if (before === after) return richText;
  const diff = textReplacementRange(before, after);
  const spans = presentationStyleSpans(richText);
  const paragraphStarts = presentationParagraphStarts(richText);
  const insertionStyle = styleAtOffset(spans, diff.start) ?? DEFAULT_PRESENTATION_TEXT_STYLE;
  const insertionAlignment = alignmentAtOffset(richText, paragraphStarts, diff.start);
  const paragraphs: PresentationArtifactTextParagraph[] = [];
  let newOffset = 0;
  for (const paragraphText of after.split("\n")) {
    const alignment = alignmentForNewOffset(
      richText,
      paragraphStarts,
      diff,
      newOffset,
      insertionAlignment,
    );
    const runs: { text: string; style: PresentationArtifactTextStyle }[] = [];
    let localOffset = 0;
    for (const character of paragraphText) {
      const offset = newOffset + localOffset;
      const oldOffset = oldOffsetForNewOffset(diff, offset);
      const style =
        oldOffset === null ? insertionStyle : (styleAtOffset(spans, oldOffset) ?? insertionStyle);
      const previous = runs.at(-1);
      if (previous && samePresentationTextStyle(previous.style, style)) previous.text += character;
      else runs.push({ text: character, style });
      localOffset += character.length;
    }
    paragraphs.push(
      Object.freeze({
        alignment,
        runs: Object.freeze(
          runs.map((run) =>
            Object.freeze({ text: run.text, style: Object.freeze({ ...run.style }) }),
          ),
        ),
      }),
    );
    newOffset += paragraphText.length + 1;
  }
  return Object.freeze({
    verticalAlignment: richText.verticalAlignment,
    paragraphs: Object.freeze(paragraphs),
  });
}

type TextReplacement = {
  start: number;
  oldEnd: number;
  newEnd: number;
  delta: number;
};

function textReplacementRange(before: string, after: string): TextReplacement {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before.charCodeAt(start) === after.charCodeAt(start)
  ) {
    start += 1;
  }
  while (start > 0 && (splitsSurrogate(before, start) || splitsSurrogate(after, start))) start -= 1;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
  ) {
    suffix += 1;
  }
  while (
    suffix > 0 &&
    (splitsSurrogate(before, before.length - suffix) ||
      splitsSurrogate(after, after.length - suffix))
  ) {
    suffix -= 1;
  }
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  return { start, oldEnd, newEnd, delta: oldEnd - newEnd };
}

function oldOffsetForNewOffset(diff: TextReplacement, offset: number): number | null {
  if (offset < diff.start) return offset;
  if (offset >= diff.newEnd) return offset + diff.delta;
  return null;
}

type PresentationStyleSpan = {
  start: number;
  end: number;
  style: PresentationArtifactTextStyle;
};

function presentationStyleSpans(text: PresentationArtifactRichText): PresentationStyleSpan[] {
  const spans: PresentationStyleSpan[] = [];
  let offset = 0;
  text.paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const run of paragraph.runs) {
      spans.push({ start: offset, end: offset + run.text.length, style: run.style });
      offset += run.text.length;
    }
    if (paragraphIndex < text.paragraphs.length - 1) offset += 1;
  });
  return spans;
}

function presentationParagraphStarts(text: PresentationArtifactRichText): number[] {
  const starts: number[] = [];
  let offset = 0;
  text.paragraphs.forEach((paragraph, index) => {
    starts.push(offset);
    offset += paragraph.runs.reduce((sum, run) => sum + run.text.length, 0);
    if (index < text.paragraphs.length - 1) offset += 1;
  });
  return starts;
}

function styleAtOffset(
  spans: readonly PresentationStyleSpan[],
  offset: number,
): PresentationArtifactTextStyle | null {
  const containing = spans.find((span) => offset >= span.start && offset < span.end);
  if (containing) return containing.style;
  const before = [...spans].reverse().find((span) => span.end <= offset);
  return before?.style ?? spans[0]?.style ?? null;
}

function alignmentAtOffset(
  text: PresentationArtifactRichText,
  starts: readonly number[],
  offset: number,
): PresentationArtifactTextParagraph["alignment"] {
  let index = 0;
  while (index + 1 < starts.length && (starts[index + 1] ?? Number.POSITIVE_INFINITY) <= offset) {
    index += 1;
  }
  return text.paragraphs[index]?.alignment ?? "left";
}

function alignmentForNewOffset(
  text: PresentationArtifactRichText,
  starts: readonly number[],
  diff: TextReplacement,
  newOffset: number,
  fallback: PresentationArtifactTextParagraph["alignment"],
): PresentationArtifactTextParagraph["alignment"] {
  const oldOffset = oldOffsetForNewOffset(diff, newOffset);
  return oldOffset === null ? fallback : alignmentAtOffset(text, starts, oldOffset);
}

function samePresentationTextStyle(
  left: PresentationArtifactTextStyle,
  right: PresentationArtifactTextStyle,
): boolean {
  return (
    left.fontFamily === right.fontFamily &&
    left.fontSizeCentipoints === right.fontSizeCentipoints &&
    left.color === right.color &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.language === right.language
  );
}

function splitsSurrogate(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return false;
  const left = value.charCodeAt(index - 1);
  const right = value.charCodeAt(index);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function rgbaCss(value: number): string {
  const hex = (value >>> 0).toString(16).padStart(8, "0");
  return hex.endsWith("ff") ? `#${hex.slice(0, 6)}` : `#${hex}`;
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sceneNodeKey(slideId: string, nodeId: string): string {
  return `${slideId}:${nodeId}`;
}

function isPresentationRevisionDrift(error: Error): boolean {
  return error.message.includes("changed while") || error.message.includes("revision drifted");
}

function notifyPresentationCommit(
  observer: PresentationCommitHandler | undefined,
  onError: ((error: Error) => void) | undefined,
  commit: PresentationCommit,
): void {
  try {
    const result = observer?.(commit);
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch((cause) =>
        onError?.(asEditableArtifactError(cause, "Presentation commit observer failed")),
      );
    }
  } catch (cause) {
    onError?.(asEditableArtifactError(cause, "Presentation commit observer failed"));
  }
}
