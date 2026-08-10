import {
  DOCUMENT_ARTIFACT_COMMAND_VERSION,
  type DocumentArtifactCommand,
  type DocumentArtifactPageGeometryProjection,
  type DocumentArtifactProjection,
  type DocumentArtifactProjectionItem,
  type DocumentArtifactQuery,
  type DocumentArtifactTextStylePatch,
  type EditableArtifactSession,
} from "@opengeni/sdk/editable-artifacts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import {
  DocumentProjectionArtifactSurface,
  type DocumentCommit,
  type DocumentCommitHandler,
  type DocumentEditorProjection,
  type DocumentProjectionArtifactSurfaceProps,
  type DocumentProjectionPageGeometry,
} from "./document-editor";
import { ArtifactSurface } from "./artifact-surface";
import {
  asEditableArtifactError,
  editableArtifactAccessRevoked,
  editableArtifactProjectionKey,
  editableArtifactStatusLabel,
  EditableArtifactMessage,
  useEditableArtifactView,
} from "./editable-artifact-ui";

const DOCUMENT_PAGE_ITEMS = 512;
const DOCUMENT_MAX_BLOCKS = 4_096;
const DOCUMENT_MAX_SECTIONS = 1_024;
const DOCUMENT_MAX_REVIEW_ITEMS = 4_096;
const DOCUMENT_MAX_TEXT_UTF16 = 1_000_000;
const DOCUMENT_MAX_TABLE_CELLS = 100_000;
const DOCUMENT_MAX_QUERY_PAGES = 64;
const DOCUMENT_COMPOSITION_ATTEMPTS = 3;

export type EditableDocumentArtifactSurfaceProps = Omit<
  DocumentProjectionArtifactSurfaceProps,
  "projection" | "commit" | "readOnly" | "busy" | "subtitle"
> & {
  session: EditableArtifactSession;
  subtitle?: ReactNode | undefined;
  readOnly?: boolean | undefined;
  /** Called only after the durable SDK command has been accepted locally. */
  onCommit?: DocumentCommitHandler | undefined;
};

type DocumentProjectionState = {
  session: EditableArtifactSession;
  projection: DocumentEditorProjection | null;
  loading: boolean;
  error: Error | null;
};

type DocumentCommandState = {
  session: EditableArtifactSession;
  tail: Promise<void>;
  paragraphText: Map<string, string>;
  localParagraphIds: Set<string>;
  optimisticParagraphIds: Map<string, string>;
};

/**
 * Durable document editor over the public SDK session. Canonical state and
 * speculative replay remain Worker-owned; React receives bounded projections.
 */
