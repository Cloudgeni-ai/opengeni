import { WorkspaceArtifactSourceBundle, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, ObjectStorageDependency } from "@opengeni/core";
import {
  createWorkspaceArtifactUpload,
  getWorkspaceArtifactUpload,
  expireWorkspaceArtifactUploads,
  WorkspaceArtifactOperationError,
} from "@opengeni/db";
import {
  prepareWorkspaceArtifactContent,
  type PreparedWorkspaceArtifactContent,
} from "./workspace-artifact-content";
type Storage = NonNullable<ObjectStorageDependency>;
export const MAX_SITE_SOURCE_BYTES = 64 * 1024 * 1024;

export async function validateSiteSource(storage: Storage, key: string, sizeBytes: number) {
  if (sizeBytes > MAX_SITE_SOURCE_BYTES) {
    throw new WorkspaceArtifactOperationError(
      "Editable source JSON must be at most 64 MiB. Exclude dependencies and build output; HTML has a separate storage limit.",
    );
  }
  const content = await storage.getObjectBytes(key);
  try {
    WorkspaceArtifactSourceBundle.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content!.bytes)),
    );
  } catch {
    throw new WorkspaceArtifactOperationError(
      "Source must be JSON {entrypoint, files: [{path, content}]}. Correct it and prepare a new upload.",
    );
  }
}
function keys(workspaceId: string, id: string) {
  const base = `workspaces/${workspaceId}/workspace-artifacts`;
  return {
    html: `${base}/uploads/${id}/index.html`,
    source: `${base}/uploads/${id}/source.json`,
    frozenHtml: `${base}/blobs/${id}.html`,
    frozenSource: `${base}/sources/${id}.json`,
  };
}
function owner(grant: AccessGrant) {
  return typeof grant.metadata?.sessionId === "string"
    ? `session:${grant.metadata.sessionId}`
    : `subject:${grant.subjectId}`;
}
export async function prepareWorkspaceArtifactUpload(deps: ApiRouteDeps, grant: AccessGrant) {
  const storage = deps.objectStorage;
  if (!storage) throw new Error("Object storage is not configured");
  const expired = await expireWorkspaceArtifactUploads(deps.db, grant.workspaceId);
  await Promise.allSettled(
    expired.flatMap((row) => {
      const paths = keys(row.workspaceId, row.id);
      return (row.status === "published" ? [paths.html, paths.source] : Object.values(paths)).map(
        (key) => storage.deleteObject(key),
      );
    }),
  );
  const row = await createWorkspaceArtifactUpload(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ownerId: owner(grant),
  });
  const paths = keys(grant.workspaceId, row.id);
  const audience = grant.principalKind === "agent_attempt" ? "sandbox" : "public";
  const [html, source] = await Promise.all([
    storage.createPutUrl({ key: paths.html, contentType: "text/html", audience }),
    storage.createPutUrl({ key: paths.source, contentType: "application/json", audience }),
  ]);
  return {
    uploadId: row.id,
    html: { putUrl: html.url, requiredHeaders: html.requiredHeaders },
    source: { putUrl: source.url, requiredHeaders: source.requiredHeaders },
    expiresAt: new Date(
      Math.min(html.expiresAt.getTime(), source.expiresAt.getTime()),
    ).toISOString(),
  };
}
/** Provider version-pinned reads, without Site SHA checks or full HTML buffering. */
export async function* readArtifactObject(
  storage: Storage,
  key: string,
  expectedHead?: Awaited<ReturnType<NonNullable<Storage["headObject"]>>>,
) {
  if (!storage.headObject || !storage.getObjectRange)
    throw new Error("Object storage cannot stream Site content");
  const head = expectedHead ?? (await storage.headObject(key));
  if (!head || !head.VersionToken || head.ContentLength === undefined)
    throw new Error("Site content is unavailable");
  for (let start = 0; start < head.ContentLength; start += 1024 * 1024) {
    const endInclusive = Math.min(head.ContentLength - 1, start + 1024 * 1024 - 1);
    const part = await storage.getObjectRange({
      key,
      start,
      endInclusive,
      expectedVersionToken: head.VersionToken,
    });
    if (
      !part ||
      part.versionToken !== head.VersionToken ||
      part.bytes.length !== endInclusive - start + 1
    )
      throw new Error("Site object changed during transfer");
    yield part.bytes;
  }
}
async function freeze(
  storage: Storage,
  from: string,
  to: string,
  contentType: string,
  optional = false,
) {
  if (!storage.headObject || !storage.putObjectStreamIfAbsent)
    throw new Error("Object storage cannot freeze Site uploads");
  const existing = await storage.headObject(to);
  if (existing) return existing.ContentLength!;
  const head = await storage.headObject(from);
  if (!head && optional) return null;
  if (!head || !head.ContentLength)
    throw new WorkspaceArtifactOperationError("Upload HTML before publishing the Site");
  if (head.ContentLength > storage.maxSinglePutSizeBytes)
    throw new Error("Site exceeds the storage upload limit");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  async function* chunks() {
    for await (const part of readArtifactObject(storage, from, head)) {
      decoder.decode(part, { stream: true });
      yield part;
    }
    decoder.decode();
  }
  await storage.putObjectStreamIfAbsent({
    key: to,
    contentType,
    byteSize: head.ContentLength,
    chunks: chunks(),
  });
  return (await storage.headObject(to))!.ContentLength!;
}
type Input = Partial<Parameters<typeof prepareWorkspaceArtifactContent>[2]> & { uploadId?: string };
export async function prepareWorkspaceArtifactPublication(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  input: Input,
): Promise<PreparedWorkspaceArtifactContent & { uploadId?: string }> {
  const storage = deps.objectStorage;
  if (!storage) throw new Error("Object storage is not configured");
  if (Boolean(input.uploadId) === (input.html !== undefined))
    throw new Error("Provide either uploadId or inline html, not both");
  if (!input.uploadId) {
    return prepareWorkspaceArtifactContent(storage, grant.workspaceId, {
      ...input,
      html: input.html!,
    });
  }
  if (input.source) throw new Error("Upload source JSON using the source upload URL");
  const row = await getWorkspaceArtifactUpload(deps.db, grant.workspaceId, input.uploadId);
  if (
    !row ||
    row.ownerId !== owner(grant) ||
    row.status === "expired" ||
    (row.status === "pending" && row.expiresAt.getTime() <= Date.now())
  )
    throw new WorkspaceArtifactOperationError("Site upload expired or unavailable");
  const paths = keys(grant.workspaceId, row.id);
  const sizeBytes = await freeze(storage, paths.html, paths.frozenHtml, "text/html; charset=utf-8");
  const sourceSizeBytes =
    row.status === "published" && !(await storage.headObject!(paths.frozenSource))
      ? null
      : await freeze(storage, paths.source, paths.frozenSource, "application/json", true);
  if (sourceSizeBytes !== null) {
    await validateSiteSource(storage, paths.frozenSource, sourceSizeBytes);
  }
  return {
    uploadId: row.id,
    contentKey: paths.frozenHtml,
    contentSha256: null,
    sizeBytes: sizeBytes!,
    sourceKey: sourceSizeBytes === null ? null : paths.frozenSource,
    sourceSha256: null,
    sourceSizeBytes,
    ...(input.requestedTools === undefined ? {} : { requestedTools: input.requestedTools }),
    persistContent: async () => {},
    discardContent: async () => {},
  };
}
export async function workspaceArtifactDownloads(
  storage: Storage,
  ref: { contentKey: string; sourceKey: string | null },
  audience: "sandbox" | "public",
) {
  const [html, source] = await Promise.all([
    storage.createGetUrl({ key: ref.contentKey, audience }),
    ref.sourceKey ? storage.createGetUrl({ key: ref.sourceKey, audience }) : null,
  ]);
  return {
    html: { url: html.url, expiresAt: html.expiresAt },
    source: source
      ? { url: source.url, expiresAt: source.expiresAt, format: "source-bundle-json" }
      : null,
  };
}
