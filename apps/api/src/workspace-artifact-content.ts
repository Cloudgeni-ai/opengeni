import { createHash } from "node:crypto";
import {
  WorkspaceArtifactHtml,
  WorkspaceArtifactRequestedTools,
  WorkspaceArtifactSourceBundle,
  type ToolGatewayIdentity,
  type WorkspaceArtifactSourceBundle as WorkspaceArtifactSourceBundleValue,
  type WorkspaceArtifactVersion,
} from "@opengeni/contracts";
import type { ObjectStorageDependency } from "@opengeni/core";
import { retryWhileMissing } from "@opengeni/storage";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type PreparedWorkspaceArtifactContent = {
  contentKey: string;
  contentSha256: string;
  sizeBytes: number;
  sourceKey: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  requestedTools?: ToolGatewayIdentity[];
  persistContent: () => Promise<void>;
};

export function prepareWorkspaceArtifactContent(
  objectStorage: NonNullable<ObjectStorageDependency>,
  workspaceId: string,
  input: {
    html: string;
    source?: WorkspaceArtifactSourceBundleValue;
    requestedTools?: ToolGatewayIdentity[];
  },
): PreparedWorkspaceArtifactContent {
  const html = WorkspaceArtifactHtml.parse(input.html);
  const source = WorkspaceArtifactSourceBundle.parse(input.source ?? sourceBundleFromHtml(html));
  const requestedTools =
    input.requestedTools === undefined
      ? undefined
      : WorkspaceArtifactRequestedTools.parse(input.requestedTools);
  const contentBytes = encoder.encode(html);
  const sourceBytes = encoder.encode(JSON.stringify(source));
  const contentSha256 = sha256(contentBytes);
  const sourceSha256 = sha256(sourceBytes);
  const contentKey = `workspaces/${workspaceId}/workspace-artifacts/blobs/${contentSha256}.html`;
  const sourceKey = `workspaces/${workspaceId}/workspace-artifacts/sources/${sourceSha256}.json`;
  return {
    contentKey,
    contentSha256,
    sizeBytes: contentBytes.byteLength,
    sourceKey,
    sourceSha256,
    sourceSizeBytes: sourceBytes.byteLength,
    ...(requestedTools === undefined ? {} : { requestedTools }),
    persistContent: async () => {
      await Promise.all([
        objectStorage.putObject({
          key: contentKey,
          contentType: "text/html; charset=utf-8",
          body: contentBytes,
          sha256: contentSha256,
        }),
        objectStorage.putObject({
          key: sourceKey,
          contentType: "application/json; charset=utf-8",
          body: sourceBytes,
          sha256: sourceSha256,
        }),
      ]);
    },
  };
}

export async function readWorkspaceArtifactContent(
  objectStorage: NonNullable<ObjectStorageDependency>,
  input: {
    contentKey: string;
    sourceKey: string | null;
    version: WorkspaceArtifactVersion;
  },
): Promise<{
  html: string;
  source: WorkspaceArtifactSourceBundleValue;
  requestedTools: ToolGatewayIdentity[];
}> {
  const [contentObject, sourceObject] = await Promise.all([
    retryWhileMissing(async () => await objectStorage.getObjectBytes(input.contentKey)),
    input.sourceKey
      ? retryWhileMissing(async () => await objectStorage.getObjectBytes(input.sourceKey!))
      : Promise.resolve(null),
  ]);
  if (!contentObject) throw new Error("Artifact content is unavailable");
  if (
    sha256(contentObject.bytes) !== input.version.contentSha256 ||
    contentObject.bytes.byteLength !== input.version.sizeBytes
  ) {
    throw new Error("Artifact content failed integrity verification");
  }
  const html = decode(contentObject.bytes, "Artifact content is not valid UTF-8");
  let source = sourceBundleFromHtml(html);
  if (input.sourceKey) {
    if (!sourceObject) throw new Error("Artifact source is unavailable");
    if (
      !input.version.sourceSha256 ||
      input.version.sourceSizeBytes === null ||
      sha256(sourceObject.bytes) !== input.version.sourceSha256 ||
      sourceObject.bytes.byteLength !== input.version.sourceSizeBytes
    ) {
      throw new Error("Artifact source failed integrity verification");
    }
    try {
      source = WorkspaceArtifactSourceBundle.parse(
        JSON.parse(decode(sourceObject.bytes, "Artifact source is not valid UTF-8")),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "Artifact source is not valid UTF-8") {
        throw error;
      }
      throw new Error("Artifact source is invalid", { cause: error });
    }
  }
  return {
    html,
    source,
    requestedTools: WorkspaceArtifactRequestedTools.parse(input.version.requestedTools),
  };
}

export function sourceBundleFromHtml(html: string): WorkspaceArtifactSourceBundleValue {
  return { entrypoint: "index.html", files: [{ path: "index.html", content: html }] };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decode(bytes: Uint8Array, message: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}
