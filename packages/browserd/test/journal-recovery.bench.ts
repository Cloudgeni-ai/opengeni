import {
  BrowserInteractionController,
  type BrowserOperationJournalRecord,
} from "@opengeni/interaction";
import { Database } from "bun:sqlite";
import { SqliteBrowserOperationJournal } from "../src/journal";
const [mode, path] = Bun.argv.slice(2);
if (!path || !["seed", "baseline", "candidate"].includes(mode ?? ""))
  throw new Error(
    "Usage: bun test/journal-recovery.bench.ts seed|baseline|candidate /absolute/fixture.sqlite",
  );
if (mode === "seed" && (await Bun.file(path).exists()))
  throw new Error("Refusing to replace existing fixture");
if (mode !== "seed" && !(await Bun.file(path).exists())) throw new Error("Seed the fixture first");
const browserSessionId = "11111111-1111-4111-8111-111111111111",
  controllerGeneration = "controller-1",
  at = "2026-09-27T10:00:00.000Z";
const count = 1800,
  nodes = 1000;
const j = await SqliteBrowserOperationJournal.open({
  path,
  browserSessionId,
  controllerGeneration,
});
if (mode === "seed") {
  j.close();
  const db = new Database(path);
  const insert = db.query(
    "INSERT INTO interaction_operation_journal(resource_kind,resource_id,controller_generation,operation_id,command_digest,state,receipt_json,receipt_bytes,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const operationId = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
      const target = {
        id: "target-1",
        browserSessionId,
        controllerGeneration,
        targetGeneration: "target-1",
        documentGeneration: "document-1",
        kind: "page",
        title: "Fixture",
        url: "https://example.test/",
        selected: true,
        attached: true,
        createdAt: at,
      };
      const observation = {
        protocolVersion: 1,
        observationId: "observation-" + i,
        browserSessionId,
        target,
        frameId: "frame-1",
        semantic: {
          kind: "snapshot",
          nodeCount: nodes,
          roots: Array.from({ length: nodes }, (_, n) => ({
            ref: "e" + n,
            role: "text",
            name: `Receipt ${i} item ${n} — review synthetic installation progress`,
            states: [],
            actions: [],
          })),
        },
        screenshot: null,
        focusedRef: null,
        changedRegions: [],
        diagnostics: {
          consoleErrorCount: 0,
          failedRequestCount: 0,
          downloadCount: 0,
          pageErrorCount: 0,
        },
        dialog: null,
        observedAt: at,
      };
      const text = JSON.stringify({
        protocolVersion: 1,
        operationId,
        browserSessionId,
        controllerGeneration,
        targetId: "target-1",
        state: "completed",
        dispatchedAt: at,
        settledAt: at,
        observation,
        error: null,
      });
      insert.run(
        "browser_session",
        browserSessionId,
        controllerGeneration,
        operationId,
        "a".repeat(64),
        "completed",
        text,
        Buffer.byteLength(text),
        at,
      );
    }
  })();
  db.close();
  console.log(JSON.stringify({ seeded: count, nodes, fileBytes: Bun.file(path).size }));
} else {
  Bun.gc(true);
  const before = process.memoryUsage();
  const start = performance.now();
  const digest = new Bun.CryptoHasher("sha256");
  let seen = 0;
  const driver = {
    target: async () => {
      throw Error("unexpected target");
    },
    observe: async () => {
      throw Error("unexpected observe");
    },
    dispatch: async () => {
      throw Error("unexpected dispatch");
    },
  };
  const consume = (records: Iterable<BrowserOperationJournalRecord>) =>
    new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
      loadJournalRecord: (id) => j.read(id),
      initialJournal: (function* () {
        for (const r of records) {
          digest.update(JSON.stringify(r));
          seen++;
          yield r;
        }
      })(),
    });
  const controller =
    mode === "candidate" ? j.withRecoveredRecords(consume, at) : consume(j.loadAndRecover(at));
  const elapsedMs = performance.now() - start;
  if (seen !== count) throw Error("restore count mismatch");
  const restoredDigest = digest.digest("hex");
  const replay = new Bun.CryptoHasher("sha256");
  for (let i = 0; i < count; i++) {
    const id = "22222222-2222-4222-8222-" + String(i).padStart(12, "0");
    const receipt = controller.receipt(id);
    if (!receipt) throw Error("missing replay");
    replay.update(JSON.stringify({ operationId: id, commandDigest: "a".repeat(64), receipt }));
  }
  const replayDigest = replay.digest("hex");
  if (replayDigest !== restoredDigest) throw Error("receipt replay changed");
  console.log(
    JSON.stringify({
      mode: mode,
      records: seen,
      elapsedMs,
      rssBeforeMiB: before.rss / 1048576,
      rssMiB: process.memoryUsage().rss / 1048576,
      maxRSSKiB: process.resourceUsage().maxRSS,
      restoredDigest,
      replayDigest,
    }),
  );
  j.close();
}
