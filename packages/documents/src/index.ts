import type { Settings } from "@opengeni/config";
import {
  KnowledgeProviderCitation,
  type KnowledgeProviderCitation as KnowledgeProviderCitationValue,
  type AddDocumentRequest,
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
  IndexedDocumentSummary,
  KnowledgeBrowseResponse,
  KnowledgeRecord,
  KnowledgeSearchResponse,
  KnowledgeSourceKind,
  ListIndexedDocumentsResponse,
} from "@opengeni/contracts";
import {
  createPersonalDocumentAuthority,
  getFilesForSubject,
  rlsContextForWorkspace,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type OpenAI from "openai";
import { KNOWLEDGE_BROWSE_CURSOR_MAX_CHARS } from "@opengeni/contracts";
import { projectKnowledgeRecord } from "./knowledge-projection";

export { projectKnowledgeRecord } from "./knowledge-projection";

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
export const DOCUMENT_INDEX_CHECKPOINT_MAX_CHARS = 1_024;
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
  /** Exact attempt whose grant snapshot must be revalidated in the content query. */
  authorizedPersonalAttempt?:
    | {
        accountId: string;
        workspaceId: string;
        sessionId: string;
        attemptId: string;
      }
    | undefined;
};

export type DocumentAuthority = {
  kind: DocumentAuthorityKind;
  workspaceId: string | null;
  subjectId: string | null;
};

export type AgentDocumentAuthorityContext = {
  sessionId: string;
  attemptId: string;
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
  agentAuthority?: AgentDocumentAuthorityContext | undefined;
};

export type ListEffectiveIndexedDocumentsInput = {
  accountId: string;
  workspaceId: string;
  /** Immutable human subject accepted for the logical request/turn. */
  initiatingSubjectId: string;
  checkpoint?: string | undefined;
  limit?: number | undefined;
  agentAuthority?: AgentDocumentAuthorityContext | undefined;
};

