import {
  KNOWLEDGE_BODY_MAX_BYTES,
  KNOWLEDGE_METADATA_MAX_BYTES,
  KNOWLEDGE_METADATA_MAX_DEPTH,
  KNOWLEDGE_METADATA_MAX_ITEMS,
  KNOWLEDGE_SOURCE_STRING_MAX_BYTES,
  KNOWLEDGE_SOURCE_URI_MAX_BYTES,
  KNOWLEDGE_SUMMARY_MAX_BYTES,
  KNOWLEDGE_TITLE_MAX_BYTES,
  KNOWLEDGE_TOPIC_MAX_BYTES,
  KNOWLEDGE_TOPICS_MAX_ITEMS,
  type KnowledgeRecord,
  type KnowledgeSource,
} from "@opengeni/contracts";

type ProjectionField = KnowledgeRecord["projection"]["fields"][number];

export type KnowledgeProjectionInput = {
  title: string;
  body: string | null;
  summary: string | null;
  topics: unknown;
  metadata: unknown;
  source: KnowledgeSource;
};

export type KnowledgeProjectionResult = Pick<
  KnowledgeRecord,
  "title" | "content" | "projection"
> & {
  source: KnowledgeSource;
};

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end =
      middle > 0 && middle < value.length && /[\uD800-\uDBFF]/u.test(value[middle - 1]!)
        ? middle - 1
        : middle;
    if (utf8Bytes(value.slice(0, end)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  while (end > 0 && utf8Bytes(value.slice(0, end)) > maxBytes) end -= 1;
  return { value: value.slice(0, end), truncated: true };
}

function projectNullableString(
  value: string | null,
  maxBytes: number,
  field: ProjectionField,
  fields: Set<ProjectionField>,
): string | null {
  if (value === null) return null;
  const projected = truncateUtf8(value, maxBytes);
  if (projected.truncated) fields.add(field);
  return projected.value;
}

function projectSourceUri(value: string | null, fields: Set<ProjectionField>): string | null {
  if (value === null || value === "") return null;
  if (utf8Bytes(value) > KNOWLEDGE_SOURCE_URI_MAX_BYTES) {
    fields.add("provenance.source.uri");
    return null;
  }
  return value;
}

function projectTopics(value: unknown, fields: Set<ProjectionField>): string[] {
  if (!Array.isArray(value)) {
    if (value !== null && value !== undefined) fields.add("content.topics");
    return [];
  }
  const result: string[] = [];
  for (const candidate of value) {
    if (result.length >= KNOWLEDGE_TOPICS_MAX_ITEMS) {
      fields.add("content.topics");
      break;
    }
    if (typeof candidate !== "string") {
      fields.add("content.topics");
      continue;
    }
    const projected = truncateUtf8(candidate, KNOWLEDGE_TOPIC_MAX_BYTES);
    if (projected.truncated) fields.add("content.topics");
    result.push(projected.value);
  }
  return result;
}

function projectMetadata(value: unknown): { value: Record<string, unknown>; truncated: boolean } {
  let remainingItems = KNOWLEDGE_METADATA_MAX_ITEMS;
  let truncated = false;

  const visit = (candidate: unknown, depth: number): unknown => {
    if (remainingItems <= 0 || depth > KNOWLEDGE_METADATA_MAX_DEPTH) {
      truncated = true;
      return undefined;
    }
    remainingItems -= 1;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const projected = truncateUtf8(candidate, KNOWLEDGE_SOURCE_STRING_MAX_BYTES);
      if (projected.truncated) truncated = true;
      return projected.value;
    }
    if (Array.isArray(candidate)) {
      const result: unknown[] = [];
      for (const item of candidate) {
        const projected = visit(item, depth + 1);
        if (projected === undefined) break;
        result.push(projected);
      }
      return result;
    }
    if (candidate && typeof candidate === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        if (utf8Bytes(key) > KNOWLEDGE_TOPIC_MAX_BYTES) {
          truncated = true;
          continue;
        }
        const projected = visit((candidate as Record<string, unknown>)[key], depth + 1);
        if (projected === undefined) break;
        result[key] = projected;
      }
      return result;
    }
    truncated = true;
    return undefined;
  };

  const root = visit(value, 0);
  let result = root && typeof root === "object" && !Array.isArray(root) ? root : {};
  if (result !== root) truncated = true;
  const bounded: Record<string, unknown> = {};
  for (const key of Object.keys(result as Record<string, unknown>).sort()) {
    bounded[key] = (result as Record<string, unknown>)[key];
    if (utf8Bytes(JSON.stringify(bounded)) > KNOWLEDGE_METADATA_MAX_BYTES) {
      delete bounded[key];
      truncated = true;
      break;
    }
  }
  result = bounded;
  return { value: result as Record<string, unknown>, truncated };
}

/** Deterministic, byte-bounded projection at the agent-facing Knowledge envelope. */
export function projectKnowledgeRecord(input: KnowledgeProjectionInput): KnowledgeProjectionResult {
  const fields = new Set<ProjectionField>();
  const title = truncateUtf8(input.title, KNOWLEDGE_TITLE_MAX_BYTES);
  if (title.truncated) fields.add("title");
  const metadata = projectMetadata(input.metadata);
  if (metadata.truncated) fields.add("content.metadata");
  const source: KnowledgeSource = {
    ...input.source,
    uri: projectSourceUri(input.source.uri, fields),
    externalId: projectNullableString(
      input.source.externalId,
      KNOWLEDGE_SOURCE_STRING_MAX_BYTES,
      "provenance.source.externalId",
      fields,
    ),
    title: projectNullableString(
      input.source.title,
      KNOWLEDGE_SOURCE_STRING_MAX_BYTES,
      "provenance.source.title",
      fields,
    ),
    author: projectNullableString(
      input.source.author,
      KNOWLEDGE_SOURCE_STRING_MAX_BYTES,
      "provenance.source.author",
      fields,
    ),
    version: projectNullableString(
      input.source.version,
      KNOWLEDGE_SOURCE_STRING_MAX_BYTES,
      "provenance.source.version",
      fields,
    ),
  };
  return {
    title: title.value,
    content: {
      format: "markdown",
      body: projectNullableString(input.body, KNOWLEDGE_BODY_MAX_BYTES, "content.body", fields),
      summary: projectNullableString(
        input.summary,
        KNOWLEDGE_SUMMARY_MAX_BYTES,
        "content.summary",
        fields,
      ),
      topics: projectTopics(input.topics, fields),
      metadata: metadata.value,
    },
    source,
    projection: { truncated: fields.size > 0, fields: [...fields].sort() },
  };
}