export function EditableDocumentArtifactSurface({
  session,
  title,
  subtitle,
  readOnly = false,
  onCommit,
  onCommandError,
  ...surfaceProps
}: EditableDocumentArtifactSurfaceProps) {
  const view = useEditableArtifactView(session);
  const invalidator = editableArtifactProjectionKey(view);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [state, setState] = useState<DocumentProjectionState>({
    session,
    projection: null,
    loading: true,
    error: null,
  });
  const loadGeneration = useRef(0);
  const commandStateRef = useRef<DocumentCommandState | null>(null);
  if (commandStateRef.current?.session !== session) {
    commandStateRef.current = {
      session,
      tail: Promise.resolve(),
      paragraphText: new Map(),
      localParagraphIds: new Set(),
      optimisticParagraphIds: new Map(),
    };
  }
  const commandState = commandStateRef.current;

  useEffect(() => {
    const generation = ++loadGeneration.current;
    let cancelled = false;
    setState((current) =>
      current.session === session
        ? { ...current, loading: true, error: null }
        : { session, projection: null, loading: true, error: null },
    );
    void composeDocumentEditorProjection(session).then(
      (projection) => {
        if (
          cancelled ||
          generation !== loadGeneration.current ||
          commandStateRef.current !== commandState
        ) {
          return;
        }
        const nextParagraphText = paragraphTextById(projection);
        for (const [localId, canonicalId] of commandState.optimisticParagraphIds) {
          if (nextParagraphText.has(canonicalId)) continue;
          const optimisticText =
            commandState.paragraphText.get(canonicalId) ?? commandState.paragraphText.get(localId);
          if (optimisticText !== undefined) nextParagraphText.set(canonicalId, optimisticText);
        }
        commandState.paragraphText = nextParagraphText;
        setState({ session, projection, loading: false, error: null });
      },
      (cause) => {
        if (
          cancelled ||
          generation !== loadGeneration.current ||
          commandStateRef.current !== commandState
        ) {
          return;
        }
        setState({
          session,
          projection: null,
          loading: false,
          error: asEditableArtifactError(cause, "Could not open this document"),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [commandState, invalidator, retryEpoch, session]);

  const refresh = useCallback(() => setRetryEpoch((value) => value + 1), []);
  const writable = !readOnly && view.writable;
  const applyCommit = useCallback(
    (commit: DocumentCommit): Promise<void> => {
      const projection = state.session === session ? state.projection : null;
      if (!projection) return Promise.reject(new Error("Document projection is not ready"));
      if (!writable) return Promise.reject(new Error("This document is read only"));
      if (String(commit.revision) !== String(projection.revision)) {
        return Promise.reject(
          new Error("The document changed; retry this edit on the latest version"),
        );
      }

      const execute = async () => {
        if (commandStateRef.current !== commandState) {
          throw new Error("The document session changed before this edit could be saved");
        }

        const allocateLocalParagraph = async (localId: string): Promise<string> => {
          const allocated = commandState.optimisticParagraphIds.get(localId);
          if (allocated !== undefined) return allocated;
          if (!commandState.localParagraphIds.has(localId)) {
            throw new Error("The edited paragraph is no longer available");
          }
          const created = await session.createDocumentParagraph();
          if (commandStateRef.current !== commandState) {
            throw new Error("The document session changed before this edit could be saved");
          }
          commandState.optimisticParagraphIds.set(localId, created.paragraphId);
          commandState.paragraphText.set(created.paragraphId, "");
          return created.paragraphId;
        };

        if (commit.kind === "insert-paragraph") {
          commandState.localParagraphIds.add(commit.blockId);
          await allocateLocalParagraph(commit.blockId);
          notifyDocumentCommit(onCommit, onCommandError, commit);
          refresh();
          return;
        }

        const targetId = commandState.localParagraphIds.has(commit.blockId)
          ? await allocateLocalParagraph(commit.blockId)
          : commit.blockId;
        let command: DocumentArtifactCommand | null = null;
        let rollbackText: (() => void) | null = null;
        if (commit.kind === "text") {
          const before = commandState.paragraphText.get(targetId);
          if (before === undefined) {
            throw new Error("The edited paragraph is no longer available");
          }
          const edit = minimalUtf16TextEdit(before, commit.text);
          if (!edit) return;
          commandState.paragraphText.set(targetId, commit.text);
          rollbackText = () => {
            if (commandState.paragraphText.get(targetId) === commit.text) {
              commandState.paragraphText.set(targetId, before);
            }
          };
          command = {
            kind: "paragraph.edit",
            id: targetId,
            range: edit.range,
            replacement: edit.replacement,
            style: null,
          };
        } else if (commit.kind === "format") {
          command = {
            kind: "paragraph.format",
            id: targetId,
            range: commit.range,
            style: documentTextStylePatch(commit.style),
          };
        }
        if (!command) throw new Error("Unsupported document edit");

        try {
          await session.applyDocumentCommands({
            version: DOCUMENT_ARTIFACT_COMMAND_VERSION,
            commands: [command],
          });
          if (commandStateRef.current !== commandState) return;
          notifyDocumentCommit(onCommit, onCommandError, commit);
          refresh();
        } catch (cause) {
          rollbackText?.();
          throw cause;
        }
      };

      // A rejected edit must not poison later user input. Each operation still
      // runs serially, but starts after the prior operation settles.
      const operation = commandState.tail.then(execute, execute);
      commandState.tail = operation;
      void operation.then(
        () => {
          if (commandState.tail === operation) commandState.tail = Promise.resolve();
        },
        () => {
          if (commandState.tail === operation) commandState.tail = Promise.resolve();
        },
      );
      return operation;
    },
    [commandState, onCommandError, onCommit, refresh, session, state, writable],
  );

  const projection = state.session === session ? state.projection : null;
  const status = editableArtifactStatusLabel(view);
  const accessRevoked = editableArtifactAccessRevoked(view);
  return projection && !accessRevoked ? (
    <DocumentProjectionArtifactSurface
      {...surfaceProps}
      title={title}
      subtitle={
        subtitle ??
        `${projection.blocks.length} block${projection.blocks.length === 1 ? "" : "s"}${writable ? "" : " · Read only"}`
      }
      projection={projection}
      commit={writable ? applyCommit : undefined}
      readOnly={!writable}
      busy={state.loading}
      onCommandError={onCommandError}
    />
  ) : (
    <ArtifactSurface
      modality="document"
      title={title}
      subtitle={subtitle ?? status}
      busy={!accessRevoked && !state.error}
      className={surfaceProps.className}
    >
      <EditableArtifactMessage
        title={
          accessRevoked
            ? "Access changed"
            : state.error
              ? "Could not open this document"
              : "Opening document"
        }
        detail={accessRevoked ? status : (state.error?.message ?? status)}
        retry={!accessRevoked && state.error ? refresh : undefined}
      />
    </ArtifactSurface>
  );
}

/** Deterministically composes summary/body/sections/review at one Worker revision. */
export async function composeDocumentEditorProjection(
  session: EditableArtifactSession,
): Promise<DocumentEditorProjection> {
  if (session.modality !== "document") throw new Error("Expected a document artifact session");
  let lastRevisionError: Error | null = null;
  for (let attempt = 0; attempt < DOCUMENT_COMPOSITION_ATTEMPTS; attempt += 1) {
    try {
      return await composeDocumentAttempt(session);
    } catch (cause) {
      const error = asEditableArtifactError(cause, "Could not project this document");
      if (!isRevisionDrift(error) || attempt === DOCUMENT_COMPOSITION_ATTEMPTS - 1) throw error;
      lastRevisionError = error;
    }
  }
  throw lastRevisionError ?? new Error("Document changed while it was opening");
}

async function composeDocumentAttempt(
  session: EditableArtifactSession,
): Promise<DocumentEditorProjection> {
  const summaryPage = await session.queryDocument({ kind: "summary" });
  const summary = summaryItem(summaryPage);
  const revision = summaryPage.revision;
  if (summary.revision !== revision) throw new Error("Document projection revision drifted");
  if (summary.blockCount > DOCUMENT_MAX_BLOCKS) {
    throw new Error(`Document exceeds the interactive limit of ${DOCUMENT_MAX_BLOCKS} blocks`);
  }
  if (summary.sectionCount > DOCUMENT_MAX_SECTIONS) {
    throw new Error(`Document exceeds the interactive limit of ${DOCUMENT_MAX_SECTIONS} sections`);
  }
  if (summary.commentCount + summary.trackedChangeCount > DOCUMENT_MAX_REVIEW_ITEMS) {
    throw new Error(
      `Document exceeds the interactive limit of ${DOCUMENT_MAX_REVIEW_ITEMS} review items`,
    );
  }

  const body = await collectDocumentPages(
    session,
    "body",
    revision,
    DOCUMENT_MAX_BLOCKS,
    DOCUMENT_MAX_TEXT_UTF16,
    DOCUMENT_MAX_TABLE_CELLS,
    (cursor, limits) => ({ kind: "body", startBlock: cursor, limits }),
  );
  const sections = await collectDocumentPages(
    session,
    "sections",
    revision,
    DOCUMENT_MAX_SECTIONS,
    DOCUMENT_MAX_TEXT_UTF16 - body.text,
    DOCUMENT_MAX_TABLE_CELLS - body.cells,
    (cursor, limits) => ({ kind: "sections", startSection: cursor, limits }),
  );
  const review = await collectDocumentPages(
    session,
    "review",
    revision,
    DOCUMENT_MAX_REVIEW_ITEMS,
    DOCUMENT_MAX_TEXT_UTF16 - body.text - sections.text,
    DOCUMENT_MAX_TABLE_CELLS - body.cells - sections.cells,
    (cursor, limits) => ({ kind: "review", startItem: cursor, limits }),
  );

  if (body.items.length !== summary.blockCount) {
    throw new Error("Document body changed while it was opening");
  }
  if (sections.items.length !== summary.sectionCount) {
    throw new Error("Document sections changed while they were opening");
  }
  if (review.items.length !== summary.commentCount + summary.trackedChangeCount) {
    throw new Error("Document review state changed while it was opening");
  }
  const totalText = body.text + sections.text + review.text;
  const totalCells = body.cells + sections.cells + review.cells;
  if (totalText > DOCUMENT_MAX_TEXT_UTF16) {
    throw new Error(
      `Document exceeds the interactive limit of ${DOCUMENT_MAX_TEXT_UTF16} UTF-16 text units`,
    );
  }
  if (totalCells > DOCUMENT_MAX_TABLE_CELLS) {
    throw new Error(
      `Document exceeds the interactive limit of ${DOCUMENT_MAX_TABLE_CELLS} table cells`,
    );
  }

  return Object.freeze({
    revision: revision.toString(),
    page: projectDocumentPage(summary.page),
    blocks: Object.freeze(body.items.map(projectDocumentBlock)),
    sections: Object.freeze(sections.items.map(projectDocumentSection)),
    comments: Object.freeze(
      review.items.filter(isProjectionKind("comment")).map((item) => ({
        id: item.id,
        blockId: item.paragraphId,
        start: item.range.start,
        end: item.range.end,
        resolved: item.resolved,
        replies: item.replies.map((reply) => ({ ...reply })),
      })),
    ),
    changes: Object.freeze(
      review.items.filter(isProjectionKind("tracked-change")).map((item) => ({
        id: item.id,
        blockId: item.paragraphId,
        kind: item.changeKind,
        start: item.range.start,
        end: item.range.end,
        author: item.author,
        createdAt: item.createdAt,
      })),
    ),
  });
}

type DocumentPageCollection = {
  items: DocumentArtifactProjectionItem[];
  text: number;
  cells: number;
};

async function collectDocumentPages(
  session: EditableArtifactSession,
  label: "body" | "sections" | "review",
  revision: bigint,
  maxItems: number,
  maxText: number,
  maxCells: number,
  query: (
    cursor: number,
    limits: { maxItems: number; maxTextUtf16: number; maxTableCells: number },
  ) => DocumentArtifactQuery,
): Promise<DocumentPageCollection> {
  const output: DocumentPageCollection = { items: [], text: 0, cells: 0 };
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < DOCUMENT_MAX_QUERY_PAGES; pageIndex += 1) {
    if (output.items.length >= maxItems && cursor > 0) {
      throw new Error(`Document ${label} exceeds its interactive item limit`);
    }
    const page = await session.queryDocument(
      query(cursor, {
        maxItems: Math.min(DOCUMENT_PAGE_ITEMS, Math.max(1, maxItems - output.items.length)),
        maxTextUtf16: Math.max(1, maxText - output.text),
        maxTableCells: Math.max(1, maxCells - output.cells),
      }),
    );
    assertDocumentRevision(page, revision);
    assertDocumentPageKinds(label, page.items);
    if (output.items.length + page.items.length > maxItems) {
      throw new Error(`Document ${label} exceeds its interactive item limit`);
    }
    output.items.push(...page.items);
    output.text += page.projectedTextUtf16;
    output.cells += page.projectedTableCells;
    if (output.text > maxText || output.cells > maxCells) {
      throw new Error(`Document ${label} exceeds its interactive content limit`);
    }
    if (page.nextCursor === null) return output;
    if (page.nextCursor <= cursor || page.items.length === 0) {
      throw new Error(`Document ${label} pagination did not advance`);
    }
    cursor = page.nextCursor;
  }
  throw new Error(`Document ${label} exceeds ${DOCUMENT_MAX_QUERY_PAGES} query pages`);
}

function summaryItem(
  projection: DocumentArtifactProjection,
): Extract<DocumentArtifactProjectionItem, { kind: "summary" }> {
  if (
    projection.items.length !== 1 ||
    projection.items[0]?.kind !== "summary" ||
    projection.nextCursor !== null ||
    projection.truncated
  ) {
    throw new Error("Document summary projection is malformed");
  }
  return projection.items[0];
}

function assertDocumentRevision(page: DocumentArtifactProjection, revision: bigint): void {
  if (page.revision !== revision) throw new Error("Document projection revision drifted");
}

function assertDocumentPageKinds(
  label: "body" | "sections" | "review",
  items: readonly DocumentArtifactProjectionItem[],
): void {
  const valid =
    label === "body"
      ? new Set(["paragraph", "table", "page-break"])
      : label === "sections"
        ? new Set(["section"])
        : new Set(["comment", "tracked-change"]);
  if (items.some((item) => !valid.has(item.kind))) {
    throw new Error(`Document ${label} projection contains an unexpected item`);
  }
}

function projectDocumentBlock(
  item: DocumentArtifactProjectionItem,
): DocumentEditorProjection["blocks"][number] {
  if (item.kind === "paragraph") {
    const { headingLevel, list, ...paragraphStyle } = item.style;
    return {
      kind: "paragraph",
      id: item.id,
      runs: item.runs.map((run) => ({ text: run.text, style: { ...run.style } })),
      style: {
        ...paragraphStyle,
        ...(headingLevel === undefined ? {} : { headingLevel: documentHeadingLevel(headingLevel) }),
        ...(list
          ? {
              list: {
                kind: list.kind,
                ...(list.level === null ? {} : { level: list.level }),
                ...(list.instanceId === null ? {} : { instanceId: list.instanceId }),
              },
            }
          : {}),
      },
    };
  }
  if (item.kind === "table") {
    return {
      kind: "table",
      id: item.id,
      rows: item.rows.map((row) =>
        row.map((cell) => cell.map((run) => ({ text: run.text, style: { ...run.style } }))),
      ),
      style: { ...item.style },
    };
  }
  if (item.kind === "page-break") return { kind: "pageBreak", id: item.id };
  throw new Error("Document body projection contains an unexpected item");
}

function documentHeadingLevel(value: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (value < 1 || value > 6 || !Number.isInteger(value)) {
    throw new Error("Document projection contains an invalid heading level");
  }
  return value as 1 | 2 | 3 | 4 | 5 | 6;
}

function projectDocumentSection(item: DocumentArtifactProjectionItem) {
  if (item.kind !== "section") {
    throw new Error("Document section projection contains an unexpected item");
  }
  return {
    id: item.id,
    startBlockIndex: item.startBlockIndex,
    page: projectDocumentPage(item.page),
    titlePage: item.titlePage,
    headerBlockCounts: item.headerBlockCounts,
    footerBlockCounts: item.footerBlockCounts,
  };
}

function projectDocumentPage(
  page: DocumentArtifactPageGeometryProjection,
): DocumentProjectionPageGeometry {
  const points = (value: bigint) => Number(value) / 1_000;
  return {
    widthPt: points(page.widthMillipoints),
    heightPt: points(page.heightMillipoints),
    marginTopPt: points(page.marginTopMillipoints),
    marginRightPt: points(page.marginRightMillipoints),
    marginBottomPt: points(page.marginBottomMillipoints),
    marginLeftPt: points(page.marginLeftMillipoints),
    headerPt: points(page.headerMillipoints),
    footerPt: points(page.footerMillipoints),
    gutterPt: points(page.gutterMillipoints),
  };
}

function isProjectionKind<K extends DocumentArtifactProjectionItem["kind"]>(kind: K) {
  return (
    item: DocumentArtifactProjectionItem,
  ): item is Extract<DocumentArtifactProjectionItem, { kind: K }> => item.kind === kind;
}

function paragraphTextById(projection: DocumentEditorProjection): Map<string, string> {
  return new Map(
    projection.blocks
      .filter((block) => block.kind === "paragraph")
      .map((paragraph) => [paragraph.id, paragraph.runs.map((run) => run.text).join("")] as const),
  );
}

export function minimalUtf16TextEdit(
  before: string,
  after: string,
): { range: { start: number; end: number }; replacement: string } | null {
  if (before === after) return null;
  let start = 0;
  const maximumStart = Math.min(before.length, after.length);
  while (start < maximumStart && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
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
  return {
    range: { start, end: before.length - suffix },
    replacement: after.slice(start, after.length - suffix),
  };
}

function splitsSurrogate(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return false;
  const left = value.charCodeAt(index - 1);
  const right = value.charCodeAt(index);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function documentTextStylePatch(
  style: Extract<DocumentCommit, { kind: "format" }>["style"],
): DocumentArtifactTextStylePatch {
  return {
    ...(style.fontFamily === undefined ? {} : { fontFamily: style.fontFamily }),
    ...(style.fontSizePt === undefined ? {} : { fontSizePt: style.fontSizePt }),
    ...(style.color === undefined ? {} : { color: style.color }),
    ...(style.bold === undefined ? {} : { bold: style.bold }),
    ...(style.italic === undefined ? {} : { italic: style.italic }),
    ...(style.underline === undefined ? {} : { underline: style.underline }),
    ...(style.strike === undefined ? {} : { strike: style.strike }),
  };
}

function isRevisionDrift(error: Error): boolean {
  return error.message.includes("changed while") || error.message.includes("revision drifted");
}

function notifyDocumentCommit(
  observer: DocumentCommitHandler | undefined,
  onError: ((error: Error) => void) | undefined,
  commit: DocumentCommit,
): void {
  try {
    const result = observer?.(commit);
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch((cause) =>
        onError?.(asEditableArtifactError(cause, "Document commit observer failed")),
      );
    }
  } catch (cause) {
    onError?.(asEditableArtifactError(cause, "Document commit observer failed"));
  }
}
