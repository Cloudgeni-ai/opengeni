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
 * return the complete contract to every caller. Codemode and other programmatic
 * callers keep those exact bytes; only the model caller receives this
 * projection (see `projectAttemptToolResultForCaller`). It is the same JSON with
 * bookkeeping and repeated text removed:
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
 * Everything needed to act is kept: entry and collection IDs, `version` (the
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
  return compactListResponse(value as JsonRecord);
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
  const title = keptRevision.title as string;
  const excerptList = (excerpts ?? []) as JsonRecord[];
  const shownText = [title, ...excerptList.map((excerpt) => excerpt.text as string)];
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
      ...(textAlreadyShown(preview, shownText) ? {} : { preview }),
    },
    ...(excerpts === undefined
      ? {}
      : {
          excerpts: excerptList.filter(
            (excerpt) => !(excerpt.field === "title" && title.includes(excerpt.text as string)),
          ),
        }),
  };
}

function textAlreadyShown(text: unknown, shown: readonly string[]): boolean {
  return typeof text === "string" && (text === "" || shown.some((value) => value.includes(text)));
}