export type EffectiveKnowledgeBrowseInput = {
  accountId: string;
  workspaceId: string;
  /** Immutable human subject accepted for the logical request/turn. */
  initiatingSubjectId: string;
  /** Omit to browse top-level documents; pass a document record id for chunks. */
  parentId?: string | undefined;
  topic?: string | undefined;
  sourceKinds?: KnowledgeSourceKind[] | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  agentAuthority?: AgentDocumentAuthorityContext | undefined;
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
      const { LiteParse } = await import("@llamaindex/liteparse");
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
  private clientPromise: Promise<OpenAI> | null = null;
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
      const response = await (
        await this.openai()
      ).embeddings.create({
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

  private async openai(): Promise<OpenAI> {
    if (!this.apiKey) {
      throw new Error("OpenAI document embeddings require an API key");
    }
    this.clientPromise ??= import("openai").then(
      ({ default: OpenAIClient }) =>
        new OpenAIClient({
          apiKey: this.apiKey,
          ...(this.baseURL ? { baseURL: this.baseURL } : {}),
          ...(this.defaultQuery ? { defaultQuery: this.defaultQuery } : {}),
          ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
        }),
    );
    return await this.clientPromise;
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
  private clientPromise: Promise<OpenAI> | null = null;
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
    const response = await (
      await this.openai()
    ).chat.completions.create({
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

  private async openai(): Promise<OpenAI> {
    if (!this.apiKey) {
      throw new Error("OpenAI document curation requires an API key");
    }
    this.clientPromise ??= import("openai").then(
      ({ default: OpenAIClient }) =>
        new OpenAIClient({
          apiKey: this.apiKey,
          ...(this.baseURL ? { baseURL: this.baseURL } : {}),
          ...(this.defaultQuery ? { defaultQuery: this.defaultQuery } : {}),
          ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
        }),
    );
    return await this.clientPromise;
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
    knowledgeSourceIdentity?: string | null | undefined;
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
      const initiatingSubjectId = cleanString(input.initiatingSubjectId ?? null);
      const createdBy = cleanString(input.createdBy ?? null);
      if (initiatingSubjectId && createdBy && initiatingSubjectId !== createdBy) {
        throw new Error("document file authority must match the exact initiating subject");
      }
      const fileAuthoritySubjectId = initiatingSubjectId ?? createdBy ?? null;
      const file = await requireReadyFile(scopedDb, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: fileAuthoritySubjectId,
        fileId: input.fileId,
      });
      const knowledgeSourceIdentity = cleanString(input.knowledgeSourceIdentity ?? null);
      if (knowledgeSourceIdentity && knowledgeSourceIdentity.length > 512) {
        throw new Error("knowledge source document identity exceeds 512 characters");
      }
      const now = new Date();
      const [existing] = await scopedDb
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.workspaceId, input.workspaceId),
            ...(knowledgeSourceIdentity
              ? [eq(schema.documents.knowledgeSourceIdentity, knowledgeSourceIdentity)]
              : [
                  eq(schema.documents.baseId, input.baseId),
                  eq(schema.documents.fileId, input.fileId),
                ]),
          ),
        )
        .limit(1);
      if (existing) {
        if (knowledgeSourceIdentity && existing.fileId !== input.fileId) {
          throw new Error("knowledge source document identity is bound to different content");
        }
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
      const documentId = randomUUID();
      const row = await scopedDb.transaction(async (tx) => {
        const userAuthority =
          authority.kind === "personal"
            ? await createPersonalDocumentAuthority(tx, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                subjectId: authority.subjectId!,
                documentId,
              })
            : null;
        const [inserted] = await tx
          .insert(schema.documents)
          .values({
            id: documentId,
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
            knowledgeSourceIdentity,
            aclTags: cleanStringArray(input.aclTags),
            authorityKind: authority.kind,
            authorityWorkspaceId: userAuthority ? null : authority.workspaceId,
            authoritySubjectId: authority.subjectId,
            authorityId: userAuthority?.authorityId ?? null,
            ownerOrganizationMembershipId: userAuthority?.ownerOrganizationMembershipId ?? null,
            originWorkspaceId: input.workspaceId,
            visibility: authority.kind === "personal" ? "private" : "workspace",
            agentAccess: input.agentAccess ?? true,
            createdBy: fileAuthoritySubjectId,
            curationStatus: input.curationStatus ?? "none",
            updatedAt: now,
          })
          .returning();
        return inserted;
      });
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
            ...(row.knowledgeSourceIdentity
              ? [eq(schema.documents.knowledgeSourceIdentity, row.knowledgeSourceIdentity)]
              : [eq(schema.documents.fileId, row.fileId)]),
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

/**
 * List newly ready documents in the same effective scope used by agent
 * retrieval. The opaque checkpoint is bound to the account, requesting
 * workspace, and immutable initiating subject, so it cannot be reused across
 * scheduled-task authority boundaries.
 */
export async function listEffectiveIndexedDocuments(
  db: Database,
  input: ListEffectiveIndexedDocumentsInput,
): Promise<ListIndexedDocumentsResponse> {
  const initiatingSubjectId = canonicalEffectiveDocumentSubject(input.initiatingSubjectId);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("indexed document list limit must be between 1 and 100");
  }
  const afterSequence = input.checkpoint
    ? decodeDocumentIndexCheckpoint(input.checkpoint, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        initiatingSubjectId,
      })
    : 0n;
  const access = await resolveEffectiveDocumentAccess(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId,
    surface: "agent",
    agentAuthority: input.agentAuthority,
  });
  const rows = await withDocumentAccountRls(
    db,
    input.accountId,
    input.workspaceId,
    access,
    async (scopedDb) =>
      await scopedDb
        .select()
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.accountId, input.accountId),
            eq(schema.documents.status, "ready"),
            isNotNull(schema.documents.indexSequence),
            gt(schema.documents.indexSequence, afterSequence),
            ...documentAccessConditions(input.workspaceId, access),
          ),
        )
        .orderBy(asc(schema.documents.indexSequence))
        .limit(limit + 1),
  );
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const nextSequence = pageRows.at(-1)?.indexSequence ?? afterSequence;
  if (nextSequence === null) {
    throw new Error("ready document is missing its index sequence");
  }
  return {
    documents: pageRows.map(mapIndexedDocumentSummary),
    nextCheckpoint: encodeDocumentIndexCheckpoint({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      initiatingSubjectId,
      sequence: nextSequence,
    }),
    hasMore,
  };
}

