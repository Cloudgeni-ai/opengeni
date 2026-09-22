import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  execute,
  initialize,
  initLedger,
  assertNativeBudget,
  nativeReservation,
  REVISION,
  type Config,
} from "./codex-tool";
import { TYPESAFE_INPUT_RATE } from "./typesafe-direct";
import { hash, type Judge, type Snapshot } from "./core";

const snapshot: Snapshot = {
  revision: REVISION,
  digest: hash("fixture"),
  excluded: 0,
  limited: false,
  chunks: [
    {
      id: "e0",
      path: "example.ts",
      startLine: 1,
      endLine: 1,
      text: "export const example = true;",
    },
  ],
};
test("shared budget counts unknown reservations and never releases reported reservations", () => {
  const attempt = { taskId: "one", reservedUsd: 0.008, status: "billing_unknown_reserved" };
  expect(() => assertNativeBudget(Array(32).fill(attempt), 0.001)).toThrow("native_shared_budget");
  expect(() =>
    assertNativeBudget([{ ...attempt, reservedUsd: 0.25, estimatedUsd: 0.001 }], 0.001),
  ).toThrow("native_shared_budget");
  expect(() => assertNativeBudget([{ ...attempt, estimatedUsd: 0.25 }], 0.001)).toThrow(
    "native_shared_budget",
  );
  expect(() => assertNativeBudget([attempt], 0.001)).not.toThrow();
});
async function setup(
  arm: Config["arm"] = "ordinary",
  mode: Config["mode"] = "answer_if_supported",
) {
  const root = mkdtempSync(join(tmpdir(), "codex-tool-")),
    ledgerDir = join(root, "ledger"),
    outputDir = join(root, "task");
  initLedger(ledgerDir);
  const config: Config = {
    root,
    revision: REVISION,
    subdir: "apps/web/src/lib",
    question: "Is example true?",
    context: "",
    mode,
    initialQueries: ["example"],
    arm,
    outputDir,
    ledgerDir,
    taskId: "task1",
    deadlineMs: 240000,
    nativeAuthorized: false,
  };
  await initialize(config, () => snapshot);
  return { config, outputDir, ledgerDir };
}
test("native payload and reservation bounds", () => {
  expect(nativeReservation({ state: "small", questions: {} })).toBeGreaterThanOrEqual(
    64000 * TYPESAFE_INPUT_RATE,
  );
  expect(() => nativeReservation({ state: "x".repeat(64000) })).toThrow(
    "native_payload_byte_budget",
  );
});
test("evidence mode rejects binary finish", async () => {
  const { outputDir } = await setup("ordinary", "evidence");
  await execute(outputDir, { op: "discover" });
  await expect(
    execute(outputDir, {
      op: "finish",
      answer: "yes",
      explanation: "example",
      citationIds: ["c0"],
    }),
  ).rejects.toThrow("evidence_mode_requires_indecisive");
});
test("failed initial investigation cannot be skipped", async () => {
  const { outputDir } = await setup("delegated");
  await expect(
    execute(outputDir, { op: "investigate" }, async () => {
      throw new Error("mock_failure");
    }),
  ).rejects.toThrow("mock_failure");
  await expect(execute(outputDir, { op: "search", queries: ["example"] })).rejects.toThrow(
    "initial_operation_failed_no_continuation",
  );
});
test("ordinary discovery, persisted citations, reads and tiny finish", async () => {
  const { outputDir } = await setup();
  const discovered: any = await execute(outputDir, { op: "discover" });
  expect(discovered.queries).toEqual(["example"]);
  expect(discovered.hits[0].citationId).toBe("c0");
  await execute(outputDir, { op: "read", path: "example.ts", startLine: 1, endLine: 1 });
  expect(
    await execute(outputDir, {
      op: "finish",
      answer: "yes",
      explanation: "The exported constant is true.",
      citationIds: ["c0"],
    }),
  ).toEqual({ finished: true, answer: "yes", citationCount: 1 });
  expect(JSON.parse(readFileSync(join(outputDir, "source-citations.json"), "utf8")).revision).toBe(
    REVISION,
  );
  await expect(execute(outputDir, { op: "discover" })).rejects.toThrow("task_closed");
});
test("initial order and exact initial queries are enforced", async () => {
  const { outputDir } = await setup();
  await expect(execute(outputDir, { op: "search", queries: ["example"] })).rejects.toThrow(
    "operation_order",
  );
  await expect(execute(outputDir, { op: "discover", queries: ["other"] })).rejects.toThrow(
    "initial_queries_mismatch",
  );
  await execute(outputDir, { op: "discover" });
  await expect(
    execute(outputDir, { op: "finish", answer: "yes", explanation: "yes", citationIds: ["c99"] }),
  ).rejects.toThrow("citation_not_delivered");
});
test("delegated content investigator uses mock judge, keeps internals off response", async () => {
  const { outputDir, ledgerDir } = await setup("delegated");
  let calls = 0;
  const judge: Judge = async (_, questions) => {
    calls++;
    return Object.fromEntries(
      Object.entries(questions).map(([id, question]) => {
        const choice = id.startsWith("h")
          ? "read"
          : id.startsWith("r") && id !== "reference"
            ? "essential"
            : id === "action"
              ? "complete"
              : id === "answer"
                ? "yes"
                : "none";
        expect(Object.keys(question.criteria)).toContain(choice);
        return [
          id,
          {
            choice,
            probabilities: Object.fromEntries(
              Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    );
  };
  const result: any = await execute(outputDir, { op: "investigate" }, judge);
  expect(calls).toBeGreaterThan(0);
  expect(result.evidence[0].citationId).toBe("c0");
  expect(result.trace).toBeUndefined();
  expect(JSON.parse(readFileSync(join(ledgerDir, "native-ledger.json"), "utf8")).attempts).toEqual(
    [],
  );
  await execute(outputDir, { op: "search", queries: ["true"] });
});
test("config and snapshot tampering fails closed", async () => {
  for (const file of ["config.json", "snapshot.json"]) {
    const { outputDir } = await setup();
    const path = join(outputDir, file),
      data = JSON.parse(readFileSync(path, "utf8"));
    data.extra = "changed";
    writeFileSync(path, JSON.stringify(data));
    await expect(execute(outputDir, { op: "discover" })).rejects.toThrow(
      "immutable_config_or_snapshot_changed",
    );
  }
});
test("ten operations, deadline, exclusive lock and no ledger overwrite", async () => {
  const { outputDir, ledgerDir } = await setup();
  expect(() => initLedger(ledgerDir)).toThrow();
  await execute(outputDir, { op: "discover" });
  for (let i = 1; i < 10; i++) await execute(outputDir, { op: "search", queries: ["example"] });
  await expect(execute(outputDir, { op: "search", queries: ["example"] })).rejects.toThrow(
    "task_closed_or_budget",
  );
  const second = await setup();
  const path = join(second.outputDir, "state.json"),
    state = JSON.parse(readFileSync(path, "utf8"));
  state.startedAt = 0;
  writeFileSync(path, JSON.stringify(state));
  await expect(execute(second.outputDir, { op: "discover" })).rejects.toThrow(
    "task_closed_or_budget",
  );
  mkdirSync(join(second.outputDir, ".lock"));
  await expect(execute(second.outputDir, { op: "discover" })).rejects.toThrow(
    "adapter_locked_no_retry",
  );
});
test("launch queue does not consume operation deadline; first operation clock persists", async () => {
  const { outputDir } = await setup();
  const path = join(outputDir, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.startedAt = Date.now() - 300000;
  writeFileSync(path, JSON.stringify(state));
  await execute(outputDir, { op: "discover" });
  const accepted = JSON.parse(readFileSync(path, "utf8"));
  expect(accepted.startedAt).toBe(state.startedAt);
  expect(accepted.firstOperationAt).toBeGreaterThan(state.startedAt + 240000);
  expect(accepted.ingestionMs).toBe(state.ingestionMs);
  accepted.firstOperationAt = Date.now() - 240001;
  writeFileSync(path, JSON.stringify(accepted));
  await expect(execute(outputDir, { op: "search", queries: ["example"] })).rejects.toThrow(
    "task_closed_or_budget",
  );
});
