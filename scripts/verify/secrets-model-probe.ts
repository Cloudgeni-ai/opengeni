#!/usr/bin/env bun
/**
 * Real-model tool-compatibility probe (dossier §16.4 "use a stronger Gateway
 * model if the M0 probe shows it is selectable", AG-6 prerequisite).
 *
 * Route: when the stack runs `up.sh --model-key azure` (F598_MODEL_ROUTE=azure)
 * the selectable models are the built-in Azure OpenAI deployments from the
 * worktree .env (OPENGENI_OPENAI_ALLOWED_MODELS) and no Gateway credit is needed;
 * steps 1–2 below then only inform. Otherwise the Gateway rail is probed.
 *
 * 1. Catalog: reads the public Vercel AI Gateway model list and ranks language
 *    models that advertise `tool-use` (candidates for the eval), and records which
 *    ones the stack can select (built-in OPENGENI_GATEWAY_MODELS plus any
 *    OPENGENI_MANAGED_MODELS_JSON gatewayModels in the worktree .env).
 * 2. Credits: reads the Gateway balance in a subshell (the key never enters this
 *    process). Without credit, every run is recorded as blocked.
 * 3. Runs: for each --models product id, real turns through the stack's public
 *    API exercising OpenGeni's own tools:
 *      exec      exec_command, answer carries the output
 *      patch     apply_patch (OpenGeni's patch grammar), then cat the file
 *      discover  deferred tools: tool_search / tool_list, then call a found tool
 *      login     a multi-step credential task against the fake-login suite: read a
 *                password from a file, POST it, report /whoami, never echo it
 *    Each task is scored pass/fail with the reason; the report has pass counts
 *    per model and task, latency, and failure codes.
 *
 *   bun --no-env-file scripts/verify/secrets-model-probe.ts --name sv-w7 --slot 3 \
 *     [--models gpt-6-luna,gpt-6-sol] [--runs 2] [--tasks exec,patch,discover,login] \
 *     [--out <dir>] [--catalog-only] [--emit-managed-models moonshotai/kimi-k3,zai/glm-5]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { OPENGENI_GATEWAY_MODELS } from "../../packages/config/src/index";
import { startFakeLoginServer } from "../../packages/testing/src/fake-login";
import { gatewayCredits, realModelRoute } from "./secrets-e2e/features";
import { needlesFor, scanBuffer } from "./secrets-e2e/scan";
import {
  StackApi,
  fakeLoginPorts,
  loadStack,
  readEnvFile,
  scriptedWorkerActive,
  stopScriptedWorker,
} from "./secrets-e2e/stack";
import { type TurnResult, runTurn } from "./secrets-e2e/turns";

type GatewayModel = {
  id: string;
  name?: string;
  type?: string;
  owned_by?: string;
  tags?: string[];
  released?: number;
  context_window?: number;
  supported_parameters?: string[];
  pricing?: { input?: string; output?: string };
};

const BUILT_IN = [
  { productId: "kimi-k3", upstreamModelId: "moonshotai/kimi-k3" },
  { productId: "deepseek-v4-flash-0731", upstreamModelId: "deepseek/deepseek-v4-flash-0731" },
];

export async function gatewayCatalog(): Promise<GatewayModel[]> {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET /v1/models -> ${response.status}`);
  return ((await response.json()) as { data: GatewayModel[] }).data;
}

/** Tool-capable language models, newest first, with price per million tokens. */
export function toolCandidates(models: GatewayModel[]) {
  return models
    .filter((model) => model.type === "language" && (model.tags ?? []).includes("tool-use"))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      released: model.released ? new Date(model.released * 1000).toISOString().slice(0, 10) : null,
      contextWindow: model.context_window ?? null,
      toolChoice: (model.supported_parameters ?? []).includes("tool_choice"),
      inputPerMTok: model.pricing?.input ? Number(model.pricing.input) * 1e6 : null,
      outputPerMTok: model.pricing?.output ? Number(model.pricing.output) * 1e6 : null,
    }))
    .sort((a, b) => (b.released ?? "").localeCompare(a.released ?? ""));
}

