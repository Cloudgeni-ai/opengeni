import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmdirSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { hash, loadSnapshot, type Snapshot, type Judge, type Request } from "./core";
import { SourceTools, type Citation } from "./trajectory";
import { CitationRegistry } from "./citation-registry";
import { searchContent, searchTerms } from "./content-search";
import { investigateContent } from "./content-investigation";
import { safeGatewayError } from "./gateway-diagnostics";
import {
  evaluateDirect,
  assertNativeCredential,
  TYPESAFE_INPUT_RATE,
  TYPESAFE_MODEL,
} from "./typesafe-direct";

export const REVISION = "b0a5a54f5ce6e1ab44d90eb5e2cd1193e14f45ae";
export function nativeReservation(payload: unknown) {
  const bytes = Buffer.byteLength(
    JSON.stringify({ model: TYPESAFE_MODEL, ...(payload as object) }),
  );
  if (bytes > 64000) throw new Error("native_payload_byte_budget");
  return Math.max(64000, bytes + 8192) * TYPESAFE_INPUT_RATE;
}
export type Config = {
  root: string;
  revision: string;
  subdir: string;
  question: string;
  context: string;
  mode: "evidence" | "answer_if_supported";
  initialQueries: string[];
  arm: "ordinary" | "delegated";
  outputDir: string;
  ledgerDir: string;
  taskId: string;
  deadlineMs: number;
  nativeAuthorized: boolean;
};
type State = {
  configHash: string;
  snapshotHash: string;
  startedAt: number;
  firstOperationAt?: number;
  operations: number;
  delivered: Citation[];
  receipts: unknown[];
  finished: boolean;
  ingestionMs: number;
  initialCompleted?: boolean;
};
type Ledger = {
  version: "codex-native-v1";
  tasks: Record<string, string>;
  attempts: {
    taskId: string;
    reservedUsd: number;
    estimatedUsd?: number;
    status: string;
    elapsedMs?: number;
  }[];
};
export function assertNativeBudget(attempts: Ledger["attempts"], reserve: number) {
  if (
    !Number.isFinite(reserve) ||
    reserve <= 0 ||
    attempts.length >= 32 ||
    attempts.some(
      (a) =>
        !Number.isFinite(a.reservedUsd) ||
        a.reservedUsd <= 0 ||
        (a.estimatedUsd !== undefined && (!Number.isFinite(a.estimatedUsd) || a.estimatedUsd < 0)),
    ) ||
    attempts.reduce((n, a) => n + Math.max(a.reservedUsd, a.estimatedUsd ?? 0), 0) + reserve > 0.25
  )
    throw new Error("native_shared_budget");
}
export type Operation =
  | { op: "discover" | "investigate"; queries?: string[] }
  | { op: "search"; queries: string[]; offset?: number }
  | { op: "read"; path: string; startLine: number; endLine: number }
  | {
      op: "finish";
      answer: "yes" | "no" | "indecisive";
      explanation: string;
      citationIds: string[];
    };
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
function save(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
async function locked<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const lock = join(directory, ".lock");
  try {
    mkdirSync(lock);
  } catch {
    throw new Error("adapter_locked_no_retry");
  }
  try {
    return await work();
  } finally {
    rmdirSync(lock);
  }
}
function validate(c: Config) {
  if (
    c.revision !== REVISION ||
    c.subdir !== "apps/web/src/lib" ||
    !["ordinary", "delegated"].includes(c.arm) ||
    !["evidence", "answer_if_supported"].includes(c.mode) ||
    !c.question?.trim() ||
    c.question.length > 4000 ||
    typeof c.context !== "string" ||
    c.context.length > 8000 ||
    !Array.isArray(c.initialQueries) ||
    !c.initialQueries.length ||
    JSON.stringify(searchTerms({ question: c.question, searchHints: c.initialQueries })) !==
      JSON.stringify(c.initialQueries) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(c.taskId) ||
    !Number.isInteger(c.deadlineMs) ||
    c.deadlineMs < 1 ||
    c.deadlineMs > 240000 ||
    typeof c.nativeAuthorized !== "boolean" ||
    [c.root, c.outputDir, c.ledgerDir].some((p) => typeof p !== "string" || resolve(p) !== p) ||
    c.outputDir === c.ledgerDir
  )
    throw new Error("invalid_immutable_config");
}
/** Call once for the entire eight-task pass. Existing ledgers are never reused/overwritten. */
export function initLedger(directory: string) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "native-ledger.json"),
    JSON.stringify({ version: "codex-native-v1", tasks: {}, attempts: [] }),
    { flag: "wx", mode: 0o600 },
  );
}
export async function initialize(config: Config, loader = loadSnapshot) {
  const startedAt = Date.now();
  validate(config);
  if (
    realpathSync(config.root) !== config.root ||
    realpathSync(config.ledgerDir) !== config.ledgerDir
  )
    throw new Error("noncanonical_config_path");
  const configHash = hash(JSON.stringify(config));
  mkdirSync(config.outputDir); // must be a new task directory
  return locked(config.outputDir, async () => {
    await locked(config.ledgerDir, async () => {
      const path = join(config.ledgerDir, "native-ledger.json"),
        ledger = read<Ledger>(path);
      if (
        ledger.version !== "codex-native-v1" ||
        ledger.tasks[config.taskId] ||
        Object.keys(ledger.tasks).length >= 8
      )
        throw new Error("native_task_registration_rejected");
      ledger.tasks[config.taskId] = configHash;
      save(path, ledger);
    });
    const snapshot = loader(config.root, config.revision, config.subdir);
    if (snapshot.revision !== REVISION || Date.now() - startedAt >= 600000)
      throw new Error("snapshot_revision_or_deadline");
    save(join(config.outputDir, "config.json"), config);
    save(join(config.outputDir, "snapshot.json"), snapshot);
    save(join(config.outputDir, "state.json"), {
      configHash,
      snapshotHash: hash(JSON.stringify(snapshot)),
      startedAt,
      operations: 0,
      delivered: [],
      receipts: [],
      finished: false,
      ingestionMs: Date.now() - startedAt,
    } satisfies State);
    return { initialized: true, configHash, snapshotHash: hash(JSON.stringify(snapshot)) };
  });
}
export async function execute(directory: string, operation: Operation, mockJudge?: Judge) {
  const start = Date.now();
  return locked(directory, async () => {
    const config = read<Config>(join(directory, "config.json")),
      state = read<State>(join(directory, "state.json"));
    validate(config);
    const snapshot = read<Snapshot>(join(directory, "snapshot.json"));
    if (
      resolve(directory) !== config.outputDir ||
      state.configHash !== hash(JSON.stringify(config)) ||
      state.snapshotHash !== hash(JSON.stringify(snapshot))
    )
      throw new Error("immutable_config_or_snapshot_changed");
    const remaining = () => config.deadlineMs - (Date.now() - (state.firstOperationAt ?? start));
    if (
      state.finished ||
      state.operations >= 10 ||
      remaining() <= 0 ||
      (state.firstOperationAt === undefined && Date.now() - state.startedAt >= 600000)
    )
      throw new Error("task_closed_or_budget");
    if (state.operations > 0 && !state.initialCompleted)
      throw new Error("initial_operation_failed_no_continuation");
    const first = config.arm === "ordinary" ? "discover" : "investigate";
    if (
      state.operations === 0
        ? operation.op !== first
        : !["search", "read", "finish"].includes(operation.op)
    )
      throw new Error("operation_order");
    if (
      (operation.op === "discover" || operation.op === "investigate") &&
      operation.queries &&
      JSON.stringify(operation.queries) !== JSON.stringify(config.initialQueries)
    )
      throw new Error("initial_queries_mismatch");
    state.firstOperationAt ??= start;
    state.operations++;
    save(join(directory, "state.json"), state); // failures and process death consume the operation
    const deliveredBefore = [...state.delivered];
    const registry = new CitationRegistry();
    state.delivered.forEach((s) => registry.register(s));
    const deliver = <T extends Citation>(span: T) => {
      const citationId = registry.register(span);
      if (
        !state.delivered.some(
          (s) =>
            JSON.stringify(s) ===
            JSON.stringify({ path: span.path, startLine: span.startLine, endLine: span.endLine }),
        )
      )
        state.delivered.push({ path: span.path, startLine: span.startLine, endLine: span.endLine });
      return { ...span, citationId };
    };
    const source = new SourceTools(snapshot);
    try {
      let result: unknown;
      if (operation.op === "discover" || operation.op === "search") {
        const found = searchContent(
          source,
          operation.op === "search" ? operation.queries : config.initialQueries,
          operation.op === "search" ? (operation.offset ?? 0) : 0,
          performance.now() + Math.min(2000, remaining()),
        );
        result = { ...found, hits: found.hits.map(deliver) };
      } else if (operation.op === "read") {
        if (
          typeof operation.path !== "string" ||
          !Number.isInteger(operation.startLine) ||
          !Number.isInteger(operation.endLine) ||
          operation.startLine < 1 ||
          operation.endLine < operation.startLine
        )
          throw new Error("invalid_read");
        const found = source.read(operation.path, operation.startLine, operation.endLine);
        result = "text" in found ? deliver(found) : found;
      } else if (operation.op === "investigate") {
        let call = 0;
        const judge: Judge = async (input, questions, signal) => {
          const payload = { state: input, questions },
            callId = `${state.operations}-${++call}`;
          const reservedUsd = nativeReservation(payload);
          save(join(directory, `jev-${callId}-request.json`), payload);
          if (mockJudge) return mockJudge(input, questions, signal);
          if (!config.nativeAuthorized) throw new Error("native_not_authorized");
          assertNativeCredential(process.env.JEV_API_KEY);
          const key = process.env.JEV_API_KEY;
          return locked(config.ledgerDir, async () => {
            const path = join(config.ledgerDir, "native-ledger.json"),
              ledger = read<Ledger>(path);
            if (
              ledger.version !== "codex-native-v1" ||
              ledger.tasks[config.taskId] !== state.configHash
            )
              throw new Error("native_shared_budget");
            assertNativeBudget(ledger.attempts, reservedUsd);
            const attempt: Ledger["attempts"][number] = {
              taskId: config.taskId,
              reservedUsd,
              status: "billing_unknown_reserved",
            };
            ledger.attempts.push(attempt);
            save(path, ledger);
            const calledAt = Date.now();
            const journal = (event: string, details: object = {}) =>
              appendFileSync(
                join(config.ledgerDir, "native-attempts.jsonl"),
                JSON.stringify({
                  id: `${config.taskId}-${callId}`,
                  taskId: config.taskId,
                  model: TYPESAFE_MODEL,
                  payloadHash: hash(JSON.stringify({ model: TYPESAFE_MODEL, ...payload })),
                  event,
                  at: Date.now(),
                  startedAt: calledAt,
                  elapsedMs: Date.now() - calledAt,
                  reservedUsd,
                  ...details,
                }) + "\n",
                { mode: 0o600 },
              );
            journal("start", { status: "billing_unknown_reserved" });
            try {
              const evaluated = await evaluateDirect(payload, {
                apiKey: key,
                signal: AbortSignal.any([
                  signal ?? AbortSignal.timeout(90000),
                  AbortSignal.timeout(Math.max(1, remaining())),
                ]),
              });
              attempt.estimatedUsd = evaluated.usage.inputTokens * TYPESAFE_INPUT_RATE;
              attempt.status = "usage_reported_estimate";
              save(join(directory, `jev-${callId}-response.json`), {
                ...evaluated,
                elapsedMs: Date.now() - calledAt,
              });
              journal("completion", {
                status: attempt.status,
                usage: evaluated.usage,
                estimatedUsd: attempt.estimatedUsd,
              });
              return evaluated.answers;
            } catch (error) {
              journal("failure", {
                status: attempt.status,
                estimatedUsd: attempt.estimatedUsd,
                error: safeGatewayError(error, key),
              });
              throw error;
            } finally {
              attempt.elapsedMs = Date.now() - calledAt;
              save(path, ledger);
            }
          });
        };
        const request: Request = {
          question: config.question,
          context: config.context,
          searchHints: config.initialQueries,
          requestedOutput: config.mode,
        };
        const investigated = await investigateContent(
          snapshot,
          request,
          judge,
          Math.min(90000, remaining()),
        );
        save(join(directory, `investigation-${state.operations}.json`), investigated);
        result = {
          status: investigated.status,
          reasonCode: investigated.reasonCode,
          answer: investigated.answer,
          coverage: { initialSearchDigest: investigated.coverage.initialSearchDigest },
          evidence: investigated.evidence.map(deliver),
        };
      } else if (operation.op === "finish") {
        if (
          !["yes", "no", "indecisive"].includes(operation.answer) ||
          typeof operation.explanation !== "string" ||
          !operation.explanation.trim() ||
          operation.explanation.length > 12000
        )
          throw new Error("invalid_final_answer");
        const citations = registry.resolve(operation.citationIds, state.delivered);
        if (config.mode === "evidence" && operation.answer !== "indecisive")
          throw new Error("evidence_mode_requires_indecisive");
        if (operation.answer !== "indecisive" && !citations.length)
          throw new Error("supported_answer_requires_citation");
        if (remaining() <= 0) throw new Error("task_deadline");
        save(join(directory, "source-citations.json"), {
          revision: config.revision,
          subdir: config.subdir,
          citations,
        });
        save(join(directory, "final.json"), {
          answer: operation.answer,
          explanation: operation.explanation,
          citationIds: operation.citationIds,
          citations,
        });
        state.finished = true;
        result = { finished: true, answer: operation.answer, citationCount: citations.length };
      } else throw new Error("unknown_operation");
      if (!state.finished && remaining() <= 0) throw new Error("task_deadline");
      if (Buffer.byteLength(JSON.stringify(result)) > 50000) throw new Error("tool_output_budget");
      state.receipts.push({
        op: operation.op,
        elapsedMs: Date.now() - start,
        status: "ok",
        resultHash: hash(JSON.stringify(result)),
      });
      save(join(directory, `tool-${state.operations}.json`), result);
      state.initialCompleted = true;
      save(join(directory, "state.json"), state);
      return result;
    } catch (error) {
      state.delivered = deliveredBefore;
      state.receipts.push({ op: operation.op, elapsedMs: Date.now() - start, status: "failed" });
      save(join(directory, "state.json"), state);
      throw error;
    }
  });
}
async function requestFromStdin(): Promise<Operation> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of Bun.stdin.stream()) {
    bytes += chunk.byteLength;
    if (bytes > 64000) throw new Error("request_byte_budget");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
if (import.meta.main) {
  try {
    const [command, path] = process.argv.slice(2);
    if (!path)
      throw new Error("usage: ledger-init DIR | init CONFIG.json | request TASK_DIR (JSON stdin)");
    const result =
      command === "ledger-init"
        ? (initLedger(path), { initialized: true })
        : command === "init"
          ? await initialize(read<Config>(path))
          : command === "request"
            ? await execute(path, await requestFromStdin())
            : (() => {
                throw new Error("unknown_command");
              })();
    console.log(JSON.stringify(result));
  } catch {
    console.log(
      JSON.stringify({
        error: "adapter_request_failed",
        details: "Check task state/receipts; no automatic retry.",
      }),
    );
    process.exitCode = 1;
  }
}
