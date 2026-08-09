import { mkdtemp, rm } from "node:fs/promises";
import { homedir, platform, release, totalmem } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

import { loadBudgets, type PerfBudgets } from "./support";

type JsonRecord = Record<string, unknown>;

if (process.env.OPENGENI_ARTIFACT_BENCH_PINNED !== "1") {
  throw new Error(
    "Release benchmarks require OPENGENI_ARTIFACT_BENCH_PINNED=1 on the pinned runner",
  );
}

const packageDirectory = resolve(import.meta.dir, "..");
const kernelDirectory = resolve(packageDirectory, "kernel");
const budgets = await loadBudgets();
const platformEvidence = await Bun.file(
  new URL("./platform-evidence.json", import.meta.url),
).json();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "opengeni-artifact-wasm-"));
const measurements: JsonRecord[] = [];

try {
  measurements.push(
    ...(await runJsonLines(["cargo", "bench", "--bench", "kernel"], kernelDirectory, {
      OPENGENI_ARTIFACT_BENCH_DEEP: "1",
      OPENGENI_ARTIFACT_BENCH_FILTER: "core",
    })),
  );
  for (const filter of ["sparse", "dense", "collaboration"]) {
    measurements.push(
      ...(await runJsonLines(["cargo", "bench", "--bench", "kernel"], kernelDirectory, {
        OPENGENI_ARTIFACT_BENCH_DEEP: "1",
        OPENGENI_ARTIFACT_BENCH_FILTER: filter,
      })),
    );
  }
  measurements.push(
    ...(await runJsonLines(
      ["cargo", "bench", "--manifest-path", "bindings/protocol/Cargo.toml", "--bench", "session"],
      kernelDirectory,
    )),
  );
  measurements.push(
    ...(await runJsonLines(["cargo", "bench", "--bench", "formula"], kernelDirectory)),
  );

  const wasmDirectory = resolve(kernelDirectory, "bindings/wasm");
  await run(
    ["bash", "scripts/build.sh", "web", temporaryDirectory],
    wasmDirectory,
    cargoPathEnvironment(),
  );
  for (const modality of ["spreadsheet", "document", "presentation"] as const) {
    await run(
      ["bash", "scripts/build.sh", "web", temporaryDirectory, modality],
      wasmDirectory,
      cargoPathEnvironment(),
    );
  }
  measurements.push(
    ...(await runJsonLines(
      ["bun", "run", "scripts/benchmark.ts", temporaryDirectory],
      wasmDirectory,
    )),
  );

  await assertReleaseBudgets(measurements, budgets, temporaryDirectory);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      machine: {
        id: process.env.OPENGENI_ARTIFACT_BENCH_MACHINE_ID ?? "unlabeled-pinned-runner",
        platform: `${process.platform}-${process.arch}`,
        os: `${platform()} ${release()}`,
        logicalCpus: navigator.hardwareConcurrency,
        totalMemoryBytes: totalmem(),
        bun: Bun.version,
      },
      budgetsSource: budgets.source,
      platformEvidence,
      measurements,
    }),
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function assertReleaseBudgets(
  results: readonly JsonRecord[],
  source: PerfBudgets,
  wasmDirectory: string,
): Promise<void> {
  const dense = named(results, "dense_tile_random_edit");
  assertLess(
    number(dense, "p95Ms"),
    operationBudget(source, "dense_tile_random_edit"),
    "native dense random-edit p95",
  );
  const denseFacts = record(dense, "facts");
  assertLess(
    number(denseFacts, "modelAllocatedBytes"),
    structural(source, "rustDenseMillionModelAllocatedMaxBytes"),
    "native dense million-cell allocated bytes",
  );
  assertLess(
    number(denseFacts, "modelPeakLiveDeltaBytes"),
    structural(source, "rustDenseMillionModelPeakLiveDeltaMaxBytes"),
    "native dense million-cell peak live bytes",
  );

  const collaboration = named(results, "collaboration_random_edit_on_million_cells");
  assertLess(
    number(collaboration, "p95Ms"),
    operationBudget(source, "collaboration_random_edit_on_million_cells"),
    "native collaboration edit p95",
  );
  assertLess(
    number(collaboration, "allocatedBytesPerUnit"),
    structural(source, "rustCollaborationMillionEditAllocatedPerUnitMaxBytes"),
    "native collaboration allocation per edit",
  );
  assertLess(
    number(collaboration, "peakLiveDeltaBytes"),
    structural(source, "rustCollaborationMillionEditPeakLiveDeltaMaxBytes"),
    "native collaboration edit peak live bytes",
  );
  const collaborationFacts = record(collaboration, "facts");
  assertLess(
    number(collaborationFacts, "modelAllocatedBytes"),
    structural(source, "rustCollaborationMillionModelAllocatedMaxBytes"),
    "native collaboration million-cell allocated bytes",
  );
  assertLess(
    number(collaborationFacts, "modelPeakLiveDeltaBytes"),
    structural(source, "rustCollaborationMillionModelPeakLiveDeltaMaxBytes"),
    "native collaboration million-cell peak live bytes",
  );
  assertLess(
    number(collaborationFacts, "modelRssDeltaBytes"),
    structural(source, "rustCollaborationMillionModelRssDeltaMaxBytes"),
    "native collaboration million-cell RSS delta",
  );

  const sparse = named(results, "sparse_million_row_sheet");
  assertLess(
    number(sparse, "allocatedBytes"),
    structural(source, "rustSparseAllocatedMaxBytes"),
    "native sparse allocated bytes",
  );
  assertLess(
    number(sparse, "peakLiveDeltaBytes"),
    structural(source, "rustSparsePeakLiveDeltaMaxBytes"),
    "native sparse peak live bytes",
  );

  const formula = results.find((result) => result.benchmark === "recalculate_simple_dependents");
  if (!formula) throw new Error("Missing native formula benchmark result");
  assertLess(
    number(formula, "p95_ms"),
    operationBudget(source, "recalculate_simple_dependents"),
    "native formula recalculation p95",
  );

  const bindingEdit = named(results, "binding_stateful_edit");
  assertLess(
    number(bindingEdit, "p95Ms"),
    operationBudget(source, "binding_stateful_edit"),
    "native binding stateful edit p95",
  );
  if (
    number(bindingEdit, "statefulSpeedup") <=
    structural(source, "bindingStatefulMinimumSpeedupRatio")
  ) {
    throw new Error("Native stateful binding no longer proves snapshot-roundtrip elimination");
  }
  const bindingScales = results.filter((result) => result.name === "binding_session_scale");
  const bindingMillion = bindingScales.find((result) => result.cells === 1_000_000);
  if (!bindingMillion) throw new Error("Missing million-cell native binding benchmark result");
  assertLess(
    number(bindingMillion, "forkP95Ms"),
    operationBudget(source, "binding_session_fork_million_cells"),
    "native binding million-cell fork p95",
  );
  assertLess(
    number(bindingMillion, "stateHashP95Ms"),
    operationBudget(source, "binding_state_hash_million_cells"),
    "native binding million-cell state-hash p95",
  );

  const wasmScale = results.filter((result) => result.name === "wasm_session_scale");
  const million = wasmScale.find((result) => result.cells === 1_000_000);
  if (!million) throw new Error("Missing million-cell WASM benchmark result");
  assertLess(
    number(million, "forkP95Ms"),
    operationBudget(source, "wasm_session_fork_million_cells"),
    "WASM million-cell fork p95",
  );
  assertLess(
    number(million, "hashP95Ms"),
    operationBudget(source, "wasm_state_hash_million_cells"),
    "WASM million-cell state-hash p95",
  );
  assertLess(
    number(million, "wasmHeapBytes"),
    structural(source, "wasmMillionCellHeapMaxBytes"),
    "WASM million-cell heap",
  );
  assertLess(
    number(million, "liveForkWasmHeapBytes"),
    structural(source, "wasmMillionCellHeapMaxBytes"),
    "WASM million-cell heap with a live fork",
  );
  const wasmEdit = named(results, "wasm_dense_random_edit_on_million_cells");
  assertLess(
    number(wasmEdit, "p95Ms"),
    operationBudget(source, "wasm_dense_random_edit_on_million_cells"),
    "WASM million-cell edit p95",
  );
  assertLess(
    number(wasmEdit, "wasmHeapBytes"),
    structural(source, "wasmMillionCellHeapMaxBytes"),
    "WASM heap after repeated edits",
  );

  await assertWasmBundle(
    "full WASM tool kernel",
    resolve(wasmDirectory, "artifact_kernel_bg.wasm"),
    structural(source, "wasmFullKernelBinaryMaxBytes"),
    structural(source, "wasmFullKernelGzipMaxBytes"),
  );
  await assertWasmBundle(
    "spreadsheet editor WASM kernel",
    resolve(wasmDirectory, "artifact_kernel_spreadsheet_bg.wasm"),
    structural(source, "wasmSpreadsheetKernelBinaryMaxBytes"),
    structural(source, "wasmSpreadsheetKernelGzipMaxBytes"),
  );
  for (const modality of ["document", "presentation"] as const) {
    await assertWasmBundle(
      `${modality} editor WASM kernel`,
      resolve(wasmDirectory, `artifact_kernel_${modality}_bg.wasm`),
      structural(source, "wasmDocumentPresentationKernelBinaryMaxBytes"),
      structural(source, "wasmDocumentPresentationKernelGzipMaxBytes"),
    );
  }
}

