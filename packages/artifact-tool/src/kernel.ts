import { ArtifactLimitError, UnsupportedArtifactFeatureError } from "./errors";
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

export const ARTIFACT_OPERATION_MAX_BYTES = 1024 * 1024;
export const ARTIFACT_OPERATION_MAX_COMMANDS = 10_000;
export const ARTIFACT_OPERATION_MAX_VECTOR_ACTORS = 1_024;
export const ARTIFACT_OPERATION_MAX_STRING_BYTES = 256 * 1024;
export const ARTIFACT_OPERATION_MAX_JSON_DEPTH = 64;
export const ARTIFACT_OPERATION_MAX_JSON_NODES = 100_000;
const OPERATION_MAGIC = new Uint8Array([0x4f, 0x47, 0x41, 0x52]); // OGAR
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Deterministic codec retained only for historical TypeScript conformance
 * fixtures.
 *
 * @deprecated OGAR duplicates authored identity/causality and must never be
 * persisted, submitted, or lowered by a production runtime. Use the canonical
 * OGATX001 envelope with an identity-free OGASC001 command payload from
 * `@opengeni/contracts/editable-artifacts`.
 */
export const ArtifactCommandBatchCodec = {
  encode(batch: ArtifactCommandBatch): Uint8Array {
    validateBatch(batch);
    const writer = new BinaryWriter(ARTIFACT_OPERATION_MAX_BYTES);
    writer.bytes(OPERATION_MAGIC);
    writer.varint(batch.schemaVersion);
    writer.varint(modalityCode(batch.modality));
    writer.string(batch.artifactId);
    writer.string(batch.transactionId);
    writer.string(batch.actorId);
    writer.varint(batch.baseSequence);
    const vector = Object.entries(batch.baseVector).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    writer.varint(vector.length);
    for (const [actor, counter] of vector) {
      writer.string(actor);
      writer.varint(counter);
    }
    writer.varint(batch.commands.length);
    for (const command of batch.commands) {
      writer.string(command.code);
      writer.string(command.targetId ?? "");
      let flags = 0;
      if (command.precondition?.objectRevision !== undefined) flags |= 1;
      if (command.precondition?.exists !== undefined) flags |= 2;
      if (command.payload !== undefined) flags |= 4;
      writer.byte(flags);
      if ((flags & 1) !== 0) writer.varint(command.precondition!.objectRevision!);
      if ((flags & 2) !== 0) writer.byte(command.precondition!.exists ? 1 : 0);
      if ((flags & 4) !== 0) writer.string(canonicalJson(command.payload));
    }
    return writer.finish();
  },

  decode(bytes: Uint8Array): ArtifactCommandBatch {
    if (bytes.byteLength > ARTIFACT_OPERATION_MAX_BYTES) {
      throw new ArtifactLimitError(
        "operation bytes",
        bytes.byteLength,
        ARTIFACT_OPERATION_MAX_BYTES,
      );
    }
    const reader = new BinaryReader(bytes);
    const magic = reader.bytes(OPERATION_MAGIC.length);
    if (!magic.every((value, index) => value === OPERATION_MAGIC[index])) {
      throw new Error("Invalid artifact operation magic");
    }
    const schemaVersion = reader.varint();
    if (schemaVersion !== 1)
      throw new Error(`Unsupported artifact operation schema: ${schemaVersion}`);
    const modality = modalityFromCode(reader.varint());
    const artifactId = reader.string();
    const transactionId = reader.string();
    const actorId = reader.string();
    const baseSequence = reader.varint();
    const vectorCount = reader.varint();
    if (vectorCount > ARTIFACT_OPERATION_MAX_VECTOR_ACTORS) {
      throw new ArtifactLimitError(
        "causal vector actors",
        vectorCount,
        ARTIFACT_OPERATION_MAX_VECTOR_ACTORS,
      );
    }
    const vectorEntries: Array<readonly [string, number]> = [];
    let previousActor = "";
    for (let index = 0; index < vectorCount; index += 1) {
      const actor = reader.string();
      if (actor <= previousActor) {
        throw new Error("Causal vector actors must be unique and sorted");
      }
      previousActor = actor;
      vectorEntries.push([actor, reader.varint()]);
    }
    // Object.fromEntries defines data properties instead of invoking the legacy
    // `__proto__` setter. Actor identifiers therefore round-trip without
    // mutating the vector object's prototype or silently losing an entry.
    const baseVector = Object.fromEntries(vectorEntries);
    const commandCount = reader.varint();
    if (commandCount > ARTIFACT_OPERATION_MAX_COMMANDS) {
      throw new ArtifactLimitError(
        "operation commands",
        commandCount,
        ARTIFACT_OPERATION_MAX_COMMANDS,
      );
    }
    const commands: ArtifactCommand[] = [];
    for (let index = 0; index < commandCount; index += 1) {
      const code = reader.string();
      const targetId = reader.string();
      const flags = reader.byte();
      if ((flags & ~7) !== 0) throw new Error("Unknown artifact command flags");
      const objectRevision = (flags & 1) !== 0 ? reader.varint() : undefined;
      let exists: boolean | undefined;
      if ((flags & 2) !== 0) {
        const encodedExists = reader.byte();
        if (encodedExists > 1) {
          throw new Error("Artifact command boolean uses a non-canonical encoding");
        }
        exists = encodedExists === 1;
      }
      const payload = (flags & 4) !== 0 ? parseCanonicalJson(reader.string()) : undefined;
      commands.push({
        code,
        ...(targetId ? { targetId } : {}),
        ...(objectRevision !== undefined || exists !== undefined
          ? {
              precondition: {
                ...(objectRevision !== undefined ? { objectRevision } : {}),
                ...(exists !== undefined ? { exists } : {}),
              },
            }
          : {}),
        ...(payload !== undefined ? { payload } : {}),
      });
    }
    reader.done();
    const batch: ArtifactCommandBatch = {
      schemaVersion: 1,
      artifactId,
      modality,
      transactionId,
      actorId,
      baseSequence,
      baseVector,
      commands,
    };
    validateBatch(batch);
    return batch;
  },
};

