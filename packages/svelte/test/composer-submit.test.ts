import { describe, expect, test } from "bun:test";
import type {
  FileAttachmentStore,
  FileAttachmentStoreSnapshot,
  SessionComposerRuntimeSnapshot,
  SessionComposerRuntimeStore,
} from "@opengeni/sdk/session";
import { canSubmitSessionComposer, submitSessionComposer } from "../src/composer-submit";

const composerSnapshot = (
  overrides: Partial<Pick<SessionComposerRuntimeSnapshot, "canSend" | "submitting">> = {},
) =>
  ({
    canSend: true,
    submitting: false,
    ...overrides,
  }) as SessionComposerRuntimeSnapshot;

const attachmentSnapshot = (
  fileIds: readonly string[],
  hasUnresolved = false,
): FileAttachmentStoreSnapshot => ({
  attachments: [],
  readyResources: fileIds.map((fileId) => ({ kind: "file" as const, fileId })),
  uploading: hasUnresolved,
  hasUnresolved,
});

describe("native Svelte composer attachment transaction", () => {
  test("blocks every submit entry point while an attachment is unresolved", async () => {
    let submitCalls = 0;
    const controller = {
      getSnapshot: () => composerSnapshot(),
      submit: async () => {
        submitCalls += 1;
        return true;
      },
    } as unknown as SessionComposerRuntimeStore;
    const attachments = {
      getSnapshot: () => attachmentSnapshot([], true),
      removeReadyFiles: () => undefined,
    } as unknown as FileAttachmentStore;

    expect(canSubmitSessionComposer(controller.getSnapshot(), attachments.getSnapshot())).toBe(
      false,
    );
    expect(await submitSessionComposer(controller, attachments, "send")).toBe(false);
    expect(await submitSessionComposer(controller, attachments, "steer")).toBe(false);
    expect(submitCalls).toBe(0);
  });

  test("removes exactly the files captured by an accepted submit", async () => {
    let resolveSubmit!: (accepted: boolean) => void;
    const accepted = new Promise<boolean>((resolve) => {
      resolveSubmit = resolve;
    });
    let currentAttachments = attachmentSnapshot(["file-a"]);
    const removals: string[][] = [];
    const submitted: unknown[] = [];
    const controller = {
      getSnapshot: () => composerSnapshot({ canSend: false }),
      submit: async (delivery: "send" | "steer", extras: unknown) => {
        submitted.push([delivery, extras]);
        return await accepted;
      },
    } as unknown as SessionComposerRuntimeStore;
    const attachments = {
      getSnapshot: () => currentAttachments,
      removeReadyFiles: (fileIds: Iterable<string>) => removals.push([...fileIds]),
    } as unknown as FileAttachmentStore;

    const submission = submitSessionComposer(controller, attachments, "send");
    currentAttachments = attachmentSnapshot(["file-a", "file-later"]);
    resolveSubmit(true);

    expect(await submission).toBe(true);
    expect(submitted).toEqual([["send", { resources: [{ kind: "file", fileId: "file-a" }] }]]);
    expect(removals).toEqual([["file-a"]]);
  });

  test("keeps captured files when local submission is rejected", async () => {
    const removals: string[][] = [];
    const controller = {
      getSnapshot: () => composerSnapshot({ canSend: false }),
      submit: async () => false,
    } as unknown as SessionComposerRuntimeStore;
    const attachments = {
      getSnapshot: () => attachmentSnapshot(["file-a"]),
      removeReadyFiles: (fileIds: Iterable<string>) => removals.push([...fileIds]),
    } as unknown as FileAttachmentStore;

    expect(await submitSessionComposer(controller, attachments, "send")).toBe(false);
    expect(removals).toEqual([]);
  });
});
