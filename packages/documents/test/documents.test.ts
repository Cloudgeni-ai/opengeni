import { describe, expect, test } from "bun:test";
import {
  DeterministicEmbeddingProvider,
  HeuristicCurationProvider,
  RecursiveTextChunker,
  canViewDocument,
  chunkText,
  deterministicEmbedding,
  documentOpenAIEmbeddingConfig,
  heuristicCuration,
  parseCurationOutcome,
  parseDocumentBytes,
  resolveDocumentAuthority,
} from "../src";

describe("documents", () => {
  test("fails closed for personal documents without the initiating subject", () => {
    const document = {
      authorityKind: "personal",
      authoritySubjectId: "subject:owner",
    } as const;
    expect(canViewDocument(document, undefined)).toBe(false);
    expect(canViewDocument(document, "subject:other")).toBe(false);
    expect(canViewDocument(document, "subject:owner")).toBe(true);
    expect(
      canViewDocument({ authorityKind: "workspace", authoritySubjectId: null }, undefined),
    ).toBe(true);
    expect(
      canViewDocument({ authorityKind: "organization", authoritySubjectId: null }, undefined),
    ).toBe(true);
  });

  test("resolves fixed authority tuples and deterministic legacy compatibility", () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    expect(resolveDocumentAuthority({ kind: "organization", workspaceId })).toEqual({
      kind: "organization",
      workspaceId: null,
      subjectId: null,
    });
    expect(resolveDocumentAuthority({ kind: "workspace", workspaceId })).toEqual({
      kind: "workspace",
      workspaceId,
      subjectId: null,
    });
    expect(
      resolveDocumentAuthority({
        legacyVisibility: "private",
        workspaceId,
        initiatingSubjectId: "subject:owner",
      }),
    ).toEqual({ kind: "personal", workspaceId, subjectId: "subject:owner" });
    expect(() =>
      resolveDocumentAuthority({ kind: "personal", workspaceId, initiatingSubjectId: null }),
    ).toThrow("personal documents require an initiating subject");
    expect(() =>
      resolveDocumentAuthority({
        kind: "organization",
        legacyVisibility: "private",
        workspaceId,
        initiatingSubjectId: "subject:owner",
      }),
    ).toThrow("conflicts with legacy visibility");
  });

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
      azureOpenaiDeployment: "gpt-5.6-sol",
      azureOpenaiApiKey: "azure-key",
      azureOpenaiApiVersion: "2025-04-01-preview",
      openaiApiKey: undefined,
      openaiBaseUrl: undefined,
    } as Parameters<typeof documentOpenAIEmbeddingConfig>[0]);

    expect(config).toMatchObject({
      apiKey: "azure-key",
      baseURL: "https://example.openai.azure.com/openai/deployments/gpt-5.6-sol",
      defaultQuery: { "api-version": "2025-04-01-preview" },
    });
  });
});

describe("document curation", () => {
  const bases = [
    { id: "11111111-1111-4111-8111-111111111111", name: "Engineering", description: "Eng docs" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Sales", description: null },
  ];

  test("heuristic curation names from the first meaningful line and summarizes", () => {
    const outcome = heuristicCuration(
      {
        text: "# Q3 Incident Review\n\nOn July 3rd the API returned 500s for 12 minutes because...",
        filename: "notes.txt",
        title: "notes.txt",
        bases,
      },
      "text/plain",
    );
    expect(outcome.title).toBe("Q3 Incident Review");
    expect(outcome.summary).toContain("Q3 Incident Review");
    expect(outcome.targetBaseId).toBeNull();
    expect(outcome.confidence).toBe(0);
  });

  test("heuristic curation falls back to the current title for unusable text", () => {
    const outcome = heuristicCuration(
      { text: "-\n*\n>", filename: "x.bin", title: "x.bin", bases: [] },
      "application/octet-stream",
    );
    expect(outcome.title).toBe("x.bin");
  });

  test("heuristic curation guesses source kind from filename/content type", async () => {
    const provider = new HeuristicCurationProvider();
    const transcript = await provider.curate({
      text: "00:01 Alice: welcome everyone",
      filename: "standup-transcript.vtt",
      title: "standup-transcript.vtt",
      bases: [],
    });
    expect(transcript.sourceKind).toBe("meeting_transcript");
    expect(provider.model).toBe("heuristic");
  });

  test("parseCurationOutcome clamps confidence and drops unknown base ids", () => {
    const outcome = parseCurationOutcome(
      JSON.stringify({
        title: "API Incident Postmortem",
        summary: "A postmortem of the July outage.",
        sourceKind: "document",
        topics: ["incident", "API ", "incident"],
        targetBaseId: "99999999-9999-4999-8999-999999999999",
        confidence: 3.5,
        reason: "looks like an eng doc",
      }),
      bases,
    );
    // Unknown base → no target and confidence zeroed, so no auto-file can happen.
    expect(outcome.targetBaseId).toBeNull();
    expect(outcome.confidence).toBe(0);
    expect(outcome.topics).toEqual(["incident", "api"]);
  });

  test("parseCurationOutcome accepts a known base and normalizes fields", () => {
    const outcome = parseCurationOutcome(
      JSON.stringify({
        title: "  Pricing Proposal  ",
        summary: "Draft pricing for enterprise tier.",
        sourceKind: "not-a-kind",
        topics: "nope",
        targetBaseId: bases[1]?.id,
        confidence: 0.9,
        reason: null,
      }),
      bases,
    );
    expect(outcome.title).toBe("Pricing Proposal");
    expect(outcome.targetBaseId).toBe(bases[1]?.id ?? "");
    expect(outcome.confidence).toBe(0.9);
    expect(outcome.sourceKind).toBe("other");
    expect(outcome.topics).toEqual([]);
  });

  test("parseCurationOutcome rejects non-object payloads", () => {
    expect(() => parseCurationOutcome("[]", bases)).toThrow();
    expect(() => parseCurationOutcome("null", bases)).toThrow("non-object");
  });
});
