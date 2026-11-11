import {
  KnowledgeEntryListResponse,
  KnowledgeSavePreparationResponse,
  type AttemptToolIdentity,
  type AttemptToolResult as AttemptToolResultValue,
} from "@opengeni/contracts";

type JsonRecord = Record<string, unknown>;

type KnowledgeModelProjection = "entry_list" | "save_preparation";

/**
 * The model-visible copy of a Knowledge discovery result.
 *
 * `knowledge_search` (first-party and Docs servers) and `knowledge_prepare_save`
 * return the complete contract to programmatic callers. Codemode and other programmatic
 * callers keep those exact bytes; only the model caller receives this
 * projection (see `projectAttemptToolResultForCaller`). Search returns discovery
 * cards: identity, title, kind, scope, outcome and a short snippet. Full text,
 * exact revision IDs and update versions come from knowledge_get. This projection
 * runs only when executing a new call, never when replaying stored results.
 * Save preparation retains its existing lossless projection, removing only:
 *
 * - entry timestamps, rank score, revision lineage/session/batch/number fields;
 * - defaults: `archived: false`, `change: "upsert"`, `sourceKind: null`, and a
 *   collection's `descriptionTruncated: false`;
 * - `publishedRevisionId`/`latestRevisionId` and `revision.entryId` when they
 *   repeat `revision.id`/`id` (a differing value is kept);
 * - `revision.preview` only when its complete text already appears verbatim in
 *   the title or an excerpt, and title-field excerpts contained in the title;
 * - a collection descriptor's `revisionId` (collections are saved by `id` and
 *   `version` and read by `view`; they are never cited as evidence).
 *
 * Save preparation keeps everything needed to act: entry and collection IDs, `version` (the
 * `expectedVersion` for an update), `revision.id` (evidence pins), scope,
 * view/outcome status, titles, kinds, group/parent IDs, descriptions, excerpts
 * with their offsets, index status and pagination cursors. Nothing is truncated.
 * A result that is an error, carries structured content, or does not strictly
 * match the contract is returned unchanged.
 */
export function projectKnowledgeToolResultForModel(
  identity: AttemptToolIdentity,
  result: AttemptToolResultValue,
): AttemptToolResultValue {
  const projection = knowledgeModelProjection(identity);
  if (!projection || result.isError === true || result.structuredContent !== undefined) {
    return result;
  }
  if (result.content.length !== 1) return result;
  const [content] = result.content;
  if (content?.type !== "text") return result;
  let value: unknown;
  try {
    value = JSON.parse(content.text);
  } catch {
    return result;
  }
  const compact =
    projection === "entry_list" ? compactEntryList(value) : compactSavePreparation(value);
  if (!compact) return result;
  const text = JSON.stringify(compact);
  if (text.length >= content.text.length) return result;
  return { ...result, content: [{ ...content, text }] };
}

function knowledgeModelProjection(identity: AttemptToolIdentity): KnowledgeModelProjection | null {
  if (
    identity.toolName === "knowledge_search" &&
    (identity.serverId === "opengeni" || identity.serverId === "docs")
  ) {
    return "entry_list";
  }
  if (identity.toolName === "knowledge_prepare_save" && identity.serverId === "opengeni") {
    return "save_preparation";
  }
  return null;
}

function compactEntryList(value: unknown): JsonRecord | null {
  if (!KnowledgeEntryListResponse.safeParse(value).success) return null;
  const { entries, nextCursor, ...rest } = value as JsonRecord;
  return {
    ...rest,
    entries: (entries as JsonRecord[]).map((entry) => {
      const revision = entry.revision as JsonRecord;
      const excerpts = (entry.excerpts ?? []) as JsonRecord[];
      const match = excerpts.find(
        (excerpt) =>
          excerpt.field === "content" &&
          typeof excerpt.text === "string" &&
          excerpt.text.length > 0,
      );
      const text = match?.text ?? revision.preview;
      const snippet = Array.from(text as string)
        .slice(0, 200)
        .join("")
        .trimEnd();
      return {
        id: entry.id,
        title: revision.title,
        kind: revision.kind,
        scope: entry.scope,
        outcome: revision.outcome,
        ...(entry.archived === true ? { archived: true } : {}),
        ...(revision.change === "upsert" ? {} : { change: revision.change }),
        ...(snippet ? { snippet } : {}),
      };
    }),
    ...(nextCursor === null ? {} : { nextCursor }),
    readWith: "knowledge_get",
  };
}

function compactSavePreparation(value: unknown): JsonRecord | null {
  if (!KnowledgeSavePreparationResponse.safeParse(value).success) return null;
  const response = value as JsonRecord & {
    collections: JsonRecord & { entries: JsonRecord[] };
    matches: JsonRecord & { published: JsonRecord; needs_review: JsonRecord };
  };
  return {
    ...response,
    collections: {
      ...response.collections,
      entries: response.collections.entries.map(compactCollection),
    },
    matches: {
      ...response.matches,
      published: compactListResponse(response.matches.published),
      needs_review: compactListResponse(response.matches.needs_review),
    },
  };
}

function compactListResponse(response: JsonRecord): JsonRecord {
  return { ...response, entries: (response.entries as JsonRecord[]).map(compactEntrySummary) };
}

function compactCollection(collection: JsonRecord): JsonRecord {
  const { revisionId: _revisionId, descriptionTruncated, ...kept } = collection;
  return { ...kept, ...(descriptionTruncated === false ? {} : { descriptionTruncated }) };
}

function compactEntrySummary(entry: JsonRecord): JsonRecord {
  const {
    score: _score,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    archived,
    publishedRevisionId,
    latestRevisionId,
    excerpts,
    revision,
    ...kept
  } = entry;
  const {
    entryId,
    number: _number,
    change,
    previousRevisionId: _previousRevisionId,
    restoredFromRevisionId: _restoredFromRevisionId,
    createdAt: _revisionCreatedAt,
    createdBySessionId: _createdBySessionId,
    reviewBatchId: _reviewBatchId,
    sourceKind,
    preview,
    ...keptRevision
  } = revision as JsonRecord;
  const revisionId = keptRevision.id;
  const excerptList = (excerpts ?? []) as JsonRecord[];
  return {
    ...kept,
    ...(archived === false ? {} : { archived }),
    ...(publishedRevisionId === revisionId ? {} : { publishedRevisionId }),
    ...(latestRevisionId === revisionId ? {} : { latestRevisionId }),
    revision: {
      ...keptRevision,
      ...(entryId === entry.id ? {} : { entryId }),
      ...(change === "upsert" ? {} : { change }),
      ...(sourceKind === null ? {} : { sourceKind }),
      ...(previewAlreadyShown(preview, excerptList) ? {} : { preview }),
    },
    ...(excerpts === undefined ? {} : { excerpts }),
  };
}

/**
 * The preview is the start of the entry's content. It is redundant only when
 * it is empty or a content excerpt that starts at offset 0 already begins with
 * it. The title never counts: a short content (a decision's answer) can be a
 * substring of its title and still be the only place the answer appears.
 */
function previewAlreadyShown(preview: unknown, excerpts: readonly JsonRecord[]): boolean {
  if (typeof preview !== "string") return false;
  if (preview === "") return true;
  return excerpts.some(
    (excerpt) =>
      excerpt.field === "content" &&
      excerpt.start === 0 &&
      typeof excerpt.text === "string" &&
      excerpt.text.startsWith(preview),
  );
}