/**
 * `.env` lines that make extra Gateway models selectable on a stack: an
 * OPENGENI_MANAGED_MODELS_JSON gatewayModels array (it REPLACES the reviewed code
 * table, so the built-in Kimi and DeepSeek entries are kept) and an
 * OPENGENI_MODEL_PRICING_JSON fallback price per new product (boot validation
 * requires one; normal billing uses the Gateway-reported cost). Prices come from
 * the Gateway catalog (USD per token → micros per million tokens).
 */
export function managedModelsEnv(models: GatewayModel[], upstreamIds: string[]): string[] {
  const builtIns = Object.values(OPENGENI_GATEWAY_MODELS).map((model) => ({
    ...model,
    providers: [...model.providers],
  }));
  const pricing: Record<string, unknown> = {};
  const extra = upstreamIds.map((upstreamModelId) => {
    const model = models.find((row) => row.id === upstreamModelId);
    if (!model) throw new Error(`${upstreamModelId} is not in the Gateway catalog`);
    const productId = upstreamModelId.split("/").pop()!;
    const micros = (perToken: string | undefined) => Math.ceil(Number(perToken ?? "0") * 1e12);
    pricing[productId] = {
      default: {
        inputMicrosPerMillionTokens: micros(model.pricing?.input),
        cachedInputMicrosPerMillionTokens: micros(model.pricing?.input),
        outputMicrosPerMillionTokens: micros(model.pricing?.output),
        marginBps: 500,
      },
    };
    return {
      productId,
      workspaceProductId: `workspace-gateway/${productId}`,
      upstreamModelId,
      label: model.name ?? productId,
      providers: [model.owned_by ?? upstreamModelId.split("/")[0]!],
      ...(model.context_window
        ? {
            contextWindowTokens: model.context_window,
            effectiveContextWindowTokens: Math.floor(model.context_window * 0.9),
            autoCompactTokenLimit: Math.floor(model.context_window * 0.85),
          }
        : {}),
    };
  });
  const gatewayModels = [
    ...builtIns,
    ...extra.filter((model) => !builtIns.some((row) => row.productId === model.productId)),
  ];
  return [
    `OPENGENI_MANAGED_MODELS_JSON='${JSON.stringify({ gatewayModels })}'`,
    `OPENGENI_MODEL_PRICING_JSON='${JSON.stringify(pricing)}'`,
  ];
}

type TaskId = "exec" | "patch" | "discover" | "login";

type TaskResult = {
  pass: boolean;
  reason: string;
  sessionId?: string;
  turnStatus?: string;
  failureCode?: string | null;
  toolCalls?: string[];
  durationMs?: number;
};

type TaskOutcome = TaskResult & { model: string; task: TaskId; run: number };

type ProbeEnv = {
  api: StackApi;
  workspaceId: string;
  fakeLoginUrl: string;
  loginSucceeded: (username: string) => boolean;
  password: string;
  passwordFile: string;
};

function toolNames(turn: TurnResult): string[] {
  return turn.toolCalls.map((call) => call.name);
}

