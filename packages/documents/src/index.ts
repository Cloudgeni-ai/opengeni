import type { Settings } from "@opengeni/config";
import type {
  AddDocumentRequest,
  CreateDocumentBaseRequest,
  Document,
  DocumentAuthorityKind,
  DocumentBase,
  DocumentCuration,
  DocumentCurationStatus,
  DocumentSearchMode,
  DocumentSearchResult,
  DocumentStatus,
  DocumentVisibility,
  FileAsset,
  KnowledgeSourceKind,
} from "@opengeni/contracts";
import {
  requireFile,
  rlsContextForWorkspace,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { ObjectStorage } from "@opengeni/storage";
import { LiteParse } from "@llamaindex/liteparse";
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import OpenAI from "openai";

export const DEFAULT_DOCUMENT_PARSER = "liteparse";
export const DEFAULT_DOCUMENT_EMBEDDING_MODEL = "text-embedding-3-large";
export const DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS = 3072;
export const DEFAULT_DOCUMENT_CHUNK_SIZE = 1200;
export const DEFAULT_DOCUMENT_CHUNK_OVERLAP = 160;
export const DEFAULT_DOCUMENT_CURATION_MODEL = "gpt-4o-mini";
// Curator input is a preview, not the whole document — enough to name and
// classify without paying for a full-document prompt on every drop.
export const DOCUMENT_CURATION_MAX_INPUT_CHARS = 24_000;
export const DOCUMENT_AUTHORITY_SUBJECT_MAX_BYTES = 1024;
// A base move is applied automatically only at or above this curator
// confidence; below it the suggestion is surfaced for human review instead.
export const DOCUMENT_CURATION_AUTO_FILE_CONFIDENCE = 0.75;
// The per-workspace default base: where knowledge drops land (created on
// first drop) and stay unless configured curation files them into a topical base.
export const DEFAULT_BASE_NAME = "Default";
export const DEFAULT_BASE_DESCRIPTION = "Default base for dropped files and notes.";

export type ParsedDocument = {
  text: string;
  metadata?: Record<string, unknown>;
};

export type DocumentChunk = {
  text: string;
  metadata: Record<string, unknown>;
};

export type DocumentParser = {
  name: string;
  parse: (bytes: Uint8Array, file: FileAsset) => Promise<ParsedDocument>;
};

export type DocumentChunker = {
  chunk: (parsed: ParsedDocument, file: FileAsset) => DocumentChunk[];
};

export type DocumentEmbedder = {
  model: string;
  dimensions: number;
  embedMany: (texts: string[]) => Promise<number[][]>;
  embedQuery: (text: string) => Promise<number[]>;
};

export type DocumentCurationCandidateBase = {
  id: string;
  name: string;
  description: string | null;
};

export type DocumentCurationInput = {
  /** Parsed document text, clipped to DOCUMENT_CURATION_MAX_INPUT_CHARS. */
  text: string;
  filename: string;
  /** Current (usually filename-derived) title. */
  title: string;
  /** Candidate bases the document could be filed into (never its current base). */
  bases: DocumentCurationCandidateBase[];
};

export type DocumentCurationOutcome = {
  title: string | null;
  summary: string | null;
  sourceKind: KnowledgeSourceKind | null;
  topics: string[];
  targetBaseId: string | null;
  confidence: number;
  reason: string | null;
};

export type DocumentCurator = {
  model: string;
  curate: (input: DocumentCurationInput) => Promise<DocumentCurationOutcome>;
};

export type DocumentServices = {
  parser: DocumentParser;
  chunker: DocumentChunker;
  embedder: DocumentEmbedder;
  /** Optional: names/summarizes/categorizes dropped documents during indexing. */
  curator?: DocumentCurator | undefined;
};

/**
 * Read-scoping for document queries. Fail-closed: when a caller supplies no
 * filter, private documents are invisible (only their creator may see them,
 * and only by passing their subject id).
 */
export type DocumentAccessFilter = {
  /** Grant subject id of the human viewer; null/undefined hides private docs. */
  viewerSubjectId?: string | null | undefined;
  /**
   * Agent retrieval surface: only agent-enabled documents. Workspace-visible
   * documents are available to every agent; private documents are available
   * only when the agent carries the creating subject as its viewer subject.
   */
  agentOnly?: boolean | undefined;
};

export type DocumentAuthority = {
  kind: DocumentAuthorityKind;
  workspaceId: string | null;
  subjectId: string | null;
};

export type DocumentInventoryStatusCounts = Record<DocumentStatus, number>;
export type DocumentInventorySourceKindCounts = Record<KnowledgeSourceKind, number>;
export type DocumentInventoryAuthorityKindCounts = Record<DocumentAuthorityKind, number>;

export type DocumentInventory = {
  baseCount: number;
  bases: Array<{
    id: string;
    name: string;
    visibleDocumentCount: number;
    statusCounts: DocumentInventoryStatusCounts;
    latestUpdatedAt: string | null;
  }>;
  visibleDocumentCount: number;
  statusCounts: DocumentInventoryStatusCounts;
  sourceKindCounts: DocumentInventorySourceKindCounts;
  authorityKindCounts: DocumentInventoryAuthorityKindCounts;
  latestUpdatedAt: string | null;
  topics: Array<{ name: string; documentCount: number }>;
  topicsTruncated: boolean;
};

export type DocumentInventoryInput = {
  baseLimit: number;
  topicLimit: number;
  topicMaxChars: number;
  access?: DocumentAccessFilter | undefined;
};

const DOCUMENT_INVENTORY_MAX_BASE_LIMIT = 100;
const DOCUMENT_INVENTORY_MAX_TOPIC_LIMIT = 100;
const DOCUMENT_INVENTORY_MAX_TOPIC_CHARS = 256;

export type DocumentSearchInput = {
  accountId: string;
  workspaceId: string;
  query: string;
  baseIds?: string[] | undefined;
  limit?: number | undefined;
  mode?: DocumentSearchMode | undefined;
  sourceKinds?: KnowledgeSourceKind[] | undefined;
  aclTags?: string[] | undefined;
  access?: DocumentAccessFilter | undefined;
};

export type EffectiveDocumentSearchInput = Omit<DocumentSearchInput, "access"> & {
  /** Immutable human subject accepted for the logical request/turn. */
  initiatingSubjectId: string;
  /** Agent retrieval additionally enforces documents.agent_access. */
  surface: "human" | "agent";
};

export type DocumentIndexHooks = {
  beforeEmbed?: (input: {
    accountId: string;
    workspaceId: string;
    documentId: string;
    chunkCount: number;
  }) => Promise<void>;
};

export class LiteParseDocumentParser implements DocumentParser {
  readonly name = DEFAULT_DOCUMENT_PARSER;
  private parseQueue: Promise<void> = Promise.resolve();

  async parse(bytes: Uint8Array, file: FileAsset): Promise<ParsedDocument> {
    const text = isTextLike(file)
      ? Buffer.from(bytes).toString("utf8").replace(/\0/g, " ").trim()
      : await this.parseWithLiteParse(bytes);
    if (!text.trim()) {
      throw new Error(`Parsed document is empty: ${file.filename}`);
    }
    return {
      text: text.trim(),
      metadata: {
        parser: this.name,
        filename: file.filename,
        contentType: file.contentType,
      },
    };
  }

  private async parseWithLiteParse(bytes: Uint8Array): Promise<string> {
    return await this.enqueueParse(async () => {
      const parser = new LiteParse({ ocrEnabled: true, numWorkers: 1 });
      const result = await parser.parse(Buffer.from(bytes), true);
      const text = typeof result?.text === "string" ? result.text : "";
      return text.replace(/\0/g, " ").trim();
    });
  }

  private async enqueueParse<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.parseQueue;
    let release: () => void = () => undefined;
    this.parseQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export class RecursiveTextChunker implements DocumentChunker {
  constructor(
    private readonly maxChars = DEFAULT_DOCUMENT_CHUNK_SIZE,
    private readonly overlapChars = DEFAULT_DOCUMENT_CHUNK_OVERLAP,
  ) {
    if (overlapChars >= maxChars) {
      throw new Error("document chunk overlap must be smaller than chunk size");
    }
  }

  chunk(parsed: ParsedDocument, file: FileAsset): DocumentChunk[] {
    return chunkText(parsed.text, this.maxChars, this.overlapChars).map((text, index) => ({
      text,
      metadata: {
        ...parsed.metadata,
        filename: file.filename,
        contentType: file.contentType,
        chunkIndex: index,
      },
    }));
  }
}

export class OpenAIEmbeddingProvider implements DocumentEmbedder {
  private client: OpenAI | null = null;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;

  constructor(args: {
    apiKey?: string | undefined;
    baseURL?: string | undefined;
    defaultHeaders?: Record<string, string> | undefined;
    defaultQuery?: Record<string, string> | undefined;
    model?: string | undefined;
    dimensions?: number | undefined;
  }) {
    this.apiKey = args.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseURL = args.baseURL;
    this.defaultHeaders = args.defaultHeaders;
    this.defaultQuery = args.defaultQuery;
    this.model = args.model ?? DEFAULT_DOCUMENT_EMBEDDING_MODEL;
    this.dimensions = args.dimensions ?? DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS;
  }

  readonly model: string;
  readonly dimensions: number;
  private readonly defaultHeaders: Record<string, string> | undefined;
  private readonly defaultQuery: Record<string, string> | undefined;

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += 64) {
      const batch = texts.slice(start, start + 64);
      const response = await this.openai().embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });
      for (const item of response.data) {
        out.push(validateEmbedding(item.embedding, this.dimensions, this.model));
      }
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedMany([text]);
    if (!embedding) {
      throw new Error("Embedding provider returned no query embedding");
    }
    return embedding;
  }

  private openai(): OpenAI {
    if (!this.apiKey) {
      throw new Error("OpenAI document embeddings require an API key");
    }
    this.client ??= new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(this.defaultQuery ? { defaultQuery: this.defaultQuery } : {}),
      ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
    });
    return this.client;
  }
}

