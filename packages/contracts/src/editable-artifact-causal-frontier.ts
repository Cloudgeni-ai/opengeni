import {
  ArtifactBinaryReader,
  ArtifactBinaryWriter,
  equalBytes,
  fnv1a64,
  positiveSafeInteger,
  strictUtf8,
} from "./editable-artifact-binary";

export const EDITABLE_ARTIFACT_CAUSAL_FRONTIER_VERSION = 1 as const;
/** Exact effective Rust OGACF001 bound (`MAX_INTENT_CAUSAL_ACTORS`). */
export const EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS = 1_024;
export const EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_BYTES =
  8 + 2 + 2 + 4 + EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS * 16 + 8;

const MAGIC = strictUtf8("OGACF001", "causal frontier magic");
const REPLICA_ID = /^[0-9a-f]{16}$/u;
const HEADER_BYTES = 16;
const CHECKSUM_BYTES = 8;

export type EditableArtifactCausalFrontierEntry = Readonly<{
  replicaId: string;
  counter: number;
}>;

export type EditableArtifactCausalFrontier = readonly EditableArtifactCausalFrontierEntry[];

export function encodeEditableArtifactCausalFrontier(
  frontier: EditableArtifactCausalFrontier,
): Uint8Array {
  const entries = normalizeFrontier(frontier);
  const writer = new ArtifactBinaryWriter(EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_BYTES);
  writer.bytes(MAGIC);
  writer.u16(EDITABLE_ARTIFACT_CAUSAL_FRONTIER_VERSION);
  writer.u16(0);
  writer.u32(entries.length);
  for (const entry of entries) {
    writer.u64(BigInt(`0x${entry.replicaId}`));
    writer.u64(entry.counter);
  }
  writer.u64(fnv1a64(writer.view()));
  return writer.finish();
}

export function decodeEditableArtifactCausalFrontier(
  bytes: Uint8Array,
): EditableArtifactCausalFrontier {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError("causal frontier bytes must be a Uint8Array");
  if (bytes.byteLength > EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_BYTES) {
    throw new RangeError("causal frontier exceeds its byte limit");
  }
  if (bytes.byteLength < HEADER_BYTES + CHECKSUM_BYTES) {
    throw new TypeError("truncated causal frontier");
  }
  const reader = new ArtifactBinaryReader(bytes);
  if (!equalBytes(reader.bytes(8), MAGIC)) throw new TypeError("invalid causal frontier magic");
  const version = reader.u16();
  if (version !== EDITABLE_ARTIFACT_CAUSAL_FRONTIER_VERSION) {
    throw new TypeError(`unsupported causal frontier version: ${version}`);
  }
  if (reader.u16() !== 0) throw new TypeError("reserved causal frontier flags must be zero");
  const count = reader.u32();
  if (count > EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS) {
    throw new RangeError("causal frontier exceeds its replica limit");
  }
  const expected = HEADER_BYTES + count * 16 + CHECKSUM_BYTES;
  if (bytes.byteLength < expected) throw new TypeError("truncated causal frontier");
  if (bytes.byteLength > expected) throw new TypeError("causal frontier contains trailing bytes");
  if (fnv1a64(bytes.subarray(0, -CHECKSUM_BYTES)) !== readU64At(bytes, expected - CHECKSUM_BYTES)) {
    throw new TypeError("causal frontier checksum does not match");
  }
  const entries: EditableArtifactCausalFrontierEntry[] = [];
  let previous = 0n;
  for (let index = 0; index < count; index += 1) {
    const replica = reader.u64BigInt();
    const counter = reader.u64Safe("causal frontier counter");
    if (replica === 0n || replica <= previous || counter === 0) {
      throw new TypeError("causal frontier entries must be nonzero and strictly ordered");
    }
    previous = replica;
    entries.push(
      Object.freeze({
        replicaId: replica.toString(16).padStart(16, "0"),
        counter,
      }),
    );
  }
  reader.u64BigInt();
  reader.done();
  return Object.freeze(entries);
}

export function assertCanonicalEditableArtifactCausalFrontierBytes(bytes: Uint8Array): void {
  const decoded = decodeEditableArtifactCausalFrontier(bytes);
  if (!equalBytes(bytes, encodeEditableArtifactCausalFrontier(decoded))) {
    throw new TypeError("causal frontier is not canonically encoded");
  }
}

function normalizeFrontier(
  frontier: EditableArtifactCausalFrontier,
): EditableArtifactCausalFrontier {
  if (!Array.isArray(frontier)) throw new TypeError("causal frontier must be an array");
  if (frontier.length > EDITABLE_ARTIFACT_CAUSAL_FRONTIER_MAX_REPLICAS) {
    throw new RangeError("causal frontier exceeds its replica limit");
  }
  let previous = "";
  const entries: EditableArtifactCausalFrontierEntry[] = [];
  for (const entry of frontier) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)
    ) {
      throw new TypeError("causal frontier entries must be records");
    }
    const keys = Reflect.ownKeys(entry);
    if (
      keys.length !== 2 ||
      keys.some((key) => typeof key !== "string") ||
      !(keys as string[]).includes("counter") ||
      !(keys as string[]).includes("replicaId")
    ) {
      throw new TypeError("causal frontier entry fields must be exactly counter and replicaId");
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("causal frontier entries must contain enumerable data properties");
      }
    }
    if (!REPLICA_ID.test(entry.replicaId) || entry.replicaId === "0000000000000000") {
      throw new TypeError("causal frontier replicaId must be canonical nonzero lowercase hex");
    }
    if (entry.replicaId <= previous) {
      throw new TypeError("causal frontier replica ids must be unique and strictly ordered");
    }
    previous = entry.replicaId;
    entries.push(
      Object.freeze({
        replicaId: entry.replicaId,
        counter: positiveSafeInteger(entry.counter, "causal frontier counter"),
      }),
    );
  }
  return Object.freeze(entries);
}

function readU64At(bytes: Uint8Array, offset: number): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(offset, true);
}