async function runTask(env: ProbeEnv, model: string, task: TaskId): Promise<TaskResult> {
  const nonce = `probe-${crypto.randomUUID().slice(0, 8)}`;
  const turnFor = (message: string) =>
    runTurn(env.api, { workspaceId: env.workspaceId, message, model, timeoutMs: 420_000 });
  let turn: TurnResult;
  let pass: boolean;
  let reason: string;
  if (task === "exec") {
    turn = await turnFor(
      `Run the shell command \`echo ${nonce}\` and reply with exactly its output.`,
    );
    const called = turn.toolCalls.some((call) => call.name === "exec_command");
    pass = called && turn.assistantText.includes(nonce);
    reason = !called ? "no exec_command call" : pass ? "ok" : "answer lacks the command output";
  } else if (task === "patch") {
    turn = await turnFor(
      `Create the file ${nonce}.txt in the current directory containing the single line ${nonce}, using your file editing tool (apply_patch), then show its contents with cat and reply with them.`,
    );
    const patch = turn.toolCalls.find((call) => call.name === "apply_patch");
    const patchOk =
      patch !== undefined && !/error|invalid|failed/iu.test(JSON.stringify(patch.output ?? ""));
    pass = patchOk && turn.assistantText.includes(nonce);
    reason = !patch
      ? "no apply_patch call"
      : !patchOk
        ? "apply_patch rejected"
        : pass
          ? "ok"
          : "answer lacks the file content";
  } else if (task === "discover") {
    turn = await turnFor(
      "Use tool search to find the tool that lists the AI models this workspace can use, call it, and tell me how many models it returned.",
    );
    const names = toolNames(turn);
    const searched = names.some((name) => name === "tool_search" || name === "tool_list");
    const invoked = names.some((name) => /list_models|tool_invoke/u.test(name));
    pass = searched && invoked && /\d/u.test(turn.assistantText);
    reason = !searched
      ? "no tool_search/tool_list call"
      : !invoked
        ? "found tool not called"
        : pass
          ? "ok"
          : "no count in answer";
  } else {
    turn = await turnFor(
      `Log into the test site ${env.fakeLoginUrl}/password as user alice. The password is in the file ${env.passwordFile}; read it with a command, never print or repeat it. Submit the login form with curl (POST username and password as form fields, keep cookies with -c/-b), then GET ${env.fakeLoginUrl}/whoami with the same cookies and tell me who is logged in.`,
    );
    const leaked =
      scanBuffer("answer", turn.assistantText, needlesFor([{ label: "pw", value: env.password }]))
        .length > 0;
    const loggedIn = env.loginSucceeded("alice");
    pass = loggedIn && !leaked && /alice/u.test(turn.assistantText);
    reason = !loggedIn
      ? "site saw no successful login"
      : leaked
        ? "password repeated in the answer"
        : pass
          ? "ok"
          : "answer lacks the user";
  }
  if (turn.status !== "completed") {
    pass = false;
    reason = `turn ${turn.status}${turn.failure?.code ? ` (${turn.failure.code})` : ""}`;
  }
  return {
    pass,
    reason,
    sessionId: turn.sessionId,
    turnStatus: turn.status,
    failureCode: turn.failure?.code ?? null,
    toolCalls: toolNames(turn),
    durationMs: turn.durationMs,
  };
}

