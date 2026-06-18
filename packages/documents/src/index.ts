import type { Settings } from "@opengeni/config";
import type {
  AddDocumentRequest,
  CreateDocumentBaseRequest,
  Document,
  DocumentBase,
  DocumentSearchMode,
  DocumentSearchResult,
  FileAsset,
  KnowledgeSourceKind,
} from "@opengeni/contracts";
import { requireFile, withRlsContext, withWorkspaceRls, type Database } from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { ObjectStorage } from "@opengeni/storage";
import { LiteParse } from "@llamaindex/liteparse";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import OpenAI from "openai";

export const DEFAULT_DOCUMENT_PARSER = "liteparse";
export const DEFAULT_DOCUMENT_EMBEDDING_MODEL = "text-embedding-3-large";
export const DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS = 3072;
export const DEFAULT_DOCUMENT_CHUNK_SIZE = 1200;
export const DEFAULT_DOCUMENT_CHUNK_OVERLAP = 160;

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

export type DocumentServices = {
  parser: DocumentParser;
  chunker: DocumentChunker;
  embedder: DocumentEmbedder;
};

export type DocumentSearchInput = {
  workspaceId: string;
  query: string;
  baseIds?: string[] | undefined;
  limit?: number | undefined;
  mode?: DocumentSearchMode | undefined;
  sourceKinds?: KnowledgeSourceKind[] | undefined;
  aclTags?: string[] | undefined;
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

export function createDocumentServices(settings?: Settings, overrides: Partial<DocumentServices> = {}): DocumentServices {
  const dimensions = settings?.documentEmbeddingDimensions ?? DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS;
  const openAIEmbeddingConfig = documentOpenAIEmbeddingConfig(settings);
  return {
    parser: overrides.parser ?? new LiteParseDocumentParser(),
    chunker: overrides.chunker ?? new RecursiveTextChunker(
      settings?.documentChunkSize ?? DEFAULT_DOCUMENT_CHUNK_SIZE,
      settings?.documentChunkOverlap ?? DEFAULT_DOCUMENT_CHUNK_OVERLAP,
    ),
    embedder: overrides.embedder ?? (
      settings?.documentEmbeddingProvider === "deterministic"
        ? new DeterministicEmbeddingProvider(dimensions, settings.documentEmbeddingModel)
        : new OpenAIEmbeddingProvider({
          ...openAIEmbeddingConfig,
          model: settings?.documentEmbeddingModel ?? DEFAULT_DOCUMENT_EMBEDDING_MODEL,
          dimensions,
        })
    ),
  };
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
      apiKey: settings.documentEmbeddingApiKey ?? settings.openaiApiKey ?? settings.azureOpenaiApiKey,
      baseURL: settings.documentEmbeddingBaseUrl ?? settings.openaiBaseUrl ?? settings.azureOpenaiBaseUrl,
    };
  }
  if (settings.openaiProvider === "azure") {
    const baseURL = settings.azureOpenaiBaseUrl ?? azureDeploymentBaseUrl(settings);
    return {
      apiKey: settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken ?? "azure-ad-token",
      baseURL,
      defaultQuery: azureOpenAIDefaultQuery(settings, baseURL),
      defaultHeaders: settings.azureOpenaiAdToken && !settings.azureOpenaiApiKey
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

export async function createDocumentBase(db: Database, input: CreateDocumentBaseRequest & { accountId: string; workspaceId: string }): Promise<DocumentBase> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.documentBases).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
    }).returning();
    if (!row) throw new Error("Failed to create document base");
    return mapDocumentBase(row);
  });
}

export async function listDocumentBases(db: Database, workspaceId: string): Promise<DocumentBase[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.documentBases)
      .where(eq(schema.documentBases.workspaceId, workspaceId))
      .orderBy(desc(schema.documentBases.createdAt));
    return rows.map(mapDocumentBase);
  });
}

export async function getDocumentBase(db: Database, workspaceId: string, baseId: string): Promise<DocumentBase | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.documentBases).where(and(eq(schema.documentBases.workspaceId, workspaceId), eq(schema.documentBases.id, baseId))).limit(1);
    return row ? mapDocumentBase(row) : null;
  });
}

export async function addDocumentToBase(db: Database, input: AddDocumentRequest & { accountId: string; workspaceId: string; baseId: string }): Promise<Document> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const base = await getDocumentBase(scopedDb, input.workspaceId, input.baseId);
    if (!base) throw new Error(`Document base not found: ${input.baseId}`);
    const file = await requireReadyFile(scopedDb, input.workspaceId, input.fileId);
    const now = new Date();
    const [existing] = await scopedDb.select().from(schema.documents)
      .where(and(eq(schema.documents.workspaceId, input.workspaceId), eq(schema.documents.baseId, input.baseId), eq(schema.documents.fileId, input.fileId)))
      .limit(1);
    if (existing) {
      return mapDocument(existing);
    }
    const [row] = await scopedDb.insert(schema.documents).values({
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
      updatedAt: now,
    }).returning();
    if (!row) throw new Error("Failed to create document");
    return mapDocument(row);
  });
}