export function encodeDocumentIndexCheckpoint(input: {
  accountId: string;
  workspaceId: string;
  initiatingSubjectId: string;
  sequence: bigint;
}): string {
  if (input.sequence < 0n) throw new Error("document index checkpoint sequence is invalid");
  return Buffer.from(
    JSON.stringify({
      v: 1,
      s: documentIndexCheckpointScope(input),
      q: input.sequence.toString(),
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeDocumentIndexCheckpoint(
  value: string,
  scope: { accountId: string; workspaceId: string; initiatingSubjectId: string },
): bigint {
  try {
    if (!value || value.length > DOCUMENT_INDEX_CHECKPOINT_MAX_CHARS) {
      throw new Error("checkpoint length");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("checkpoint encoding");
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !== "q,s,v" ||
      parsed.v !== 1 ||
      typeof parsed.s !== "string" ||
      typeof parsed.q !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(parsed.q)
    ) {
      throw new Error("checkpoint payload");
    }
    if (parsed.s !== documentIndexCheckpointScope(scope)) {
      throw new Error("document index checkpoint belongs to a different workspace or subject");
    }
    return BigInt(parsed.q);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "document index checkpoint belongs to a different workspace or subject"
    ) {
      throw error;
    }
    throw new Error("invalid document index checkpoint", { cause: error });
  }
}

function documentIndexCheckpointScope(input: {
  accountId: string;
  workspaceId: string;
  initiatingSubjectId: string;
}): string {
  return createHash("sha256")
    .update("opengeni:document-index-checkpoint:v1\0")
    .update(input.accountId)
    .update("\0")
    .update(input.workspaceId)
    .update("\0")
    .update(canonicalEffectiveDocumentSubject(input.initiatingSubjectId))
    .digest("hex");
}

function canonicalEffectiveDocumentSubject(value: string): string {
  const subjectId = cleanString(value);
  if (!subjectId || subjectId !== value) {
    throw new Error("effective document retrieval requires an initiating subject");
  }
  if (new TextEncoder().encode(subjectId).byteLength > DOCUMENT_AUTHORITY_SUBJECT_MAX_BYTES) {
    throw new Error(
      `effective document initiating subject exceeds ${DOCUMENT_AUTHORITY_SUBJECT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return subjectId;
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

/**
 * Internal ingestion-only read used after the worker has independently resolved
 * and fenced the immutable document authority tuple. It deliberately does not
 * apply provider retrieval authorization because a new Drive document must be
 * indexed before its first ACL evidence can be attached. User, API, MCP, and
 * agent reads must use getDocument/effective retrieval instead.
 */
export async function getDocumentForIndexing(
  db: Database,
  workspaceId: string,
  documentId: string,
): Promise<Document | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.documents)
      .where(
        and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId)),
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
  const file = await requireReadyFile(db, {
    accountId: document.accountId,
    workspaceId,
    subjectId: cleanString(document.createdBy) ?? null,
    fileId: document.fileId,
  });
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
  const updated = await getDocumentForIndexing(db, workspaceId, documentId);
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
  const access = await resolveEffectiveDocumentAccess(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId,
    surface: input.surface,
    agentAuthority: input.agentAuthority,
  });
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
      access,
    },
    services,
  );
}

/**
 * Agent-facing Knowledge search over the existing Documents evidence store.
 * Search selects candidates only after authority filtering; this second read
 * rechecks every exact chunk before projecting it, so a record revoked between
 * ranking and response construction disappears rather than leaking stale data.
 */
export async function searchEffectiveKnowledge(
  db: Database,
  input: EffectiveDocumentSearchInput,
  services: Pick<DocumentServices, "embedder"> = createDocumentServices(),
): Promise<KnowledgeSearchResponse> {
  const initiatingSubjectId = canonicalEffectiveDocumentSubject(input.initiatingSubjectId);
  const ranked = await searchEffectiveDocuments(
    db,
    { ...input, initiatingSubjectId, surface: "agent" },
    services,
  );
  if (ranked.length === 0) return { results: [] };
  const access = await resolveEffectiveDocumentAccess(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId,
    surface: "agent",
    agentAuthority: input.agentAuthority,
  });
  const current = await withDocumentAccountRls(
    db,
    input.accountId,
    input.workspaceId,
    access,
    async (scopedDb) =>
      await scopedDb
        .select({
          chunk: schema.documentChunks,
          document: schema.documents,
          citation: googleDriveCitationProjection(input.workspaceId, access),
        })
        .from(schema.documentChunks)
        .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
        .where(
          and(
            eq(schema.documents.accountId, input.accountId),
            eq(schema.documentChunks.accountId, input.accountId),
            inArray(
              schema.documentChunks.id,
              ranked.map((result) => result.chunkId),
            ),
            eq(schema.documents.status, "ready"),
            ...documentAccessConditions(input.workspaceId, access),
          ),
        ),
  );
  const currentByChunkId = new Map(current.map((row) => [row.chunk.id, row]));
  return {
    results: ranked.flatMap((rankedResult) => {
      const row = currentByChunkId.get(rankedResult.chunkId);
      if (!row) return [];
      return [
        {
          record: knowledgeChunkRecord(row.document, row.chunk, row.citation),
          retrieval: {
            score: rankedResult.score,
            matchType: rankedResult.matchType,
            vectorScore: rankedResult.vectorScore,
            keywordScore: rankedResult.keywordScore,
          },
        },
      ];
    }),
  };
}

/** Fetch one stable Knowledge record with a fresh authorization check. */
export async function getEffectiveKnowledgeRecord(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    initiatingSubjectId: string;
    id: string;
    agentAuthority?: AgentDocumentAuthorityContext | undefined;
  },
): Promise<KnowledgeRecord | null> {
  const initiatingSubjectId = canonicalEffectiveDocumentSubject(input.initiatingSubjectId);
  const target = parseKnowledgeRecordId(input.id);
  const access = await resolveEffectiveDocumentAccess(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId,
    surface: "agent",
    agentAuthority: input.agentAuthority,
  });
  return await withDocumentAccountRls(
    db,
    input.accountId,
    input.workspaceId,
    access,
    async (scopedDb) => {
      if (target.kind === "document") {
        const [row] = await scopedDb
          .select({
            document: schema.documents,
            citation: googleDriveCitationProjection(input.workspaceId, access),
          })
          .from(schema.documents)
          .where(
            and(
              eq(schema.documents.accountId, input.accountId),
              eq(schema.documents.id, target.id),
              eq(schema.documents.status, "ready"),
              ...documentAccessConditions(input.workspaceId, access),
            ),
          )
          .limit(1);
        return row ? knowledgeDocumentRecord(row.document, row.citation) : null;
      }
      const [row] = await scopedDb
        .select({
          chunk: schema.documentChunks,
          document: schema.documents,
          citation: googleDriveCitationProjection(input.workspaceId, access),
        })
        .from(schema.documentChunks)
        .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
        .where(
          and(
            eq(schema.documents.accountId, input.accountId),
            eq(schema.documentChunks.accountId, input.accountId),
            eq(schema.documentChunks.id, target.id),
            eq(schema.documents.status, "ready"),
            ...documentAccessConditions(input.workspaceId, access),
          ),
        )
        .limit(1);
      return row ? knowledgeChunkRecord(row.document, row.chunk, row.citation) : null;
    },
  );
}

/**
 * Browse top-level authorized documents or the chunks of one authorized
 * document. The cursor is opaque and bound to the caller, workspace, parent,
 * and filters. It can change pagination position but can never widen scope.
 */
export async function browseEffectiveKnowledge(
  db: Database,
  input: EffectiveKnowledgeBrowseInput,
): Promise<KnowledgeBrowseResponse> {
  const initiatingSubjectId = canonicalEffectiveDocumentSubject(input.initiatingSubjectId);
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("knowledge browse limit must be between 1 and 50");
  }
  const topic = input.topic === undefined ? null : (cleanString(input.topic) ?? null);
  if (input.topic !== undefined && (!topic || topic !== input.topic || topic.length > 256)) {
    throw new Error("knowledge browse topic is invalid");
  }
  const sourceKinds = [...new Set(input.sourceKinds ?? [])].sort();
  const parent = input.parentId ? parseKnowledgeRecordId(input.parentId) : null;
  if (parent?.kind === "document_chunk") {
    throw new Error("knowledge browse parent must be a document record");
  }
  if (parent && (topic || sourceKinds.length > 0)) {
    throw new Error("knowledge browse document contents do not accept topic/source filters");
  }
  const cursorScope = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId,
    parentId: parent ? `${parent.kind}:${parent.id}` : null,
    topic,
    sourceKinds,
  };
  const after = input.cursor ? decodeKnowledgeBrowseCursor(input.cursor, cursorScope) : 0n;
  if (parent && after > 2_147_483_648n) {
    throw new Error("invalid knowledge browse cursor");
  }
  const access = await resolveEffectiveDocumentAccess(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId,
    surface: "agent",
    agentAuthority: input.agentAuthority,
  });
  return await withDocumentAccountRls(
    db,
    input.accountId,
    input.workspaceId,
    access,
    async (scopedDb) => {
      if (parent) {
        const [authorizedParent] = await scopedDb
          .select({ id: schema.documents.id })
          .from(schema.documents)
          .where(
            and(
              eq(schema.documents.accountId, input.accountId),
              eq(schema.documents.id, parent.id),
              eq(schema.documents.status, "ready"),
              ...documentAccessConditions(input.workspaceId, access),
            ),
          )
          .limit(1);
        if (!authorizedParent) return { records: [], nextCursor: null, hasMore: false };
        const rows = await scopedDb
          .select({
            chunk: schema.documentChunks,
            document: schema.documents,
            citation: googleDriveCitationProjection(input.workspaceId, access),
          })
          .from(schema.documentChunks)
          .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
          .where(
            and(
              eq(schema.documentChunks.accountId, input.accountId),
              eq(schema.documentChunks.documentId, parent.id),
              gt(schema.documentChunks.chunkIndex, Number(after) - 1),
              eq(schema.documents.status, "ready"),
              ...documentAccessConditions(input.workspaceId, access),
            ),
          )
          .orderBy(asc(schema.documentChunks.chunkIndex))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const last = page.at(-1)?.chunk.chunkIndex;
        return {
          records: page.map((row) => knowledgeChunkRecord(row.document, row.chunk, row.citation)),
          nextCursor:
            hasMore && last !== undefined
              ? encodeKnowledgeBrowseCursor(cursorScope, BigInt(last + 1))
              : null,
          hasMore,
        };
      }

      const conditions: SQL[] = [
        eq(schema.documents.accountId, input.accountId),
        eq(schema.documents.status, "ready"),
        isNotNull(schema.documents.indexSequence),
        gt(schema.documents.indexSequence, after),
        ...documentAccessConditions(input.workspaceId, access),
      ];
      if (topic) conditions.push(sql`${schema.documents.topics} ? ${topic}`);
      if (sourceKinds.length > 0)
        conditions.push(inArray(schema.documents.sourceKind, sourceKinds));
      const rows = await scopedDb
        .select({
          document: schema.documents,
          citation: googleDriveCitationProjection(input.workspaceId, access),
        })
        .from(schema.documents)
        .where(and(...conditions))
        .orderBy(asc(schema.documents.indexSequence))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1)?.document.indexSequence;
      return {
        records: page.map((row) => knowledgeDocumentRecord(row.document, row.citation)),
        nextCursor:
          hasMore && last !== undefined && last !== null
            ? encodeKnowledgeBrowseCursor(cursorScope, last)
            : null,
        hasMore,
      };
    },
  );
}

type KnowledgeBrowseCursorScope = {
  accountId: string;
  workspaceId: string;
  initiatingSubjectId: string;
  parentId: string | null;
  topic: string | null;
  sourceKinds: readonly string[];
};

export function encodeKnowledgeBrowseCursor(
  scope: KnowledgeBrowseCursorScope,
  position: bigint,
): string {
  if (position < 0n) throw new Error("knowledge browse cursor position is invalid");
  return Buffer.from(
    JSON.stringify({ v: 1, s: knowledgeBrowseCursorScope(scope), q: position.toString() }),
    "utf8",
  ).toString("base64url");
}

export function decodeKnowledgeBrowseCursor(
  value: string,
  scope: KnowledgeBrowseCursorScope,
): bigint {
  try {
    if (!value || value.length > KNOWLEDGE_BROWSE_CURSOR_MAX_CHARS) {
      throw new Error("cursor length");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("cursor encoding");
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !== "q,s,v" ||
      parsed.v !== 1 ||
      typeof parsed.s !== "string" ||
      typeof parsed.q !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(parsed.q)
    ) {
      throw new Error("cursor payload");
    }
    if (parsed.s !== knowledgeBrowseCursorScope(scope)) {
      throw new Error("knowledge browse cursor belongs to a different scope");
    }
    const position = BigInt(parsed.q);
    if (position > 9_223_372_036_854_775_807n) throw new Error("cursor position");
    return position;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "knowledge browse cursor belongs to a different scope"
    ) {
      throw error;
    }
    throw new Error("invalid knowledge browse cursor", { cause: error });
  }
}

function knowledgeBrowseCursorScope(scope: KnowledgeBrowseCursorScope): string {
  return createHash("sha256")
    .update("opengeni:knowledge-browse-cursor:v1\0")
    .update(scope.accountId)
    .update("\0")
    .update(scope.workspaceId)
    .update("\0")
    .update(canonicalEffectiveDocumentSubject(scope.initiatingSubjectId))
    .update("\0")
    .update(scope.parentId ?? "")
    .update("\0")
    .update(scope.topic ?? "")
    .update("\0")
    .update([...scope.sourceKinds].sort().join("\0"))
    .digest("hex");
}

function parseKnowledgeRecordId(value: string): {
  kind: "document" | "document_chunk";
  id: string;
} {
  const match =
    /^(document|document_chunk):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(
      value,
    );
  if (!match) throw new Error("invalid knowledge record id");
  return { kind: match[1] as "document" | "document_chunk", id: match[2]!.toLowerCase() };
}

function knowledgeDocumentRecord(
  document: typeof schema.documents.$inferSelect,
  citation: unknown = null,
): KnowledgeRecord {
  if (!document.indexedAt) throw new Error(`Ready document is missing indexed_at: ${document.id}`);
  const projected = projectKnowledgeRecord({
    title: document.title,
    body: document.summary,
    summary: document.summary,
    topics: document.topics,
    metadata: { parser: document.parser, chunkCount: document.chunkCount },
    source: knowledgeSource(document),
  });
  return {
    id: `document:${document.id}`,
    kind: "document",
    title: projected.title,
    content: projected.content,
    authority: { kind: normalizeDocumentAuthorityKind(document.authorityKind) },
    provenance: {
      source: projected.source,
      indexedAt: document.indexedAt.toISOString(),
      citation: parseKnowledgeProviderCitation(citation),
    },
    lifecycle: { state: "active", updatedAt: document.updatedAt.toISOString() },
    quality: knowledgeQuality(document),
    links: knowledgeSourceLinks(projected.source.uri),
    projection: projected.projection,
  };
}

function knowledgeChunkRecord(
  document: typeof schema.documents.$inferSelect,
  chunk: typeof schema.documentChunks.$inferSelect,
  citation: unknown = null,
): KnowledgeRecord {
  if (!document.indexedAt) throw new Error(`Ready document is missing indexed_at: ${document.id}`);
  const projected = projectKnowledgeRecord({
    title: document.title,
    body: chunk.text,
    summary: document.summary,
    topics: document.topics,
    metadata: { ...chunk.metadata, chunkIndex: chunk.chunkIndex },
    source: knowledgeSource(document),
  });
  return {
    id: `document_chunk:${chunk.id}`,
    kind: "document_chunk",
    title: projected.title,
    content: projected.content,
    authority: { kind: normalizeDocumentAuthorityKind(document.authorityKind) },
    provenance: {
      source: projected.source,
      indexedAt: document.indexedAt.toISOString(),
      citation: parseKnowledgeProviderCitation(citation),
    },
    lifecycle: { state: "active", updatedAt: document.updatedAt.toISOString() },
    quality: knowledgeQuality(document),
    links: [
      { relation: "parent", target: { kind: "knowledge", id: `document:${document.id}` } },
      ...knowledgeSourceLinks(projected.source.uri),
    ],
    projection: projected.projection,
  };
}

function knowledgeSource(document: typeof schema.documents.$inferSelect) {
  return {
    kind: normalizeKnowledgeSourceKind(document.sourceKind),
    uri: document.sourceUri,
    externalId: document.sourceExternalId,
    title: document.sourceTitle,
    author: document.sourceAuthor,
    createdAt: document.sourceCreatedAt?.toISOString() ?? null,
    updatedAt: document.sourceUpdatedAt?.toISOString() ?? null,
    version: document.sourceVersion,
  };
}

function knowledgeQuality(
  document: typeof schema.documents.$inferSelect,
): KnowledgeRecord["quality"] {
  if (!document.indexedAt) throw new Error(`Ready document is missing indexed_at: ${document.id}`);
  return {
    trust: "sourced",
    freshnessAt: (document.sourceUpdatedAt ?? document.indexedAt).toISOString(),
    conflict: "not_evaluated",
    correction: "current_source_version",
  };
}

function knowledgeSourceLinks(sourceUri: string | null): KnowledgeRecord["links"] {
  return sourceUri ? [{ relation: "source", target: { kind: "external", uri: sourceUri } }] : [];
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
          citation: googleDriveCitationProjection(input.workspaceId, input.access),
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
          citation: googleDriveCitationProjection(input.workspaceId, input.access),
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
          citation: googleDriveCitationProjection(workspaceId, access),
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

export async function resolveEffectiveDocumentAccess(
  _db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    initiatingSubjectId: string;
    surface: "human" | "agent";
    agentAuthority?: AgentDocumentAuthorityContext | undefined;
  },
): Promise<DocumentAccessFilter> {
  if (input.surface === "human") {
    return { viewerSubjectId: input.initiatingSubjectId };
  }
  return {
    agentOnly: true,
    viewerSubjectId: input.initiatingSubjectId,
    authorizedPersonalAttempt: input.agentAuthority
      ? {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.agentAuthority.sessionId,
          attemptId: input.agentAuthority.attemptId,
        }
      : undefined,
  };
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
  const personalAttempt = access?.authorizedPersonalAttempt;
  const authorizedPersonal = personalAttempt
    ? sql`${schema.documents.id} IN (
        SELECT resolve_session_attempt_personal_document_reads(
          ${personalAttempt.accountId}::uuid,
          ${personalAttempt.workspaceId}::uuid,
          ${personalAttempt.sessionId}::uuid,
          ${personalAttempt.attemptId}::uuid
        )
      )`
    : sql`false`;
  const personal = viewer
    ? and(
        eq(schema.documents.authorityKind, "personal"),
        eq(schema.documents.authoritySubjectId, viewer),
        access?.agentOnly
          ? authorizedPersonal
          : (or(
              eq(schema.documents.authorityWorkspaceId, workspaceId),
              isNull(schema.documents.authorityWorkspaceId),
            ) ?? eq(schema.documents.authorityWorkspaceId, workspaceId)),
      )
    : undefined;
  const authority = viewer
    ? (or(organization, workspace, personal) ?? organization)
    : (or(organization, workspace) ?? organization);
  const viewerSql = viewer ? sql`${viewer}` : sql`NULL::text`;
  const providerAuthorization = sql`google_drive_file_authorized(
    ${schema.documents.accountId},
    ${workspaceId}::uuid,
    ${viewerSql},
    ${schema.documents.fileId}
  )`;
  if (access?.agentOnly) {
    return [eq(schema.documents.agentAccess, true), authority, providerAuthorization];
  }
  return [authority, providerAuthorization];
}

function documentMatchesAccess(
  document: Pick<
    DocumentAccessRecord,
    "id" | "authorityKind" | "authorityWorkspaceId" | "authoritySubjectId" | "agentAccess"
  >,
  workspaceId: string,
  access: DocumentAccessFilter | undefined,
): boolean {
  if (access?.agentOnly) {
    return (
      document.agentAccess &&
      document.authorityKind !== "personal" &&
      canViewDocument(document, access.viewerSubjectId, workspaceId)
    );
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
 * Keep this compatibility predicate as strict as SQL/RLS: legacy personal
 * authority remains origin-workspace anchored while activated personal
 * authority has a null workspace and follows the exact owner within the org.
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
  if (!normalizedWorkspaceId) {
    return false;
  }
  if (document.authorityKind === "workspace") {
    return (
      document.authorityWorkspaceId === normalizedWorkspaceId &&
      document.authoritySubjectId === null
    );
  }
  if (document.authorityKind === "personal") {
    const authoritySubjectId = canonicalDocumentAuthoritySubject(document.authoritySubjectId);
    const viewer = canonicalDocumentAuthoritySubject(viewerSubjectId);
    return (
      !!authoritySubjectId &&
      authoritySubjectId === viewer &&
      (document.authorityWorkspaceId === null ||
        document.authorityWorkspaceId === normalizedWorkspaceId)
    );
  }
  return false;
}

type DocumentAccessRecord = {
  id: string;
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
  citation?: unknown;
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
    citation: parseKnowledgeProviderCitation(row.citation),
  };
}

function googleDriveCitationProjection(
  workspaceId: string,
  access: DocumentAccessFilter | undefined,
): SQL<unknown> {
  const viewer = cleanString(access?.viewerSubjectId ?? null);
  const viewerSql = viewer ? sql`${viewer}` : sql`NULL::text`;
  return sql`google_drive_document_citation(
    ${schema.documents.accountId},
    ${workspaceId}::uuid,
    ${viewerSql},
    ${schema.documents.id},
    ${schema.documents.fileId}
  )`;
}

function parseKnowledgeProviderCitation(value: unknown): KnowledgeProviderCitationValue | null {
  return value === null || value === undefined ? null : KnowledgeProviderCitation.parse(value);
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
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string | null;
    fileId: string;
  },
): Promise<FileAsset> {
  const [file] = await getFilesForSubject(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    fileIds: [input.fileId],
  });
  if (!file) throw new Error(`File not found: ${input.fileId}`);
  if (file.status !== "ready") {
    throw new Error(`File ${input.fileId} is ${file.status}`);
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
    authorityId: row.authorityId,
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

function mapIndexedDocumentSummary(
  row: typeof schema.documents.$inferSelect,
): IndexedDocumentSummary {
  if (row.indexSequence === null || row.indexedAt === null) {
    throw new Error(`Ready document is missing index completion metadata: ${row.id}`);
  }
  return {
    id: row.id,
    title: row.title,
    parser: row.parser,
    chunkCount: row.chunkCount,
    indexedAt: row.indexedAt.toISOString(),
    summary: row.summary,
    topics: cleanStringArray(row.topics),
    source: {
      kind: normalizeKnowledgeSourceKind(row.sourceKind),
      uri: row.sourceUri,
      externalId: row.sourceExternalId,
      title: row.sourceTitle,
      author: row.sourceAuthor,
      createdAt: row.sourceCreatedAt?.toISOString() ?? null,
      updatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
      version: row.sourceVersion,
    },
    provenance: {
      ingestionWorkspaceId: row.workspaceId,
      baseId: row.baseId,
      fileId: row.fileId,
      authorityKind: normalizeDocumentAuthorityKind(row.authorityKind),
      authorityWorkspaceId: row.authorityWorkspaceId,
      authoritySubjectId: row.authoritySubjectId,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    },
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
