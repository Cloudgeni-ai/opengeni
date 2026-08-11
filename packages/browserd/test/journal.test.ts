import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionReceipt } from "@opengeni/contracts";
import { BrowserInteractionController, type BrowserInteractionDriver } from "@opengeni/interaction";
import { Database } from "bun:sqlite";
import { SqliteBrowserOperationJournal } from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";
const settledAt = "2026-08-09T12:00:00.000Z";

describe("SqliteBrowserOperationJournal", () => {
  test("recovers dispatched work as outcome unknown and never replays it", async () => {
    await withJournal(async ({ path, journal }) => {
      const operationId = id(1);
      const dispatched = deferred();
      const release = deferred();
      const original = new BrowserInteractionController({
        browserSessionId,
        controllerGeneration,
        onJournalRecord: (next) => journal.write(next),
        driver: fixtureDriver(async () => {
          dispatched.resolve();
          await release.promise;
        }),
      });
      const interrupted = original.run(command(operationId));
      await dispatched.promise;
      journal.close();
      release.reject(new Error("controller process disappeared"));
      expect((await interrupted).state).toBe("outcome_unknown");

      const reopened = await SqliteBrowserOperationJournal.open({
        path,
        browserSessionId,
        controllerGeneration,
      });
      try {
        const recovered = reopened.loadAndRecover(settledAt);
        expect(recovered).toHaveLength(1);
        expect(recovered[0]?.receipt).toMatchObject({
          state: "outcome_unknown",
          settledAt,
          error: { code: "controller_lost", retryable: false },
        });
        let dispatches = 0;
        const controller = new BrowserInteractionController({
          browserSessionId,
          controllerGeneration,
          initialJournal: recovered,
          onJournalRecord: (next) => reopened.write(next),
          driver: fixtureDriver(() => {
            dispatches += 1;
          }),
        });
        const replay = await controller.run(command(operationId));
        expect(replay.state).toBe("outcome_unknown");
        expect(dispatches).toBe(0);
        expect(reopened.loadAndRecover(settledAt)).toEqual(recovered);
      } finally {
        reopened.close();
      }
    });
  });

  test("recovers prepared work as a retryable failure", async () => {
    await withJournal(async ({ journal }) => {
      const operationId = id(1);
      const digest = createHash("sha256").update("prepared").digest("hex");
      journal.write(record(operationId, digest, "prepared"));
      expect(journal.loadAndRecover(settledAt)[0]?.receipt).toMatchObject({
        state: "failed",
        dispatchedAt: null,
        error: { code: "controller_lost", retryable: true },
      });
    });
  });

  test("enforces digest identity and monotonic transitions", async () => {
    await withJournal(async ({ journal }) => {
      const operationId = id(1);
      const digest = createHash("sha256").update("first").digest("hex");
      journal.write(record(operationId, digest, "prepared"));
      expect(() =>
        journal.write(
          record(operationId, createHash("sha256").update("second").digest("hex"), "dispatched"),
        ),
      ).toThrow("another command digest");
      journal.write(record(operationId, digest, "dispatched"));
      journal.write(record(operationId, digest, "completed"));
      expect(() => journal.write(record(operationId, digest, "outcome_unknown"))).toThrow(
        "invalid browser operation transition",
      );
    });
  });

  test("evicts only the oldest terminal operation at capacity", async () => {
    await withJournal(
      async ({ journal }) => {
        const firstDigest = createHash("sha256").update("first").digest("hex");
        journal.write(record(id(1), firstDigest, "prepared"));
        expect(() =>
          journal.write(
            record(id(2), createHash("sha256").update("second").digest("hex"), "prepared"),
          ),
        ).toThrow("no safely evictable record");
        journal.write(record(id(1), firstDigest, "failed"));
        journal.write(
          record(id(2), createHash("sha256").update("second").digest("hex"), "prepared"),
        );
        expect(journal.loadAndRecover(settledAt).map((entry) => entry.operationId)).toEqual([
          id(2),
        ]);
      },
      { maxEntries: 1 },
    );
  });

  test("atomically carries the legacy Browser journal into the shared schema", async () => {
    const directory = await mkdtemp("/tmp/ogb-journal-migration-");
    const path = join(directory, "operations.sqlite");
    const operationId = id(1);
    const digest = createHash("sha256").update("legacy").digest("hex");
    const legacyReceipt = receipt(operationId, "prepared");
    const database = new Database(path, { create: true, readwrite: true, strict: true });
    database.exec(`
      CREATE TABLE browser_operation_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        browser_session_id TEXT NOT NULL,
        controller_generation TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        command_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        receipt_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (browser_session_id, controller_generation, operation_id)
      );
    `);
    const receiptJson = JSON.stringify(legacyReceipt);
    database
      .query<unknown, [string, string, string, string, string, string, number, string]>(
        `INSERT INTO browser_operation_journal (
           browser_session_id, controller_generation, operation_id, command_digest,
           state, receipt_json, receipt_bytes, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        browserSessionId,
        controllerGeneration,
        operationId,
        digest,
        "prepared",
        receiptJson,
        Buffer.byteLength(receiptJson),
        settledAt,
      );
    database.close();

    const journal = await SqliteBrowserOperationJournal.open({
      path,
      browserSessionId,
      controllerGeneration,
    });
    try {
      expect(journal.loadAndRecover(settledAt)[0]?.receipt.state).toBe("failed");
    } finally {
      journal.close();
    }
    const verification = new Database(path, { readonly: true, strict: true });
    try {
      expect(
        verification
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_operation_journal'",
          )
          .get(),
      ).toBeNull();
      expect(
        verification
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM interaction_operation_journal",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      verification.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function withJournal(
  callback: (fixture: { path: string; journal: SqliteBrowserOperationJournal }) => Promise<void>,
  options: { maxEntries?: number } = {},
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-journal-");
  const path = join(directory, "operations.sqlite");
  const journal = await SqliteBrowserOperationJournal.open({
    path,
    browserSessionId,
    controllerGeneration,
    ...options,
  });
  try {
    await callback({ path, journal });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function id(sequence: number): string {
  return `22222222-2222-4222-8222-${sequence.toString().padStart(12, "0")}`;
}

function record(operationId: string, commandDigest: string, state: BrowserActionReceipt["state"]) {
  return {
    operationId,
    commandDigest,
    receipt: receipt(operationId, state),
  };
}

function receipt(operationId: string, state: BrowserActionReceipt["state"]): BrowserActionReceipt {
  const dispatchedAt = state === "prepared" ? null : settledAt;
  const terminal = state === "completed" || state === "failed" || state === "outcome_unknown";
  return {
    protocolVersion: 1,
    operationId,
    browserSessionId,
    controllerGeneration,
    targetId: "target-1",
    state,
    dispatchedAt,
    settledAt: terminal ? settledAt : null,
    observation: null,
    error:
      state === "failed" || state === "outcome_unknown"
        ? { code: "controller_lost", message: "fixture", retryable: false }
        : null,
  };
}

function command(operationId: string) {
  return {
    protocolVersion: 1 as const,
    operationId,
    browserSessionId,
    controllerGeneration,
    targetId: "target-1",
    expectedTargetGeneration: "target-1",
    expectedDocumentGeneration: "document-1",
    expectedFrameId: "frame-1",
    actor: { kind: "system" as const, subjectId: "fixture" },
    action: { type: "click" as const, locator: { kind: "ref" as const, ref: "e1" } },
  };
}

function fixtureDriver(onDispatch: () => void | Promise<void>): BrowserInteractionDriver {
  return {
    async target() {
      return {
        id: "target-1",
        browserSessionId,
        controllerGeneration,
        targetGeneration: "target-1",
        documentGeneration: "document-1",
        kind: "page",
        title: "Fixture",
        url: "https://fixture.test/",
        selected: true,
        attached: true,
        createdAt: settledAt,
      };
    },
    async observe() {
      throw new Error("unused");
    },
    async dispatch() {
      await onDispatch();
      throw new Error("must not dispatch");
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
