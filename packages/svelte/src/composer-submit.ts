import type {
  FileAttachmentStore,
  FileAttachmentStoreSnapshot,
  SessionComposerRuntimeSnapshot,
  SessionComposerRuntimeStore,
} from "@opengeni/sdk/session";

type ComposerSubmitSnapshot = Pick<
  SessionComposerRuntimeSnapshot,
  "canSend" | "pendingDelivery" | "submitting"
>;

export function canSubmitSessionComposer(
  composer: ComposerSubmitSnapshot,
  attachments: FileAttachmentStoreSnapshot | null,
): boolean {
  return (
    !composer.submitting &&
    attachments?.hasUnresolved !== true &&
    (composer.canSend || (attachments?.readyResources.length ?? 0) > 0)
  );
}

export async function submitSessionComposer(
  controller: SessionComposerRuntimeStore,
  attachments: FileAttachmentStore | undefined,
  delivery: "send" | "steer",
): Promise<boolean> {
  const composerSnapshot = controller.getSnapshot();
  const attachmentSnapshot = attachments?.getSnapshot() ?? null;
  if (!canSubmitSessionComposer(composerSnapshot, attachmentSnapshot)) return false;

  const resources = [...(attachmentSnapshot?.readyResources ?? [])];
  const acceptedFileIds =
    delivery === "send" && composerSnapshot.pendingDelivery == null
      ? resources.map((resource) => resource.fileId)
      : [];
  const accepted = await controller.submit(delivery, { resources });
  if (accepted && acceptedFileIds.length > 0) attachments?.removeReadyFiles(acceptedFileIds);
  return accepted;
}