export class DeterministicEmbeddingProvider implements DocumentEmbedder {
  constructor(
    readonly dimensions = DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
    readonly model = `deterministic-local-${dimensions}`,
  ) {}

  async embedMany(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicEmbedding(text, this.dimensions));
  }

  async embedQuery(text: string): Promise<number[]> {
    return deterministicEmbedding(text, this.dimensions);
  }
}

/**
 * Deterministic no-network curation: first meaningful line becomes the title,
 * the opening text becomes the summary, and the kind is guessed from the
 * filename/content type. Never proposes a base move (confidence 0). Used as
 * the `heuristic` provider and as the in-pipeline fallback when the LLM
 * curator fails — a drop must always end up named and summarized.
 */
export function heuristicCuration(
  input: DocumentCurationInput,
  contentType = "application/octet-stream",
): DocumentCurationOutcome {
  const firstLine = input.text
    .split("\n")
    .map((line) => line.replace(/^[#>\s*-]+/, "").trim())
    .find((line) => line.length >= 3);
  const title = (firstLine ?? input.title).slice(0, 120).trim() || input.title;
  const summaryWindow = input.text.replace(/\s+/g, " ").trim().slice(0, 360);
  const summary =
    summaryWindow.length === 360 ? `${summaryWindow.slice(0, 357)}...` : summaryWindow;
  return {
    title,
    summary: summary || null,
    sourceKind: heuristicSourceKind(input.filename, contentType),
    topics: [],
    targetBaseId: null,
    confidence: 0,
    reason: null,
  };
}

function heuristicSourceKind(rawFilename: string, rawContentType: string): KnowledgeSourceKind {
  const filename = rawFilename.toLowerCase();
  const contentType = rawContentType.toLowerCase();
  if (filename.endsWith(".eml") || contentType === "message/rfc822") return "email";
  if (filename.endsWith(".vtt") || filename.endsWith(".srt") || filename.includes("transcript")) {
    return "meeting_transcript";
  }
  if (contentType === "text/html") return "web";
  if (contentType === "application/pdf" || filename.endsWith(".docx") || filename.endsWith(".md")) {
    return "document";
  }
  return "manual_upload";
}

export class HeuristicCurationProvider implements DocumentCurator {
  readonly model = "heuristic";

  async curate(input: DocumentCurationInput): Promise<DocumentCurationOutcome> {
    return heuristicCuration(input);
  }
}

const CURATION_SYSTEM_PROMPT = [
  "You organize a team knowledge base. Given the beginning of a dropped document",
  "and the list of existing collections (bases), return STRICT JSON with keys:",
  '"title" (concise, specific, <= 120 chars, no filename extensions),',
  '"summary" (2-3 sentences, plain prose, what the document is and why it matters),',
  '"sourceKind" (one of: manual_upload, meeting_transcript, repository, email, chat, document, web, other),',
  '"topics" (3-6 short lowercase tags),',
  '"targetBaseId" (the id of the best-fitting existing base, or null if none fits),',
  '"confidence" (0..1 — how sure you are the document belongs in targetBaseId),',
  '"reason" (one sentence explaining the filing choice).',
  "Only pick a targetBaseId from the provided list. If the document fits no base",
  "well, return targetBaseId null and confidence 0. Respond with JSON only.",
].join(" ");

export class OpenAICurationProvider implements DocumentCurator {
  private client: OpenAI | null = null;
  private readonly apiKey: string | undefined;
  private readonly baseURL: string | undefined;
  private readonly defaultHeaders: Record<string, string> | undefined;
  private readonly defaultQuery: Record<string, string> | undefined;
  readonly model: string;

  constructor(args: {
    apiKey?: string | undefined;
    baseURL?: string | undefined;
    defaultHeaders?: Record<string, string> | undefined;
    defaultQuery?: Record<string, string> | undefined;
    model?: string | undefined;
  }) {
    this.apiKey = args.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseURL = args.baseURL;
    this.defaultHeaders = args.defaultHeaders;
    this.defaultQuery = args.defaultQuery;
    this.model = args.model ?? DEFAULT_DOCUMENT_CURATION_MODEL;
  }

  async curate(input: DocumentCurationInput): Promise<DocumentCurationOutcome> {
    const response = await this.openai().chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CURATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            filename: input.filename,
            currentTitle: input.title,
            bases: input.bases,
            text: input.text,
          }),
        },
      ],
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      throw new Error("curation model returned no content");
    }
    return parseCurationOutcome(raw, input.bases);
  }

  private openai(): OpenAI {
    if (!this.apiKey) {
      throw new Error("OpenAI document curation requires an API key");
    }
    this.client ??= new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(this.defaultQuery ? { defaultQuery: this.defaultQuery } : {}),
      ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
    });
    return this.client;
  }
}

/** Parse + clamp model output; a targetBaseId outside the candidate list is dropped. */
export function parseCurationOutcome(
  raw: string,
  bases: DocumentCurationCandidateBase[],
): DocumentCurationOutcome {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("curation model returned non-object JSON");
  }
  const record = parsed as Record<string, unknown>;
  const knownBase = bases.find((base) => base.id === record.targetBaseId);
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : 0;
  return {
    title:
      cleanString(typeof record.title === "string" ? record.title.slice(0, 200) : null) ?? null,
    summary:
      cleanString(typeof record.summary === "string" ? record.summary.slice(0, 2000) : null) ??
      null,
    sourceKind:
      typeof record.sourceKind === "string"
        ? normalizeKnowledgeSourceKind(record.sourceKind)
        : null,
    topics: cleanStringArray(
      Array.isArray(record.topics)
        ? record.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 8)
        : [],
    ).map((topic) => topic.toLowerCase().slice(0, 60)),
    targetBaseId: knownBase?.id ?? null,
    confidence: knownBase ? confidence : 0,
    reason:
      cleanString(typeof record.reason === "string" ? record.reason.slice(0, 500) : null) ?? null,
  };
}

export function createDocumentServices(
  settings?: Settings,
  overrides: Partial<DocumentServices> = {},
): DocumentServices {
  const dimensions = settings?.documentEmbeddingDimensions ?? DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS;
  const openAIEmbeddingConfig = documentOpenAIEmbeddingConfig(settings);
  return {
    parser: overrides.parser ?? new LiteParseDocumentParser(),
    chunker:
      overrides.chunker ??
      new RecursiveTextChunker(
        settings?.documentChunkSize ?? DEFAULT_DOCUMENT_CHUNK_SIZE,
        settings?.documentChunkOverlap ?? DEFAULT_DOCUMENT_CHUNK_OVERLAP,
      ),
    embedder:
      overrides.embedder ??
      (settings?.documentEmbeddingProvider === "deterministic"
        ? new DeterministicEmbeddingProvider(dimensions, settings.documentEmbeddingModel)
        : new OpenAIEmbeddingProvider({
            ...openAIEmbeddingConfig,
            model: settings?.documentEmbeddingModel ?? DEFAULT_DOCUMENT_EMBEDDING_MODEL,
            dimensions,
          })),
    curator: overrides.curator ?? createDocumentCurator(settings),
  };
}

function createDocumentCurator(settings?: Settings): DocumentCurator | undefined {
  const provider = settings?.documentCurationProvider ?? "openai";
  if (provider === "none") return undefined;
  if (provider === "heuristic") return new HeuristicCurationProvider();
  const embeddingConfig = documentOpenAIEmbeddingConfig(settings);
  return new OpenAICurationProvider({
    apiKey: settings?.documentCurationApiKey ?? embeddingConfig.apiKey,
    baseURL: settings?.documentCurationBaseUrl ?? embeddingConfig.baseURL,
    defaultHeaders: embeddingConfig.defaultHeaders,
    defaultQuery: embeddingConfig.defaultQuery,
    model: settings?.documentCurationModel ?? DEFAULT_DOCUMENT_CURATION_MODEL,
  });
}