function validateBatch(batch: ArtifactCommandBatch): void {
  if (batch.schemaVersion !== 1) throw new Error("Artifact operation schema must be 1");
  for (const [label, value] of [
    ["artifactId", batch.artifactId],
    ["transactionId", batch.transactionId],
    ["actorId", batch.actorId],
  ] as const) {
    if (!value || value.length > 512) throw new Error(`${label} must contain 1-512 characters`);
  }
  assertSafeInteger(batch.baseSequence, "baseSequence");
  const vector = Object.entries(batch.baseVector);
  if (vector.length > ARTIFACT_OPERATION_MAX_VECTOR_ACTORS) {
    throw new ArtifactLimitError(
      "causal vector actors",
      vector.length,
      ARTIFACT_OPERATION_MAX_VECTOR_ACTORS,
    );
  }
  for (const [actor, counter] of vector) {
    if (!actor || actor.length > 512)
      throw new Error("Causal vector actor must contain 1-512 characters");
    assertSafeInteger(counter, `baseVector.${actor}`);
  }
  if (batch.commands.length > ARTIFACT_OPERATION_MAX_COMMANDS) {
    throw new ArtifactLimitError(
      "operation commands",
      batch.commands.length,
      ARTIFACT_OPERATION_MAX_COMMANDS,
    );
  }
  if (batch.commands.length === 0) throw new Error("Artifact command batch must not be empty");
  for (const command of batch.commands) {
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(command.code))
      throw new Error(`Invalid artifact command code: ${command.code}`);
    if (
      command.targetId !== undefined &&
      (command.targetId.length === 0 || command.targetId.length > 512)
    ) {
      throw new Error("Artifact command target id must contain 1-512 characters");
    }
    if (command.precondition?.objectRevision !== undefined) {
      assertSafeInteger(command.precondition.objectRevision, "objectRevision");
    }
  }
}

function defaultKernelOrder(): readonly ArtifactKernelKind[] {
  return typeof window === "undefined" ? ["native"] : [];
}

function modalityCode(modality: ArtifactModality): number {
  return { spreadsheet: 1, presentation: 2, document: 3 }[modality];
}

function modalityFromCode(value: number): ArtifactModality {
  if (value === 1) return "spreadsheet";
  if (value === 2) return "presentation";
  if (value === 3) return "document";
  throw new Error(`Unknown artifact modality code: ${value}`);
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, { nodes: 0 }, 0));
}