async function assertWasmBundle(
  label: string,
  path: string,
  maximumBytes: number,
  maximumGzipBytes: number,
): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  assertLess(bytes.byteLength, maximumBytes, `${label} raw bytes`);
  assertLess(gzipSync(bytes, { level: 9 }).byteLength, maximumGzipBytes, `${label} gzip bytes`);
}

async function runJsonLines(
  command: readonly string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<JsonRecord[]> {
  const output = await run(command, cwd, environment);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function run(
  command: readonly string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<string> {
  const process = Bun.spawn([...command], {
    cwd,
    env: { ...Bun.env, ...environment },
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited ${exitCode}`);
  return output;
}

function cargoPathEnvironment(): Record<string, string> {
  const cargoBin = join(homedir(), ".cargo", "bin");
  return { PATH: [cargoBin, Bun.env.PATH ?? ""].filter(Boolean).join(delimiter) };
}

function named(results: readonly JsonRecord[], name: string): JsonRecord {
  const result = results.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing benchmark result: ${name}`);
  return result;
}

function record(source: JsonRecord, key: string): JsonRecord {
  const value = source[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Benchmark field ${key} is not an object`);
  }
  return value as JsonRecord;
}

function number(source: JsonRecord, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Benchmark field ${key} is not a finite number`);
  }
  return value;
}

function operationBudget(source: PerfBudgets, name: string): number {
  const budget = source.release.operations[name];
  if (!budget) throw new Error(`Missing release operation budget: ${name}`);
  return budget.p95Ms;
}

function structural(source: PerfBudgets, name: string): number {
  const budget = source.ci.structural[name];
  if (budget === undefined) throw new Error(`Missing structural budget: ${name}`);
  return budget;
}

function assertLess(actual: number, maximum: number, label: string): void {
  if (actual >= maximum) throw new Error(`${label}: ${actual} exceeded ${maximum}`);
}
