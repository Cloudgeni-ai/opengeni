/**
 * Local full-stack access for the secrets gate (design §13.0, §17.1).
 *
 * The stack is the f598 "localstack" (one per worktree and port slot), started by
 * `$F598_LS/up.sh`. Every helper takes the stack NAME and reads that stack's own
 * state file (`run/stack-<name>.env`) instead of the shared, racy `current.env`.
 * Raw API calls reuse the Playwright storage state written by `login.ts`, with the
 * same headers the web app sends.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_LOCALSTACK = "/workspace/sessions/f5980f29/localstack";
export const API_CONTRACT = "2026-09-plugins-and-skills-v1";
export const DEFAULT_WORKSPACE = "Platform engineering";

export function localstackDir(): string {
  return process.env.F598_LS ?? DEFAULT_LOCALSTACK;
}

export type SeedUser = "owner" | "admin" | "member" | "viewer";

export type StackState = {
  name: string;
  stateFile: string;
  worktree: string;
  slot: number;
  web: string;
  api: string;
  pgUrl: string;
  temporal: string;
  composeProject: string;
  unit: string;
  log: string;
  /** up.sh model rail: `azure` (--model-key azure), `key-file` (--model-key) or `none`. */
  modelRoute: string;
};

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/gu, "");
  }
  return values;
}

export function stackStateFile(name: string): string {
  return join(localstackDir(), "run", `stack-${name}.env`);
}

export function loadStack(name: string): StackState | null {
  const stateFile = stackStateFile(name);
  const env = readEnvFile(stateFile);
  if (!env.F598_API || !env.F598_WEB) return null;
  return {
    name,
    stateFile,
    worktree: env.F598_WT ?? "",
    slot: Number(env.F598_SLOT ?? 0),
    web: env.F598_WEB,
    api: env.F598_API,
    pgUrl: env.F598_PG_MIGRATIONS ?? "",
    temporal: env.F598_TEMPORAL ?? "",
    composeProject: env.F598_PROJECT ?? `f598-${name}`,
    unit: env.F598_UNIT ?? `f598-stack-${name}`,
    log: env.F598_LOG ?? join(localstackDir(), "logs", `stack-${name}.log`),
    modelRoute: env.F598_MODEL_ROUTE ?? "unknown",
  };
}

/** Slot port bases used by up.sh (slot 3 skips 47190, the shared test Postgres). */
export function slotBase(slot: number): number {
  const bases: Record<number, number> = { 0: 47100, 1: 47130, 2: 47160, 3: 47200 };
  const base = bases[slot];
  if (base === undefined) throw new Error(`unknown localstack slot ${slot}`);
  return base;
}

/** Fake-login ports for a slot: base+20 (site) and base+21 (cross-origin iframe). */
export function fakeLoginPorts(slot: number): { port: number; iframePort: number } {
  const base = slotBase(slot);
  return { port: base + 20, iframePort: base + 21 };
}

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