function canonicalValue(value: unknown, state: { nodes: number }, depth: number): unknown {
  state.nodes += 1;
  if (state.nodes > ARTIFACT_OPERATION_MAX_JSON_NODES) {
    throw new ArtifactLimitError(
      "operation JSON nodes",
      state.nodes,
      ARTIFACT_OPERATION_MAX_JSON_NODES,
    );
  }
  if (depth > ARTIFACT_OPERATION_MAX_JSON_DEPTH) {
    throw new ArtifactLimitError("operation JSON depth", depth, ARTIFACT_OPERATION_MAX_JSON_DEPTH);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Artifact command JSON cannot contain non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) {
      throw new Error("Artifact command payload arrays must be dense JSON arrays");
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("Artifact command payload arrays must contain data properties");
      }
      output.push(canonicalValue(descriptor.value, state, depth + 1));
    }
    return output;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error("Artifact command payload must be plain JSON");
    const record = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("Artifact command payload cannot contain symbol properties");
    }
    return Object.fromEntries(
      (keys as string[]).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Artifact command payload properties must be enumerable data properties");
        }
        return [key, canonicalValue(descriptor.value, state, depth + 1)];
      }),
    );
  }
  throw new Error(`Artifact command payload contains unsupported ${typeof value}`);
}

function parseCanonicalJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  if (canonicalJson(parsed) !== value)
    throw new Error("Artifact command payload is not canonical JSON");
  return parsed;
}

class BinaryWriter {
  private buffer = new Uint8Array(1_024);
  private length = 0;
  constructor(private readonly maximum: number) {}

  byte(value: number): void {
    this.ensure(1);
    this.buffer[this.length++] = value;
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.byteLength);
    this.buffer.set(value, this.length);
    this.length += value.byteLength;
  }

  varint(value: number): void {
    assertSafeInteger(value, "varint");
    let remaining = BigInt(value);
    do {
      let byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining > 0n) byte |= 0x80;
      this.byte(byte);
    } while (remaining > 0n);
  }

  string(value: string): void {
    const bytes = textEncoder.encode(value);
    if (bytes.byteLength > ARTIFACT_OPERATION_MAX_STRING_BYTES) {
      throw new ArtifactLimitError(
        "operation string bytes",
        bytes.byteLength,
        ARTIFACT_OPERATION_MAX_STRING_BYTES,
      );
    }
    this.varint(bytes.byteLength);
    this.bytes(bytes);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }

  private ensure(extra: number): void {
    const required = this.length + extra;
    if (required > this.maximum)
      throw new ArtifactLimitError("operation bytes", required, this.maximum);
    if (required <= this.buffer.byteLength) return;
    let nextSize = this.buffer.byteLength;
    while (nextSize < required) nextSize = Math.min(this.maximum, nextSize * 2);
    const next = new Uint8Array(nextSize);
    next.set(this.buffer);
    this.buffer = next;
  }
}

class BinaryReader {
  private offset = 0;
  constructor(private readonly input: Uint8Array) {}

  byte(): number {
    const value = this.input[this.offset];
    if (value === undefined) throw new Error("Truncated artifact operation");
    this.offset += 1;
    return value;
  }

  bytes(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.input.byteLength
    ) {
      throw new Error("Truncated artifact operation bytes");
    }
    const value = this.input.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  varint(): number {
    let value = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (index > 0 && byte === 0) {
          throw new Error("Artifact operation varint is non-canonical");
        }
        const number = Number(value);
        if (!Number.isSafeInteger(number))
          throw new Error("Artifact operation varint exceeds safe integer");
        return number;
      }
      shift += 7n;
    }
    throw new Error("Invalid artifact operation varint");
  }

  string(): string {
    const length = this.varint();
    if (length > ARTIFACT_OPERATION_MAX_STRING_BYTES) {
      throw new ArtifactLimitError(
        "operation string bytes",
        length,
        ARTIFACT_OPERATION_MAX_STRING_BYTES,
      );
    }
    return textDecoder.decode(this.bytes(length));
  }

  done(): void {
    if (this.offset !== this.input.byteLength)
      throw new Error("Artifact operation has trailing bytes");
  }
}
