/**
 * Feature probes. Every gate scenario declares the product features it needs;
 * a missing feature makes that scenario fail with an explicit `missing_feature`
 * reason instead of an opaque assertion, so the harness is runnable (and red)
 * long before W1–W6 land, and turns green scenario by scenario as they merge.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type StackApi, type StackState, listMachines, readEnvFile } from "./stack";
import { directiveMessage, parseDirectiveReport, runTurn } from "./turns";

export const KEYS_DIR = process.env.F598_KEYS_DIR ?? "/workspace/sessions/f5980f29/keys";

export type FeatureId =
  | "vaults_api"
  | "legacy_routes_removed"
  | "secret_tools"
  | "secrets_capability_toggle"
  | "ask_card_secret_field"
  | "real_model"
  | "onepassword_token"
  | "connected_machine"
  | "directive_worker"
  | "pre_vaults_fixture";

export type FeatureProbe = { id: FeatureId; present: boolean; detail: string };

export type FeatureReport = Record<FeatureId, FeatureProbe>;

export type ProbeContext = {
  stack: StackState;
  owner: StackApi;
  workspaceId: string;
  /** Run tool-surface probes through the scripted worker (it must be active). */
  scriptedWorkerActive: boolean;
  harnessRoot: string;
};

/**
 * Which real-model rail the stack runs. `up.sh --model-key azure` records
 * F598_MODEL_ROUTE=azure and pins the built-in provider to Azure OpenAI (key and
 * base URL from keys/cloud.env, values never written to .env); otherwise real
 * turns go through the Vercel AI Gateway rail and need Gateway credit.
 */
