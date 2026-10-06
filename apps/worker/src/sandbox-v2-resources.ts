import { isDeepStrictEqual } from "node:util";
import {
  getFilesForSubject,
  loadSandboxV2TurnFileResources,
  loadSandboxV2TurnResourceInputs,
  type Database,
} from "@opengeni/db";
import {
  resourceMountPath,
  SandboxV2PreparationFile,
  assertUniqueResourceMountPaths,
  type SandboxV2PreparationRepository,
  type FileAsset,
} from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";
import {
  buildSandboxV2PreparedFileManifest,
  sandboxV2PreparedRepositoryFor,
} from "@opengeni/runtime";
import { JournalBindingError } from "@opengeni/runtime/sandbox";
import type { SandboxV2TurnMachine } from "@opengeni/core";
import { runtimeResourcesForTurn } from "./activities/agent-turn/file-resources";

/** Use the same canonical session/current-turn merge as the normal runner.
 * The retained references carry no credential seed or refreshed remote data. */
export async function planSandboxV2TurnRepositoryResources(
  db: Database,
  machine: SandboxV2TurnMachine,
) {
  const inputs = await loadSandboxV2TurnResourceInputs(db, machine.authority);
  const resources = runtimeResourcesForTurn(inputs.sessionResources, inputs.turnResources);
  assertUniqueResourceMountPaths(resources);
  return resources
    .filter((resource) => resource.kind === "repository")
    .map(sandboxV2PreparedRepositoryFor);
}

export async function assertSandboxV2TurnRepositoryResourcesAuthorized(
  db: Database,
  machine: SandboxV2TurnMachine,
  expected: readonly SandboxV2PreparationRepository[],
) {
  if (!isDeepStrictEqual(await planSandboxV2TurnRepositoryResources(db, machine), expected))
    throw new JournalBindingError(
      "Native prepared repositories differ from the current canonical inputs",
    );
}

function metadata(file: FileAsset, mountPath: string): SandboxV2PreparationFile {
  if (file.status !== "ready")
    throw new JournalBindingError("Native attachment must be finalized and available");
  const result = SandboxV2PreparationFile.safeParse({
    fileId: file.id,
    mountPath,
    filename: file.safeFilename,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  });
  if (!result.success)
    throw new JournalBindingError("Native attachment requires finalized size and SHA-256 metadata");
  return result.data;
}

/** Build only the exact canonical current turn's file inputs. Use the ordinary
 * file owner/provider ACL, including existing session-attachment context, then
 * freeze nonsecret finalized metadata in the host preparation plan. This seam
 * mints no URLs, reads no object bytes and cannot inherit historical inputs. */
export async function planSandboxV2TurnFileResources(
  db: Database,
  machine: SandboxV2TurnMachine,
  workspaceRoot = "/workspace",
) {
  const authority = structuredClone(machine.authority);
  const turn = await loadSandboxV2TurnFileResources(db, authority);
  const assets = await getFilesForSubject(db, {
    accountId: authority.accountId,
    workspaceId: authority.workspaceId,
    subjectId: turn.initiatingHumanSubjectId,
    fileIds: turn.resources.map((resource) => resource.fileId),
  });
  const files = turn.resources.map((resource) => {
    const file = assets.find((asset) => asset.id === resource.fileId);
    if (!file)
      throw new JournalBindingError("Native attachment is unavailable or no longer authorized");
    return metadata(file, resourceMountPath(resource));
  });
  buildSandboxV2PreparedFileManifest(files, workspaceRoot);
  return { resources: turn.resources, files };
}

/** Fresh-start URL owner. Storage is explicitly selected for the native
 * machine's network; the deployment's legacy backend/default cannot choose it.
 * Every mint rechecks exact live attempt/incarnation, current-turn membership,
 * ordinary owner/provider file access and original finalized metadata. Native
 * completed/ambiguous command replay never calls this resolver. */
export function createSandboxV2TurnFileUrlResolver(
  db: Database,
  machine: SandboxV2TurnMachine,
  downloadStorage: Pick<ObjectStorage, "createGetUrl">,
  options: { audience: "public" | "sandbox" },
) {
  const authority = structuredClone(machine.authority);
  const audience = options.audience;
  if (audience !== "public" && audience !== "sandbox")
    throw new JournalBindingError(
      "Native attachment requires an explicit storage network audience",
    );
  return async (input: SandboxV2PreparationFile): Promise<string> => {
    const expected = SandboxV2PreparationFile.parse(structuredClone(input));
    const turn = await loadSandboxV2TurnFileResources(db, authority);
    const reference = turn.resources.find((resource) => resource.fileId === expected.fileId);
    if (!reference || resourceMountPath(reference) !== expected.mountPath)
      throw new JournalBindingError("Native attachment is outside the current turn");
    const [file] = await getFilesForSubject(db, {
      accountId: authority.accountId,
      workspaceId: authority.workspaceId,
      subjectId: turn.initiatingHumanSubjectId,
      fileIds: [expected.fileId],
    });
    if (!file || !isDeepStrictEqual(metadata(file, resourceMountPath(reference)), expected))
      throw new JournalBindingError("Native attachment changed or is no longer authorized");
    const signed = await downloadStorage.createGetUrl({ key: file.objectKey, audience });
    if (!Number.isFinite(signed.expiresAt.getTime()) || signed.expiresAt.getTime() <= Date.now())
      throw new JournalBindingError("Native attachment URL has expired");
    return signed.url;
  };
}

/** Recheck cached/prepared inputs too. No URL or object bytes are resolved;
 * callers use this before preparation and every model/tool dispatch. */
export async function assertSandboxV2TurnFileResourcesAuthorized(
  db: Database,
  machine: SandboxV2TurnMachine,
  expectedFiles: readonly SandboxV2PreparationFile[],
) {
  const expected = SandboxV2PreparationFile.array().max(1024).parse(structuredClone(expectedFiles));
  const current = await planSandboxV2TurnFileResources(db, machine);
  if (
    expected.length !== current.files.length ||
    new Set(expected.map((file) => file.fileId)).size !== expected.length ||
    expected.some((file) => !current.files.some((value) => isDeepStrictEqual(file, value)))
  )
    throw new JournalBindingError(
      "Native prepared attachments differ from the authorized current turn",
    );
}

export function createSandboxV2TurnFileResourceOwner(
  db: Database,
  machine: SandboxV2TurnMachine,
  downloadStorage: Pick<ObjectStorage, "createGetUrl">,
  options: { audience: "public" | "sandbox" },
) {
  machine = { ...machine, authority: structuredClone(machine.authority) };
  return {
    plan: () => planSandboxV2TurnFileResources(db, machine),
    authorize: (files: readonly SandboxV2PreparationFile[]) =>
      assertSandboxV2TurnFileResourcesAuthorized(db, machine, files),
    resolveDownloadUrl: createSandboxV2TurnFileUrlResolver(db, machine, downloadStorage, options),
  };
}
