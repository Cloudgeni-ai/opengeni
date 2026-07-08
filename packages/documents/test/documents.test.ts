import { describe, expect, test } from "bun:test";
import {
  DeterministicEmbeddingProvider,
  RecursiveTextChunker,
  chunkText,
  deterministicEmbedding,
  documentOpenAIEmbeddingConfig,
  parseDocumentBytes,
} from "../src";

describe("documents", () => {
  test("parses uploaded text bytes into normalized document text", async () => {
    const parsed = await parseDocumentBytes(new TextEncoder().encode("  hello\0 world  "), {
      id: "file-1",
      filename: "notes.txt",
      safeFilename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 14,
      status: "ready",
      bucket: "opengeni-files",
      objectKey: "files/file-1/original/notes.txt",
      sha256: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(parsed.text).toBe("hello  world");
  });

  test("rejects empty parsed documents", async () => {
    await expect(
      parseDocumentBytes(new TextEncoder().encode("   "), {
        id: "file-1",
        filename: "empty.txt",
        safeFilename: "empty.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        status: "ready",
        bucket: "opengeni-files",
        objectKey: "files/file-1/original/empty.txt",
        sha256: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Parsed document is empty");
  });

  test("delegates non-text documents to the configured parser", async () => {
    const parsed = await parseDocumentBytes(
      new Uint8Array([1, 2, 3]),
      {
        id: "file-1",
        filename: "scan.pdf",
        safeFilename: "scan.pdf",
        contentType: "application/pdf",
        sizeBytes: 3,
        status: "ready",
        bucket: "opengeni-files",
        objectKey: "files/file-1/original/scan.pdf",
        sha256: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        name: "fake-parser",
        parse: async () => ({ text: "parsed pdf text", metadata: { page: 1 } }),
      },
    );
    expect(parsed).toEqual({ text: "parsed pdf text", metadata: { page: 1 } });
  });

  test("surfaces parser failures for unsupported binary documents", async () => {
    await expect(
      parseDocumentBytes(
        new Uint8Array([1, 2, 3]),
        {
          id: "file-1",
          filename: "scan.png",
          safeFilename: "scan.png",
          contentType: "image/png",
          sizeBytes: 3,
          status: "ready",
          bucket: "opengeni-files",
          objectKey: "files/file-1/original/scan.png",
          sha256: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          name: "fake-parser",
          parse: async () => {
            throw new Error("Unsupported document type");
          },
        },
      ),
    ).rejects.toThrow("Unsupported document type");
  });

  test("chunks text with paragraph boundaries and stable overlap", () => {
    const chunks = chunkText("alpha beta gamma\n\n delta epsilon zeta", 18, 6);
    expect(chunks).toEqual(["alpha beta gamma", "delta epsilon zeta"]);
  });

  test("chunker preserves parser and file metadata", () => {
    const chunks = new RecursiveTextChunker(80, 10).chunk(
      {
        text: "network policy runbook",
        metadata: { parser: "fake" },
      },
      {
        id: "file-1",
        filename: "runbook.txt",
        safeFilename: "runbook.txt",
        contentType: "text/plain",
        sizeBytes: 22,
        status: "ready",
        bucket: "opengeni-files",
        objectKey: "files/file-1/original/runbook.txt",
        sha256: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    );
    expect(chunks[0]?.metadata).toMatchObject({
      parser: "fake",
      filename: "runbook.txt",
      chunkIndex: 0,
    });
  });

  test("embeds text into deterministic unit-length vectors", async () => {
    const first = deterministicEmbedding("network policy network", 32);
    const second = await new DeterministicEmbeddingProvider(32).embedQuery(
      "network policy network",
    );
    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    expect(Math.hypot(...first)).toBeCloseTo(1, 5);
  });

  test("resolves Azure OpenAI config for document embeddings", () => {
    const config = documentOpenAIEmbeddingConfig({
      openaiProvider: "azure",
      azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      azureOpenaiApiKey: "azure-key",
      azureOpenaiApiVersion: "2025-04-01-preview",
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
    } as Parameters<typeof documentOpenAIEmbeddingConfig>[0]);
    expect(config).toMatchObject({
      apiKey: "azure-key",
      baseURL: "https://example.openai.azure.com/openai/v1",
    });
    expect(config.defaultQuery).toBeUndefined();
  });

  test("keeps Azure api-version for deployment-style document embedding base URLs", () => {
    const config = documentOpenAIEmbeddingConfig({
      openaiProvider: "azure",
      azureOpenaiEndpoint: "https://example.openai.azure.com",
      azureOpenaiDeployment: "gpt-5.5",
      azureOpenaiApiKey: "azure-key",
      azureOpenaiApiVersion: "2025-04-01-preview",
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
    } as Parameters<typeof documentOpenAIEmbeddingConfig>[0]);

    expect(config).toMatchObject({
      apiKey: "azure-key",
      baseURL: "https://example.openai.azure.com/openai/deployments/gpt-5.5",
      defaultQuery: { "api-version": "2025-04-01-preview" },
    });
  });
});
