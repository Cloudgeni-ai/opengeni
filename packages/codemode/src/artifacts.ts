import { randomBytes } from "node:crypto";

import type {
  DocumentArtifactId,
  DocumentArtifactIdKind,
  DocumentArtifactCommand,
  DocumentArtifactQuery,
  EditableArtifactStableId,
  PresentationArtifactCommand,
  PresentationArtifactQuery,
  SpreadsheetArtifactCommand,
  SpreadsheetArtifactKernelQuery,
} from "@opengeni/contracts/editable-artifacts";
import type { CodemodeCallOptions } from "./index";
import type { CodemodeClientProvider } from "./environment";
import { callStructured } from "./structured";

const PATH = {
  list: ["artifacts", "list"],
  create: ["artifacts", "create"],
  import: ["artifacts", "import"],
  get: ["artifacts", "get"],
  inspect: ["artifacts", "inspect"],
  apply: ["artifacts", "apply"],
  export: ["artifacts", "export"],
  exportStatus: ["artifacts", "exportStatus"],
} as const;

export type CodemodeArtifactModality = "spreadsheet" | "document" | "presentation";
export type CodemodeArtifactFormat = "xlsx" | "pptx" | "docx" | "pdf" | "png" | "webp";
export type CodemodeArtifactMetadata = Readonly<{
  id: string;
  modality: CodemodeArtifactModality;
  title: string;
  lifecycle: "active" | "archived";
  headSequence: number;
  stateHash: string;
  createdAt: string;
  updatedAt: string;
}>;
export type CodemodeArtifactQuery =
  | SpreadsheetArtifactKernelQuery
  | DocumentArtifactQuery
  | PresentationArtifactQuery;
export type CodemodeArtifactCommand =
  | SpreadsheetArtifactCommand
  | DocumentArtifactCommand
  | PresentationArtifactCommand;
export type CodemodeArtifactMutationReceipt = Readonly<{
  artifact: CodemodeArtifactMetadata;
  transaction: Readonly<{
    id: string;
    clientTransactionId: string;
    sequenceStart: number;
    sequenceEnd: number;
    stateHash: string;
    committedAt: string;
    replayed: boolean;
  }>;
}>;
export type CodemodeArtifactExportFile = Readonly<{
  fileId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  artifactId: string;
  versionId: string;
  materializationJobId: string;
  sourceHeadSequence: number;
  sourceStateHash: string;
}>;
export type CodemodeArtifactExportStatus = Readonly<{
  artifact: CodemodeArtifactMetadata;
  versionId: string;
  jobId: string;
  sourceHeadSequence: number;
  sourceStateHash: string;
  state: "pending" | "running" | "succeeded" | "failed";
  errorCode: string | null;
  file: CodemodeArtifactExportFile | null;
}>;

export type CodemodeArtifactIdFactory = Readonly<{
  /** Create a nonzero 128-bit id accepted by spreadsheet and presentation commands. */
  stable(): EditableArtifactStableId;
  /** Create a document object id in the namespace returned by a summary query. */
  document(kind: DocumentArtifactIdKind, namespace: bigint | number | string): DocumentArtifactId;
}>;

export const codemodeArtifactIds: CodemodeArtifactIdFactory = Object.freeze({
  stable: createStableArtifactId,
  document: createDocumentArtifactId,
});

/** Authored CodeMode collection over the exact MCP-backed artifact operations. */
export class CodemodeArtifactCollection {
  readonly ids = codemodeArtifactIds;

  constructor(private readonly client: CodemodeClientProvider) {}

