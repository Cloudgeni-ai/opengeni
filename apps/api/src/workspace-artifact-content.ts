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
  contentSha256: null;
  sizeBytes: number;
  sourceKey: string | null;
  sourceSha256: null;
  sourceSizeBytes: number | null;
  requestedTools?: ToolGatewayIdentity[];
  persistContent: () => Promise<void>;
  discardContent: () => Promise<void>;
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
  const source = input.source ? WorkspaceArtifactSourceBundle.parse(input.source) : null;
  const requestedTools =
    input.requestedTools === undefined
      ? undefined
      : WorkspaceArtifactRequestedTools.parse(input.requestedTools);
  const contentBytes = encoder.encode(html);
  const sourceBytes = source ? encoder.encode(JSON.stringify(source)) : null;
  const contentSha256 = null;
  const sourceSha256 = null;
  const storageGroupId = crypto.randomUUID();
  const contentKey = `workspaces/${workspaceId}/workspace-artifacts/blobs/${storageGroupId}.html`;
  const sourceKey = `workspaces/${workspaceId}/workspace-artifacts/sources/${storageGroupId}.json`;
  const discardContent = async (): Promise<void> => {
    await Promise.allSettled([
      objectStorage.deleteObject(contentKey),
      ...(source ? [objectStorage.deleteObject(sourceKey)] : []),
    ]);
  };
  return {
    contentKey,
    contentSha256,
    sizeBytes: contentBytes.byteLength,
    sourceKey: source ? sourceKey : null,
    sourceSha256,
    sourceSizeBytes: sourceBytes?.byteLength ?? null,
    ...(requestedTools === undefined ? {} : { requestedTools }),
    discardContent,
    persistContent: async () => {
      const writes = await Promise.allSettled([
        objectStorage.putObject({
          key: contentKey,
          contentType: "text/html; charset=utf-8",
          body: contentBytes,
        }),
        sourceBytes
          ? objectStorage.putObject({
              key: sourceKey,
              contentType: "application/json; charset=utf-8",
              body: sourceBytes,
            })
          : Promise.resolve(),
      ]);
      const failed = writes.find((write) => write.status === "rejected");
      if (!failed) return;
      await Promise.allSettled(
        writes.flatMap((write, index) =>
          write.status === "fulfilled"
            ? [objectStorage.deleteObject(index === 0 ? contentKey : sourceKey)]
            : [],
        ),
      );
      throw failed.reason;
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
  const html = decode(contentObject.bytes, "Artifact content is not valid UTF-8");
  let source = sourceBundleFromHtml(html);
  if (input.sourceKey) {
    if (!sourceObject) throw new Error("Artifact source is unavailable");
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

function decode(bytes: Uint8Array, message: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}
