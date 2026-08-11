import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BrowserStateTransferConflictError,
  BrowserStateTransferOutcomeUnknownError,
  SqliteBrowserStateTransferJournal,
  type BrowserStateCaptureReceipt,
} from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";

describe("SqliteBrowserStateTransferJournal", () => {
  test("replays one completed upload and rejects operation-id drift", async () => {
    await withJournal(async ({ journal }) => {
      const operationId = id(1);
      const digest = requestDigest("first");
      expect(journal.begin(operationId, digest)).toBeNull();
      journal.markDispatched(operationId, digest);
      const completed = journal.complete(operationId, digest, receipt(operationId));
      expect(journal.begin(operationId, digest)).toEqual(completed);
      expect(() => journal.begin(operationId, requestDigest("changed"))).toThrow(
        BrowserStateTransferConflictError,
      );
    });
  });

  test("recovers a dispatched upload as outcome-unknown without replay", async () => {
    await withJournal(async ({ journal, reopen }) => {
      const operationId = id(1);
      const digest = requestDigest("upload");
      journal.begin(operationId, digest);
      journal.markDispatched(operationId, digest);
      journal.close();
      const recovered = await reopen();
      expect(() => recovered.begin(operationId, digest)).toThrow(
        BrowserStateTransferOutcomeUnknownError,
      );
    });
  });

  test("allows an undispatched preparation to be abandoned and retried", async () => {
    await withJournal(async ({ journal }) => {
      const operationId = id(1);
      const digest = requestDigest("prepared");
      journal.begin(operationId, digest);
      journal.abandonPrepared(operationId, digest);
      expect(journal.begin(operationId, digest)).toBeNull();
      expect(() => journal.markOutcomeUnknown(operationId, digest)).toThrow(
        BrowserStateTransferConflictError,
      );
    });
  });

  test("evicts only terminal receipts at capacity", async () => {
    await withJournal(
      async ({ journal }) => {
        const first = id(1);
        const second = id(2);
        const firstDigest = requestDigest("first");
        journal.begin(first, firstDigest);
        expect(() => journal.begin(second, requestDigest("second"))).toThrow(
          "no safely evictable receipt",
        );
        journal.markDispatched(first, firstDigest);
        journal.complete(first, firstDigest, receipt(first));
        expect(journal.begin(second, requestDigest("second"))).toBeNull();
      },
      { maxEntries: 1 },
    );
  });
});

async function withJournal(
  callback: (fixture: {
    journal: SqliteBrowserStateTransferJournal;
    reopen: () => Promise<SqliteBrowserStateTransferJournal>;
  }) => Promise<void>,
  options: { maxEntries?: number } = {},
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-state-journal-");
  const path = join(directory, "state-transfers.sqlite");
  let active = await openJournal(path, options);
  try {
    await callback({
      journal: active,
      reopen: async () => {
        active = await openJournal(path, options);
        return active;
      },
    });
  } finally {
    active.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function openJournal(
  path: string,
  options: { maxEntries?: number },
): Promise<SqliteBrowserStateTransferJournal> {
  return await SqliteBrowserStateTransferJournal.open({
    path,
    browserSessionId,
    controllerGeneration,
    ...options,
  });
}

function receipt(operationId: string): BrowserStateCaptureReceipt {
  return {
    operationId,
    browserSessionId,
    controllerGeneration,
    objectKey: `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/publications/${operationId}/chromium-profile.ogbs`,
    format: BROWSER_PROFILE_ARTIFACT_FORMAT,
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    sizeBytes: 123,
    fileCount: 2,
    profileBytes: 100,
    manifest: {
      schemaVersion: 1,
      browserSessionId,
      controllerGeneration,
      capturedAt: "2026-08-09T12:00:00.000Z",
      engine: "chromium",
      engineVersion: "140.0.0.0",
      driverId: "opengeni.cdp.v1",
      driverSchemaVersion: 1,
      profileCrypto: "chromium_basic",
      platform: "linux",
      architecture: "x64",
      tabs: [{ url: "https://example.test/", selected: true }],
    },
  };
}

function requestDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function id(sequence: number): string {
  return `22222222-2222-4222-8222-${sequence.toString().padStart(12, "0")}`;
}