export function documentOpenAIEmbeddingConfig(settings?: Settings): {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  defaultQuery?: Record<string, string> | undefined;
} {
  if (!settings) return {};
  if (settings.documentEmbeddingApiKey || settings.documentEmbeddingBaseUrl) {
    return {
      apiKey:
        settings.documentEmbeddingApiKey ?? settings.openaiApiKey ?? settings.azureOpenaiApiKey,
      baseURL:
        settings.documentEmbeddingBaseUrl ?? settings.openaiBaseUrl ?? settings.azureOpenaiBaseUrl,
    };
  }
  if (settings.openaiProvider === "azure") {
    const baseURL = settings.azureOpenaiBaseUrl ?? azureDeploymentBaseUrl(settings);
    return {
      apiKey: settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken ?? "azure-ad-token",
      baseURL,
      defaultQuery: azureOpenAIDefaultQuery(settings, baseURL),
      defaultHeaders:
        settings.azureOpenaiAdToken && !settings.azureOpenaiApiKey
          ? { Authorization: `Bearer ${settings.azureOpenaiAdToken}` }
          : undefined,
    };
  }
  return {
    apiKey: settings.openaiApiKey,
    baseURL: settings.openaiBaseUrl,
  };
}

function azureDeploymentBaseUrl(settings: Settings): string {
  const endpoint = settings.azureOpenaiEndpoint?.replace(/\/+$/, "");
  if (!endpoint || !settings.azureOpenaiDeployment) {
    throw new Error("Azure OpenAI endpoint/deployment settings are incomplete");
  }
  return `${endpoint}/openai/deployments/${settings.azureOpenaiDeployment}`;
}

function azureOpenAIDefaultQuery(
  settings: Pick<Settings, "azureOpenaiApiVersion">,
  baseURL: string,
): Record<string, string> | undefined {
  if (!settings.azureOpenaiApiVersion) return undefined;
  const normalized = baseURL.replace(/\/+$/, "").toLowerCase();
  if (normalized.endsWith("/openai/v1")) {
    return undefined;
  }
  return { "api-version": settings.azureOpenaiApiVersion };
}

export async function createDocumentBase(
  db: Database,
  input: CreateDocumentBaseRequest & { accountId: string; workspaceId: string },
): Promise<DocumentBase> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.documentBases)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
        })
        .returning();
      if (!row) throw new Error("Failed to create document base");
      return mapDocumentBase(row);
    },
  );
}

export async function listDocumentBases(
  db: Database,
  workspaceId: string,
): Promise<DocumentBase[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.documentBases)
      .where(eq(schema.documentBases.workspaceId, workspaceId))
      .orderBy(desc(schema.documentBases.createdAt));
    return rows.map(mapDocumentBase);
  });
}

/**
 * Return a bounded structural inventory without loading document records.
 * Document predicates are applied independently to every aggregate so private
 * counts and topic metadata remain scoped to the initiating grant subject.
 */
