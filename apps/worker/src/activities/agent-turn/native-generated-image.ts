import { isDeepStrictEqual } from "node:util";
import {
  GeneratedImageReceiptSchema,
  SandboxV2PreparationFile,
  type GeneratedImageReceipt,
} from "@opengeni/contracts";
import { deliverSandboxV2File } from "@opengeni/core";
import {
  getFilesForSubject,
  getGeneratedImageArtifact,
  loadSandboxV2TurnResourceInputs,
  retainSandboxV2PreparationPlan,
  type Database,
} from "@opengeni/db";
import { JournalBindingError } from "@opengeni/runtime/sandbox";
import type { ObjectStorage } from "@opengeni/storage";
import { retainedGeneratedImageFromArtifact } from "../generated-images";
import type { SandboxRuntimeState } from "./turn-context";

/** Deliver this turn's already retained image through its original native
 * owner. A provider receipt grants no file access and is not a model call.
 * Named setup/file identities recover the original delivery without issuing a
 * replacement command or resolving another URL after completion. */
export async function materializeNativeGeneratedImage(
  db: Database,
  owner: NonNullable<SandboxRuntimeState["nativeTurn"]>,
  storage: Pick<ObjectStorage, "createGetUrl">,
  receipt: GeneratedImageReceipt,
): Promise<void> {
  const expected = GeneratedImageReceiptSchema.parse(structuredClone(receipt));
  const audience = owner.fileDownloadAudience;
  const workspaceRoot = owner.binding.session.state.manifest.root;
  if (
    !owner.binding.authorizeResources ||
    workspaceRoot !== "/workspace" ||
    (audience !== "public" && audience !== "sandbox")
  )
    throw new JournalBindingError("Native generated image delivery owner is unavailable");
  const machine = {
    ...owner.machine,
    authority: structuredClone(owner.machine.authority),
    capabilities: { ...owner.machine.capabilities },
  };
  await owner.invocations.run(async (signal) => {
    const authorize = async () => {
      owner.invocations.assertOpen();
      signal.throwIfAborted();
      await owner.binding.authorizeResources!();
      const inputs = await loadSandboxV2TurnResourceInputs(db, machine.authority);
      const [file] = await getFilesForSubject(db, {
        accountId: machine.authority.accountId,
        workspaceId: machine.authority.workspaceId,
        subjectId: inputs.initiatingHumanSubjectId,
        fileIds: [expected.artifact.artifactId],
      });
      const artifact = await getGeneratedImageArtifact(
        db,
        machine.authority.workspaceId,
        expected.artifact.artifactId,
      );
      if (
        !file ||
        !artifact ||
        artifact.accountId !== machine.authority.accountId ||
        artifact.workspaceId !== machine.authority.workspaceId ||
        artifact.sessionId !== machine.authority.sessionId ||
        artifact.turnId !== machine.authority.turnId ||
        artifact.status !== "ready" ||
        file.status !== "ready" ||
        artifact.file.objectKey !== file.objectKey ||
        artifact.file.bucket !== file.bucket ||
        file.safeFilename !== expected.sandboxPath.split("/").at(-1) ||
        !isDeepStrictEqual(
          retainedGeneratedImageFromArtifact({ ...artifact, file }).receipt,
          expected,
        )
      )
        throw new JournalBindingError("Native generated image changed or is no longer authorized");
      const delivery = SandboxV2PreparationFile.parse({
        fileId: file.id,
        mountPath: "generated-images",
        filename: file.safeFilename,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      });
      signal.throwIfAborted();
      return { file, delivery };
    };
    const original = await authorize();
    const setupId = `generated-image:v1:${expected.artifact.artifactId}`;
    const plan = await retainSandboxV2PreparationPlan(db, machine.authority, {
      setupId,
      workspaceRoot,
      steps: [],
      files: [original.delivery],
    });
    await deliverSandboxV2File(
      db,
      machine,
      { setupId: plan.setupId, file: original.delivery },
      {
        workspaceRoot,
        signal,
        environment: async () => ({}),
        authorizeWrite: async () => {
          await authorize();
        },
        resolveDownloadUrl: async (input) => {
          const current = await authorize();
          if (!isDeepStrictEqual(current.delivery, input))
            throw new JournalBindingError("Native generated image delivery metadata changed");
          const signed = await storage.createGetUrl({ key: current.file.objectKey, audience });
          if (
            !Number.isFinite(signed.expiresAt.getTime()) ||
            signed.expiresAt.getTime() <= Date.now()
          )
            throw new JournalBindingError("Native generated image URL has expired");
          signal.throwIfAborted();
          return signed.url;
        },
      },
    );
    await authorize();
  });
}
