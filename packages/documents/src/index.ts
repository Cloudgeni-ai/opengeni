import type { Settings } from "@infra-agents/config";
import type { AddDocumentRequest, CreateDocumentBaseRequest, Document, DocumentBase, DocumentSearchResult, FileAsset } from "@infra-agents/contracts";
import { requireFile, type Database } from "@infra-agents/db";
import * as schema from "@infra-agents/db/schema";
import type { ObjectStorage } from "@infra-agents/storage";
import { LiteParse } from "@llamaindex/liteparse";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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

export class LiteParseDocumentParser implements DocumentParser {
  readonly name = DEFAULT_DOCUMENT_PARSER;
  private parser: LiteParse | null = null;

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
    this.parser ??= new LiteParse({ ocrEnabled: true });
    const result = await this.parser.parse(Buffer.from(bytes));
    const text = typeof result?.text === "string" ? result.text : "";
    return text.replace(/\0/g, " ").trim();
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
    const defaultQuery = settings.azureOpenaiBaseUrl
      ? undefined
      : settings.azureOpenaiApiVersion
        ? { "api-version": settings.azureOpenaiApiVersion }
        : undefined;
    return {
      apiKey: settings.azureOpenaiApiKey ?? settings.azureOpenaiAdToken ?? "azure-ad-token",
      baseURL,
      defaultQuery,
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

export async function createDocumentBase(db: Database, input: CreateDocumentBaseRequest): Promise<DocumentBase> {
  const [row] = await db.insert(schema.documentBases).values({
    name: input.name.trim(),
    description: input.description?.trim() || null,
  }).returning();
  if (!row) throw new Error("Failed to create document base");
  return mapDocumentBase(row);
}

export async function listDocumentBases(db: Database): Promise<DocumentBase[]> {
  const rows = await db.select().from(schema.documentBases).orderBy(desc(schema.documentBases.createdAt));
  return rows.map(mapDocumentBase);
}

export async function getDocumentBase(db: Database, baseId: string): Promise<DocumentBase | null> {
  const [row] = await db.select().from(schema.documentBases).where(eq(schema.documentBases.id, baseId)).limit(1);
  return row ? mapDocumentBase(row) : null;
}

export async function addDocumentToBase(db: Database, input: AddDocumentRequest & { baseId: string }): Promise<Document> {
  const base = await getDocumentBase(db, input.baseId);
  if (!base) throw new Error(`Document base not found: ${input.baseId}`);
  const file = await requireReadyFile(db, input.fileId);
  const now = new Date();
  const [existing] = await db.select().from(schema.documents)
    .where(and(eq(schema.documents.baseId, input.baseId), eq(schema.documents.fileId, input.fileId)))
    .limit(1);
  if (existing) {
    return mapDocument(existing);
  }
  const [row] = await db.insert(schema.documents).values({
    baseId: input.baseId,
    fileId: input.fileId,
    status: "queued",
    title: file.filename,
    parser: DEFAULT_DOCUMENT_PARSER,
    updatedAt: now,
  }).returning();
  if (!row) throw new Error("Failed to create document");
  return mapDocument(row);
}

export async function listDocuments(db: Database, baseId: string): Promise<Document[]> {
  const rows = await db.select().from(schema.documents)
    .where(eq(schema.documents.baseId, baseId))
    .orderBy(asc(schema.documents.createdAt));
  return rows.map(mapDocument);
}

export async function getDocument(db: Database, documentId: string): Promise<Document | null> {
  const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
  return row ? mapDocument(row) : null;
}

export async function indexDocumentNow(
  db: Database,
  objectStorage: ObjectStorage,
  documentId: string,
  services: DocumentServices = createDocumentServices(),
): Promise<Document> {
  const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
  if (!document) throw new Error(`Document not found: ${documentId}`);
  const file = await requireReadyFile(db, document.fileId);
  await db.update(schema.documents).set({
    status: "indexing",
    parser: services.parser.name,
    error: null,
    updatedAt: new Date(),
  }).where(eq(schema.documents.id, documentId));
  try {
    const bytes = await objectStorage.getFileBytes(file);
    const parsed = await services.parser.parse(bytes, file);
    const chunks = services.chunker.chunk(parsed, file);
    const embeddings = await services.embedder.embedMany(chunks.map((chunk) => chunk.text));
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding provider returned ${embeddings.length} embeddings for ${chunks.length} chunks`);
    }
    await db.transaction(async (tx) => {
      await tx.delete(schema.documentChunks).where(eq(schema.documentChunks.documentId, documentId));
      if (chunks.length > 0) {
        await tx.insert(schema.documentChunks).values(chunks.map((chunk, index) => ({
          documentId,
          baseId: document.baseId,
          fileId: file.id,
          chunkIndex: index,
          text: chunk.text,
          metadata: chunk.metadata,
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
      }).where(eq(schema.documents.id, documentId));
    });
  } catch (error) {
    const [failed] = await db.update(schema.documents).set({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    }).where(eq(schema.documents.id, documentId)).returning();
    if (!failed) throw error;
    return mapDocument(failed);
  }
  const updated = await getDocument(db, documentId);
  if (!updated) throw new Error(`Document disappeared after indexing: ${documentId}`);
  return updated;
}

export async function searchDocuments(
  db: Database,
  input: { query: string; baseIds?: string[]; limit?: number },
  services: Pick<DocumentServices, "embedder"> = createDocumentServices(),
): Promise<DocumentSearchResult[]> {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const queryEmbedding = await services.embedder.embedQuery(input.query);
  validateEmbedding(queryEmbedding, services.embedder.dimensions, services.embedder.model);
  const distance = sql<number>`${schema.documentChunks.embedding} <=> ${vectorLiteral(queryEmbedding)}::vector`;
  const rows = await db.select({
    chunkId: schema.documentChunks.id,
    documentId: schema.documentChunks.documentId,
    baseId: schema.documentChunks.baseId,
    fileId: schema.documentChunks.fileId,
    title: schema.documents.title,
    text: schema.documentChunks.text,
    chunkIndex: schema.documentChunks.chunkIndex,
    metadata: schema.documentChunks.metadata,
    distance,
  }).from(schema.documentChunks)
    .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
    .where(and(
      eq(schema.documents.status, "ready"),
      eq(schema.documentChunks.embeddingModel, services.embedder.model),
      input.baseIds && input.baseIds.length > 0 ? inArray(schema.documentChunks.baseId, input.baseIds) : undefined,
    ))
    .orderBy(distance)
    .limit(limit);
  return rows.map((row) => ({
    chunkId: row.chunkId,
    documentId: row.documentId,
    baseId: row.baseId,
    fileId: row.fileId,
    title: row.title,
    text: row.text,
    score: 1 / (1 + Number(row.distance)),
    chunkIndex: row.chunkIndex,
    metadata: row.metadata,
  }));
}

export async function getDocumentChunk(db: Database, chunkId: string): Promise<DocumentSearchResult | null> {
  const [row] = await db.select({
    chunkId: schema.documentChunks.id,
    documentId: schema.documentChunks.documentId,
    baseId: schema.documentChunks.baseId,
    fileId: schema.documentChunks.fileId,
    title: schema.documents.title,
    text: schema.documentChunks.text,
    chunkIndex: schema.documentChunks.chunkIndex,
    metadata: schema.documentChunks.metadata,
  }).from(schema.documentChunks)
    .innerJoin(schema.documents, eq(schema.documentChunks.documentId, schema.documents.id))
    .where(and(eq(schema.documentChunks.id, chunkId), eq(schema.documents.status, "ready")))
    .limit(1);
  if (!row) return null;
  return {
    chunkId: row.chunkId,
    documentId: row.documentId,
    baseId: row.baseId,
    fileId: row.fileId,
    title: row.title,
    text: row.text,
    score: 1,
    chunkIndex: row.chunkIndex,
    metadata: row.metadata,
  };
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

async function requireReadyFile(db: Database, fileId: string): Promise<FileAsset> {
  const file = await requireFile(db, fileId);
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

function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function mapDocumentBase(row: typeof schema.documentBases.$inferSelect): DocumentBase {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapDocument(row: typeof schema.documents.$inferSelect): Document {
  return {
    id: row.id,
    baseId: row.baseId,
    fileId: row.fileId,
    status: row.status as Document["status"],
    title: row.title,
    parser: row.parser,
    chunkCount: row.chunkCount,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