export async function getDocumentInventory(
  db: Database,
  workspaceId: string,
  input: DocumentInventoryInput,
): Promise<DocumentInventory> {
  const baseLimit = requireDocumentInventoryLimit(
    input.baseLimit,
    DOCUMENT_INVENTORY_MAX_BASE_LIMIT,
    "baseLimit",
  );
  const topicLimit = requireDocumentInventoryLimit(
    input.topicLimit,
    DOCUMENT_INVENTORY_MAX_TOPIC_LIMIT,
    "topicLimit",
  );
  const topicMaxChars = requireDocumentInventoryLimit(
    input.topicMaxChars,
    DOCUMENT_INVENTORY_MAX_TOPIC_CHARS,
    "topicMaxChars",
  );

  return await withDocumentRls(db, workspaceId, input.access, async (scopedDb) => {
    const [baseTotal] = await scopedDb
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.documentBases)
      .where(eq(schema.documentBases.workspaceId, workspaceId));

    const baseJoin = and(
      eq(schema.documents.workspaceId, workspaceId),
      eq(schema.documents.baseId, schema.documentBases.id),
      ...documentAccessConditions(workspaceId, input.access),
    );
    const baseRows = await scopedDb
      .select({
        id: schema.documentBases.id,
        name: schema.documentBases.name,
        visibleDocumentCount: sql<number>`count(${schema.documents.id})::int`,
        queuedCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'queued')::int`,
        indexingCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'indexing')::int`,
        readyCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'ready')::int`,
        failedCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'failed')::int`,
        latestUpdatedAt: sql<Date | null>`max(${schema.documents.updatedAt})`,
      })
      .from(schema.documentBases)
      .leftJoin(schema.documents, baseJoin)
      .where(eq(schema.documentBases.workspaceId, workspaceId))
      .groupBy(schema.documentBases.id, schema.documentBases.name, schema.documentBases.createdAt)
      .orderBy(desc(schema.documentBases.createdAt), asc(schema.documentBases.id))
      .limit(baseLimit);

    const documentWhere = and(
      eq(schema.documents.workspaceId, workspaceId),
      ...documentAccessConditions(workspaceId, input.access),
    );
    const [summary] = await scopedDb
      .select({
        visibleDocumentCount: sql<number>`count(${schema.documents.id})::int`,
        queuedCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'queued')::int`,
        indexingCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'indexing')::int`,
        readyCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'ready')::int`,
        failedCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.status} = 'failed')::int`,
        manualUploadCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'manual_upload')::int`,
        meetingTranscriptCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'meeting_transcript')::int`,
        repositoryCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'repository')::int`,
        emailCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'email')::int`,
        chatCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'chat')::int`,
        documentCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'document')::int`,
        webCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'web')::int`,
        otherCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.sourceKind} = 'other')::int`,
        organizationAuthorityCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.authorityKind} = 'organization')::int`,
        workspaceAuthorityCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.authorityKind} = 'workspace')::int`,
        personalAuthorityCount: sql<number>`count(${schema.documents.id}) filter (where ${schema.documents.authorityKind} = 'personal')::int`,
        latestUpdatedAt: sql<Date | null>`max(${schema.documents.updatedAt})`,
      })
      .from(schema.documents)
      .where(documentWhere);

    const topicStringValue = sql<string>`topic.value #>> '{}'`;
    const topicNormalizedName = sql<string>`btrim(regexp_replace(normalize(${topicStringValue}, NFKC), '[[:space:]]+', ' ', 'g'))`;
    const topicName = sql<string>`left(${topicNormalizedName}, ${topicMaxChars})`;
    const topicDocumentCount = sql<number>`count(distinct ${schema.documents.id})::int`;
    const topicRows = await scopedDb
      .select({ name: topicName, documentCount: topicDocumentCount })
      .from(schema.documents)
      .innerJoin(
        sql`lateral jsonb_array_elements(${schema.documents.topics}) as topic(value)`,
        sql`true`,
      )
      .where(
        and(
          documentWhere,
          sql`jsonb_typeof(topic.value) = 'string'`,
          sql`nullif(${topicNormalizedName}, '') is not null`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`, sql`1 asc`)
      .limit(topicLimit + 1);

    const statusCounts = documentInventoryStatusCounts(summary ?? {});
    const topics = topicRows.slice(0, topicLimit).map((topic) => ({
      name: topic.name,
      documentCount: Number(topic.documentCount),
    }));
    return {
      baseCount: Number(baseTotal?.count ?? 0),
      bases: baseRows.map((base) => ({
        id: base.id,
        name: base.name,
        visibleDocumentCount: Number(base.visibleDocumentCount),
        statusCounts: documentInventoryStatusCounts(base),
        latestUpdatedAt: documentInventoryTimestamp(base.latestUpdatedAt),
      })),
      visibleDocumentCount: Number(summary?.visibleDocumentCount ?? 0),
      statusCounts,
      sourceKindCounts: {
        manual_upload: Number(summary?.manualUploadCount ?? 0),
        meeting_transcript: Number(summary?.meetingTranscriptCount ?? 0),
        repository: Number(summary?.repositoryCount ?? 0),
        email: Number(summary?.emailCount ?? 0),
        chat: Number(summary?.chatCount ?? 0),
        document: Number(summary?.documentCount ?? 0),
        web: Number(summary?.webCount ?? 0),
        other: Number(summary?.otherCount ?? 0),
      },
      authorityKindCounts: {
        organization: Number(summary?.organizationAuthorityCount ?? 0),
        workspace: Number(summary?.workspaceAuthorityCount ?? 0),
        personal: Number(summary?.personalAuthorityCount ?? 0),
      },
      latestUpdatedAt: documentInventoryTimestamp(summary?.latestUpdatedAt ?? null),
      topics,
      topicsTruncated: topicRows.length > topics.length,
    };
  });
}

function requireDocumentInventoryLimit(value: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function documentInventoryStatusCounts(input: {
  queuedCount?: number | null | undefined;
  indexingCount?: number | null | undefined;
  readyCount?: number | null | undefined;
  failedCount?: number | null | undefined;
}): DocumentInventoryStatusCounts {
  return {
    queued: Number(input.queuedCount ?? 0),
    indexing: Number(input.indexingCount ?? 0),
    ready: Number(input.readyCount ?? 0),
    failed: Number(input.failedCount ?? 0),
  };
}

function documentInventoryTimestamp(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getDocumentBase(
  db: Database,
  workspaceId: string,
  baseId: string,
): Promise<DocumentBase | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.documentBases)
      .where(
        and(eq(schema.documentBases.workspaceId, workspaceId), eq(schema.documentBases.id, baseId)),
      )
      .limit(1);
    return row ? mapDocumentBase(row) : null;
  });
}

/**
 * Find-or-create the workspace's internal Default collection — where ordinary
 * uploads can start and knowledge drops land before configured curation files
 * them elsewhere. Matched by name (case-insensitive) so a user-created
 * "Default" is adopted rather than duplicated.
 */
export async function ensureDefaultBase(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<DocumentBase> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const defaultName = sql`lower(btrim(${schema.documentBases.name})) = ${DEFAULT_BASE_NAME.toLowerCase()}`;
        const [existing] = await tx
          .select()
          .from(schema.documentBases)
          .where(and(eq(schema.documentBases.workspaceId, input.workspaceId), defaultName))
          .limit(1);
        if (existing) return mapDocumentBase(existing);

        // The partial unique index is the serialization point for concurrent
        // first uploads. A losing insert re-reads the winner instead of
        // surfacing a duplicate-base error.
        const [inserted] = await tx
          .insert(schema.documentBases)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            name: DEFAULT_BASE_NAME,
            description: DEFAULT_BASE_DESCRIPTION,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) return mapDocumentBase(inserted);

        const [raced] = await tx
          .select()
          .from(schema.documentBases)
          .where(and(eq(schema.documentBases.workspaceId, input.workspaceId), defaultName))
          .limit(1);
        if (raced) return mapDocumentBase(raced);
        throw new Error("Failed to create Default document base");
      }),
  );
}

/**
 * List a workspace's optional document collections after restoring the
 * internal Default collection when it is missing. Keeping the ensure and list
 * in the service layer gives every caller the same migration-free recovery
 * behavior after an old writer, manual repair, or future collection-management
 * path renames or removes Default.
 */
export async function listDocumentBasesEnsuringDefault(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<DocumentBase[]> {
  await ensureDefaultBase(db, input);
  return await listDocumentBases(db, input.workspaceId);
}

export async function addDocumentToBase(
  db: Database,
  input: AddDocumentRequest & {
    accountId: string;
    workspaceId: string;
    baseId: string;
    createdBy?: string | null | undefined;
    initiatingSubjectId?: string | null | undefined;
    organizationAuthorityGranted?: boolean | undefined;
    curationStatus?: DocumentCurationStatus | undefined;
    access?: DocumentAccessFilter | undefined;
  },
): Promise<Document> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const viewerSubjectId = cleanString(input.access?.viewerSubjectId ?? null);
      const authority = resolveDocumentAuthority({
        kind: input.authorityKind,
        legacyVisibility: input.visibility,
        workspaceId: input.workspaceId,
        initiatingSubjectId: input.initiatingSubjectId,
      });
      if (authority.kind === "organization" && input.organizationAuthorityGranted !== true) {
        throw new Error("organization document writes require exact account authority");
      }
      if (
        authority.kind === "personal" &&
        (viewerSubjectId !== authority.subjectId ||
          cleanString(input.createdBy ?? null) !== authority.subjectId)
      ) {
        throw new Error("personal document writes require the exact initiating subject");
      }
      if (viewerSubjectId) await setSubjectRlsContext(scopedDb, viewerSubjectId);
      const base = await getDocumentBase(scopedDb, input.workspaceId, input.baseId);
      if (!base) throw new Error(`Document base not found: ${input.baseId}`);
      const file = await requireReadyFile(scopedDb, input.workspaceId, input.fileId);
      const now = new Date();
      const [existing] = await scopedDb
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.workspaceId, input.workspaceId),
            eq(schema.documents.baseId, input.baseId),
            eq(schema.documents.fileId, input.fileId),
          ),
        )
        .limit(1);
      if (existing) {
        if (!documentMatchesAccess(existing, input.workspaceId, input.access)) {
          throw new Error(`Document not found: ${existing.id}`);
        }
        assertOrganizationDocumentAuthority(
          existing.authorityKind,
          input.organizationAuthorityGranted,
        );
        // Idempotent re-add: refresh caller-supplied source metadata on the
        // existing row instead of silently discarding it (aclTags especially —
        // a re-add that tightens tags must not be a no-op). Access policy is
        // deliberately inherited: re-adding a known file is not an implicit
        // visibility/agent-policy update that another manager can exploit.
        const [updated] = await scopedDb
          .update(schema.documents)
          .set({
            title: cleanString(input.title) ?? cleanString(input.sourceTitle) ?? existing.title,
            ...(input.sourceKind !== undefined ? { sourceKind: input.sourceKind } : {}),
            sourceUri: cleanString(input.sourceUri) ?? existing.sourceUri,
            sourceExternalId: cleanString(input.sourceExternalId) ?? existing.sourceExternalId,
            sourceTitle: cleanString(input.sourceTitle) ?? existing.sourceTitle,
            sourceAuthor: cleanString(input.sourceAuthor) ?? existing.sourceAuthor,
            sourceCreatedAt: parseOptionalDate(input.sourceCreatedAt) ?? existing.sourceCreatedAt,
            sourceUpdatedAt: parseOptionalDate(input.sourceUpdatedAt) ?? existing.sourceUpdatedAt,
            sourceVersion: cleanString(input.sourceVersion) ?? existing.sourceVersion,
            ...(input.aclTags !== undefined ? { aclTags: cleanStringArray(input.aclTags) } : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.documents.workspaceId, input.workspaceId),
              eq(schema.documents.id, existing.id),
              ...documentAccessConditions(input.workspaceId, input.access),
            ),
          )
          .returning();
        return mapDocument(updated ?? existing);
      }
      const [row] = await scopedDb
        .insert(schema.documents)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          baseId: input.baseId,
          fileId: input.fileId,
          status: "queued",
          title: cleanString(input.title) ?? cleanString(input.sourceTitle) ?? file.filename,
          parser: DEFAULT_DOCUMENT_PARSER,
          sourceKind: input.sourceKind ?? "manual_upload",
          sourceUri: cleanString(input.sourceUri) ?? null,
          sourceExternalId: cleanString(input.sourceExternalId) ?? null,
          sourceTitle: cleanString(input.sourceTitle) ?? null,
          sourceAuthor: cleanString(input.sourceAuthor) ?? null,
          sourceCreatedAt: parseOptionalDate(input.sourceCreatedAt),
          sourceUpdatedAt: parseOptionalDate(input.sourceUpdatedAt),
          sourceVersion: cleanString(input.sourceVersion) ?? null,
          aclTags: cleanStringArray(input.aclTags),
          authorityKind: authority.kind,
          authorityWorkspaceId: authority.workspaceId,
          authoritySubjectId: authority.subjectId,
          visibility: authority.kind === "personal" ? "private" : "workspace",
          agentAccess: input.agentAccess ?? true,
          createdBy: input.createdBy ?? null,
          curationStatus: input.curationStatus ?? "none",
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Failed to create document");
      return mapDocument(row);
    },
  );
}

/**
 * Move a document and its indexed chunks to another base. With no explicit
 * target, applies the stored curation suggestion. A 'suggested' or 'pending'
 * document that gets moved counts as filed.
 */
export async function moveDocumentToBase(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    documentId: string;
    targetBaseId?: string | null | undefined;
    organizationAuthorityGranted?: boolean | undefined;
    access?: DocumentAccessFilter | undefined;
  },
): Promise<Document> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const viewerSubjectId = cleanString(input.access?.viewerSubjectId ?? null);
      if (viewerSubjectId) await setSubjectRlsContext(scopedDb, viewerSubjectId);
      const [row] = await scopedDb
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.workspaceId, input.workspaceId),
            eq(schema.documents.id, input.documentId),
            ...documentAccessConditions(input.workspaceId, input.access),
          ),
        )
        .limit(1);
      if (!row) throw new Error(`Document not found: ${input.documentId}`);
      assertOrganizationDocumentAuthority(row.authorityKind, input.organizationAuthorityGranted);
      const suggestion = (row.curation as { suggestedBaseId?: string | null } | null)
        ?.suggestedBaseId;
      const targetBaseId = input.targetBaseId ?? suggestion;
      if (!targetBaseId) {
        throw new Error("document has no suggested base; pass targetBaseId");
      }
      if (targetBaseId === row.baseId) return mapDocument(row);
      const base = await getDocumentBase(scopedDb, input.workspaceId, targetBaseId);
      if (!base) throw new Error(`Document base not found: ${targetBaseId}`);
      const [conflict] = await scopedDb
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.workspaceId, input.workspaceId),
            eq(schema.documents.baseId, targetBaseId),
            eq(schema.documents.fileId, row.fileId),
          ),
        )
        .limit(1);
      if (conflict) {
        throw new Error("a document for this file already exists in the target base");
      }
      const now = new Date();
      const moved = await scopedDb.transaction(async (tx) => {
        const [updated] = await tx
          .update(schema.documents)
          .set({
            baseId: targetBaseId,
            ...(row.curationStatus === "suggested" || row.curationStatus === "pending"
              ? { curationStatus: "auto_filed" }
              : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.documents.workspaceId, input.workspaceId),
              eq(schema.documents.id, input.documentId),
              ...documentAccessConditions(input.workspaceId, input.access),
            ),
          )
          .returning();
        if (updated) {
          await tx
            .update(schema.documentChunks)
            .set({ baseId: targetBaseId })
            .where(
              and(
                eq(schema.documentChunks.workspaceId, input.workspaceId),
                eq(schema.documentChunks.documentId, input.documentId),
              ),
            );
        }
        return updated;
      });
      if (!moved) throw new Error(`Document not found: ${input.documentId}`);
      return mapDocument(moved);
    },
  );
}

export async function deleteDocumentFromBase(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    baseId: string;
    documentId: string;
    organizationAuthorityGranted?: boolean | undefined;
    access?: DocumentAccessFilter | undefined;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const viewerSubjectId = cleanString(input.access?.viewerSubjectId ?? null);
      if (viewerSubjectId) await setSubjectRlsContext(scopedDb, viewerSubjectId);
      const [document] = await scopedDb
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.workspaceId, input.workspaceId),
            eq(schema.documents.id, input.documentId),
            ...documentAccessConditions(input.workspaceId, input.access),
          ),
        )
        .limit(1);
      if (!document) {
        throw new Error(`Document not found: ${input.documentId}`);
      }
      assertOrganizationDocumentAuthority(
        document.authorityKind,
        input.organizationAuthorityGranted,
      );
      if (document.baseId !== input.baseId) {
        throw new Error(`Document not found: ${input.documentId}`);
      }
      await scopedDb
        .delete(schema.documents)
        .where(
          and(
            eq(schema.documents.workspaceId, input.workspaceId),
            eq(schema.documents.id, input.documentId),
            ...documentAccessConditions(input.workspaceId, input.access),
          ),
        );
    },
  );
}

export async function listDocuments(
  db: Database,
  workspaceId: string,
  baseId: string,
  access?: DocumentAccessFilter,
): Promise<Document[]> {
  return await withDocumentRls(db, workspaceId, access, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.workspaceId, workspaceId),
          eq(schema.documents.baseId, baseId),
          ...documentAccessConditions(workspaceId, access),
        ),
      )
      .orderBy(asc(schema.documents.createdAt));
    return rows.map(mapDocument);
  });
}

export async function getDocument(
  db: Database,
  workspaceId: string,
  documentId: string,
  access?: DocumentAccessFilter,
): Promise<Document | null> {
  return await withDocumentRls(db, workspaceId, access, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.workspaceId, workspaceId),
          eq(schema.documents.id, documentId),
          ...documentAccessConditions(workspaceId, access),
        ),
      )
      .limit(1);
    return row ? mapDocument(row) : null;
  });
}

export async function queueDocumentForReindex(
  db: Database,
  workspaceId: string,
  documentId: string,
  access?: DocumentAccessFilter,
  organizationAuthorityGranted?: boolean,
): Promise<Document> {
  return await withDocumentRls(db, workspaceId, access, async (scopedDb) => {
    const [document] = await scopedDb
      .select({ authorityKind: schema.documents.authorityKind })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.workspaceId, workspaceId),
          eq(schema.documents.id, documentId),
          ...documentAccessConditions(workspaceId, access),
        ),
      )
      .limit(1);
    if (!document) throw new Error(`Document not found: ${documentId}`);
    assertOrganizationDocumentAuthority(document.authorityKind, organizationAuthorityGranted);
    const [row] = await scopedDb
      .update(schema.documents)
      .set({
        status: "queued",
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.documents.workspaceId, workspaceId),
          eq(schema.documents.id, documentId),
          ...documentAccessConditions(workspaceId, access),
        ),
      )
      .returning();
    if (!row) throw new Error(`Document not found: ${documentId}`);
    return mapDocument(row);
  });
}

function assertOrganizationDocumentAuthority(
  authorityKind: string,
  organizationAuthorityGranted: boolean | undefined,
): void {
  if (authorityKind === "organization" && organizationAuthorityGranted !== true) {
    throw new Error("organization document mutations require exact account authority");
  }
}

export async function indexDocumentNow(
  db: Database,
  objectStorage: ObjectStorage,
  workspaceId: string,
  documentId: string,
  services: DocumentServices = createDocumentServices(),
  hooks: DocumentIndexHooks = {},
  access?: DocumentAccessFilter,
): Promise<Document> {
  const [loadedDocument] = await withDocumentRls(
    db,
    workspaceId,
    access,
    async (scopedDb) =>
      await scopedDb
        .select()
        .from(schema.documents)
        .where(
          and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId)),
        )
        .limit(1),
  );
  if (!loadedDocument) throw new Error(`Document not found: ${documentId}`);
  let document: DocumentRow = loadedDocument;
  const file = await requireReadyFile(db, workspaceId, document.fileId);
  await withDocumentRls(db, workspaceId, access, async (scopedDb) => {
    await scopedDb
      .update(schema.documents)
      .set({
        status: "indexing",
        parser: services.parser.name,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId)),
      );
  });
  try {
    const bytes = await objectStorage.getFileBytes(file);
    const parsed = await services.parser.parse(bytes, file);
    // Knowledge drops (curationStatus 'pending') are curated between parse and
    // chunking when a provider is enabled, so chunk metadata and base placement
    // reflect the curated truth. Disabled curation leaves caller metadata intact;
    // enabled-provider failures remain fail-soft through the heuristic fallback.
    if (document.curationStatus === "pending") {
      document = await curateDroppedDocument(db, services, document, parsed, file);
    }
    const chunks = services.chunker.chunk(parsed, file);
    await hooks.beforeEmbed?.({
      accountId: document.accountId,
      workspaceId: document.workspaceId,
      documentId,
      chunkCount: chunks.length,
    });
    const embeddings = await services.embedder.embedMany(chunks.map((chunk) => chunk.text));
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding provider returned ${embeddings.length} embeddings for ${chunks.length} chunks`,
      );
    }
    await withDocumentRls(
      db,
      workspaceId,
      access,
      async (scopedDb) =>
        await scopedDb.transaction(async (tx) => {
          await tx
            .delete(schema.documentChunks)
            .where(
              and(
                eq(schema.documentChunks.workspaceId, workspaceId),
                eq(schema.documentChunks.documentId, documentId),
              ),
            );
          if (chunks.length > 0) {
            await tx.insert(schema.documentChunks).values(
              chunks.map((chunk, index) => ({
                accountId: document.accountId,
                workspaceId: document.workspaceId,
                documentId,
                baseId: document.baseId,
                fileId: file.id,
                authorityKind: document.authorityKind,
                authorityWorkspaceId: document.authorityWorkspaceId,
                authoritySubjectId: document.authoritySubjectId,
                chunkIndex: index,
                text: chunk.text,
                metadata: {
                  ...chunk.metadata,
                  documentTitle: document.title,
                  sourceKind: document.sourceKind,
                  sourceUri: document.sourceUri,
                  sourceExternalId: document.sourceExternalId,
                  sourceTitle: document.sourceTitle,
                  sourceAuthor: document.sourceAuthor,
                  sourceCreatedAt: document.sourceCreatedAt?.toISOString() ?? null,
                  sourceUpdatedAt: document.sourceUpdatedAt?.toISOString() ?? null,
                  sourceVersion: document.sourceVersion,
                  aclTags: document.aclTags,
                },
                embedding: validateEmbedding(
                  embeddings[index] ?? [],
                  services.embedder.dimensions,
                  services.embedder.model,
                ),
                embeddingModel: services.embedder.model,
              })),
            );
          }
          await tx
            .update(schema.documents)
            .set({
              status: "ready",
              parser: services.parser.name,
              chunkCount: chunks.length,
              error: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.documents.workspaceId, workspaceId),
                eq(schema.documents.id, documentId),
              ),
            );
        }),
    );
  } catch (error) {
    const [failed] = await withDocumentRls(
      db,
      workspaceId,
      access,
      async (scopedDb) =>
        await scopedDb
          .update(schema.documents)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(
            and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId)),
          )
          .returning(),
    );
    if (!failed) throw error;
    return mapDocument(failed);
  }
  // Internal indexing must be able to return a private document to the caller
  // that created/queued it. Public reads remain fail-closed when no subject is
  // supplied; the creator subject is the document's frozen access principal.
  const updated = await getDocument(db, workspaceId, documentId, {
    viewerSubjectId: document.authoritySubjectId,
  });
  if (!updated) throw new Error(`Document disappeared after indexing: ${documentId}`);
  return updated;
}