export function realModelRoute(
  stack: Pick<StackState, "modelRoute" | "worktree">,
  azureEnvFile = join(KEYS_DIR, "cloud.env"),
): { ok: boolean; route: "azure" | "gateway"; models: string[]; detail: string } {
  if (stack.modelRoute === "azure") {
    const dotenv = readEnvFile(join(stack.worktree, ".env"));
    const models = (dotenv.OPENGENI_OPENAI_ALLOWED_MODELS ?? "").split(",").filter(Boolean);
    if (dotenv.OPENGENI_OPENAI_PROVIDER !== "azure") {
      return { ok: false, route: "azure", models, detail: ".env does not pin provider=azure" };
    }
    const names = Bun.spawnSync(
      [
        "bash",
        "-c",
        '. "$1" >/dev/null 2>&1; [ -n "${F598_AZURE_OPENAI_API_KEY:-}" ] && [ -n "${F598_AZURE_OPENAI_BASE_URL:-}" ] && echo ok',
        "_",
        azureEnvFile,
      ],
      { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    );
    const ok = names.stdout.toString().trim() === "ok";
    return {
      ok,
      route: "azure",
      models,
      detail: ok
        ? `azure built-in provider (${models.join(",") || "default catalog"})`
        : `${azureEnvFile} lacks F598_AZURE_OPENAI_API_KEY/BASE_URL`,
    };
  }
  const credits = gatewayCredits();
  return {
    ok: credits.ok,
    route: "gateway",
    models: [],
    detail: `gateway: ${credits.detail} (start the stack with up.sh --model-key azure for the Azure route)`,
  };
}

/** Read the Gateway balance in a subshell; the key never enters this process. */
export function gatewayCredits(envFile = join(KEYS_DIR, "env.sh")): {
  ok: boolean;
  balance: number | null;
  detail: string;
} {
  if (!existsSync(envFile)) return { ok: false, balance: null, detail: `${envFile} missing` };
  const script =
    '. "$1" >/dev/null 2>&1; k="${OPENGENI_VERCEL_AI_GATEWAY_API_KEY:-${VERCEL_AI_GATEWAY_API_KEY:-}}"; ' +
    '[ -n "$k" ] || { echo "{\\"error\\":\\"no gateway key\\"}"; exit 0; }; ' +
    'curl -s -m 15 -H "Authorization: Bearer $k" https://ai-gateway.vercel.sh/v1/credits';
  const result = Bun.spawnSync(["bash", "-c", script, "_", envFile], {
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const text = result.stdout.toString().trim();
  try {
    const body = JSON.parse(text) as { balance?: string; error?: unknown };
    if (body.balance === undefined) {
      return { ok: false, balance: null, detail: `credits endpoint: ${text.slice(0, 200)}` };
    }
    const balance = Number(body.balance);
    return {
      ok: balance > 0,
      balance,
      detail: balance > 0 ? `balance ${balance.toFixed(2)}` : `no credit (balance ${balance})`,
    };
  } catch {
    return {
      ok: false,
      balance: null,
      detail: `credits endpoint unreadable: ${text.slice(0, 120)}`,
    };
  }
}

export async function probeFeatures(context: ProbeContext): Promise<FeatureReport> {
  const { owner, workspaceId } = context;
  const report = {} as FeatureReport;
  const set = (id: FeatureId, present: boolean, detail: string) => {
    report[id] = { id, present, detail };
  };

  const vaults = await owner.request("GET", `/v1/workspaces/${workspaceId}/vaults`);
  set("vaults_api", vaults.status === 200, `GET /vaults -> ${vaults.status}`);

  const legacy = await owner.request("GET", `/v1/workspaces/${workspaceId}/variable-sets`);
  set("legacy_routes_removed", legacy.status === 410, `GET /variable-sets -> ${legacy.status}`);

  const realModel = realModelRoute(context.stack);
  set("real_model", realModel.ok, realModel.detail);

  const opEnv = join(KEYS_DIR, "op.env");
  set(
    "onepassword_token",
    existsSync(opEnv) && process.env.OPENGENI_ONEPASSWORD_LIVE === "1",
    existsSync(opEnv)
      ? process.env.OPENGENI_ONEPASSWORD_LIVE === "1"
        ? "op.env present; live mode on"
        : "op.env present; set OPENGENI_ONEPASSWORD_LIVE=1 to run live 1Password"
      : "op.env missing",
  );

  const machines = await listMachines(owner, workspaceId);
  const online = machines.filter((machine) => machine.online);
  set(
    "connected_machine",
    online.length > 0,
    online.length > 0
      ? `online: ${online.map((machine) => `${machine.name} (${machine.id})`).join(", ")}`
      : `no online connected machine (${machines.length} enrolled); run machine.sh up`,
  );

  const fixture = join(context.harnessRoot, "packages/testing/src/fixtures/pre-vaults-fixture.sql");
  set(
    "pre_vaults_fixture",
    existsSync(fixture),
    existsSync(fixture) ? fixture : `${fixture} missing`,
  );

  // Ask-card secret field: the contract adds `kind: "secret"` questions (§10B.1.5).
  const contracts = join(context.stack.worktree, "packages/contracts/src/index.ts");
  const contractText = existsSync(contracts) ? await Bun.file(contracts).text() : "";
  set(
    "ask_card_secret_field",
    /SecretQuestion|kind:\s*z\.literal\("secret"\)/u.test(contractText),
    "contracts declare the ask-card secret question kind",
  );
  set(
    "secrets_capability_toggle",
    /capabilities[\s\S]{0,400}secrets/u.test(contractText) ||
      existsSync(join(context.stack.worktree, "packages/contracts/src/vaults.ts")),
    "contracts declare the `secrets` agent capability",
  );

  if (!context.scriptedWorkerActive) {
    set("directive_worker", false, "scripted worker not running (tool surface not probed)");
    set("secret_tools", false, "not probed: needs the directive worker");
    return report;
  }
  const turn = await runTurn(owner, {
    workspaceId,
    message: directiveMessage(
      [{ tool: "tool_list", args: { namePrefix: "secret_", limit: 40 } }],
      "secrets gate probe: list secret tools",
    ),
    timeoutMs: 120_000,
  });
  const parsed = parseDirectiveReport(turn.assistantText);
  set(
    "directive_worker",
    parsed !== null,
    parsed
      ? `directive worker answered (session ${turn.sessionId})`
      : `no E2E-REPORT (${turn.status})`,
  );
  const offered = new Set(parsed?.tools ?? []);
  const listed = (parsed?.outputs ?? []).join("\n");
  const required = ["secret_search", "secret_save"];
  const found = required.filter((name) => offered.has(name) || listed.includes(name));
  set(
    "secret_tools",
    found.length === required.length,
    `found ${found.join(", ") || "none"} of ${required.join(", ")}`,
  );
  return report;
}

export function missingFeatures(report: FeatureReport, required: FeatureId[]): FeatureProbe[] {
  return required.map((id) => report[id]).filter((probe) => !probe?.present);
}
