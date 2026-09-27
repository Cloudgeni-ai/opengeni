import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { BrowserActionReceipt } from "@opengeni/contracts";
import {
  BrowserInteractionController,
  BrowserProtectedAuthController,
  type BrowserInteractionDriver,
} from "@opengeni/interaction";
import { SqliteBrowserOperationJournal, SqliteBrowserProtectedAuthJournal } from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";
const settledAt = "2026-08-09T12:00:00.000Z";

describe("SqliteBrowserOperationJournal", () => {
  test("replays exact durable receipts and isolates readers by controller authority", async () => {
    await withJournal(async ({ path, journal }) => {
      let dispatches = 0;
      const controller = new BrowserInteractionController({
        browserSessionId,
        controllerGeneration,
        onJournalRecord: (next) => journal.write(next),
        loadJournalRecord: (operation) => journal.read(operation),
        driver: fixtureDriver(() => {
          dispatches++;
        }),
      });
      const completedReceipt = await controller.run(command(id(1)));
      await controller.waitForIdle();
      expect(journal.read(id(1))?.receipt).toEqual(completedReceipt);
      expect(controller.receipt(id(1))).toEqual(completedReceipt);
      expect(await controller.run(command(id(1)))).toEqual(completedReceipt);
      const other = await SqliteBrowserOperationJournal.open({
        path,
        browserSessionId,
        controllerGeneration: "other-controller",
      });
      try {
        expect(other.read(id(1))).toBeNull();
      } finally {
        other.close();
      }
      expect(journal.read(id(2))).toBeNull();
      expect(dispatches).toBe(1);
      journal.close();
      expect(() => controller.receipt(id(1))).toThrow("closed");
      expect(() => controller.run(command(id(1)))).toThrow("closed");
      expect(dispatches).toBe(1);
    });
  });

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

  test("streams recovered receipts into the controller without redispatch", async () => {
    await withJournal(async ({ journal }) => {
      let dispatches = 0;
      const driver = fixtureDriver(() => {
        dispatches++;
      });
      const original = new BrowserInteractionController({
        browserSessionId,
        controllerGeneration,
        driver,
        onJournalRecord: (entry) => journal.write(entry),
        loadJournalRecord: (operationId) => journal.read(operationId),
      });
      const receipts = [];
      for (let i = 1; i <= 3; i++) receipts.push(await original.run(command(id(i))));
      await original.waitForIdle();
      const restored = journal.withRecoveredRecords((records) => {
        expect(Array.isArray(records)).toBe(false);
        return new BrowserInteractionController({
          browserSessionId,
          controllerGeneration,
          driver,
          initialJournal: records,
          onJournalRecord: (entry) => journal.write(entry),
          loadJournalRecord: (operationId) => journal.read(operationId),
        });
      }, settledAt);
      for (let i = 1; i <= 3; i++) {
        expect(await restored.run(command(id(i)))).toEqual(receipts[i - 1]!);
      }
      expect(dispatches).toBe(3);
    });
  });

  test("consumer failure rolls back recovery and cannot leave a live iterator", async () => {
    await withJournal(async ({ journal }) => {
      journal.write(record(id(1), "a".repeat(64), "prepared"));
      journal.write(record(id(2), "b".repeat(64), "prepared"));
      let escaped: Iterator<unknown> | undefined;
      expect(() =>
        journal.withRecoveredRecords((records) => {
          escaped = records[Symbol.iterator]();
          expect(escaped.next().done).toBe(false);
          throw new Error("controller initialization failed");
        }, settledAt),
      ).toThrow("controller initialization failed");
      expect(escaped?.next().done).toBe(true);
      expect(journal.read(id(1))?.receipt.state).toBe("prepared");
      expect(journal.read(id(2))?.receipt.state).toBe("prepared");
      expect(() => journal.withRecoveredRecords(() => Promise.resolve(), settledAt)).toThrow(
        "consumer must be synchronous",
      );
      expect(journal.read(id(1))?.receipt.state).toBe("prepared");
    });
  });

  test("rolls back earlier recovery when a later retained receipt is corrupt", async () => {
    await withJournal(async ({ path, journal }) => {
      const digest = createHash("sha256").update("recovery").digest("hex");
      journal.write(record(id(1), digest, "prepared"));
      journal.write(record(id(2), digest, "prepared"));
      journal.write(record(id(2), digest, "dispatched"));
      const db = new Database(path);
      try {
        db.query(
          "UPDATE interaction_operation_journal SET receipt_json = '{}' WHERE operation_id = ?",
        ).run(id(2));
        expect(() => journal.loadAndRecover(settledAt)).toThrow("byte count is corrupt");
        let consumed = false;
        expect(() =>
          journal.withRecoveredRecords(() => {
            consumed = true;
          }, settledAt),
        ).toThrow("byte count is corrupt");
        expect(consumed).toBe(false);
        expect(
          db
            .query("SELECT state FROM interaction_operation_journal WHERE operation_id = ?")
            .get(id(1)),
        ).toEqual({ state: "prepared" });
      } finally {
        db.close();
      }
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
});

describe("SqliteBrowserProtectedAuthJournal", () => {
  test("never persists secret values and replays an exact non-secret command identity", async () => {
    const directory = await mkdtemp("/tmp/ogb-protected-journal-");
    const path = join(directory, "protected.sqlite");
    const operationId = id(9);
    const journal = await SqliteBrowserProtectedAuthJournal.open({
      path,
      browserSessionId,
      controllerGeneration,
    });
    let dispatches = 0;
    const makeController = () =>
      new BrowserProtectedAuthController({
        browserSessionId,
        controllerGeneration,
        initialJournal: journal.loadAndRecover(settledAt),
        onJournalRecord: (next) => journal.write(next),
        driver: {
          async target() {
            return protectedTarget();
          },
          async observe() {
            return { target: protectedTarget(), status: "working" };
          },
          async dispatch() {
            dispatches += 1;
            return { target: protectedTarget(), status: "submitted" };
          },
        },
      });
    try {
      const first = await makeController().run(protectedCommand(operationId, "journal-secret"));
      const replay = await makeController().run(protectedCommand(operationId, "rotated-secret"));
      expect(first.state).toBe("completed");
      expect(replay).toEqual(first);
      expect(dispatches).toBe(1);
    } finally {
      journal.close();
    }
    const durableBytes = await readFile(path, "utf8");
    expect(durableBytes).not.toContain("journal-secret");
    expect(durableBytes).not.toContain("rotated-secret");
    await rm(directory, { recursive: true, force: true });
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

function protectedTarget() {
  return {
    id: "target-1",
    browserSessionId,
    controllerGeneration,
    targetGeneration: "target-1",
    documentGeneration: "document-1",
    kind: "page" as const,
    title: "Fixture",
    url: "https://fixture.test/",
    selected: true,
    attached: true,
    createdAt: settledAt,
  };
}

function protectedCommand(operationId: string, value: string) {
  return {
    protocolVersion: 1 as const,
    operationId,
    browserSessionId,
    controllerGeneration,
    targetId: "target-1",
    expectedTargetGeneration: "target-1",
    expectedDocumentGeneration: "document-1",
    expectedFrameId: "frame-1",
    actor: { kind: "system" as const, subjectId: "credential-broker" },
    authorityId: "password-authority",
    credentialVersion: 1,
    allowedOrigins: ["https://fixture.test"],
    fields: [
      {
        fieldId: "password",
        locator: { kind: "ref" as const, ref: "e-password" },
        purpose: "password" as const,
        value,
      },
    ],
    submit: { type: "press" as const, key: "Enter" },
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