/** Run a localstack script (bash or bun) against one stack's state file. */
export function runLocalstack(
  stateFile: string | null,
  command: string[],
  options: { cwd?: string; timeoutMs?: number; extraEnv?: Record<string, string> } = {},
): CommandResult {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (stateFile) env.F598_STATE = stateFile;
  Object.assign(env, options.extraEnv ?? {});
  const result = Bun.spawnSync(command, {
    cwd: options.cwd ?? localstackDir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? 15 * 60_000,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export async function apiReady(stack: StackState): Promise<boolean> {
  try {
    const response = await fetch(`${stack.api}/healthz`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export type EnsureStackOptions = {
  name: string;
  worktree: string;
  slot: number;
  /** up.sh `--model-key` (key-file rails) or `--model-key azure`; false starts model-free. */
  modelKey: boolean | "azure";
  /** Start, seed and log in when the stack is not ready. */
  allowUp: boolean;
  log?: (line: string) => void;
};

/**
 * Return a ready, seeded, logged-in stack. With allowUp it runs
 * `up.sh <wt> --slot N --name X [--model-key]`, `seed.sh` and `login.ts --user all`.
 */
export async function ensureStack(options: EnsureStackOptions): Promise<StackState> {
  const log = options.log ?? (() => {});
  let stack = loadStack(options.name);
  if (stack && (await apiReady(stack))) {
    if (stack.worktree && stack.worktree !== options.worktree) {
      throw new Error(
        `stack ${options.name} runs worktree ${stack.worktree}, not ${options.worktree}; pick another --name`,
      );
    }
  } else {
    if (!options.allowUp) {
      throw new Error(`stack ${options.name} is not running (pass --up to start it)`);
    }
    const up = [
      "bash",
      join(localstackDir(), "up.sh"),
      options.worktree,
      "--slot",
      String(options.slot),
      "--name",
      options.name,
    ];
    if (options.modelKey) up.push("--model-key");
    if (options.modelKey === "azure") up.push("azure");
    log(`starting stack: ${up.slice(1).join(" ")}`);
    const started = runLocalstack(null, up, { timeoutMs: 30 * 60_000 });
    if (started.exitCode !== 0) {
      throw new Error(`up.sh failed (${started.exitCode}): ${started.stderr.slice(-2_000)}`);
    }
    stack = loadStack(options.name);
    if (!stack) throw new Error(`up.sh did not write ${stackStateFile(options.name)}`);
    log("seeding");
    const seeded = runLocalstack(stack.stateFile, ["bash", join(localstackDir(), "seed.sh")]);
    if (seeded.exitCode !== 0) throw new Error(`seed.sh failed: ${seeded.stderr.slice(-2_000)}`);
  }
  for (const user of ["owner", "admin", "member", "viewer"] as const) {
    if (!existsSync(authStatePath(stack, user))) {
      log("logging in seeded users");
      const login = runLocalstack(stack.stateFile, ["bun", "login.ts", "--user", "all"]);
      if (login.exitCode !== 0) throw new Error(`login.ts failed: ${login.stderr.slice(-2_000)}`);
      break;
    }
  }
  return stack;
}

export function authStatePath(stack: StackState, user: SeedUser): string {
  return join(localstackDir(), "run", `auth-${stack.name}-${user}.json`);
}

export type ApiResult<T = any> = { status: number; ok: boolean; json: T; text: string };

/** Authenticated API client acting as one seeded user. */
export class StackApi {
  readonly stack: StackState;
  readonly user: SeedUser;
  #cookie: string;

  constructor(stack: StackState, user: SeedUser) {
    this.stack = stack;
    this.user = user;
    const state = JSON.parse(readFileSync(authStatePath(stack, user), "utf8")) as {
      cookies: { name: string; value: string }[];
    };
    this.#cookie = state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const response = await fetch(`${this.stack.api}${path}`, {
      method,
      headers: {
        cookie: this.#cookie,
        origin: this.stack.web,
        "x-opengeni-api-contract": API_CONTRACT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, ok: response.ok, json: json as T, text };
  }

  /** Like request() but throws on a non-2xx response. */
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.request<T>(method, path, body);
    if (!result.ok) {
      throw new Error(`${method} ${path} -> ${result.status}: ${result.text.slice(0, 400)}`);
    }
    return result.json;
  }

  async workspaceId(name = DEFAULT_WORKSPACE): Promise<string> {
    const rows = await this.call<{ id: string; name: string }[]>("GET", "/v1/workspaces");
    const row = rows.find((candidate) => candidate.name === name);
    if (!row) throw new Error(`workspace ${name} is not visible to ${this.user}`);
    return row.id;
  }
}

export type MachineRow = { id: string; name: string; kind: string; state: string; online: boolean };

/** Connected machines (MachinesResponse.machines, excluding session group boxes). */
export async function listMachines(api: StackApi, workspaceId: string): Promise<MachineRow[]> {
  const result = await api.request("GET", `/v1/workspaces/${workspaceId}/machines`);
  if (!result.ok) return [];
  const body = result.json as {
    machines?: {
      sandboxId: string;
      name: string;
      kind: string;
      state: string;
      isSessionGroup: boolean;
    }[];
  };
  return (body.machines ?? [])
    .filter((row) => !row.isSessionGroup && row.kind !== "local")
    .map((row) => ({
      id: row.sandboxId,
      name: row.name,
      kind: row.kind,
      state: row.state,
      online: row.state === "online" || row.state === "display_unavailable",
    }));
}

/** Bring the stack's connected machine (real Rust agent) online via machine.sh. */
export function machineUp(stack: StackState): CommandResult {
  return runLocalstack(stack.stateFile, ["bash", join(localstackDir(), "machine.sh"), "up"], {
    timeoutMs: 45 * 60_000,
  });
}

export function machineStatus(stack: StackState): CommandResult {
  return runLocalstack(stack.stateFile, ["bash", join(localstackDir(), "machine.sh"), "status"]);
}

/** Swap the real turn worker for the model-free scripted worker (e2e-worker.ts). */
export function startScriptedWorker(stack: StackState, scenario: string): CommandResult {
  return runLocalstack(
    stack.stateFile,
    ["bash", join(localstackDir(), "scripted-turn.sh"), "start", scenario],
    { timeoutMs: 5 * 60_000 },
  );
}

export function stopScriptedWorker(stack: StackState): CommandResult {
  return runLocalstack(
    stack.stateFile,
    ["bash", join(localstackDir(), "scripted-turn.sh"), "stop"],
    {
      timeoutMs: 5 * 60_000,
    },
  );
}

export function scriptedWorkerActive(stack: StackState): boolean {
  const result = Bun.spawnSync(
    ["systemctl", "--user", "is-active", `f598-${stack.name}-scripted-turn`],
    { stdout: "pipe", stderr: "ignore" },
  );
  return result.stdout.toString().trim() === "active";
}