type DocumentRow = typeof schema.documents.$inferSelect;

async function curateDroppedDocument(
  db: Database,
  services: DocumentServices,
  document: DocumentRow,
  parsed: ParsedDocument,
  file: FileAsset,
): Promise<DocumentRow> {
  // `none` is an explicit disabled-curation policy. Do not silently replace
  // it with heuristics: indexing still proceeds, but the drop remains an
  // ordinary uncured document with its caller-supplied title and metadata.
  if (!services.curator) {
    const [updated] = await withDocumentRls(
      db,
      document.workspaceId,
      { viewerSubjectId: document.authoritySubjectId },
      async (scopedDb) =>
        await scopedDb
          .update(schema.documents)
          .set({
            curationStatus: "none",
            summary: null,
            topics: [],
            curation: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.documents.workspaceId, document.workspaceId),
              eq(schema.documents.id, document.id),
            ),
          )
          .returning(),
    );
    return updated ?? document;
  }
  const bases = await listDocumentBases(db, document.workspaceId);
  const candidates: DocumentCurationCandidateBase[] = bases
    .filter((base) => base.id !== document.baseId)
    .map((base) => ({ id: base.id, name: base.name, description: base.description }));
  const input: DocumentCurationInput = {
    text: parsed.text.slice(0, DOCUMENT_CURATION_MAX_INPUT_CHARS),
    filename: file.filename,
    title: document.title,
    bases: candidates,
  };
  let outcome: DocumentCurationOutcome;
  let model: string;
  let failure: string | null = null;
  try {
    outcome = await services.curator.curate(input);
    model = services.curator.model;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.warn("document curation failed; applying heuristic fallback", {
      workspaceId: document.workspaceId,
      documentId: document.id,
      error: failure,
    });
    outcome = heuristicCuration(input, file.contentType);
    model = "heuristic";
  }
  const suggestedBase = candidates.find((base) => base.id === outcome.targetBaseId) ?? null;
  let moveToBaseId: string | null = null;
  if (
    suggestedBase &&
    failure === null &&
    outcome.confidence >= DOCUMENT_CURATION_AUTO_FILE_CONFIDENCE
  ) {
    // The (workspace, base, file) unique index means a same-file twin already
    // in the target base blocks the move; keep it as a suggestion instead.
    const conflict = await withDocumentRls(
      db,
      document.workspaceId,
      { viewerSubjectId: document.authoritySubjectId },
      async (scopedDb) =>
        await scopedDb
          .select({ id: schema.documents.id })
          .from(schema.documents)
          .where(
            and(
              eq(schema.documents.workspaceId, document.workspaceId),
              eq(schema.documents.baseId, suggestedBase.id),
              eq(schema.documents.fileId, document.fileId),
            ),
          )
          .limit(1),
    );
    if (conflict.length === 0) {
      moveToBaseId = suggestedBase.id;
    }
  }
  const curation: DocumentCuration = {
    suggestedBaseId: suggestedBase?.id ?? null,
    suggestedBaseName: suggestedBase?.name ?? null,
    confidence: outcome.confidence,
    reason: failure ? `curation failed (${failure}); heuristic fallback applied` : outcome.reason,
    originalTitle: document.title,
    model,
  };
  const curationStatus: DocumentCurationStatus = failure
    ? "failed"
    : moveToBaseId
      ? "auto_filed"
      : "suggested";
  const [updated] = await withDocumentRls(
    db,
    document.workspaceId,
    { viewerSubjectId: document.authoritySubjectId },
    async (scopedDb) =>
      await scopedDb
        .update(schema.documents)
        .set({
          title: outcome.title ?? document.title,
          summary: outcome.summary,
          topics: outcome.topics,
          ...(outcome.sourceKind ? { sourceKind: outcome.sourceKind } : {}),
          ...(moveToBaseId ? { baseId: moveToBaseId } : {}),
          curationStatus,
          curation,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.documents.workspaceId, document.workspaceId),
            eq(schema.documents.id, document.id),
          ),
        )
        .returning(),
  );
  return updated ?? document;
}