  async list(
    options: { limit?: number | undefined } = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeArtifactMetadata[]> {
    return (
      await callStructured<{ artifacts: CodemodeArtifactMetadata[] }>(
        this.client,
        PATH.list,
        options,
        callOptions,
      )
    ).artifacts;
  }

  async create(
    modality: CodemodeArtifactModality,
    title: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeArtifact> {
    const metadata = await callStructured<CodemodeArtifactMetadata>(
      this.client,
      PATH.create,
      { modality, title },
      callOptions,
    );
    return new CodemodeArtifact(this.client, metadata.id, metadata);
  }

  async import(
    fileId: string,
    modality: CodemodeArtifactModality,
    title: string,
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeArtifact> {
    const metadata = await callStructured<CodemodeArtifactMetadata>(
      this.client,
      PATH.import,
      { fileId, modality, title },
      callOptions,
    );
    return new CodemodeArtifact(this.client, metadata.id, metadata);
  }

  use(artifact: string | CodemodeArtifactMetadata): CodemodeArtifact {
    return typeof artifact === "string"
      ? new CodemodeArtifact(this.client, artifact)
      : new CodemodeArtifact(this.client, artifact.id, artifact);
  }
}

const DOCUMENT_ID_PREFIX = Object.freeze({
  paragraph: "p",
  table: "dt",
  "page-break": "pb",
  section: "sec",
  header: "hdr",
  footer: "ftr",
  comment: "dc",
  "tracked-change": "chg",
} satisfies Readonly<Record<DocumentArtifactIdKind, string>>);
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_DOCUMENT_COUNTER = BigInt(Number.MAX_SAFE_INTEGER) - 1n;

function createStableArtifactId(): EditableArtifactStableId {
  const bytes = randomBytes(16);
  if (bytes.subarray(0, 8).every((byte) => byte === 0)) bytes[0] = 1;
  if (bytes.subarray(8, 16).every((byte) => byte === 0)) bytes[8] = 1;
  return bytes.toString("hex") as EditableArtifactStableId;
}

function createDocumentArtifactId(
  kind: DocumentArtifactIdKind,
  namespaceInput: bigint | number | string,
): DocumentArtifactId {
  const namespace = parseDocumentNamespace(namespaceInput);
  const bytes = randomBytes(7);
  bytes[0] = (bytes[0] ?? 0) & 0x1f;
  let counter = 0n;
  for (const byte of bytes) counter = (counter << 8n) | BigInt(byte);
  if (counter === 0n) counter = 1n;
  if (counter > MAX_DOCUMENT_COUNTER) {
    throw new Error("Generated document id counter exceeds the canonical limit");
  }
  return `${DOCUMENT_ID_PREFIX[kind]}/${namespace.toString(16).padStart(16, "0")}${counter
    .toString(16)
    .padStart(16, "0")}`;
}

function parseDocumentNamespace(input: bigint | number | string): bigint {
  if (
    (typeof input === "number" && (!Number.isSafeInteger(input) || input < 0)) ||
    (typeof input === "string" && !/^(?:0|[1-9][0-9]*)$/u.test(input))
  ) {
    throw new TypeError("Document id namespace must be an unsigned decimal integer");
  }
  const namespace = BigInt(input);
  if (namespace < 0n || namespace > MAX_U64) {
    throw new RangeError("Document id namespace is outside the uint64 range");
  }
  return namespace;
}

export class CodemodeArtifact {
  private metadata: CodemodeArtifactMetadata | null;

  constructor(
    private readonly client: CodemodeClientProvider,
    readonly id: string,
    metadata: CodemodeArtifactMetadata | null = null,
  ) {
    this.metadata = metadata;
  }

  async get(callOptions: CodemodeCallOptions = {}): Promise<CodemodeArtifactMetadata> {
    const metadata = await callStructured<CodemodeArtifactMetadata>(
      this.client,
      PATH.get,
      { artifactId: this.id },
      callOptions,
    );
    this.metadata = metadata;
    return metadata;
  }

  async inspect<T = unknown>(
    query: CodemodeArtifactQuery,
    callOptions: CodemodeCallOptions = {},
  ): Promise<Readonly<{ artifact: CodemodeArtifactMetadata; projection: T }>> {
    const modality = (await this.currentMetadata(callOptions)).modality;
    const result = await callStructured<{
      artifact: CodemodeArtifactMetadata;
      projection: T;
    }>(this.client, PATH.inspect, { artifactId: this.id, modality, query }, callOptions);
    this.metadata = result.artifact;
    return result;
  }

  async apply(
    commands: readonly CodemodeArtifactCommand[],
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeArtifactMutationReceipt> {
    const metadata = await this.currentMetadata(callOptions);
    const result = await callStructured<CodemodeArtifactMutationReceipt>(
      this.client,
      PATH.apply,
      {
        artifactId: this.id,
        modality: metadata.modality,
        expectedHeadSequence: metadata.headSequence,
        expectedStateHash: metadata.stateHash,
        commands,
      },
      callOptions,
    );
    this.metadata = result.artifact;
    return result;
  }

  async export(
    format: CodemodeArtifactFormat,
    options: Readonly<Record<string, unknown>> = {},
    callOptions: CodemodeCallOptions = {},
  ): Promise<CodemodeArtifactExport> {
    const started = await callStructured<{
      artifact: CodemodeArtifactMetadata;
      versionId: string;
      jobId: string;
      sourceHeadSequence: number;
      sourceStateHash: string;
      state: "pending" | "running" | "succeeded" | "failed";
    }>(this.client, PATH.export, { artifactId: this.id, format, options }, callOptions);
    this.metadata = started.artifact;
    return new CodemodeArtifactExport(
      this.client,
      started.artifact.id,
      started.versionId,
      started.jobId,
      started.sourceHeadSequence,
      started.sourceStateHash,
    );
  }

  private async currentMetadata(
    callOptions: CodemodeCallOptions,
  ): Promise<CodemodeArtifactMetadata> {
    return this.metadata ?? (await this.get(callOptions));
  }
}

export class CodemodeArtifactExport {
  constructor(
    private readonly client: CodemodeClientProvider,
    readonly artifactId: string,
    readonly versionId: string,
    readonly jobId: string,
    readonly sourceHeadSequence: number,
    readonly sourceStateHash: string,
  ) {}

  async status(callOptions: CodemodeCallOptions = {}): Promise<CodemodeArtifactExportStatus> {
    return await callStructured(
      this.client,
      PATH.exportStatus,
      {
        artifactId: this.artifactId,
        versionId: this.versionId,
        jobId: this.jobId,
      },
      callOptions,
    );
  }
}
