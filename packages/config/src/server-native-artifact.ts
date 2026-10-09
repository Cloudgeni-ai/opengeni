import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { readImmutableServerSourceSha } from "./server-source-identity";

const artifactBrand: unique symbol = Symbol("immutable-server-native-artifact");
const measuredBytes = new WeakMap<object, Buffer>();
const maximumBytes = 256 * 1024;
const directory = "/opt/opengeni";

export type ImmutableServerNativeArtifact = Readonly<{
  [artifactBrand]: true;
  version: 1;
  sourceSha: string;
  sourceFileSha256: string;
  artifactSha256: string;
  byteSize: number;
  target: "linux-amd64" | "linux-arm64";
}>;

/** Runtime authority cannot come from an equivalent structural object. */
export function isImmutableServerNativeArtifact(
  value: unknown,
): value is ImmutableServerNativeArtifact {
  return value !== null && typeof value === "object" && measuredBytes.has(value);
}

/** Each caller receives its own bytes; the measured original remains private. */
export function readImmutableServerNativeArtifactBytes(
  artifact: ImmutableServerNativeArtifact,
): Uint8Array {
  const bytes = measuredBytes.get(artifact);
  if (!bytes) throw new Error("Native artifact did not originate from the immutable reader");
  return Buffer.from(bytes);
}

/** Fixed image-owned files only. Never execute a host ELF, accept a caller path,
 * use environment identity, or substitute a version/source ancestry claim. */
export async function readImmutableServerNativeArtifact(): Promise<
  ImmutableServerNativeArtifact | undefined
> {
  let parent: Awaited<ReturnType<typeof open>> | undefined;
  try {
    parent = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentBefore = await parent.stat();
    if (!parentBefore.isDirectory() || parentBefore.uid !== 0 || (parentBefore.mode & 0o222) !== 0)
      return undefined;
    const sourceSha = await readImmutableServerSourceSha();
    if (!sourceSha) return undefined;
    const manifestBytes = await immutableFile(`${directory}/native-command-artifact.json`, 2048);
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!validManifest(manifest, sourceSha)) return undefined;
    const source = await immutableFile(`${directory}/native-command-supervisor.c`, 128 * 1024);
    const bytes = await immutableFile(`${directory}/native-command-supervisor.elf`, maximumBytes);
    if (
      bytes.byteLength !== manifest.byteSize ||
      digest(source) !== manifest.sourceFileSha256 ||
      digest(bytes) !== manifest.artifactSha256 ||
      !staticTarget(bytes, manifest.target)
    )
      return undefined;
    const parentAfter = await parent.stat();
    if (
      parentBefore.dev !== parentAfter.dev ||
      parentBefore.ino !== parentAfter.ino ||
      parentAfter.uid !== 0 ||
      (parentAfter.mode & 0o222) !== 0 ||
      parentBefore.mtimeMs !== parentAfter.mtimeMs ||
      parentBefore.ctimeMs !== parentAfter.ctimeMs
    )
      return undefined;
    const artifact = Object.freeze({ ...manifest, [artifactBrand]: true as const });
    measuredBytes.set(artifact, bytes);
    return artifact;
  } catch {
    // Old/local images are unavailable; metadata never supplies a fallback.
    return undefined;
  } finally {
    await parent?.close().catch(() => undefined);
  }
}

type Manifest = Omit<ImmutableServerNativeArtifact, typeof artifactBrand>;

function validManifest(value: unknown, sourceSha: string): value is Manifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "artifactSha256,byteSize,sourceFileSha256,sourceSha,target,version"
  )
    return false;
  const target =
    process.platform === "linux"
      ? process.arch === "x64"
        ? "linux-amd64"
        : process.arch === "arm64"
          ? "linux-arm64"
          : undefined
      : undefined;
  return (
    record.version === 1 &&
    record.sourceSha === sourceSha &&
    typeof record.sourceFileSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(record.sourceFileSha256) &&
    typeof record.artifactSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(record.artifactSha256) &&
    typeof record.byteSize === "number" &&
    Number.isSafeInteger(record.byteSize) &&
    record.byteSize >= 64 &&
    record.byteSize <= maximumBytes &&
    target !== undefined &&
    record.target === target
  );
}

async function immutableFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      (before.mode & 0o222) !== 0 ||
      before.size <= 0 ||
      before.size > maximum
    )
      throw new Error("Immutable native artifact unavailable");
    const bytes = Buffer.alloc(before.size + 1);
    let filled = 0;
    while (filled < bytes.byteLength) {
      const result = await file.read(bytes, filled, bytes.byteLength - filled, filled);
      if (!result.bytesRead) break;
      filled += result.bytesRead;
    }
    const after = await file.stat();
    if (
      filled !== before.size ||
      after.size !== before.size ||
      !after.isFile() ||
      after.uid !== 0 ||
      (after.mode & 0o222) !== 0 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Immutable native artifact changed");
    return bytes.subarray(0, filled);
  } finally {
    await file.close();
  }
}

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function staticTarget(bytes: Buffer, target: Manifest["target"]): boolean {
  if (
    bytes.byteLength < 64 ||
    bytes.subarray(0, 7).compare(Buffer.from([0x7f, 69, 76, 70, 2, 1, 1])) !== 0 ||
    bytes.readUInt16LE(16) !== 2 ||
    bytes.readUInt32LE(20) !== 1 ||
    bytes.readBigUInt64LE(24) === 0n ||
    bytes.readUInt16LE(18) !== (target === "linux-amd64" ? 62 : 183) ||
    bytes.readUInt16LE(52) !== 64 ||
    bytes.readUInt16LE(54) !== 56
  )
    return false;
  const offset = bytes.readBigUInt64LE(32);
  const count = bytes.readUInt16LE(56);
  if (
    offset < 64n ||
    count < 1 ||
    count > 64 ||
    offset + BigInt(count * 56) > BigInt(bytes.byteLength)
  )
    return false;
  let loads = 0;
  for (let index = 0; index < count; index++) {
    const start = Number(offset) + index * 56;
    const type = bytes.readUInt32LE(start);
    if (type === 2 || type === 3) return false;
    if (type === 1) {
      loads++;
      const fileOffset = bytes.readBigUInt64LE(start + 8);
      const size = bytes.readBigUInt64LE(start + 32);
      if (size > bytes.readBigUInt64LE(start + 40) || fileOffset + size > BigInt(bytes.byteLength))
        return false;
    }
  }
  return loads > 0;
}
