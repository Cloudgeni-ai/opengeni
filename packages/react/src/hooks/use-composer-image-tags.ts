import type { ResourceRef } from "@opengeni/sdk";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { messageImageIds, reconcileImageMarkers } from "../lib/image-markers";
import type { FileAttachment, UseFileAttachmentsResult } from "./use-file-attachments";

export type ComposerImageTagsOptions = {
  enabled: boolean;
  attachments: readonly FileAttachment[];
  /** Files a restored draft brought back; they reach the agent before attachments. */
  restoredResources: readonly ResourceRef[];
  loadFileContentType?: UseFileAttachmentsResult["loadFileContentType"];
  /** The composer's current text, read when the images change. */
  readValue: () => string;
  setValue: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

/**
 * Keeps a composer's `[Image N]` tags in line with the images its message
 * carries. An image the person adds gets a tag where they were writing;
 * removing one deletes its tag and renumbers the later ones. Returns each
 * image's number, keyed by attachment id and by `restoredImageKey(fileId)`,
 * or undefined when tags are off.
 */
export function useComposerImageTags({
  enabled,
  attachments,
  restoredResources,
  loadFileContentType,
  readValue,
  setValue,
  textareaRef,
}: ComposerImageTagsOptions): ReadonlyMap<string, number> | undefined {
  const restoredFileIds = useMemo(
    () =>
      enabled
        ? restoredResources.flatMap((resource) =>
            resource.kind === "file" ? [resource.fileId] : [],
          )
        : [],
    [enabled, restoredResources],
  );
  const restoredKey = restoredFileIds.join("\n");
  // Whether each restored file is an image. A restored draft names its files
  // without their content types, so they are looked up once.
  const [restoredKinds, setRestoredKinds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const restoredKindsRef = useRef(restoredKinds);
  restoredKindsRef.current = restoredKinds;
  useEffect(() => {
    const unknown = restoredFileIds.filter((fileId) => !restoredKindsRef.current.has(fileId));
    if (unknown.length === 0) return;
    const controller = new AbortController();
    // A file whose type can't be read counts as an image: a chat draft's
    // files are almost always pasted images, and its text tagged them.
    const kindOf = async (fileId: string): Promise<readonly [string, boolean]> => {
      try {
        const contentType = await loadFileContentType?.(fileId, controller.signal);
        return [fileId, contentType === undefined || contentType.startsWith("image/")];
      } catch {
        return [fileId, true];
      }
    };
    void Promise.all(unknown.map(kindOf)).then((entries) => {
      if (controller.signal.aborted) return;
      setRestoredKinds((current) => new Map([...current, ...entries]));
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the restored file list
  }, [restoredKey, loadFileContentType]);

  const restoredReady = restoredFileIds.every((fileId) => restoredKinds.has(fileId));
  const imageIds = useMemo(
    () =>
      enabled && restoredReady
        ? messageImageIds(
            restoredFileIds.filter((fileId) => restoredKinds.get(fileId) === true),
            attachments,
          )
        : null,
    [attachments, enabled, restoredFileIds, restoredKinds, restoredReady],
  );
  const imageNumbers = useMemo(
    () => (imageIds ? new Map(imageIds.map((id, index) => [id, index + 1])) : undefined),
    [imageIds],
  );

  // The images the text's tags were last numbered against. Null until the
  // first complete list, which is taken as it is: images already present when
  // tags turn on (or the composer mounts) are not tagged again.
  const previousRef = useRef<readonly string[] | null>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const imageIdsKey = imageIds?.join("\n") ?? null;
  useEffect(() => {
    if (!enabled) {
      previousRef.current = null;
      return;
    }
    if (!imageIds) return; // a restored file's type is still being looked up
    const previous = previousRef.current;
    previousRef.current = imageIds;
    if (previous === null) return;
    // Only attachments the person just added get a new tag; restored files
    // and restored attachments bring theirs in the restored text.
    const added = new Set(
      attachmentsRef.current
        .filter((attachment) => attachment.restored !== true)
        .map((attachment) => attachment.id),
    );
    const insert = imageIds.filter((id) => added.has(id) && !previous.includes(id));
    const value = readValue();
    const textarea = textareaRef.current;
    const edit = reconcileImageMarkers({
      text: value,
      previous,
      next: imageIds,
      insert,
      caret: textarea && textarea.value === value ? textarea.selectionStart : value.length,
    });
    if (!edit) return;
    setValue(edit.text);
    window.requestAnimationFrame(() => {
      const current = textareaRef.current;
      if (current && current.value === edit.text) current.setSelectionRange(edit.caret, edit.caret);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the image list itself
  }, [imageIdsKey, enabled]);

  return imageNumbers;
}