export async function searchDocuments(
  db: Database,
  input: DocumentSearchInput,
  services: Pick<DocumentServices, "embedder"> = createDocumentServices(),
): Promise<DocumentSearchResult[]> {
  await assertDocumentAccountWorkspace(db, input.accountId, input.workspaceId);
  const mode = input.mode ?? "hybrid";
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 50);
  const candidateLimit = mode === "hybrid" ? Math.min(limit * 4, 100) : limit;
  const rows: CombinedSearchRow[] = [];
  if (mode === "vector" || mode === "hybrid") {
    try {
      rows.push(...(await vectorSearchDocuments(db, input, candidateLimit, services)));
    } catch (error) {
      if (mode === "vector") {
        throw error;
      }
      console.warn(
        "document hybrid search vector component failed; falling back to keyword search",
        {
          workspaceId: input.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  if (mode === "keyword" || mode === "hybrid") {
    rows.push(...(await keywordSearchDocuments(db, input, candidateLimit)));
  }
  return mergeDocumentSearchRows(rows, mode).slice(0, limit);
}

/**
 * Canonical effective retrieval composition for API, SDK, and MCP surfaces.
 * Callers supply the already-authorized immutable initiating subject; no
 * request/tool input can replace it with another user's personal authority.
 */
export async function searchEffectiveDocuments(
  db: Database,
  input: EffectiveDocumentSearchInput,
  services: Pick<DocumentServices, "embedder"> = createDocumentServices(),
): Promise<DocumentSearchResult[]> {
  const initiatingSubjectId = cleanString(input.initiatingSubjectId);
  if (!initiatingSubjectId) {
    throw new Error("effective document retrieval requires an initiating subject");
  }
  return await searchDocuments(
    db,
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      query: input.query,
      baseIds: input.baseIds,
      limit: input.limit,
      mode: input.mode,
      sourceKinds: input.sourceKinds,
      aclTags: input.aclTags,
      // Construct the lower-level access filter here instead of spreading the
      // caller input, so an untyped/legacy access override is always ignored.
      access: {
        viewerSubjectId: initiatingSubjectId,
        ...(input.surface === "agent" ? { agentOnly: true } : {}),
      },
    },
    services,
  );
}

async function vectorSearchDocuments(
  db: Database,
  input: DocumentSearchInput,
  limit: number,
  services: Pick<DocumentServices, "embedder">,
): Promise<CombinedSearchRow[]> {
  const queryEmbedding = await services.embedder.embedQuery(input.query);
  validateEmbedding(queryEmbedding, services.embedder.dimensions, services.embedder.model);
  const distance = sql<number>`${schema.documentChunks.embedding} <=> ${vectorLiteral(queryEmbedding)}::vector`;
  const rows = await withDocumentAccountRls(
    db,
    input.accountId,
    input.workspaceId,
    input.access,
    async (scopedDb) =>
      await scopedDb
        .select({
          chunkId: schema.documentChunks.id,
          workspaceId: schema.documentChunks.workspaceId,
          documentId: schema.documentChunks.documentId,
          baseId: schema.documentChunks.baseId,
          fileId: schema.documentChunks.fileId,
          title: schema.documents.title,
          text: schema.documentChunks.text,
          chunkIndex: schema.documentChunks.chunkIndex,
          metadata: schema.documentChunks.metadata,
          sourceKind: schema.documents.sourceKind,
          sourceUri: schema.documents.sourceUri,
          sourceExternalId: schema.documents.sourceExternalId,
          sourceTitle: schema.documents.sourceTitle,
          sourceAuthor: schema.documents.sourceAuthor,
          sourceCreatedAt: schema.documents.sourceCreatedAt,
          sourceUpdatedAt: schema.documents.sourceUpdatedAt,
          sourceVersion: schema.documents.sourceVersion,
          aclTags: schema.documents.aclTags,
          authorityKind: schema.documents.authorityKind,
          authorityWorkspaceId: schema.documents.authorityWorkspaceId,
          authoritySubjectId: schema.documents.authoritySubjectId,
          distance,
        })
        .from(schema.documentChunks)
        .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
        .where(and(...documentSearchConditions(input, services.embedder.model)))
        .orderBy(distance)
        .limit(limit),
  );
  return rows.map((row) => ({
    ...mapSearchRowBase(row),
    vectorScore: 1 / (1 + Number(row.distance)),
    keywordScore: null,
  }));
}

async function keywordSearchDocuments(
  db: Database,
  input: DocumentSearchInput,
  limit: number,
): Promise<CombinedSearchRow[]> {
  const rank = sql<number>`ts_rank_cd(to_tsvector('simple', ${schema.documentChunks.text}), plainto_tsquery('simple', ${input.query}))`;
  const rows = await withDocumentAccountRls(
    db,
    input.accountId,
    input.workspaceId,
    input.access,
    async (scopedDb) =>
      await scopedDb
        .select({
          chunkId: schema.documentChunks.id,
          workspaceId: schema.documentChunks.workspaceId,
          documentId: schema.documentChunks.documentId,
          baseId: schema.documentChunks.baseId,
          fileId: schema.documentChunks.fileId,
          title: schema.documents.title,
          text: schema.documentChunks.text,
          chunkIndex: schema.documentChunks.chunkIndex,
          metadata: schema.documentChunks.metadata,
          sourceKind: schema.documents.sourceKind,
          sourceUri: schema.documents.sourceUri,
          sourceExternalId: schema.documents.sourceExternalId,
          sourceTitle: schema.documents.sourceTitle,
          sourceAuthor: schema.documents.sourceAuthor,
          sourceCreatedAt: schema.documents.sourceCreatedAt,
          sourceUpdatedAt: schema.documents.sourceUpdatedAt,
          sourceVersion: schema.documents.sourceVersion,
          aclTags: schema.documents.aclTags,
          authorityKind: schema.documents.authorityKind,
          authorityWorkspaceId: schema.documents.authorityWorkspaceId,
          authoritySubjectId: schema.documents.authoritySubjectId,
          rank,
        })
        .from(schema.documentChunks)
        .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
        .where(
          and(
            ...documentSearchConditions(input),
            sql`to_tsvector('simple', ${schema.documentChunks.text}) @@ plainto_tsquery('simple', ${input.query})`,
          ),
        )
        .orderBy(desc(rank))
        .limit(limit),
  );
  return rows.map((row) => ({
    ...mapSearchRowBase(row),
    vectorScore: null,
    keywordScore: normalizeKeywordScore(Number(row.rank)),
  }));
}

export async function getDocumentChunk(
  db: Database,
  accountId: string,
  workspaceId: string,
  chunkId: string,
  access?: DocumentAccessFilter,
): Promise<DocumentSearchResult | null> {
  const [row] = await withDocumentAccountRls(
    db,
    accountId,
    workspaceId,
    access,
    async (scopedDb) =>
      await scopedDb
        .select({
          chunkId: schema.documentChunks.id,
          workspaceId: schema.documentChunks.workspaceId,
          documentId: schema.documentChunks.documentId,
          baseId: schema.documentChunks.baseId,
          fileId: schema.documentChunks.fileId,
          title: schema.documents.title,
          text: schema.documentChunks.text,
          chunkIndex: schema.documentChunks.chunkIndex,
          metadata: schema.documentChunks.metadata,
          sourceKind: schema.documents.sourceKind,
          sourceUri: schema.documents.sourceUri,
          sourceExternalId: schema.documents.sourceExternalId,
          sourceTitle: schema.documents.sourceTitle,
          sourceAuthor: schema.documents.sourceAuthor,
          sourceCreatedAt: schema.documents.sourceCreatedAt,
          sourceUpdatedAt: schema.documents.sourceUpdatedAt,
          sourceVersion: schema.documents.sourceVersion,
          aclTags: schema.documents.aclTags,
          authorityKind: schema.documents.authorityKind,
          authorityWorkspaceId: schema.documents.authorityWorkspaceId,
          authoritySubjectId: schema.documents.authoritySubjectId,
        })
        .from(schema.documentChunks)
        .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
        .where(
          and(
            eq(schema.documents.accountId, accountId),
            eq(schema.documentChunks.accountId, accountId),
            eq(schema.documentChunks.id, chunkId),
            eq(schema.documents.status, "ready"),
            ...documentAccessConditions(workspaceId, access),
          ),
        )
        .limit(1),
  );
  if (!row) return null;
  return {
    ...mapSearchRowBase(row),
    score: 1,
    matchType: "hybrid",
    vectorScore: null,
    keywordScore: null,
  };
}

type SearchRowBase = Omit<
  DocumentSearchResult,
  "score" | "matchType" | "vectorScore" | "keywordScore"
>;
type CombinedSearchRow = SearchRowBase & {
  vectorScore: number | null;
  keywordScore: number | null;
};

export function resolveDocumentAuthority(input: {
  kind?: DocumentAuthorityKind | undefined;
  legacyVisibility?: DocumentVisibility | undefined;
  workspaceId: string;
  initiatingSubjectId?: string | null | undefined;
}): DocumentAuthority {
  const legacyKind = input.legacyVisibility === "private" ? "personal" : "workspace";
  const kind = input.kind ?? legacyKind;
  if (
    input.kind &&
    input.legacyVisibility &&
    (input.legacyVisibility === "private") !== (input.kind === "personal")
  ) {
    throw new Error("document authorityKind conflicts with legacy visibility");
  }
  if (kind === "organization") {
    return { kind, workspaceId: null, subjectId: null };
  }
  if (kind === "workspace") {
    return { kind, workspaceId: input.workspaceId, subjectId: null };
  }
  const subjectId = cleanString(input.initiatingSubjectId ?? null);
  if (!subjectId) throw new Error("personal documents require an initiating subject");
  if (new TextEncoder().encode(subjectId).byteLength > DOCUMENT_AUTHORITY_SUBJECT_MAX_BYTES) {
    throw new Error(
      `personal document initiating subject exceeds ${DOCUMENT_AUTHORITY_SUBJECT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return { kind, workspaceId: input.workspaceId, subjectId };
}

async function withDocumentRls<T>(
  db: Database,
  workspaceId: string,
  access: DocumentAccessFilter | undefined,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const subjectId = cleanString(access?.viewerSubjectId ?? null);
  return subjectId
    ? await withWorkspaceSubjectRls(db, workspaceId, subjectId, fn)
    : await withWorkspaceRls(db, workspaceId, fn);
}

async function withDocumentAccountRls<T>(
  db: Database,
  accountId: string,
  workspaceId: string,
  access: DocumentAccessFilter | undefined,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const context = await assertDocumentAccountWorkspace(db, accountId, workspaceId);
  const subjectId = cleanString(access?.viewerSubjectId ?? null);
  return await withRlsContext(db, context, async (scopedDb) => {
    if (subjectId) await setSubjectRlsContext(scopedDb, subjectId);
    return await fn(scopedDb);
  });
}

async function assertDocumentAccountWorkspace(
  db: Database,
  accountId: string,
  workspaceId: string,
) {
  const context = await rlsContextForWorkspace(db, workspaceId);
  if (context.accountId !== accountId) {
    throw new Error("document account/workspace authority mismatch");
  }
  return context;
}

/**
 * Visibility/agent scoping shared by every document read path. Fail-closed:
 * with no filter supplied, private documents are invisible.
 */
function documentAccessConditions(
  workspaceId: string,
  access: DocumentAccessFilter | undefined,
): SQL[] {
  const organization = eq(schema.documents.authorityKind, "organization");
  const workspace = and(
    eq(schema.documents.authorityKind, "workspace"),
    eq(schema.documents.authorityWorkspaceId, workspaceId),
  );
  const viewer = cleanString(access?.viewerSubjectId ?? null);
  const personal = viewer
    ? and(
        eq(schema.documents.authorityKind, "personal"),
        eq(schema.documents.authorityWorkspaceId, workspaceId),
        eq(schema.documents.authoritySubjectId, viewer),
      )
    : undefined;
  const authority = viewer
    ? (or(organization, workspace, personal) ?? organization)
    : (or(organization, workspace) ?? organization);
  if (access?.agentOnly) {
    return [eq(schema.documents.agentAccess, true), authority];
  }
  return [authority];
}

function documentMatchesAccess(
  document: Pick<
    DocumentAccessRecord,
    "authorityKind" | "authorityWorkspaceId" | "authoritySubjectId" | "agentAccess"
  >,
  workspaceId: string,
  access: DocumentAccessFilter | undefined,
): boolean {
  if (access?.agentOnly) {
    return document.agentAccess && canViewDocument(document, access.viewerSubjectId, workspaceId);
  }
  return canViewDocument(document, access?.viewerSubjectId, workspaceId);
}

function canonicalDocumentAuthoritySubject(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const subjectId = cleanString(value);
  if (!subjectId || subjectId !== value) return undefined;
  if (new TextEncoder().encode(subjectId).byteLength > DOCUMENT_AUTHORITY_SUBJECT_MAX_BYTES) {
    return undefined;
  }
  return subjectId;
}

/**
 * Whether a single already-fetched document is readable in this workspace.
 *
 * Keep this compatibility predicate as strict as SQL/RLS: personal authority
 * remains anchored to its originating workspace, and unknown or incomplete
 * authority tuples deny instead of falling through as workspace-visible.
 */
export function canViewDocument(
  document: Pick<DocumentAccessRecord, "authorityKind" | "authoritySubjectId"> & {
    authorityWorkspaceId?: string | null | undefined;
  },
  viewerSubjectId: string | null | undefined,
  workspaceId?: string | null | undefined,
): boolean {
  if (document.authorityKind === "organization") {
    return document.authorityWorkspaceId === null && document.authoritySubjectId === null;
  }
  const normalizedWorkspaceId = cleanString(workspaceId ?? null);
  if (!normalizedWorkspaceId || document.authorityWorkspaceId !== normalizedWorkspaceId) {
    return false;
  }
  if (document.authorityKind === "workspace") {
    return document.authoritySubjectId === null;
  }
  if (document.authorityKind === "personal") {
    const authoritySubjectId = canonicalDocumentAuthoritySubject(document.authoritySubjectId);
    const viewer = canonicalDocumentAuthoritySubject(viewerSubjectId);
    return !!authoritySubjectId && authoritySubjectId === viewer;
  }
  return false;
}

type DocumentAccessRecord = {
  authorityKind: string;
  authorityWorkspaceId: string | null;
  authoritySubjectId: string | null;
  agentAccess: boolean;
};

function documentSearchConditions(input: DocumentSearchInput, embeddingModel?: string): SQL[] {
  const conditions: SQL[] = [
    eq(schema.documents.status, "ready"),
    eq(schema.documents.accountId, input.accountId),
    eq(schema.documentChunks.accountId, input.accountId),
    ...documentAccessConditions(input.workspaceId, input.access),
  ];
  if (embeddingModel) {
    conditions.push(eq(schema.documentChunks.embeddingModel, embeddingModel));
  }
  if (input.baseIds?.length) {
    conditions.push(inArray(schema.documentChunks.baseId, input.baseIds));
  }
  if (input.sourceKinds?.length) {
    conditions.push(inArray(schema.documents.sourceKind, input.sourceKinds));
  }
  const aclTags = cleanStringArray(input.aclTags);
  if (aclTags.length > 0) {
    conditions.push(sql`${schema.documents.aclTags} @> ${JSON.stringify(aclTags)}::jsonb`);
  }
  return conditions;
}

function mapSearchRowBase(row: {
  chunkId: string;
  workspaceId: string;
  documentId: string;
  baseId: string;
  fileId: string;
  title: string;
  text: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
  sourceKind: string;
  sourceUri: string | null;
  sourceExternalId: string | null;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
  sourceVersion: string | null;
  aclTags: string[];
  authorityKind: string;
  authorityWorkspaceId: string | null;
  authoritySubjectId: string | null;
}): SearchRowBase {
  return {
    chunkId: row.chunkId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    baseId: row.baseId,
    fileId: row.fileId,
    title: row.title,
    text: row.text,
    chunkIndex: row.chunkIndex,
    metadata: row.metadata,
    sourceKind: normalizeKnowledgeSourceKind(row.sourceKind),
    sourceUri: row.sourceUri,
    sourceExternalId: row.sourceExternalId,
    sourceTitle: row.sourceTitle,
    sourceAuthor: row.sourceAuthor,
    sourceCreatedAt: row.sourceCreatedAt?.toISOString() ?? null,
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
    sourceVersion: row.sourceVersion,
    aclTags: cleanStringArray(row.aclTags),
    authorityKind: normalizeDocumentAuthorityKind(row.authorityKind),
    authorityWorkspaceId: row.authorityWorkspaceId,
    authoritySubjectId: row.authoritySubjectId,
  };
}

function mergeDocumentSearchRows(
  rows: CombinedSearchRow[],
  mode: DocumentSearchMode,
): DocumentSearchResult[] {
  const byChunk = new Map<string, CombinedSearchRow>();
  for (const row of rows) {
    const existing = byChunk.get(row.chunkId);
    if (!existing) {
      byChunk.set(row.chunkId, row);
      continue;
    }
    byChunk.set(row.chunkId, {
      ...existing,
      vectorScore: Math.max(existing.vectorScore ?? 0, row.vectorScore ?? 0) || null,
      keywordScore: Math.max(existing.keywordScore ?? 0, row.keywordScore ?? 0) || null,
    });
  }
  return [...byChunk.values()]
    .map((row) => {
      const vectorScore = row.vectorScore;
      const keywordScore = row.keywordScore;
      const matchType: DocumentSearchMode =
        vectorScore !== null && keywordScore !== null
          ? "hybrid"
          : vectorScore !== null
            ? "vector"
            : "keyword";
      return {
        ...row,
        score: combinedSearchScore(mode, vectorScore, keywordScore, matchType),
        matchType,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.vectorScore ?? 0) - (left.vectorScore ?? 0) ||
        (right.keywordScore ?? 0) - (left.keywordScore ?? 0) ||
        left.chunkIndex - right.chunkIndex,
    );
}

function combinedSearchScore(
  mode: DocumentSearchMode,
  vectorScore: number | null,
  keywordScore: number | null,
  matchType: DocumentSearchMode,
): number {
  const vector = vectorScore ?? 0;
  const keyword = keywordScore ?? 0;
  if (mode === "vector") return roundScore(vector);
  if (mode === "keyword") return roundScore(keyword);
  return roundScore(
    Math.min(1, 0.65 * vector + 0.35 * keyword + (matchType === "hybrid" ? 0.1 : 0)),
  );
}

function normalizeKeywordScore(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  return rank / (rank + 1);
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

export async function parseDocumentBytes(
  bytes: Uint8Array,
  file: FileAsset,
  parser: DocumentParser = new LiteParseDocumentParser(),
): Promise<ParsedDocument> {
  return await parser.parse(bytes, file);
}

export function chunkText(
  text: string,
  maxChars = DEFAULT_DOCUMENT_CHUNK_SIZE,
  overlapChars = DEFAULT_DOCUMENT_CHUNK_OVERLAP,
): string[] {
  if (overlapChars >= maxChars) {
    throw new Error("chunk overlap must be smaller than chunk size");
  }
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalized.replace(/\s+/g, " ")]) {
    for (const part of splitOversizedText(paragraph, maxChars)) {
      if (!current) {
        current = part;
      } else if (current.length + 1 + part.length <= maxChars) {
        current = `${current} ${part}`;
      } else {
        chunks.push(current);
        current = withOverlap(current, overlapChars, part, maxChars);
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

export function deterministicEmbedding(
  text: string,
  dimensions = DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
): number[] {
  const values = new Array(dimensions).fill(0);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (const char of token) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    values[Math.abs(hash) % dimensions] += 1;
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => Number((value / norm).toFixed(6)));
}

async function requireReadyFile(
  db: Database,
  workspaceId: string,
  fileId: string,
): Promise<FileAsset> {
  const file = await requireFile(db, workspaceId, fileId);
  if (file.status !== "ready") {
    throw new Error(`File ${fileId} is ${file.status}`);
  }
  return file;
}

function validateEmbedding(values: number[], dimensions: number, model: string): number[] {
  if (values.length !== dimensions) {
    throw new Error(
      `Embedding model ${model} returned ${values.length} dimensions; expected ${dimensions}`,
    );
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding model ${model} returned non-finite values`);
  }
  return values;
}

function isTextLike(file: FileAsset): boolean {
  const contentType = file.contentType.toLowerCase();
  const filename = file.filename.toLowerCase();
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/x-yaml" ||
    filename.endsWith(".md") ||
    filename.endsWith(".markdown") ||
    filename.endsWith(".json") ||
    filename.endsWith(".yaml") ||
    filename.endsWith(".yml") ||
    filename.endsWith(".csv") ||
    filename.endsWith(".tsv") ||
    filename.endsWith(".xml")
  );
}

function splitOversizedText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const breakAt = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
      window.lastIndexOf("; "),
      window.lastIndexOf(", "),
      window.lastIndexOf(" "),
    );
    const end = breakAt > Math.floor(maxChars * 0.5) ? breakAt + 1 : maxChars;
    out.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

