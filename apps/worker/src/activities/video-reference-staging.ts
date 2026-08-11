import { GENERATED_VIDEO_MAX_BYTES, type GenerateVideoToolInput } from "@opengeni/contracts";
import type { SealedVideoReference, SealedVideoReferenceRole } from "@opengeni/core";
import type { ObjectStorage } from "@opengeni/storage";
import {
  copyVersionedObjectToVerifiedTemp,
  validateImageReference,
  validateVideoReference,
} from "./video-media-validation";

const MAX_IMAGE_REFERENCE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_REFERENCE_BYTES = 200 * 1024 * 1024;
const UPLOAD_TIMEOUT_SECONDS = 15 * 60;

export type SandboxCommandRunner = (input: {
  cmd: string;
  workdir: string;
  maxOutputTokens: number;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type InspectedSandboxVideoReference = Readonly<{
  ordinal: number;
  role: SealedVideoReferenceRole;
  path: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}>;

export function videoReferencePaths(
  request: GenerateVideoToolInput,
): Array<{ role: SealedVideoReferenceRole; path: string }> {
  const source = request.source;
  if (!source || source.mode === "text") return [];
  if (source.mode === "first_frame") return [{ role: "first_frame", path: source.imagePath }];
  if (source.mode === "first_and_last_frames") {
    return [
      { role: "first_frame", path: source.firstFramePath },
      { role: "last_frame", path: source.lastFramePath },
    ];
  }
  if (source.mode === "image_reference") {
    return [{ role: "image_reference", path: source.imagePath }];
  }
  return [{ role: "video_reference", path: source.videoPath }];
}

export async function inspectSandboxVideoReferences(input: {
  request: GenerateVideoToolInput;
  runCommand: SandboxCommandRunner;
}): Promise<InspectedSandboxVideoReference[]> {
  const paths = videoReferencePaths(input.request);
  const inspected: InspectedSandboxVideoReference[] = [];
  for (const [ordinal, reference] of paths.entries()) {
    const result = await input.runCommand({
      cmd: inspectCommand(reference.path),
      workdir: "/workspace",
      maxOutputTokens: 4_096,
    });
    if (result.exitCode !== 0) throw new Error("Video reference is not a stable workspace file");
    const [sizeText, sha256, prefixBase64] = result.stdout.trim().split("\t");
    const sizeBytes = Number(sizeText);
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      !/^[0-9a-f]{64}$/u.test(sha256 ?? "")
    ) {
      throw new Error("Video reference inspection returned invalid metadata");
    }
    const prefix = Buffer.from(prefixBase64 ?? "", "base64");
    const contentType = sniffContentType(prefix);
    const maxBytes =
      reference.role === "video_reference" ? MAX_VIDEO_REFERENCE_BYTES : MAX_IMAGE_REFERENCE_BYTES;
    if (sizeBytes > maxBytes) throw new Error("Video reference exceeds the supported size");
    if (
      (reference.role === "video_reference" && contentType !== "video/mp4") ||
      (reference.role !== "video_reference" && !contentType.startsWith("image/"))
    ) {
      throw new Error("Video reference media type does not match its semantic role");
    }
    inspected.push({
      ordinal,
      role: reference.role,
      path: reference.path,
      contentType,
      sizeBytes,
      sha256: sha256!,
    });
  }
  return inspected;
}

export async function uploadAndVerifyVideoReferences(input: {
  storage: ObjectStorage;
  references: readonly InspectedSandboxVideoReference[];
  stagingKeys: readonly string[];
  runCommand: SandboxCommandRunner;
  tempRoot: string;
  ffprobePath: string;
  uploadTtlSeconds: number;
  signal?: AbortSignal;
}): Promise<SealedVideoReference[]> {
  if (input.references.length !== input.stagingKeys.length) {
    throw new Error("Video reference staging identities do not match");
  }
  const sealed: SealedVideoReference[] = [];
  for (const [index, reference] of input.references.entries()) {
    throwIfAborted(input.signal);
    const key = input.stagingKeys[index]!;
    const existing = input.storage.headObject ? await input.storage.headObject(key) : null;
    if (!existing) {
      const upload = await input.storage.createPutUrl({
        key,
        contentType: reference.contentType,
        sha256: reference.sha256,
        expiresInSeconds: Math.min(input.uploadTtlSeconds, UPLOAD_TIMEOUT_SECONDS),
      });
      const result = await input.runCommand({
        cmd: uploadCommand(reference, upload),
        workdir: "/workspace",
        maxOutputTokens: 4_096,
      });
      if (result.exitCode !== 0) throw new Error("Video reference staging upload failed");
    }
    const verified = await copyVersionedObjectToVerifiedTemp({
      storage: input.storage,
      key,
      expectedSizeBytes: reference.sizeBytes,
      expectedSha256: reference.sha256,
      expectedContentType: reference.contentType,
      maxBytes:
        reference.role === "video_reference"
          ? MAX_VIDEO_REFERENCE_BYTES
          : MAX_IMAGE_REFERENCE_BYTES,
      tempRoot: input.tempRoot,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    try {
      if (reference.role === "video_reference") {
        await validateVideoReference({ path: verified.path, ffprobePath: input.ffprobePath });
      } else {
        const image = await validateImageReference(verified.path);
        if (image.contentType !== reference.contentType) {
          throw new Error("Video image reference MIME type changed during validation");
        }
      }
    } finally {
      await verified.cleanup();
    }
    sealed.push({
      role: reference.role,
      contentSha256: reference.sha256,
      contentType: reference.contentType,
      byteSize: reference.sizeBytes,
    });
  }
  return sealed;
}

export function videoReferenceStagingKey(input: {
  workspaceId: string;
  operationId: string;
  ordinal: number;
  sha256: string;
}): string {
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) throw new Error("Video reference digest is invalid");
  return `video-generation/staging/${input.workspaceId}/${input.operationId}/${input.ordinal}/${input.sha256}`;
}

function inspectCommand(path: string): string {
  return [
    "set -euo pipefail",
    `requested=${shellQuote(path)}`,
    'case "$requested" in /workspace/*) ;; *) exit 41 ;; esac',
    'case "$requested" in *"/../"*|*"/./"*|*/..|*/.) exit 42 ;; esac',
    'resolved=$(realpath -e -- "$requested")',
    '[ "$resolved" = "$requested" ] || exit 43',
    'exec 3<"$resolved"',
    'fd_path=$(realpath -e -- "/proc/$$/fd/3" 2>/dev/null || realpath -e -- "/dev/fd/3")',
    'case "$fd_path" in /workspace/*) ;; *) exit 44 ;; esac',
    '[ -f "/proc/$$/fd/3" ] 2>/dev/null || [ -f "/dev/fd/3" ] || exit 45',
    'fd=/proc/$$/fd/3; [ -e "$fd" ] || fd=/dev/fd/3',
    'before=$(stat -Lc "%d:%i:%s:%Y" -- "$fd" 2>/dev/null || stat -f "%d:%i:%z:%m" "$fd")',
    'size=$(stat -Lc "%s" -- "$fd" 2>/dev/null || stat -f "%z" "$fd")',
    "sha=$(sha256sum -- \"$fd\" 2>/dev/null | awk '{print $1}' || shasum -a 256 \"$fd\" | awk '{print $1}')",
    'exec 3<&-; exec 3<"$resolved"',
    'fd=/proc/$$/fd/3; [ -e "$fd" ] || fd=/dev/fd/3',
    'reopened=$(stat -Lc "%d:%i:%s:%Y" -- "$fd" 2>/dev/null || stat -f "%d:%i:%z:%m" "$fd")',
    '[ "$before" = "$reopened" ] || exit 46',
    'prefix=$(dd if="$fd" bs=32 count=1 2>/dev/null | base64 | tr -d "\\r\\n")',
    'after=$(stat -Lc "%d:%i:%s:%Y" -- "$fd" 2>/dev/null || stat -f "%d:%i:%z:%m" "$fd")',
    '[ "$before" = "$after" ] || exit 46',
    'printf "%s\\t%s\\t%s\\n" "$size" "$sha" "$prefix"',
  ].join("\n");
}

function uploadCommand(
  reference: InspectedSandboxVideoReference,
  upload: Awaited<ReturnType<ObjectStorage["createPutUrl"]>>,
): string {
  const headers = Object.entries(upload.requiredHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `--header ${shellQuote(`${name}: ${value}`)}`)
    .join(" ");
  return [
    "set -euo pipefail",
    `requested=${shellQuote(reference.path)}`,
    'resolved=$(realpath -e -- "$requested")',
    '[ "$resolved" = "$requested" ] || exit 51',
    'exec 3<"$resolved"',
    'fd_path=$(realpath -e -- "/proc/$$/fd/3" 2>/dev/null || realpath -e -- "/dev/fd/3")',
    'case "$fd_path" in /workspace/*) ;; *) exit 52 ;; esac',
    'fd=/proc/$$/fd/3; [ -e "$fd" ] || fd=/dev/fd/3',
    'before=$(stat -Lc "%d:%i:%s:%Y" -- "$fd" 2>/dev/null || stat -f "%d:%i:%z:%m" "$fd")',
    'size=$(stat -Lc "%s" -- "$fd" 2>/dev/null || stat -f "%z" "$fd")',
    `[ "$size" = ${shellQuote(String(reference.sizeBytes))} ] || exit 53`,
    "sha=$(sha256sum -- \"$fd\" 2>/dev/null | awk '{print $1}' || shasum -a 256 \"$fd\" | awk '{print $1}')",
    `[ "$sha" = ${shellQuote(reference.sha256)} ] || exit 54`,
    'exec 3<&-; exec 3<"$resolved"',
    'fd=/proc/$$/fd/3; [ -e "$fd" ] || fd=/dev/fd/3',
    'reopened=$(stat -Lc "%d:%i:%s:%Y" -- "$fd" 2>/dev/null || stat -f "%d:%i:%z:%m" "$fd")',
    '[ "$before" = "$reopened" ] || exit 55',
    `curl --silent --show-error --fail --connect-timeout 20 --max-time ${UPLOAD_TIMEOUT_SECONDS} --request PUT ${headers} --upload-file "$fd" --output /dev/null ${shellQuote(upload.url)}`,
    'after=$(stat -Lc "%d:%i:%s:%Y" -- "$fd" 2>/dev/null || stat -f "%d:%i:%z:%m" "$fd")',
    '[ "$before" = "$after" ] || exit 56',
  ].join("\n");
}

function sniffContentType(prefix: Uint8Array): string {
  if (
    prefix.byteLength >= 8 &&
    Buffer.from(prefix.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (prefix.byteLength >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    prefix.byteLength >= 12 &&
    Buffer.from(prefix.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(prefix.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (prefix.byteLength >= 12 && Buffer.from(prefix.subarray(4, 8)).toString("ascii") === "ftyp") {
    return "video/mp4";
  }
  throw new Error("Video reference has an unsupported media signature");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Video reference staging was cancelled");
}

export const VIDEO_REFERENCE_LIMITS = Object.freeze({
  imageBytes: MAX_IMAGE_REFERENCE_BYTES,
  videoBytes: MAX_VIDEO_REFERENCE_BYTES,
  outputBytes: GENERATED_VIDEO_MAX_BYTES,
});