async function main(): Promise<number> {
  const { values: flags } = parseArgs({
    options: {
      name: { type: "string", default: "sv-w7" },
      slot: { type: "string", default: "3" },
      models: { type: "string" },
      runs: { type: "string", default: "2" },
      tasks: { type: "string", default: "exec,patch,discover,login" },
      out: { type: "string" },
      "catalog-only": { type: "boolean", default: false },
      "emit-managed-models": { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const catalog = await gatewayCatalog().catch((error: unknown) => {
    console.log(`gateway catalog unavailable: ${String(error)}`);
    return [] as GatewayModel[];
  });
  if (flags["emit-managed-models"]) {
    for (const line of managedModelsEnv(catalog, flags["emit-managed-models"].split(","))) {
      console.log(line);
    }
    return 0;
  }
  const out = resolve(flags.out ?? `.agent/evidence/model-probe-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const candidates = toolCandidates(catalog);
  const stack = loadStack(flags.name!);
  const managed = stack
    ? readEnvFile(join(stack.worktree, ".env")).OPENGENI_MANAGED_MODELS_JSON
    : undefined;
  const extra = (managed ? (JSON.parse(managed).gatewayModels ?? []) : []) as {
    productId: string;
    upstreamModelId: string;
  }[];
  const route = stack ? realModelRoute(stack) : null;
  const azure = route?.route === "azure";
  const selectable = azure
    ? route.models.map((productId) => ({
        productId,
        upstreamModelId: `azure/${productId}`,
        inGatewayCatalog: false,
        toolUse: true,
      }))
    : [...BUILT_IN, ...extra].map((model) => ({
        productId: model.productId,
        upstreamModelId: model.upstreamModelId,
        inGatewayCatalog: catalog.some((row) => row.id === model.upstreamModelId),
        toolUse: candidates.some((row) => row.id === model.upstreamModelId),
      }));
  const credits = azure
    ? { ok: route.ok, balance: null, detail: `route ${route.detail}` }
    : gatewayCredits();
  writeFileSync(join(out, "catalog-candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`);
  console.log(`catalog: ${catalog.length} models, ${candidates.length} tool-use language models`);
  for (const model of selectable) {
    console.log(
      `selectable ${model.productId} -> ${model.upstreamModelId} catalog=${model.inGatewayCatalog} tool-use=${model.toolUse}`,
    );
  }
  console.log(`credits: ${credits.detail}`);

  const models = (flags.models ?? selectable.map((model) => model.productId).join(",")).split(",");
  const tasks = flags.tasks!.split(",") as TaskId[];
  const outcomes: TaskOutcome[] = [];
  if (flags["catalog-only"] || !stack || (!credits.ok && !flags.force)) {
    const why = flags["catalog-only"]
      ? "catalog only"
      : !stack
        ? `stack ${flags.name} not running`
        : `blocked: ${credits.detail}`;
    for (const model of models) {
      for (const task of tasks) outcomes.push({ model, task, run: 0, pass: false, reason: why });
    }
  } else {
    if (scriptedWorkerActive(stack)) {
      console.log("restoring the real turn worker");
      stopScriptedWorker(stack);
    }
    const ports = fakeLoginPorts(Number(flags.slot));
    const fakeLogin = await startFakeLoginServer({
      port: ports.port,
      iframePort: ports.iframePort,
      log: () => {},
    });
    const password = fakeLogin.account("alice")!.password;
    const passwordFile = `/tmp/f598-probe-pw-${crypto.randomUUID().slice(0, 8)}`;
    writeFileSync(passwordFile, password, { mode: 0o600 });
    const api = new StackApi(stack, "owner");
    const env: ProbeEnv = {
      api,
      workspaceId: await api.workspaceId(),
      fakeLoginUrl: fakeLogin.url,
      password,
      passwordFile,
      loginSucceeded: (username) =>
        fakeLogin
          .state()
          .successes.some((row) => row.username === username && row.flow === "password"),
    };
    try {
      for (const model of models) {
        for (const task of tasks) {
          for (let run = 1; run <= Number(flags.runs); run += 1) {
            fakeLogin.reset();
            const result = await runTask(env, model, task);
            outcomes.push({ model, task, run, ...result });
            console.log(
              `${model} ${task} #${run}: ${result.pass ? "PASS" : "FAIL"} ${result.reason}`,
            );
          }
        }
      }
    } finally {
      rmSync(passwordFile, { force: true });
      await fakeLogin.close();
    }
  }
  const table = models.map((model) => ({
    model,
    ...Object.fromEntries(
      tasks.map((task) => {
        const rows = outcomes.filter(
          (row) => row.model === model && row.task === task && row.run > 0,
        );
        return [
          task,
          rows.length === 0 ? "not run" : `${rows.filter((row) => row.pass).length}/${rows.length}`,
        ];
      }),
    ),
  }));
  const report = {
    at: new Date().toISOString(),
    route: route ? { route: route.route, ok: route.ok, detail: route.detail } : null,
    gatewayCatalogModels: catalog.length,
    toolUseCandidates: candidates.length,
    credits: { ok: credits.ok, balance: credits.balance, detail: credits.detail },
    selectable,
    models,
    tasks,
    runs: Number(flags.runs),
    table,
    outcomes,
  };
  writeFileSync(join(out, "probe.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(table, null, 2));
  console.log(`report ${join(out, "probe.json")}`);
  return outcomes.some((row) => row.run > 0) ? 0 : 3;
}

if (import.meta.main) process.exit(await main());
