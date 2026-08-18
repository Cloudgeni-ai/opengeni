import { UnsupportedArtifactFeatureError } from "./errors";
import { FileBlob } from "./file-blob";

export type ArtifactModality = "spreadsheet" | "presentation" | "document";
export type ArtifactKernelKind = "native" | "wasm" | "reference";
export type ArtifactObjectId = string & { readonly __artifactObjectId: unique symbol };

export type ArtifactKernelCapabilities = {
  modality: ArtifactModality;
  modelSchemaVersion: number;
  operationSchemaVersion: number;
  inspect: boolean;
  calculate: boolean;
  layout: boolean;
  renderFormats: readonly string[];
  importFormats: readonly string[];
  exportFormats: readonly string[];
  collaboration: boolean;
};

export type ArtifactCausalVector = Readonly<Record<string, number>>;

export type ArtifactCommand = {
  code: string;
  targetId?: string;
  precondition?: {
    objectRevision?: number;
    exists?: boolean;
  };
  payload?: unknown;
};

export type ArtifactCommandBatch = {
  schemaVersion: 1;
  artifactId: string;
  modality: ArtifactModality;
  transactionId: string;
  actorId: string;
  baseSequence: number;
  baseVector: ArtifactCausalVector;
  commands: readonly ArtifactCommand[];
};

export type ArtifactApplyResult = {
  sequence: number;
  vector: ArtifactCausalVector;
  changedObjectIds: readonly string[];
  inverse?: ArtifactCommandBatch;
};

export type ArtifactKernelOpenInput = {
  modality: ArtifactModality;
  snapshot?: Uint8Array;
  operationTail?: readonly Uint8Array[];
};

export type ArtifactKernelDocument = {
  readonly modality: ArtifactModality;
  readonly revision: number;
  apply(batch: ArtifactCommandBatch): ArtifactApplyResult;
  snapshot(): Uint8Array;
  inspect(options: Record<string, unknown>): Promise<readonly Record<string, unknown>[]>;
  render(options: Record<string, unknown>): Promise<FileBlob>;
  materialize(format: string, options?: Record<string, unknown>): Promise<FileBlob>;
  close(): void;
};

export interface ArtifactKernel {
  readonly kind: ArtifactKernelKind;
  readonly version: string;
  capabilities(modality: ArtifactModality): ArtifactKernelCapabilities;
  open(input: ArtifactKernelOpenInput): Promise<ArtifactKernelDocument>;
}

export type ArtifactKernelSelection = {
  kernel: ArtifactKernel;
  capabilities: ArtifactKernelCapabilities;
};

/**
 * Kernel registry used by the universal facade. Hosts register loaders without
 * making application code depend on platform packages. Production selection is
 * deliberately fail-closed: Node/Bun selects only native. Browser editing goes
 * through the SDK's dedicated Worker/WASM session, and the reference backend is
 * selected only when a development/conformance caller explicitly asks for it.
 */
export class ArtifactKernelRegistry {
  private readonly kernels = new Map<ArtifactKernelKind, ArtifactKernel>();

  register(kernel: ArtifactKernel): () => void {
    if (this.kernels.has(kernel.kind))
      throw new Error(`Artifact ${kernel.kind} kernel already registered`);
    this.kernels.set(kernel.kind, kernel);
    return () => {
      if (this.kernels.get(kernel.kind) === kernel) this.kernels.delete(kernel.kind);
    };
  }

  select(
    modality: ArtifactModality,
    required: Partial<
      Pick<ArtifactKernelCapabilities, "calculate" | "layout" | "collaboration">
    > = {},
    order: readonly ArtifactKernelKind[] = defaultKernelOrder(),
  ): ArtifactKernelSelection {
    for (const kind of order) {
      const kernel = this.kernels.get(kind);
      if (!kernel) continue;
      const capabilities = kernel.capabilities(modality);
      if (required.calculate === true && !capabilities.calculate) continue;
      if (required.layout === true && !capabilities.layout) continue;
      if (required.collaboration === true && !capabilities.collaboration) continue;
      return { kernel, capabilities };
    }
    throw new UnsupportedArtifactFeatureError(
      modality,
      "required kernel capabilities",
      "available",
    );
  }

  available(): readonly ArtifactKernel[] {
    return [...this.kernels.values()];
  }
}

function defaultKernelOrder(): readonly ArtifactKernelKind[] {
  return typeof window === "undefined" ? ["native"] : [];
}
