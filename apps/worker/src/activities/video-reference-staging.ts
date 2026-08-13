import {
  GENERATED_VIDEO_MAX_BYTES,
  type GenerateVideoToolInput,
  type VideoGenerationRejectedCode,
} from "@opengeni/contracts";
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

export type VideoReferenceInputErrorCode = VideoGenerationRejectedCode;

/** A deterministic, pre-admission tool-input error. No video operation exists yet. */
export class VideoReferenceInputError extends Error {
  readonly code: VideoReferenceInputErrorCode;

  constructor(code: VideoReferenceInputErrorCode, message: string) {
    super(message);
    this.name = "VideoReferenceInputError";
    this.code = code;
  }
}

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
    if (result.exitCode !== 0) {
      throw new VideoReferenceInputError(
        "reference_not_stable",
        "The video reference must be an existing regular file at the exact /workspace path returned by the preceding tool.",
      );
    }
    const [sizeText, sha256, prefixBase64] = result.stdout.trim().split("\t");
    const sizeBytes = Number(sizeText);
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      !/^[0-9a-f]{64}$/u.test(sha256 ?? "")
    ) {
      throw new VideoReferenceInputError(
        "reference_not_stable",
        "The video reference changed or could not be read safely. Use the exact current /workspace path and try again.",
      );
    }
    const prefix = Buffer.from(prefixBase64 ?? "", "base64");
    const contentType = sniffContentType(prefix);
    const maxBytes =
      reference.role === "video_reference" ? MAX_VIDEO_REFERENCE_BYTES : MAX_IMAGE_REFERENCE_BYTES;
    if (sizeBytes > maxBytes) {
      throw new VideoReferenceInputError(
        "reference_too_large",
        "The video reference exceeds the supported size for this source mode.",
      );
    }
    if (
      (reference.role === "video_reference" && contentType !== "video/mp4") ||
      (reference.role !== "video_reference" && !contentType.startsWith("image/"))
    ) {
      throw new VideoReferenceInputError(
        "reference_media_type_mismatch",
        "The video reference media type does not match the selected source mode.",
      );
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
        await validateVideoReference({
          path: verified.path,
          ffprobePath: input.ffprobePath,
        });
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
    ...stableWorkspaceFilePrelude(path, { nonCanonical: 43, invalidFile: 45 }),
    'sha=$(video_reference_sha256 "$fd")',
    'exec 3<&-; exec 3<"$resolved"',
    'fd=/proc/$$/fd/3; [ -e "$fd" ] || fd=/dev/fd/3',
    'reopened=$(video_reference_stat_identity "$fd")',
    '[ "$before" = "$reopened" ] || exit 46',
    '[ "$(video_reference_stat_content_identity "$resolved")" = "$(video_reference_stat_content_identity "$fd")" ] || exit 46',
    '[ "$(realpath -- "$requested")" = "$expected" ] || exit 46',
    'prefix=$(dd if="$fd" bs=32 count=1 2>/dev/null | base64 | tr -d "\\r\\n")',
    'after=$(video_reference_stat_identity "$fd")',
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
    ...stableWorkspaceFilePrelude(reference.path, {
      nonCanonical: 51,
      invalidFile: 52,
    }),
    `[ "$size" = ${shellQuote(String(reference.sizeBytes))} ] || exit 53`,
    'sha=$(video_reference_sha256 "$fd")',
    `[ "$sha" = ${shellQuote(reference.sha256)} ] || exit 54`,
    'exec 3<&-; exec 3<"$resolved"',
    'fd=/proc/$$/fd/3; [ -e "$fd" ] || fd=/dev/fd/3',
    'reopened=$(video_reference_stat_identity "$fd")',
    '[ "$before" = "$reopened" ] || exit 55',
    '[ "$(video_reference_stat_content_identity "$resolved")" = "$(video_reference_stat_content_identity "$fd")" ] || exit 55',
    '[ "$(realpath -- "$requested")" = "$expected" ] || exit 55',
    `curl --silent --show-error --fail --connect-timeout 20 --max-time ${UPLOAD_TIMEOUT_SECONDS} --request PUT ${headers} --upload-file "$fd" --output /dev/null ${shellQuote(upload.url)}`,
    'after=$(video_reference_stat_identity "$fd")',
    '[ "$before" = "$after" ] || exit 56',
  ].join("\n");
}

function stableWorkspaceFilePrelude(
  path: string,
  exitCodes: { nonCanonical: number; invalidFile: number },
): string[] {
  const requested = workspaceRelativeReferencePath(path);
  return [
    `requested=${shellQuote(requested)}`,
    "root=$(pwd -P)",
    'expected="$root/${requested#./}"',
    'resolved=$(realpath -- "$requested")',
    `[ "$resolved" = "$expected" ] || exit ${exitCodes.nonCanonical}`,
    `[ -f "$resolved" ] || exit ${exitCodes.invalidFile}`,
    'exec 3<"$resolved"',
    'fd=/proc/$$/fd/3; [ -e "$fd" ] || fd=/dev/fd/3',
    `[ -f "$fd" ] || exit ${exitCodes.invalidFile}`,
    "video_reference_platform=$(uname -s)",
    'if [ "$video_reference_platform" = Darwin ]; then',
    '  video_reference_stat_identity() { stat -f "%d:%i:%z:%m" "$1"; }',
    '  video_reference_stat_content_identity() { stat -f "%i:%z:%m" "$1"; }',
    '  video_reference_stat_size() { stat -f "%z" "$1"; }',
    "else",
    '  video_reference_stat_identity() { stat -Lc "%d:%i:%s:%Y" -- "$1"; }',
    '  video_reference_stat_content_identity() { stat -Lc "%d:%i:%s:%Y" -- "$1"; }',
    '  video_reference_stat_size() { stat -Lc "%s" -- "$1"; }',
    "fi",
    "video_reference_sha256() {",
    "  if command -v sha256sum >/dev/null 2>&1; then",
    "    sha256sum \"$1\" | awk '{print $1}'",
    "  else",
    "    shasum -a 256 \"$1\" | awk '{print $1}'",
    "  fi",
    "}",
    'if [ "$video_reference_platform" != Darwin ]; then',
    '  fd_path=$(realpath -- "$fd")',
    `  [ "$fd_path" = "$expected" ] || exit ${exitCodes.invalidFile}`,
    "fi",
    `[ "$(video_reference_stat_content_identity "$resolved")" = "$(video_reference_stat_content_identity "$fd")" ] || exit ${exitCodes.invalidFile}`,
    `[ "$(realpath -- "$requested")" = "$expected" ] || exit ${exitCodes.invalidFile}`,
    'before=$(video_reference_stat_identity "$fd")',
    'size=$(video_reference_stat_size "$fd")',
  ];
}

function workspaceRelativeReferencePath(path: string): string {
  if (!path.startsWith("/workspace/") || /[\0\r\n]/u.test(path)) {
    throw new VideoReferenceInputError(
      "invalid_reference_path",
      "Video references must use an exact file path under /workspace.",
    );
  }
  const segments = path.slice("/workspace/".length).split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new VideoReferenceInputError(
      "invalid_reference_path",
      "Video references must use a canonical file path under /workspace.",
    );
  }
  return `./${segments.join("/")}`;
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
  throw new VideoReferenceInputError(
    "unsupported_reference_media",
    "The video reference is not a supported PNG, JPEG, WebP, or MP4 file.",
  );
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
