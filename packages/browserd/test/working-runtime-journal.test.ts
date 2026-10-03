import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteInteractionOperationJournal } from "../src/operation-journal";
import {
  SqliteBrowserWorkingRuntimeJournal,
  assertDirectory,
  assertWorkingRuntimeReceipt,
  type BrowserWorkingRuntimeReceipt,
} from "../src/working-runtime-journal";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "synthetic-controller";
const authority = {
  tokenGeneration: 1,
  placementDigest: "a".repeat(64),
  controlDigest: "b".repeat(64),
  viewDigest: "c".repeat(64),
};
const launchDigest = "d".repeat(64);

describe("existing controller journal read-only inspection", () => {
  test("missing/read-only/close never create, recover or checkpoint a journal", async () => {
    const directory = await mkdtemp("/tmp/ogb-journal-readonly-");
    try {
      const missing = join(directory, "absent", "journal.sqlite");
      await expect(
        SqliteInteractionOperationJournal.open(genericOptions(missing, true)),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
      const path = join(directory, "journal.sqlite");
      const writer = await SqliteInteractionOperationJournal.open(genericOptions(path));
      const receipt = {
        operationId: randomUUID(),
        controllerGeneration,
        state: "prepared" as const,
      };
      writer.write({ operationId: receipt.operationId, commandDigest: launchDigest, receipt });
      const before = await databaseSnapshot(path);
      const reader = await SqliteInteractionOperationJournal.open(genericOptions(path, true));
      expect(reader.readLatest()?.receipt).toEqual(receipt);
      expect(() =>
        reader.write({ operationId: "invalid", commandDigest: "invalid", receipt }),
      ).toThrow("read-only");
      expect(() => reader.loadAndRecover()).toThrow("read-only");
      expect(() => reader.withRecoveredRecords(() => false)).toThrow("read-only");
      reader.close();
      expect(await databaseSnapshot(path)).toEqual(before);
      writer.close();
      await symlink(path, join(directory, "linked.sqlite"));
      await expect(
        SqliteInteractionOperationJournal.open(
          genericOptions(join(directory, "linked.sqlite"), true),
        ),
      ).rejects.toThrow("regular file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["state", "bytes", "generation"])(
    "latest %s mismatch cannot expose an older completed receipt",
    async (field) => {
      const directory = await mkdtemp("/tmp/ogb-journal-shadow-");
      const path = join(directory, "journal.sqlite");
      try {
        const journal = await SqliteInteractionOperationJournal.open(genericOptions(path));
        const receipt = {
          operationId: randomUUID(),
          controllerGeneration,
          state: "prepared" as const,
        };
        journal.write({ operationId: receipt.operationId, commandDigest: launchDigest, receipt });
        const newer = { ...receipt, operationId: randomUUID() };
        journal.write({
          operationId: newer.operationId,
          commandDigest: launchDigest,
          receipt: newer,
        });
        journal.close();
        const db = new Database(path);
        if (field === "state")
          db.query(
            "UPDATE interaction_operation_journal SET state='completed' WHERE operation_id=?",
          ).run(newer.operationId);
        if (field === "bytes")
          db.query(
            "UPDATE interaction_operation_journal SET receipt_bytes=100000 WHERE operation_id=?",
          ).run(newer.operationId);
        if (field === "generation")
          db.query(
            "UPDATE interaction_operation_journal SET controller_generation='different' WHERE operation_id=?",
          ).run(newer.operationId);
        db.close();
        const reader = await SqliteInteractionOperationJournal.open(genericOptions(path, true));
        try {
          expect(() => reader.readLatest()).toThrow();
        } finally {
          reader.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("durable working-runtime launch receipts", () => {
  test.each(["prepared", "dispatched", "outcome_unknown"] as const)(
    "newer %s launch shadows completed authority and is never replayed",
    async (state) => {
      await withJournal(async ({ journal, receipt, profile }) => {
        const newer = journal.begin({
          ...receipt,
          authority: { ...authority, tokenGeneration: 2 },
          process: null,
        });
        if (state !== "dispatched") {
          const db = new Database(journalPath(profile));
          const row = db
            .query<{ receipt_json: string }, [string]>(
              "SELECT receipt_json FROM interaction_operation_journal WHERE operation_id=?",
            )
            .get(newer.operationId)!;
          const value = { ...JSON.parse(row.receipt_json), state };
          db.query(
            "UPDATE interaction_operation_journal SET state=?,receipt_json=?,receipt_bytes=? WHERE operation_id=?",
          ).run(
            state,
            JSON.stringify(value),
            Buffer.byteLength(JSON.stringify(value)),
            newer.operationId,
          );
          db.close();
        }
        expect(journal.latest()?.state).toBe(state);
        expect(() =>
          assertWorkingRuntimeReceipt(journal.latest(), authority, launchDigest, receipt.profile),
        ).toThrow("preserved");
        expect(journal.latest()?.operationId).toBe(newer.operationId);
      });
    },
  );

  test("exact directory/token/placement/launch evidence is required; retirement closes recovery", async () => {
    await withJournal(async ({ journal, receipt, profile }) => {
      expect(() =>
        assertWorkingRuntimeReceipt(journal.latest(), authority, launchDigest, receipt.profile),
      ).not.toThrow();
      for (const changed of [
        { ...authority, tokenGeneration: 2 },
        { ...authority, placementDigest: "e".repeat(64) },
        { ...authority, controlDigest: "e".repeat(64) },
        { ...authority, viewDigest: "e".repeat(64) },
      ])
        expect(() =>
          assertWorkingRuntimeReceipt(journal.latest(), changed, launchDigest, receipt.profile),
        ).toThrow();
      expect(() =>
        assertWorkingRuntimeReceipt(journal.latest(), authority, "e".repeat(64), receipt.profile),
      ).toThrow();
      expect(() =>
        assertWorkingRuntimeReceipt(journal.latest(), authority, launchDigest, {
          ...receipt.profile,
          inode: receipt.profile.inode + 1,
        }),
      ).toThrow();
      expect(journal.latest()?.process?.profileDirectory === profile).toBe(true);
      journal.retire(receipt);
      expect(journal.latest()?.intent).toBe("retire");
      expect(() =>
        assertWorkingRuntimeReceipt(journal.latest(), authority, launchDigest, receipt.profile),
      ).toThrow();
    });
  });

  test("one recovery of a completed receipt can claim dispatch; a competing or unknown claim cannot launch again", async () => {
    await withJournal(async ({ journal, receipt }) => {
      const claim = journal.begin({ ...receipt, process: null }, receipt.operationId);
      expect(claim.operationId === receipt.operationId).toBe(false);
      expect(journal.latest()?.state).toBe("dispatched");
      expect(() => journal.begin({ ...receipt, process: null }, receipt.operationId)).toThrow(
        "browser operation id is already bound to another command digest",
      );
      journal.complete(claim, receipt.process);
      expect(() => journal.begin({ ...receipt, process: null }, receipt.operationId)).toThrow(
        "browser operation id is already bound to another command digest",
      );
    });
  });

  test("an independent prepared claimant excludes a rival and unknown replay from dispatch", async () => {
    await withJournal(async ({ journal, receipt, profile }) => {
      const directory = join(profile, "..");
      const childPath = join(directory, "synthetic-claimant.ts");
      const preparedPath = join(directory, "prepared.json");
      const releasePath = join(directory, "release");
      const script = `import { existsSync, writeFileSync } from "node:fs";
        import { SqliteInteractionOperationJournal } from ${JSON.stringify(new URL("../src/operation-journal.ts", import.meta.url).href)};
        import { SqliteBrowserWorkingRuntimeJournal } from ${JSON.stringify(new URL("../src/working-runtime-journal.ts", import.meta.url).href)};
        const writer = await SqliteBrowserWorkingRuntimeJournal.open(${JSON.stringify({
          sessionDirectory: directory,
          browserSessionId,
          controllerGeneration,
        })});
        const write = SqliteInteractionOperationJournal.prototype.write;
        SqliteInteractionOperationJournal.prototype.write = function(record) {
          write.call(this, record);
          if (record.receipt.state === "prepared") {
            writeFileSync(${JSON.stringify(preparedPath)}, JSON.stringify(record.receipt), { mode: 0o600 });
            const gate = new Int32Array(new SharedArrayBuffer(4));
            const deadline = performance.now() + 10000;
            while (!existsSync(${JSON.stringify(releasePath)})) {
              if (performance.now() > deadline) throw new Error("synthetic claimant release timed out");
              Atomics.wait(gate, 0, 0, 5);
            }
          }
        };
        const claim = writer.begin({ ...${JSON.stringify(receipt)}, process: null }, ${JSON.stringify(receipt.operationId)});
        writer.close();
        console.log(JSON.stringify({ operationId: claim.operationId }));`;
      await writeFile(childPath, script, { mode: 0o600 });
      const child = Bun.spawn([process.execPath, "--no-env-file", childPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const refuseClaim = () => {
        let rejected: unknown;
        try {
          journal.begin({ ...receipt, process: null }, receipt.operationId);
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(Error);
        expect((rejected as Error).message).toBe(
          "browser operation id is already bound to another command digest",
        );
      };
      try {
        const deadline = performance.now() + 5000;
        while (!(await Bun.file(preparedPath).exists())) {
          if (performance.now() > deadline) throw new Error("synthetic prepared commit timed out");
          await Bun.sleep(5);
        }
        const prepared = JSON.parse(
          await readFile(preparedPath, "utf8"),
        ) as BrowserWorkingRuntimeReceipt;
        expect(journal.latest()).toEqual(prepared);
        expect(prepared.state).toBe("prepared");
        expect(prepared.launchAttemptId === receipt.launchAttemptId).toBe(false);
        refuseClaim();
        expect(journal.latest()).toEqual(prepared);
        await writeFile(releasePath, "release", { mode: 0o600 });
        expect(await child.exited).toBe(0);
        expect(await stderr).toBe("");
        expect(JSON.parse(await stdout).operationId).toBe(prepared.operationId);
        const dispatched = journal.latest()!;
        expect(dispatched.state).toBe("dispatched");
        const unknown = { ...dispatched, state: "outcome_unknown" as const };
        const database = new Database(journalPath(profile));
        try {
          database
            .query(
              "UPDATE interaction_operation_journal SET state=?,receipt_json=?,receipt_bytes=? WHERE operation_id=?",
            )
            .run(
              unknown.state,
              JSON.stringify(unknown),
              Buffer.byteLength(JSON.stringify(unknown)),
              unknown.operationId,
            );
        } finally {
          database.close();
        }
        refuseClaim();
        expect(journal.latest()).toEqual(unknown);
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    });
  }, 20_000);
});

function genericOptions(path: string, readOnly = false) {
  return {
    path,
    resourceKind: "browser_session" as const,
    resourceId: browserSessionId,
    controllerGeneration,
    resourceLabel: "browser" as const,
    readOnly,
    maxRecordBytes: 1024,
    parseReceipt(value: unknown) {
      return value as { operationId: string; controllerGeneration: string; state: "prepared" };
    },
    assertReceiptAuthority(receipt: { controllerGeneration: string }) {
      if (receipt.controllerGeneration !== controllerGeneration)
        throw new Error("wrong generation");
    },
    recoverRecord: <T>(record: T) => record,
  };
}
async function databaseSnapshot(path: string) {
  const snapshot = [];
  for (const file of [path, `${path}-wal`]) {
    const value = await readFile(file),
      metadata = await stat(file);
    snapshot.push({
      digest: createHash("sha256").update(value).digest("hex"),
      mtime: metadata.mtimeMs,
    });
  }
  return snapshot;
}
function journalPath(profile: string) {
  return join(profile, "..", "working-runtime.sqlite");
}
async function withJournal(
  fn: (fixture: {
    journal: SqliteBrowserWorkingRuntimeJournal;
    receipt: BrowserWorkingRuntimeReceipt;
    profile: string;
  }) => Promise<void>,
) {
  const directory = await mkdtemp("/tmp/ogb-working-journal-");
  const profile = join(directory, "profile");
  await mkdir(profile);
  const journal = await SqliteBrowserWorkingRuntimeJournal.open({
    sessionDirectory: directory,
    browserSessionId,
    controllerGeneration,
  });
  try {
    const input = journal.begin({
      browserSessionId,
      controllerGeneration,
      intent: "launch",
      authority,
      launchDigest,
      restoreAuthorityDigest: null,
      profile: await assertDirectory(profile),
      process: null,
      directoryLaunchAllowed: true,
    });
    const receipt = journal.complete(input, {
      pid: 2001,
      birth: "synthetic-birth",
      executablePath: "/synthetic/chrome",
      profileDirectory: profile,
      cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
    });
    await fn({ journal, receipt, profile });
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}
