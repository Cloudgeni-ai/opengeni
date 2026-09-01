import { describe, expect, test } from "bun:test";
import { createSessionComposerRuntimeStore } from "@opengeni/sdk/session";
import type {
  FileAttachmentStore,
  FileAttachmentStoreSnapshot,
  SessionComposerRuntimeSnapshot,
  SessionComposerRuntimeStore,
} from "@opengeni/sdk/session";
import { canSubmitSessionComposer, submitSessionComposer } from "../src/composer-submit";

const composerSnapshot = (
  overrides: Partial<
    Pick<SessionComposerRuntimeSnapshot, "canSend" | "pendingDelivery" | "submitting">
  > = {},
) =>
  ({
    canSend: true,
    pendingDelivery: null,
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

  test("keeps Steer attachments when an uncertain delivery is reconciled", async () => {
    const attemptedResources: unknown[] = [];
    let attempts = 0;
    const controller = createSessionComposerRuntimeStore({
      client: {
        listEvents: async () => [],
        steerMessage: async (
          _workspaceId: string,
          _sessionId: string,
          input: { resources?: readonly unknown[] },
        ) => {
          attemptedResources.push(input.resources ?? []);
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("transport outcome unknown"), {
              outcomeUnknown: true as const,
            });
          }
          return {
            accepted: { id: "accepted-steer" },
            turn: { id: "steered-turn" },
            routing: "accepted_for_steering",
            interruptionCount: 1,
            replay: false,
          } as never;
        },
      } as never,
      workspaceId: "99999999-9999-4999-8999-999999999999",
      sessionId: "88888888-8888-4888-8888-888888888889",
      draftPersistence: "disabled",
      initialPolicy: {
        model: "model-a",
        reasoningEffort: "medium",
        latencyMode: "standard",
      },
      events: [],
    });
    await controller.start();
    controller.setText("change direction");

    let currentAttachments = attachmentSnapshot(["file-original"]);
    const removals: string[][] = [];
    const attachments = {
      getSnapshot: () => currentAttachments,
      removeReadyFiles: (fileIds: Iterable<string>) => {
        const removed = [...fileIds];
        removals.push(removed);
        currentAttachments = attachmentSnapshot(
          currentAttachments.readyResources
            .map((resource) => resource.fileId)
            .filter((fileId) => !removed.includes(fileId)),
        );
      },
    } as unknown as FileAttachmentStore;

    expect(await submitSessionComposer(controller, attachments, "steer")).toBe(false);
    expect(controller.getSnapshot().pendingDelivery).toBe("steer");

    currentAttachments = attachmentSnapshot(["file-original", "file-later"]);
    expect(await submitSessionComposer(controller, attachments, "steer")).toBe(true);

    expect(attemptedResources).toEqual([
      [{ kind: "file", fileId: "file-original" }],
      [{ kind: "file", fileId: "file-original" }],
    ]);
    expect(removals).toEqual([]);
    expect(currentAttachments.readyResources).toEqual([
      { kind: "file", fileId: "file-original" },
      { kind: "file", fileId: "file-later" },
    ]);
    expect(controller.getSnapshot().pendingDelivery).toBeNull();
    controller.destroy();
  });
});