export async function listDocuments(db: Database, workspaceId: string, baseId: string): Promise<Document[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.documents)
      .where(and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.baseId, baseId)))
      .orderBy(asc(schema.documents.createdAt));
    return rows.map(mapDocument);
  });
}

export async function getDocument(db: Database, workspaceId: string, documentId: string): Promise<Document | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.documents).where(and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId))).limit(1);
    return row ? mapDocument(row) : null;
  });
}

export async function queueDocumentForReindex(db: Database, workspaceId: string, documentId: string): Promise<Document> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.documents).set({
      status: "queued",
      error: null,
      updatedAt: new Date(),
    }).where(and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId))).returning();
    if (!row) throw new Error(`Document not found: ${documentId}`);
    return mapDocument(row);
  });
}

export async function indexDocumentNow(
  db: Database,
  objectStorage: ObjectStorage,
  workspaceId: string,
  documentId: string,
  services: DocumentServices = createDocumentServices(),
  hooks: DocumentIndexHooks = {},
): Promise<Document> {
  const [document] = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
    await scopedDb.select().from(schema.documents).where(and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId))).limit(1)
  );
  if (!document) throw new Error(`Document not found: ${documentId}`);
  const file = await requireReadyFile(db, workspaceId, document.fileId);
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.documents).set({
      status: "indexing",
      parser: services.parser.name,
      error: null,
      updatedAt: new Date(),
    }).where(and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId)));
  });
  try {
    const bytes = await objectStorage.getFileBytes(file);
    const parsed = await services.parser.parse(bytes, file);
    const chunks = services.chunker.chunk(parsed, file);
    await hooks.beforeEmbed?.({
      accountId: document.accountId,
      workspaceId: document.workspaceId,
      documentId,
      chunkCount: chunks.length,
    });
    const embeddings = await services.embedder.embedMany(chunks.map((chunk) => chunk.text));
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding provider returned ${embeddings.length} embeddings for ${chunks.length} chunks`);
    }
    await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
      await tx.delete(schema.documentChunks).where(and(eq(schema.documentChunks.workspaceId, workspaceId), eq(schema.documentChunks.documentId, documentId)));
      if (chunks.length > 0) {
        await tx.insert(schema.documentChunks).values(chunks.map((chunk, index) => ({
          accountId: document.accountId,
          workspaceId: document.workspaceId,
          documentId,
          baseId: document.baseId,
          fileId: file.id,
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
          embedding: validateEmbedding(embeddings[index] ?? [], services.embedder.dimensions, services.embedder.model),
          embeddingModel: services.embedder.model,
        })));
      }
      await tx.update(schema.documents).set({
        status: "ready",
        parser: services.parser.name,
        chunkCount: chunks.length,
        error: null,
        updatedAt: new Date(),
      }).where(and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId)));
    }));
  } catch (error) {
    const [failed] = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
      await scopedDb.update(schema.documents).set({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      }).where(and(eq(schema.documents.workspaceId, workspaceId), eq(schema.documents.id, documentId))).returning()
    );
    if (!failed) throw error;
    return mapDocument(failed);
  }
  const updated = await getDocument(db, workspaceId, documentId);
  if (!updated) throw new Error(`Document disappeared after indexing: ${documentId}`);
  return updated;
}

export async function searchDocuments(
  db: Database,
  input: DocumentSearchInput,
  services: Pick<DocumentServices, "embedder"> = createDocumentServices(),
): Promise<DocumentSearchResult[]> {
  const mode = input.mode ?? "hybrid";
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 50);
  const candidateLimit = mode === "hybrid" ? Math.min(limit * 4, 100) : limit;
  const rows: CombinedSearchRow[] = [];
  if (mode === "vector" || mode === "hybrid") {
    try {
      rows.push(...await vectorSearchDocuments(db, input, candidateLimit, services));
    } catch (error) {
      if (mode === "vector") {
        throw error;
      }
    }
  }
  if (mode === "keyword" || mode === "hybrid") {
    rows.push(...await keywordSearchDocuments(db, input, candidateLimit));
  }
  return mergeDocumentSearchRows(rows, mode).slice(0, limit);
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
  const rows = await withWorkspaceRls(db, input.workspaceId, async (scopedDb) =>
    await scopedDb.select({
      chunkId: schema.documentChunks.id,
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
      distance,
    }).from(schema.documentChunks)
      .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
      .where(and(...documentSearchConditions(input, services.embedder.model)))
      .orderBy(distance)
      .limit(limit)
  );
  return rows.map((row) => ({
    ...mapSearchRowBase(row, input.workspaceId),
    vectorScore: 1 / (1 + Number(row.distance)),
    keywordScore: null,
  }));
}

async function keywordSearchDocuments(db: Database, input: DocumentSearchInput, limit: number): Promise<CombinedSearchRow[]> {
  const rank = sql<number>`ts_rank_cd(to_tsvector('simple', ${schema.documentChunks.text}), plainto_tsquery('simple', ${input.query}))`;
  const rows = await withWorkspaceRls(db, input.workspaceId, async (scopedDb) =>
    await scopedDb.select({
      chunkId: schema.documentChunks.id,
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
      rank,
    }).from(schema.documentChunks)
      .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
      .where(and(
        ...documentSearchConditions(input),
        sql`to_tsvector('simple', ${schema.documentChunks.text}) @@ plainto_tsquery('simple', ${input.query})`,
      ))
      .orderBy(desc(rank))
      .limit(limit)
  );
  return rows.map((row) => ({
    ...mapSearchRowBase(row, input.workspaceId),
    vectorScore: null,
    keywordScore: normalizeKeywordScore(Number(row.rank)),
  }));
}

export async function getDocumentChunk(db: Database, workspaceId: string, chunkId: string): Promise<DocumentSearchResult | null> {
  const [row] = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
    await scopedDb.select({
      chunkId: schema.documentChunks.id,
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
    }).from(schema.documentChunks)
      .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
      .where(and(eq(schema.documentChunks.workspaceId, workspaceId), eq(schema.documentChunks.id, chunkId), eq(schema.documents.status, "ready")))
      .limit(1)
  );
  if (!row) return null;
  return {
    ...mapSearchRowBase(row, workspaceId),
    score: 1,
    matchType: "hybrid",
    vectorScore: null,
    keywordScore: null,
  };
}

type SearchRowBase = Omit<DocumentSearchResult, "score" | "matchType" | "vectorScore" | "keywordScore">;
type CombinedSearchRow = SearchRowBase & {
  vectorScore: number | null;
  keywordScore: number | null;
};

function documentSearchConditions(input: DocumentSearchInput, embeddingModel?: string): SQL[] {
  const conditions: SQL[] = [
    eq(schema.documents.status, "ready"),
    eq(schema.documentChunks.workspaceId, input.workspaceId),
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
}, workspaceId: string): SearchRowBase {
  return {
    chunkId: row.chunkId,
    workspaceId,
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
  };
}

function mergeDocumentSearchRows(rows: CombinedSearchRow[], mode: DocumentSearchMode): DocumentSearchResult[] {
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
  return [...byChunk.values()].map((row) => {
    const vectorScore = row.vectorScore;
    const keywordScore = row.keywordScore;
    const matchType: DocumentSearchMode = vectorScore !== null && keywordScore !== null
      ? "hybrid"
      : vectorScore !== null
        ? "vector"
        : "keyword";
    return {
      ...row,
      score: combinedSearchScore(mode, vectorScore, keywordScore, matchType),
      matchType,
    };
  }).sort((left, right) =>
    right.score - left.score
    || (right.vectorScore ?? 0) - (left.vectorScore ?? 0)
    || (right.keywordScore ?? 0) - (left.keywordScore ?? 0)
    || left.chunkIndex - right.chunkIndex
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
  return roundScore(Math.min(1, (0.65 * vector) + (0.35 * keyword) + (matchType === "hybrid" ? 0.1 : 0)));
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

export async function parseDocumentBytes(bytes: Uint8Array, file: FileAsset, parser: DocumentParser = new LiteParseDocumentParser()): Promise<ParsedDocument> {
  return await parser.parse(bytes, file);
}

export function chunkText(text: string, maxChars = DEFAULT_DOCUMENT_CHUNK_SIZE, overlapChars = DEFAULT_DOCUMENT_CHUNK_OVERLAP): string[] {
  if (overlapChars >= maxChars) {
    throw new Error("chunk overlap must be smaller than chunk size");
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
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

export function deterministicEmbedding(text: string, dimensions = DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS): number[] {
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

async function requireReadyFile(db: Database, workspaceId: string, fileId: string): Promise<FileAsset> {
  const file = await requireFile(db, workspaceId, fileId);
  if (file.status !== "ready") {
    throw new Error(`File ${fileId} is ${file.status}`);
  }
  return file;
}

function validateEmbedding(values: number[], dimensions: number, model: string): number[] {
  if (values.length !== dimensions) {
    throw new Error(`Embedding model ${model} returned ${values.length} dimensions; expected ${dimensions}`);
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding model ${model} returned non-finite values`);
  }
  return values;
}

function isTextLike(file: FileAsset): boolean {
  const contentType = file.contentType.toLowerCase();
  const filename = file.filename.toLowerCase();
  return contentType.startsWith("text/")
    || contentType === "application/json"
    || contentType === "application/xml"
    || contentType === "application/x-yaml"
    || filename.endsWith(".md")
    || filename.endsWith(".markdown")
    || filename.endsWith(".json")
    || filename.endsWith(".yaml")
    || filename.endsWith(".yml")
    || filename.endsWith(".csv")
    || filename.endsWith(".tsv")
    || filename.endsWith(".xml");
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

function withOverlap(previous: string, overlapChars: number, next: string, maxChars: number): string {
  if (overlapChars <= 0) return next;
  const overlap = previous.slice(Math.max(0, previous.length - overlapChars)).replace(/^\S+\s+/, "").trim();
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