function withOverlap(
  previous: string,
  overlapChars: number,
  next: string,
  maxChars: number,
): string {
  if (overlapChars <= 0) return next;
  const overlap = previous
    .slice(Math.max(0, previous.length - overlapChars))
    .replace(/^\S+\s+/, "")
    .trim();
  const candidate = overlap ? `${overlap} ${next}` : next;
  return candidate.length <= maxChars ? candidate : next;
}

function cleanString(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function cleanStringArray(values: string[] | undefined | null): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function parseOptionalDate(value: string | undefined): Date | null {
  const trimmed = cleanString(value);
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid source timestamp: ${trimmed}`);
  }
  return date;
}

function normalizeKnowledgeSourceKind(value: string): KnowledgeSourceKind {
  switch (value) {
    case "manual_upload":
    case "meeting_transcript":
    case "repository":
    case "email":
    case "chat":
    case "document":
    case "web":
    case "other":
      return value;
    default:
      return "other";
  }
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function mapDocumentBase(row: typeof schema.documentBases.$inferSelect): DocumentBase {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapDocument(row: typeof schema.documents.$inferSelect): Document {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    baseId: row.baseId,
    fileId: row.fileId,
    status: row.status as Document["status"],
    title: row.title,
    parser: row.parser,
    chunkCount: row.chunkCount,
    error: row.error,
    sourceKind: normalizeKnowledgeSourceKind(row.sourceKind),
    sourceUri: row.sourceUri,
    sourceExternalId: row.sourceExternalId,
    sourceTitle: row.sourceTitle,
    sourceAuthor: row.sourceAuthor,
    sourceCreatedAt: row.sourceCreatedAt?.toISOString() ?? null,
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
    sourceVersion: row.sourceVersion,
    aclTags: cleanStringArray(row.aclTags),
    authorityKind: normalizeDocumentAuthorityKind(row.authorityKind),
    authorityWorkspaceId: row.authorityWorkspaceId,
    authoritySubjectId: row.authoritySubjectId,
    visibility: normalizeDocumentVisibility(row.visibility),
    createdBy: row.createdBy,
    agentAccess: row.agentAccess,
    summary: row.summary,
    topics: cleanStringArray(row.topics),
    curationStatus: normalizeDocumentCurationStatus(row.curationStatus),
    curation: (row.curation as DocumentCuration | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeDocumentAuthorityKind(value: string): DocumentAuthorityKind {
  switch (value) {
    case "organization":
    case "personal":
      return value;
    default:
      return "workspace";
  }
}

function normalizeDocumentVisibility(value: string): DocumentVisibility {
  return value === "private" ? "private" : "workspace";
}

function normalizeDocumentCurationStatus(value: string): DocumentCurationStatus {
  switch (value) {
    case "pending":
    case "suggested":
    case "auto_filed":
    case "failed":
      return value;
    default:
      return "none";
  }
}
