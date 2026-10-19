// The end-to-end suite: real agent sessions through Opengeni's public API on
// the compute backend, with the fabric's own API to sleep, wake, move and
// lose what those sessions run on. It runs on the stack VM (stack/suite.sh)
// and writes results.json and results.md into $OUT.
//
// Each check names the checks it needs; one whose needs did not pass is
// skipped, so a run always reports every check. ONLY=a,b runs a subset (and
// what it needs). A check passes, fails, is skipped, or is n/a when the
// product has no surface for it (the reason is in its detail).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { describeFrame, frameStats, notAFrame } from "./frame.ts";
import { counts, render, type Proof, type Result, type Status } from "./report.ts";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

const OPENGENI_URL = env("OPENGENI_URL");
const API_CONTRACT = env("API_CONTRACT");
const MODEL = env("MODEL");
const OUT = env("OUT");
const STARTED = new Date().toISOString();
// No check takes longer (a host loss waits for the lost host's lease).
const CHECK_TIMEOUT_MS = 30 * 60_000;
// How long an aborted check's own cleanup may take after it (a few bounded
// requests).
const CLEANUP_LIMIT_MS = 10 * 60_000;
const COMPUTE_SERVICE = env("COMPUTE_SERVICE");
const COMPUTE_ADDRESS = env("COMPUTE_ADDRESS", "127.0.0.1");
const COMPUTE_PORT = Number(env("COMPUTE_PORT", "8080"));
const COMPUTE_CA = readFileSync(env("COMPUTE_CA"));
const OPENGENI_KEY = readFileSync(env("COMPUTE_OPENGENI_KEY"), "utf8").trim();
const OPERATOR_KEY = readFileSync(env("COMPUTE_OPERATOR_KEY"), "utf8").trim();
const PROJECT = env("PROJECT");
const ZONE = env("ZONE");
const HOSTS = Number(env("HOSTS", "3"));
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const TURN_TIMEOUT_S = Number(env("TURN_TIMEOUT_S", "900"));
// The agent build in the sandbox image (stack/suite.sh copies it out), which
// the connected-machine check enrolls as this VM.
const AGENT_BIN = process.env.AGENT_BIN ?? "";
// The Opengeni checkout the stack was built from (its relay wire module).
const OPENGENI_DIR = env("OPENGENI_DIR", "/srv/e2e/opengeni");

mkdirSync(OUT, { recursive: true });
const logLines: string[] = [];
function log(message: string): void {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  logLines.push(line);
  console.log(line);
}

// Each check runs under its own abort: when it outlives its time, the runner
// aborts it, so its requests and waits end instead of carrying on against
// the state the next check uses.
let checkAbort = new AbortController();
/** Waits `ms`, or rejects as soon as the running check is aborted. */
function sleep(ms: number): Promise<void> {
  const signal = checkAbort.signal;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
/** A request or socket ends with the running check. */
function onCheckAbort(stop: (reason: unknown) => void): void {
  const signal = checkAbort.signal;
  if (signal.aborted) stop(signal.reason);
  else signal.addEventListener("abort", () => stop(signal.reason), { once: true });
}
// What cleanup could not undo (a session not deleted, an enrollment not
// revoked); any of it fails the run.
const cleanupErrors: string[] = [];

// --- Opengeni's API ---------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${body.slice(0, 600)}`);
  }
}

/** One API request; `cleanup` requests still run after their check was aborted. */
async function og<T = any>(
  method: string,
  path: string,
  body?: unknown,
  { cleanup = false, signal }: { cleanup?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${OPENGENI_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-opengeni-api-contract": API_CONTRACT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Longer than any request's own timeout (a 120 s command), so a request
    // that never answers fails its check instead of stopping the run.
    signal: AbortSignal.any([
      ...(cleanup
        ? [AbortSignal.timeout(120_000)]
        : [AbortSignal.timeout(600_000), checkAbort.signal]),
      ...(signal ? [signal] : []),
    ]),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, text, `${method} ${path}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A GET whose answer is bytes (an image), with its media type. */
async function ogBytes(path: string): Promise<{ bytes: Uint8Array; type: string }> {
  const response = await fetch(`${OPENGENI_URL}${path}`, {
    headers: { "x-opengeni-api-contract": API_CONTRACT },
    signal: AbortSignal.any([AbortSignal.timeout(120_000), checkAbort.signal]),
  });
  if (!response.ok) throw new HttpError(response.status, await response.text(), `GET ${path}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    type: response.headers.get("content-type") ?? "",
  };
}

const state: {
  workspace?: string;
  session?: { id: string; sandboxGroupId?: string };
  sandbox?: string;
  marker?: string;
} = {};

const ws = () => `/v1/workspaces/${state.workspace}`;
const ses = () => `${ws()}/sessions/${state.session!.id}`;

type SessionEvent = { sequence: number; type: string; payload?: any };

async function eventsAfter(after: number): Promise<SessionEvent[]> {
  const all: SessionEvent[] = [];
  let cursor = after;
  for (;;) {
    const page = await og<any>("GET", `${ses()}/events?after=${cursor}&limit=500&mode=forensic`);
    const events: SessionEvent[] = Array.isArray(page) ? page : (page.events ?? page.items ?? []);
    if (events.length === 0) return all;
    all.push(...events);
    cursor = events[events.length - 1]!.sequence;
    if (events.length < 500) return all;
  }
}

/** One tool call of a turn and, once it ended, its result. */
type ToolCall = { id: string; name: string; args: any; output?: string; ok?: boolean };
type Turn = { text: string; tools: string[]; calls: ToolCall[] };

/** Whether a tool's result is a success, as Opengeni's own tool metrics
 * count it (packages/observability agentToolCallOutcome). */
function toolSucceeded(payload: any): boolean {
  if (payload?.error === true || payload?.failed === true) return false;
  const output = payload?.output;
  if (output && typeof output === "object" && output.isError === true) return false;
  const text =
    typeof output === "string" ? output : typeof output?.text === "string" ? output.text : null;
  if (text === null) return true;
  const trimmed = text.trim();
  return !(
    trimmed === "Tool execution was not approved." ||
    trimmed === "aborted" ||
    trimmed.startsWith("An error occurred while running the tool")
  );
}

function parsedArgs(payload: any): any {
  const args = payload?.arguments;
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}
const invoked = (payload: any) =>
  String(payload?.name ?? payload?.raw?.name ?? "?") === "tool_invoke";
/** A deferred tool reached through tool_invoke is named by its target. */
function toolName(payload: any): string {
  const args = parsedArgs(payload);
  return invoked(payload) && typeof args?.name === "string"
    ? args.name
    : String(payload?.name ?? payload?.raw?.name ?? "?");
}
function toolArgs(payload: any): any {
  const args = parsedArgs(payload);
  return invoked(payload) && args?.arguments ? args.arguments : args;
}

const callsText = (calls: ToolCall[]) =>
  calls
    .map((call) => `${call.name}${call.ok === undefined ? "" : call.ok ? " ok" : " failed"}`)
    .join(", ") || "none";

let eventCursor = 0;
/** Waits for the session's next turn to end; returns the agent's reply and
 * its tool calls with their results. */
async function nextTurn(timeoutS = TURN_TIMEOUT_S): Promise<Turn> {
  const deadline = Date.now() + timeoutS * 1000;
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  for (;;) {
    for (const event of await eventsAfter(eventCursor)) {
      eventCursor = Math.max(eventCursor, event.sequence);
      if (event.type === "agent.message.completed") texts.push(String(event.payload?.text ?? ""));
      if (event.type === "agent.toolCall.created") {
        calls.push({
          id: String(event.payload?.id ?? ""),
          name: toolName(event.payload),
          args: toolArgs(event.payload),
        });
      }
      if (event.type === "agent.toolCall.output") {
        const call = calls.find((one) => one.id === String(event.payload?.id ?? ""));
        if (call) {
          const output = event.payload?.output;
          call.output = typeof output === "string" ? output : JSON.stringify(output ?? null);
          call.ok = toolSucceeded(event.payload);
        }
      }
      if (event.type === "turn.completed") {
        return { text: texts.join("\n"), tools: calls.map((call) => call.name), calls };
      }
      if (event.type === "turn.failed") {
        throw new Error(`turn failed: ${JSON.stringify(event.payload).slice(0, 800)}`);
      }
    }
    if (Date.now() > deadline) throw new Error(`no turn end within ${timeoutS}s`);
    await sleep(3000);
  }
}

async function say(text: string, timeoutS?: number) {
  await og("POST", `${ses()}/events`, { type: "user.message", payload: { text } });
  return nextTurn(timeoutS);
}

type Exec = { stdout: string; stderr: string; exitCode: number };
async function exec(command: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<Exec> {
  return og<Exec>(
    "POST",
    `${ses()}/terminal/exec`,
    { command, timeoutMs, emitStream: false },
    { signal },
  );
}
async function execOk(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
  const result = await exec(command, timeoutMs, signal);
  if (result.exitCode !== 0) {
    // A traceback's last lines say what went wrong.
    throw new Error(
      `\`${command}\` exited ${result.exitCode}: ${result.stderr.trim().slice(-400)}`,
    );
  }
  return result.stdout;
}

// --- The fabric's API (at its cluster address, verified as its service name) --

function fabric<T = any>(
  method: string,
  path: string,
  body?: unknown,
  key = OPENGENI_KEY,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpsRequest(
      {
        host: COMPUTE_ADDRESS,
        port: COMPUTE_PORT,
        servername: COMPUTE_SERVICE,
        ca: COMPUTE_CA,
        method,
        path,
        headers: {
          host: COMPUTE_SERVICE,
          "x-api-key": key,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 400) reject(new HttpError(status, text, `fabric ${method} ${path}`));
          else resolve((text ? JSON.parse(text) : undefined) as T);
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(900_000, () =>
      request.destroy(new Error(`fabric ${method} ${path} timed out`)),
    );
    const stop = (reason: unknown) =>
      request.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    onCheckAbort(stop);
    if (signal) {
      if (signal.aborted) stop(signal.reason);
      else signal.addEventListener("abort", () => stop(signal.reason), { once: true });
    }
    if (payload) request.write(payload);
    request.end();
  });
}

type Host = { name: string; state: string; epoch: number; sandboxes: number; awake: number };
type Sandbox = {
  id: string;
  host: string | null;
  owner_epoch: number;
  metadata: Record<string, string>;
};
const hosts = () => fabric<Host[]>("GET", "/v1/hosts", undefined, OPERATOR_KEY);
const sandbox = () => fabric<Sandbox>("GET", `/v1/sandboxes/${state.sandbox}`);

// --- A host, as root's caller (OS Login as the stack VM's identity, which
// env.sh lets log in to this environment's hosts only) ----------------------

/** A gcloud command's stdout (as the stack VM's identity). */
function gcloud(args: string[]): string {
  const run = spawnSync("gcloud", [...args, "--quiet"], { encoding: "utf8", timeout: 120_000 });
  if (run.status !== 0)
    throw new Error(
      `gcloud ${args.slice(0, 4).join(" ")}: ${`${run.error ?? ""} ${run.stderr ?? ""}`.trim().slice(-300)}`,
    );
  return run.stdout.trim();
}
// OS Login as this VM's identity: a key of the suite's, registered for a
// day, and the login name OS Login gives the identity. (gcloud compute ssh
// would also need to read the project, which the identity may not.)
let hostLogin: { key: string; user: string } | undefined;
const hostAddresses = new Map<string, string>();
function login(): { key: string; user: string } {
  if (hostLogin) return hostLogin;
  const key = `${process.env.HOME}/.ssh/e2e_hosts`;
  if (spawnSync("test", ["-f", key]).status !== 0) {
    const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
      encoding: "utf8",
    });
    if (made.status !== 0) throw new Error(`ssh-keygen: ${made.stderr}`);
  }
  gcloud(["compute", "os-login", "ssh-keys", "add", "--key-file", `${key}.pub`, "--ttl", "1d"]);
  const user = gcloud([
    "compute",
    "os-login",
    "describe-profile",
    "--format",
    "value(posixAccounts[0].username)",
  ]);
  if (!user) throw new Error("OS Login gave this VM's identity no login name");
  hostLogin = { key, user };
  return hostLogin;
}
/** Runs `command` on `host` and returns its stdout; fails on a nonzero exit. */
function onHost(host: string, command: string, timeoutMs = 120_000): string {
  const { key, user } = login();
  let address = hostAddresses.get(host);
  if (!address) {
    address = gcloud([
      "compute",
      "instances",
      "describe",
      host,
      "--zone",
      ZONE,
      "--project",
      PROJECT,
      "--format",
      "value(networkInterfaces[0].networkIP)",
    ]);
    hostAddresses.set(host, address);
  }
  const run = spawnSync(
    "ssh",
    [
      "-n",
      "-T",
      "-i",
      key,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=20",
      `${user}@${address}`,
      command,
    ],
    { encoding: "utf8", timeout: timeoutMs },
  );
  if (run.status !== 0) {
    throw new Error(
      `on ${host}, \`${command.slice(0, 100)}\` ended ${run.status ?? run.signal}: ${`${run.error ?? ""} ${run.stderr ?? ""}`.trim().slice(-400)}`,
    );
  }
  return run.stdout;
}
const vmDir = (id: string) => `/var/lib/compute/state/vm/firecracker/${id}`;

/** Where the sandbox's guest console on a host was read up to: the file
 * and its length then, and the host's clock then (`date +%s.%N`), from
 * which the host's journal says how many times the VMM launched since. */
type ConsoleMark = { host: string; inode: string; bytes: number; at: string };
/** What the console gained since a mark about the agent's connections:
 * each "connected to control plane" is one connection made, "reconnecting
 * at once" the agent told to make one, "lost this sandbox's connections"
 * the guest told its host lost them. */
type ConsoleGrowth = {
  connected: number;
  reconnecting: number;
  lost: number;
  how: string;
  /** VMM launches of the sandbox since the mark, by the host's journal
   * (each launch writes a new console, so a launch means the counted file
   * is that launch's, read whole). */
  launches: number;
  mark: ConsoleMark;
};
/** The host keeps about the last 1 MiB of a console (it punches out the
 * start of longer ones), so a count over more than this could miss lines. */
const CONSOLE_KEPT = 900 << 10;
/** Runs `script` as root on `host` (sent whole, so it needs no quoting). */
function asRoot(host: string, script: string): string {
  return onHost(host, `echo ${Buffer.from(script).toString("base64")} | base64 -d | sudo sh`);
}
/** Shell that sets `now` (the host's clock) and `l`, the sandbox's VMM
 * launches the host journal records since `since` (0 with no mark). The
 * journal, not the file, says whether the console was replaced: a new
 * file can come back with the old one's inode. A journal that cannot be
 * read ends the script (exit 7) rather than count as no launch. */
function launchesScript(since?: ConsoleMark): string {
  return [
    `now=$(date +%s.%N); l=0`,
    since
      ? [
          `jl=$(journalctl --no-pager -o cat -u 'compute-*' --since @${since.at}) || { echo "the host journal could not be read" >&2; exit 7; }`,
          `l=$(printf '%s\\n' "$jl" | grep -F '"compute.sandbox.id":"${state.sandbox}"' | grep -o '"compute.launches":[0-9]*' | cut -d: -f2 | awk '{ n += $1 } END { print n + 0 }')`,
        ].join("\n")
      : "",
  ].join("\n");
}
/** Shell that counts the console `$f` (inode `$i`) from `since`, given
 * `launchesScript`'s `now` and `l`: with no launch since, the bytes the
 * same file gained after the mark; after a launch, all of the file. */
function countScript(since?: ConsoleMark): string {
  return [
    `s=$(stat -L -c %s $f); from=0`,
    `if [ "$l" = 0 ] && [ "$i" = "${since?.inode ?? "none"}" ] && [ "$s" -ge ${since?.bytes ?? 0} ]; then from=${since?.bytes ?? 0}; fi`,
    `echo "$i $s $from $now $l"`,
    `d=$(tail -c +$((from + 1)) $f | tr -d '\\000')`,
    `for p in 'connected to control plane' 'reconnecting at once' "lost this sandbox's connections"; do printf '%s\\n' "$d" | grep -c "$p" || true; done`,
  ].join("\n");
}
/** The growth `countScript` printed (`out`) since `since`. */
function growthOf(host: string, out: string[], since?: ConsoleMark): ConsoleGrowth {
  const [inode = "", bytesText = "", fromText = "", at = "", launchesText = ""] = (
    out[0] ?? ""
  ).split(" ");
  const [bytes, from, launches, connected, reconnecting, lost] = [
    bytesText,
    fromText,
    launchesText,
    ...out.slice(1, 4),
  ].map(Number);
  if (
    !inode ||
    !/^\d+\.\d+$/.test(at) ||
    [bytes, from, launches, connected, reconnecting, lost].some((n) => !Number.isFinite(n))
  ) {
    throw new Error(
      `the guest console on ${host} could not be read: ${out.join(" | ").slice(0, 300)}`,
    );
  }
  const mark = { host, inode, bytes: bytes!, at };
  if (!since) {
    return { connected: 0, reconnecting: 0, lost: 0, how: "marked", launches: 0, mark };
  }
  if (since.host !== host) throw new Error(`the console was marked on ${since.host}, not ${host}`);
  if (launches === 0 && from !== since.bytes) {
    throw new Error(
      `the guest console on ${host} is not the marked one continued (inode ${since.inode} of ${since.bytes} bytes, now ${inode} of ${bytes}), yet the host journal records no VMM launch since`,
    );
  }
  if (bytes! - from! > CONSOLE_KEPT) {
    throw new Error(
      `the guest console gained ${bytes! - from!} bytes, more than the host keeps of it, so a count of it could miss lines`,
    );
  }
  return {
    connected: connected!,
    reconnecting: reconnecting!,
    lost: lost!,
    how:
      launches === 0
        ? `${bytes! - from!} bytes the console gained`
        : `the console of a VMM launched since, ${bytes} bytes, after ${launches} launch(es)`,
    launches: launches!,
    mark,
  };
}
/**
 * Reads the console on `host` from `since`: the bytes the same file gained
 * after it, or, after a launch the host's journal records, all of the
 * file that launch wrote. With no mark, only marks where it is now.
 */
function consoleSince(host: string, since?: ConsoleMark): ConsoleGrowth {
  const script = [
    `f=${vmDir(state.sandbox!)}/console.log`,
    launchesScript(since),
    `i=$(stat -c %i $f)`,
    countScript(since),
  ].join("\n");
  return growthOf(host, asRoot(host, script).trim().split("\n"), since);
}
const connections = (g: ConsoleGrowth) => g.connected + g.reconnecting + g.lost;
const describeGrowth = (g: ConsoleGrowth) =>
  `"connected to control plane" +${g.connected}, "reconnecting at once" +${g.reconnecting}, ` +
  `"lost this sandbox's connections" +${g.lost} (${g.how})`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** How the sandbox's host says it is now (GET .../state): its level, the
 * step under way (the level stays the old one until a step ends), and its
 * boot generation, which rises only on a reboot. No owner answers
 * `{host: null, level: "remote"}`; a host mid-move answers 503. */
type SandboxState = {
  host: string | null;
  level: string;
  step: string | null;
  generation: number | null;
};
async function sandboxState(signal?: AbortSignal): Promise<SandboxState> {
  for (let tries = 0; ; tries += 1) {
    try {
      return await fabric<SandboxState>(
        "GET",
        `/v1/sandboxes/${state.sandbox}/state`,
        undefined,
        OPENGENI_KEY,
        signal,
      );
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 503) || tries >= 60) throw error;
      await sleep(1_000);
      if (signal?.aborted) throw signal.reason;
    }
  }
}
const LEVELS = ["running", "paused", "compressed", "saved", "archived", "remote"];
const depth = (level: string) => LEVELS.indexOf(level);
const describeState = (now: SandboxState) =>
  `${now.level}${now.step ? ` (${now.step} under way)` : ""} on ${now.host ?? "no host"}`;

/**
 * Waits until the host reports the sandbox at `level` or deeper with no step
 * under way, then holds it there a moment to show nothing woke it. Fails if
 * it wakes on its own or does not get there in time.
 */
async function reachLevel(
  level: string,
  limitMs: number,
): Promise<{ state: SandboxState; ms: number; seen: string[] }> {
  const start = Date.now();
  const seen: string[] = [];
  let deepest = 0;
  for (;;) {
    const now = await sandboxState();
    const label = describeState(now);
    if (seen.at(-1) !== label) seen.push(label);
    deepest = Math.max(deepest, depth(now.level));
    if (depth(now.level) >= depth(level) && !now.step) {
      const ms = Date.now() - start;
      await sleep(3_000);
      const held = await sandboxState();
      if (depth(held.level) < depth(level)) {
        throw new Error(
          `reached ${now.level}, then was ${describeState(held)} 3 s later with no request (${seen.join(" -> ")})`,
        );
      }
      return { state: held, ms, seen };
    }
    if (deepest > 0 && now.level === "running" && !now.step) {
      throw new Error(`woke before reaching ${level}, with no request: ${seen.join(" -> ")}`);
    }
    if (Date.now() - start > limitMs) {
      throw new Error(`not ${level} within ${limitMs / 1000} s: ${seen.join(" -> ")}`);
    }
    await sleep(250);
  }
}
const REACH_MS: Record<string, number> = {
  paused: 30_000,
  saved: 180_000,
  archived: 600_000,
  remote: 600_000,
};

/**
 * One HTTP GET to a TCP port inside the sandbox, over the fabric's connect
 * stream. connect/<n> reaches guest vsock port n; a guest TCP port is reached
 * through the guest's gateway (vsock 57), whose first line names it.
 */
const GATEWAY_PORT = 57;
function connectGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: COMPUTE_ADDRESS,
      port: COMPUTE_PORT,
      servername: COMPUTE_SERVICE,
      ca: COMPUTE_CA,
    });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => socket.destroy(new Error("connect timed out")), 120_000);
    onCheckAbort((reason) =>
      socket.destroy(reason instanceof Error ? reason : new Error(String(reason))),
    );
    socket.on("secureConnect", () => {
      socket.write(
        `GET /v1/sandboxes/${state.sandbox}/connect/${GATEWAY_PORT} HTTP/1.1\r\nHost: ${COMPUTE_SERVICE}\r\n` +
          `X-API-Key: ${OPENGENI_KEY}\r\nConnection: Upgrade\r\nUpgrade: compute-stream\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString();
        if (!head.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`connect refused: ${buffer.toString().slice(0, 400)}`));
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        socket.write(`tcp ${port}\nGET ${path} HTTP/1.0\r\nHost: localhost\r\n\r\n`);
      }
    });
    // The gateway answers its header with "ok" (or "error <reason>") first.
    const settle = () => {
      clearTimeout(timer);
      const text = buffer.toString();
      if (text.startsWith("ok\n")) resolve(text.slice(3));
      else reject(new Error(`gateway answered ${JSON.stringify(text.slice(0, 300))}`));
    };
    socket.on("end", settle);
    socket.on("close", () => {
      if (upgraded) settle();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// --- Checks ---------------------------------------------------------------

type Check = { id: string; title: string; needs: string[]; run: () => Promise<string> };
class NotApplicable extends Error {}

const checks: Check[] = [];
const check = (id: string, title: string, needs: string[], run: () => Promise<string>) =>
  checks.push({ id, title, needs, run });
const rand = () => randomUUID().slice(0, 8);
const seconds = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)} s`;

check("health", "Opengeni API is up", [], async () => {
  const response = await fetch(`${OPENGENI_URL}/healthz`);
  if (!response.ok) throw new Error(`healthz HTTP ${response.status}`);
  return "healthz 200";
});

check("hosts", `the fabric has ${HOSTS} live hosts`, [], async () => {
  const live = (await hosts()).filter((host) => host.state === "live");
  if (live.length < HOSTS)
    throw new Error(`${live.length} live: ${live.map((h) => h.name).join(", ")}`);
  return live.map((host) => host.name).join(", ");
});

check("workspace", "a workspace to work in", ["health"], async () => {
  const listed = await og<any>("GET", "/v1/workspaces");
  const workspaces = Array.isArray(listed) ? listed : (listed.workspaces ?? listed.items ?? []);
  if (workspaces.length === 0) throw new Error("no workspace");
  state.workspace = workspaces[0].id;
  return state.workspace!;
});

check(
  "create",
  "a session on the compute backend runs its first turn",
  ["workspace", "hosts"],
  async () => {
    const start = Date.now();
    const created = await og<any>("POST", `${ws()}/sessions`, {
      initialMessage: "Run `uname -r` in the shell and reply with only its output.",
      model: MODEL,
      reasoningEffort: "low",
      sandboxBackend: "compute",
    });
    state.session = { id: created.id };
    log(`session ${created.id}`);
    const turn = await nextTurn();
    const session = await og<any>("GET", ses());
    state.session.sandboxGroupId = session.sandboxGroupId;
    if (session.sandboxBackend && session.sandboxBackend !== "compute") {
      throw new Error(`session backend is ${session.sandboxBackend}`);
    }
    const boxes = await fabric<Sandbox[]>("GET", "/v1/sandboxes");
    const box = boxes.find(
      (one) => one.metadata?.opengeni_sandbox_group_id === session.sandboxGroupId,
    );
    if (!box) throw new Error(`no fabric sandbox for sandbox group ${session.sandboxGroupId}`);
    state.sandbox = box.id;
    return `first turn in ${seconds(start)}; sandbox ${box.id} on ${box.host}; reply "${turn.text.trim().slice(0, 80)}"`;
  },
);

check(
  "commands",
  "commands run in the sandbox and report their output and exit status",
  ["create"],
  async () => {
    const out = await execOk("echo e2e-ok; id -un; uname -m");
    if (!out.includes("e2e-ok")) throw new Error(`stdout ${out}`);
    const token = rand();
    const failed = await exec(`echo out-${token}; echo err-${token} >&2; exit 7`);
    if (
      failed.exitCode !== 7 ||
      !failed.stdout.includes(`out-${token}`) ||
      !failed.stderr.includes(`err-${token}`)
    ) {
      throw new Error(`a failing command answered ${JSON.stringify(failed).slice(0, 300)}`);
    }
    return `${out.trim().replaceAll("\n", " | ")}; a failing command kept its stdout, stderr and exit status 7`;
  },
);

check("egress", "the sandbox reaches the internet", ["create"], async () => {
  const out = await execOk(
    "python3 -c \"import urllib.request; print(urllib.request.urlopen('https://example.com', timeout=30).status)\"",
  );
  if (out.trim() !== "200") throw new Error(`https://example.com answered ${out.trim()}`);
  return "https://example.com answered 200 from inside the sandbox";
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

check(
  "background",
  "the agent's background commands: output and exit status read back by command id; one listed while it runs ends when stopped",
  ["create"],
  async () => {
    const done = `fin-${rand()}`;
    const marker = `bg-${rand()}`;
    const turn = await say(
      "Do these two things with your shell tools, then reply with only the two command IDs.\n" +
        `1. Start \`sh -c 'echo ${done}-start; sleep 5; echo ${done}-end; exit 3'\` with exec_command and yield_time_ms 1000, ` +
        "then wait for that command by its command ID with your command wait or read tool until it has exited.\n" +
        `2. Start \`sh -c 'echo ${marker}; sleep 900'\` with exec_command and yield_time_ms 1000, so that it keeps running ` +
        "in the background; do not wait for it or stop it.",
    );
    // The finished command, through the agent's own reads by its id.
    const started = turn.calls.find(
      (call) => /exec_command$/.test(call.name) && call.output?.includes(`${done}-start`),
    );
    const startedId = started?.output?.match(UUID)?.[0];
    if (!startedId) {
      throw new Error(
        `no background start of the finishing command with a command id; tools ${callsText(turn.calls)}`,
      );
    }
    const reads = turn.calls.filter(
      (call) =>
        /command_(wait|read)$/.test(call.name) &&
        JSON.stringify(call.args ?? "").includes(startedId),
    );
    const finished = reads.find(
      (call) =>
        call.ok &&
        call.output?.includes(`${done}-end`) &&
        /exit[_ ]?code\\?"?\s*[:=]?\s*3\b|exited with (code )?3\b/i.test(call.output),
    );
    if (!finished) {
      throw new Error(
        `reading command ${startedId} by its id gave no output with ${done}-end and exit status 3: ` +
          (reads
            .map(
              (call) => `${call.name} ${call.ok ? "ok" : "failed"} ${call.output?.slice(0, 200)}`,
            )
            .join(" / ") || "no read by id"),
      );
    }
    // The running one: listed, then stopped through the API, and its process gone.
    const active = async () =>
      ((await og<any>("GET", `${ses()}/background-commands`)).commands ?? []) as any[];
    const mine = (await active()).filter((one) => JSON.stringify(one).includes(marker));
    if (mine.length === 0) {
      throw new Error(
        `not listed while running; reply "${turn.text.slice(0, 200)}"; tools ${callsText(turn.calls)}`,
      );
    }
    const command = mine[0];
    const id = command.commandId ?? command.id;
    // pgrep's pattern does not match itself in the command line that runs it.
    const pattern = `[${marker[0]}]${marker.slice(1)}`;
    if (!(await exec(`pgrep -f '${pattern}'`)).stdout.trim())
      throw new Error(`command ${id} is listed but no process runs it`);
    await og("DELETE", `${ses()}/background-commands/${id}`);
    const stopped = Date.now();
    for (;;) {
      const listed = (await active()).some((one) => (one.commandId ?? one.id) === id);
      const running = (await exec(`pgrep -f '${pattern}'; pgrep -fx 'sleep 900'`)).stdout.trim();
      if (!listed && !running) break;
      if (Date.now() - stopped > 60_000) {
        throw new Error(
          `60 s after the stop, command ${id} is ${listed ? "still listed" : "unlisted"} and ` +
            (running
              ? `its processes still run (${running.replaceAll("\n", " ")})`
              : "its process is gone"),
        );
      }
      await sleep(2_000);
    }
    return (
      `command ${startedId} read back by id with its output and exit status 3; ` +
      `command ${id} listed as ${command.state ?? command.status}, then unlisted and its process gone ${seconds(stopped)} after the stop`
    );
  },
);

check("files", "files write, read and list (the file browser's API)", ["create"], async () => {
  state.marker = `e2e-${rand()}`;
  await og("POST", `${ses()}/fs/write`, {
    path: "e2e/hello.txt",
    content: state.marker,
    encoding: "utf8",
  });
  const read = await og<any>("POST", `${ses()}/fs/read`, { path: "e2e/hello.txt" });
  if (read.content !== state.marker) throw new Error(`read ${JSON.stringify(read).slice(0, 200)}`);
  const listed = await og<any>("POST", `${ses()}/fs/list`, { path: "", depth: 2 });
  if (!JSON.stringify(listed).includes("hello.txt")) throw new Error("hello.txt is not listed");
  return "write, read and list agree";
});

check("git", "git status and log of a repository in the sandbox", ["create"], async () => {
  await execOk(
    "rm -rf e2e-repo && git init -q e2e-repo && cd e2e-repo && git config user.email e2e@example.com && " +
      "git config user.name e2e && echo a > a.txt && git add a.txt && git commit -qm first && echo b > b.txt",
  );
  const status = await og<any>("POST", `${ses()}/git/status`, { path: "e2e-repo" });
  if (!status.isRepo || !JSON.stringify(status.files).includes("b.txt")) {
    throw new Error(`status ${JSON.stringify(status).slice(0, 300)}`);
  }
  const history = await og<any>("POST", `${ses()}/git/log`, { path: "e2e-repo" });
  if (!JSON.stringify(history).includes("first"))
    throw new Error(`log ${JSON.stringify(history).slice(0, 300)}`);
  return `head ${status.head}, untracked b.txt, one commit`;
});

// --- The viewer's terminal: a relay PTY ---------------------------------------

/**
 * A terminal as the web app opens it: attach a terminal viewer, which mints
 * the terminal plane, then speak that plane. On a compute sandbox the agent
 * serves it as a relay PTY (packages/react/src/hooks/use-terminal-stream.ts);
 * the relay messages come from the same checkout's hand-mirrored wire module.
 */
type Pty = {
  viewerId: string;
  /** Output so far, decoded. */
  output(): string;
  /** When each output frame arrived (ms since the epoch). */
  frames: number[];
  /** What the socket saw, for a failure's message. */
  seen: string[];
  /** Keystrokes, the way a person types them. */
  type(text: string): void;
  /** Until `done(output)` holds; fails if the socket ends or after `limitMs`. */
  until(done: (output: string) => boolean, limitMs: number, what: string): Promise<void>;
  close(): Promise<void>;
};

async function openPty(): Promise<Pty> {
  const wire = await import(`${OPENGENI_DIR}/packages/react/src/lib/relay-wire.ts`);
  const viewer = await og<any>("POST", `${ses()}/viewers`, { terminal: true });
  const closeViewer = () =>
    og("DELETE", `${ses()}/viewers/${viewer.viewerId}`, undefined, { cleanup: true }).catch(
      (error) => cleanupErrors.push(`closing terminal viewer ${viewer.viewerId}: ${error}`),
    );
  if (viewer.terminalTransport !== "relay-pty" || !viewer.terminalUrl) {
    await closeViewer();
    throw new Error(
      `viewer attach minted no relay terminal: transport ${viewer.terminalTransport}, url ${viewer.terminalUrl ? "set" : "null"}`,
    );
  }
  const endpoint = new URL(viewer.terminalUrl);
  const channel = {
    channelId: endpoint.searchParams.get("channel") ?? "",
    workspaceId: endpoint.searchParams.get("ws") ?? "",
    agentId: endpoint.searchParams.get("agent") ?? "",
    kind: wire.STREAM_KIND_PTY,
    port: Number(endpoint.searchParams.get("port") ?? "0"),
  };
  const datagram = (tag: number, body: Uint8Array) => {
    const bytes = new Uint8Array(body.length + 1);
    bytes[0] = tag;
    bytes.set(body, 1);
    return bytes;
  };
  const socket = new WebSocket(viewer.terminalUrl);
  socket.binaryType = "arraybuffer";
  const decoder = new TextDecoder();
  let output = "";
  let ended: Error | undefined;
  let accepted = false;
  const frames: number[] = [];
  const seen: string[] = [];
  const end = (error: Error) => {
    ended ??= error;
  };
  socket.onerror = () => end(new Error("the relay socket failed"));
  socket.onclose = (event) =>
    end(new Error(`the relay socket closed (${event.code} ${event.reason})`));
  onCheckAbort((reason) => {
    end(reason instanceof Error ? reason : new Error(String(reason)));
    socket.close();
  });
  socket.onopen = () => {
    seen.push("open");
    socket.send(
      datagram(
        1,
        wire.encodeStreamOpen({
          channel,
          token: viewer.terminalToken ?? "",
          role: wire.STREAM_ROLE_CLIENT,
          resumeFromSeq: "0",
        }),
      ),
    );
  };
  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      seen.push(`text ${event.data.slice(0, 80)}`);
      return;
    }
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    if (bytes.length < 1) return;
    const body = bytes.subarray(1);
    if (bytes[0] === 2) {
      const ack = wire.decodeStreamOpenAck(body);
      seen.push(`ack ${ack.accepted ? "accepted" : "refused"}`);
      if (ack.accepted) accepted = true;
      else end(new Error(`the relay refused the terminal: ${ack.error?.message ?? "no reason"}`));
    } else if (bytes[0] === 3) {
      if (!output) seen.push("output");
      frames.push(Date.now());
      output += decoder.decode(wire.decodeStreamFrame(body).data, { stream: true });
    } else {
      seen.push(`tag ${bytes[0]}`);
    }
  };
  let inputSeq = 0n;
  const until = async (done: (output: string) => boolean, limitMs: number, what: string) => {
    const start = Date.now();
    for (;;) {
      if (done(output)) return;
      if (ended)
        throw new Error(
          `${what}: ${ended.message}; socket ${seen.join(", ")}; output ${JSON.stringify(output.slice(-300))}`,
        );
      if (Date.now() - start > limitMs) {
        throw new Error(
          `${what} within ${limitMs / 1000} s; socket ${seen.join(", ") || "never opened"}; output ${JSON.stringify(output.slice(-300))}`,
        );
      }
      await sleep(100);
    }
  };
  const pty: Pty = {
    viewerId: viewer.viewerId,
    output: () => output,
    frames,
    seen,
    type(text) {
      seen.push("typed");
      socket.send(
        datagram(
          3,
          wire.encodeStreamFrame({
            channelId: channel.channelId,
            seq: (inputSeq++).toString(),
            data: new TextEncoder().encode(text),
            producedAtMs: String(Date.now()),
          }),
        ),
      );
    },
    until,
    async close() {
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      await closeViewer();
    },
  };
  try {
    await until(() => accepted, 60_000, "the relay did not accept the terminal");
    // The shell's prompt, or 3 s, before typing (as a person would).
    await until((out) => out.length > 0, 3_000, "no prompt").catch(() => undefined);
    await sleep(300);
  } catch (error) {
    await pty.close();
    throw error;
  }
  return pty;
}

/** Whether the file a typed command wrote holds what its shell computed. */
async function fileHolds(path: string, expected: string): Promise<string> {
  const file = await og<any>("POST", `${ses()}/fs/read`, { path, encoding: "utf8" }).catch(
    () => undefined,
  );
  return String(file?.content ?? "").trim() === expected
    ? ""
    : `${path} holds ${JSON.stringify(String(file?.content ?? "").slice(0, 80))}`;
}

check(
  "terminal",
  "a command typed into the interactive terminal runs in the sandbox",
  ["create"],
  async () => {
    const marker = `pty-${rand()}`;
    const pty = await openPty();
    try {
      pty.type(`echo ${marker}-$((1+1)) | tee e2e/${marker}.txt && echo ${marker}-done\r`);
      await pty.until(
        (out) => out.includes(`${marker}-2`) && out.includes(`${marker}-done`),
        60_000,
        "no echo",
      );
    } catch (error) {
      // Whether the typed command ran tells input from output apart.
      const wrong = await fileHolds(`e2e/${marker}.txt`, `${marker}-2`);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; the typed command ${wrong ? "did not run" : "ran (its file exists)"}`,
        { cause: error },
      );
    } finally {
      await pty.close();
    }
    // What proves the command ran, not just that its input was echoed: the
    // file it wrote, holding the shell's own arithmetic.
    const wrong = await fileHolds(`e2e/${marker}.txt`, `${marker}-2`);
    if (wrong) throw new Error(`the typed command's file: ${wrong}`);
    return `relay PTY echoed the typed command (${pty.output().length} bytes of output); its file e2e/${marker}.txt holds ${marker}-2`;
  },
);

check(
  "checkpoint",
  "a command's output and an open terminal keep streaming while the host checkpoints the running sandbox",
  ["terminal"],
  async () => {
    // The fleet checkpoints every running sandbox each minute here
    // (deploy.sh), pausing it for a moment; the agent's connections are
    // streams that outlive that. A terminal ticks for 150 s and a command
    // (the API's longest, 110 s) ticks alongside; neither may lose a tick,
    // the terminal may not go quiet for 10 s or close, and the host's
    // journal must show a checkpoint inside each window (verify.ts).
    const token = rand();
    const TICKS = 150;
    const RUN_TICKS = 110;
    const sightings = new Set<string>();
    const pty = await openPty();
    try {
      const ptyFrom = new Date().toISOString();
      pty.type(
        `for i in $(seq 1 ${TICKS}); do echo T${token}-$((i*1))-X; sleep 1; done; echo T${token}-end-$((6*7))\r`,
      );
      const ticked = (out: string, count: number) =>
        new Set(out.match(new RegExp(`T${token}-(\\d+)-X`, "g")) ?? []).size >= count;
      await pty.until((out) => ticked(out, 1), 30_000, "the terminal did not start ticking");
      const firstTick = pty.frames.length - 1;
      const runFrom = new Date().toISOString();
      const command = exec(
        `for i in $(seq 1 ${RUN_TICKS}); do echo C${token}-$i $(date +%s); sleep 1; done`,
        120_000,
      );
      // The host's own view, each second, for the record.
      const watching = { on: true };
      const watch = (async () => {
        while (watching.on) {
          const now = await sandboxState().catch(() => undefined);
          if (now?.step) sightings.add(now.step);
          await sleep(1_000).catch(() => (watching.on = false));
        }
      })();
      let result: Exec;
      let runTo: string;
      try {
        result = await command;
        runTo = new Date().toISOString();
        await pty.until(
          (out) => out.includes(`T${token}-end-42`),
          (TICKS + 60) * 1_000,
          "the terminal did not finish ticking",
        );
      } finally {
        watching.on = false;
        await watch;
      }
      const ptyTo = new Date().toISOString();
      // The command: every tick, in order, and its exit status.
      const lines = result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.startsWith(`C${token}-`));
      const numbers = lines.map((line) => Number(line.split(" ")[0].split("-")[1]));
      const inOrder = numbers.length === RUN_TICKS && numbers.every((n, i) => n === i + 1);
      if (result.exitCode !== 0 || !inOrder) {
        throw new Error(
          `the command exited ${result.exitCode} with ${numbers.length} of ${RUN_TICKS} ticks ` +
            `(${inOrder ? "in order" : `first missing ${numbers.findIndex((n, i) => n !== i + 1) + 1}`}); stderr ${result.stderr.slice(-300)}`,
        );
      }
      const clocks = lines.map((line) => Number(line.split(" ")[1]));
      const guestGap = Math.max(...clocks.slice(1).map((t, i) => t - clocks[i]));
      // The terminal: every tick, and no quiet spell.
      const ticks = new Set(pty.output().match(new RegExp(`T${token}-(\\d+)-X`, "g")) ?? []).size;
      if (ticks !== TICKS) throw new Error(`the terminal showed ${ticks} of ${TICKS} ticks`);
      const streamed = pty.frames.slice(firstTick);
      const gap = Math.max(...streamed.slice(1).map((t, i) => t - streamed[i]));
      if (gap > 10_000)
        throw new Error(`the terminal went quiet for ${(gap / 1000).toFixed(1)} s while ticking`);
      proofs.push({ kind: "checkpoint", sandbox: state.sandbox!, from: ptyFrom, to: ptyTo });
      proofs.push({ kind: "checkpoint", sandbox: state.sandbox!, from: runFrom, to: runTo });
      return (
        `the terminal showed all ${TICKS} ticks, longest quiet ${(gap / 1000).toFixed(1)} s; ` +
        `the command returned all ${RUN_TICKS} ticks in order, exit 0, longest guest-clock gap ${guestGap} s; ` +
        `steps the host reported meanwhile: ${[...sightings].join(", ") || "none seen"}`
      );
    } finally {
      await pty.close();
    }
  },
);

check(
  "port",
  "a guest TCP port answers through the fabric's connect stream (not an Opengeni preview URL)",
  ["files"],
  async () => {
    await execOk(
      "cd e2e && (setsid nohup python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/e2e-http.log 2>&1 &) && sleep 2",
    );
    const response = await connectGet(8765, "/hello.txt").catch(async (error) => {
      const inside = await exec(
        "grep -i ':223D ' /proc/net/tcp; curl -sS -m 5 http://127.0.0.1:8765/hello.txt; cat /tmp/e2e-http.log",
      ).catch((failed) => ({ stdout: `(could not look: ${failed})`, stderr: "" }));
      throw new Error(
        `${error}; inside the sandbox: ${(inside.stdout + inside.stderr).slice(0, 600)}`,
      );
    });
    if (!response.includes(state.marker!)) throw new Error(`answer ${response.slice(0, 300)}`);
    return "GET /hello.txt to guest port 8765 through the gateway (connect/57) returned the file";
  },
);

check(
  "browser",
  "the agent's browser opens a page in the sandbox and reads what only that page says",
  ["create"],
  async () => {
    // A page nobody could guess, served inside the sandbox: the title is
    // known only to the page, so a reply with it needs the browser to have
    // loaded it, and the browser tool's own result must show it.
    const page = `page-${rand()}`;
    const title = `e2e title ${rand()}`;
    await og("POST", `${ses()}/fs/write`, {
      path: `e2e/${page}.html`,
      content: `<!doctype html><html><head><title>${title}</title></head><body><p>${page}</p></body></html>`,
      encoding: "utf8",
    });
    await execOk(
      "cd e2e && (setsid nohup python3 -m http.server 8767 --bind 127.0.0.1 >/tmp/e2e-browser-http.log 2>&1 &) && sleep 2",
    );
    const turn = await say(
      `Use your browser to open http://127.0.0.1:8767/${page}.html and reply with the exact title of the page. Do not use the shell or read files for this.`,
    );
    const browsing = turn.calls.filter((call) => /browser/.test(call.name));
    const receipt = browsing.find((call) => call.ok && call.output?.includes(title));
    if (!receipt)
      throw new Error(
        `no browser tool result shows the page's title; tools ${callsText(turn.calls)}`,
      );
    if (!turn.text.includes(title)) throw new Error(`reply "${turn.text.slice(0, 300)}"`);
    return `${receipt.name} loaded the page and the reply names its title; tools ${callsText(turn.calls)}`;
  },
);

check(
  "desktop",
  "the agent opens the sandbox's desktop, and its screen is a real frame",
  ["create"],
  async () => {
    const turn = await say(
      "Open a computer (desktop) session for this sandbox, take a screenshot and describe in one sentence what is on the screen.",
    );
    const listed = await og<any>("GET", `${ws()}/computer-sessions`);
    const sessions = Array.isArray(listed)
      ? listed
      : (listed.computerSessions ?? listed.items ?? listed.sessions ?? []);
    const mine = sessions.filter((one: any) => JSON.stringify(one).includes(state.session!.id));
    if (mine.length === 0)
      throw new Error(
        `no computer session; reply "${turn.text.slice(0, 200)}"; tools ${callsText(turn.calls)}`,
      );
    const active = mine.find((one: any) => one.lifecycle === "active");
    if (!active) {
      const how = mine
        .map((one: any) => `${one.lifecycle}${one.failureCode ? ` (${one.failureCode})` : ""}`)
        .join(", ");
      throw new Error(
        `computer session ${how}; reply "${turn.text.slice(0, 200)}"; tools ${callsText(turn.calls)}`,
      );
    }
    const shot = turn.calls.find(
      (call) => /computer_(observe|screenshot)/.test(call.name) && call.ok,
    );
    if (!shot) throw new Error(`no successful screenshot; tools ${callsText(turn.calls)}`);
    // The screen through the API, decoded: a desktop that never drew fails.
    const targets =
      (await og<any>("GET", `${ws()}/computer-sessions/${active.id}/targets`)).targets ?? [];
    const target = targets.find((one: any) => one.kind === "screen") ?? targets[0];
    if (!target) throw new Error(`computer session ${active.id} has no targets`);
    const frame = await ogBytes(
      `${ws()}/computer-sessions/${active.id}/targets/${encodeURIComponent(target.id)}/screenshot`,
    );
    writeFileSync(
      `${OUT}/desktop-frame.${frame.type.split("/")[1]?.split(";")[0] ?? "bin"}`,
      frame.bytes,
    );
    const { chromium } = await import(env("PLAYWRIGHT_MODULE"));
    const browser = await chromium.launch();
    try {
      const stats = await frameStats(await browser.newPage(), frame.bytes, frame.type);
      const wrong = notAFrame(stats);
      if (wrong) throw new Error(`the ${target.kind} frame is ${wrong}`);
      return `computer session active, ${shot.name} ok; the ${target.kind} frame decodes to ${describeFrame(stats)}`;
    } finally {
      await browser.close();
    }
  },
);

check("ui", "the web UI: file browser, terminal and desktop (Playwright)", ["files"], async () => {
  const run = spawnSync("bun", [`${import.meta.dir}/ui.ts`], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORKSPACE: state.workspace!,
      SESSION: state.session!.id,
      MARKER: state.marker!,
    },
    timeout: 15 * 60_000,
  });
  writeFileSync(`${OUT}/ui.log`, `${run.stdout}\n${run.stderr}`);
  const parsed = JSON.parse(readFileSync(`${OUT}/ui.json`, "utf8")) as Record<string, string>;
  const failed = Object.entries(parsed).filter(([, value]) => !value.startsWith("pass"));
  const summary = Object.entries(parsed)
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ");
  if (run.status !== 0 || failed.length > 0)
    throw new Error(summary || `ui.ts exited ${run.status}`);
  return summary;
});

check("run-as", "commands as another user", ["create"], async () => {
  throw new NotApplicable(
    "the compute backend and the agent support runAs, but Opengeni offers no way to ask for it: sandboxRunAs sets none and no API request carries it",
  );
});

/** Names the step a failure came from. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

// What the running check claims that only the hosts' journals can prove
// (verify.ts checks it once env.sh has copied them).
let proofs: Proof[] = [];

// A process that lives through the sleep: it holds 32 MiB derived from its
// token and answers with its token, pid and whether that memory is intact.
// (A restored guest's clock does not count the time it slept, so the guest
// cannot measure the sleep itself; the hosts' journals do.)
const WITNESS = `import hashlib, http.server, os, sys
token, port = sys.argv[1], int(sys.argv[2])
block = bytearray(hashlib.sha256(token.encode()).digest() * (1 << 20))
digest = hashlib.sha256(block).hexdigest()
class Answer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        intact = "intact" if hashlib.sha256(block).hexdigest() == digest else "changed"
        body = f"{token} {os.getpid()} {intact}\\n".encode()
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), Answer).serve_forever()
`;
const WITNESS_PORTS: Record<string, number> = {
  paused: 8771,
  saved: 8772,
  archived: 8773,
  remote: 8774,
};
/** The witness port of the vm-crash check. */
const VM_CRASH_PORT = 8775;
type Witness = { token: string; pid: string; memory: string };
async function askWitness(port: number, timeoutMs?: number): Promise<Witness> {
  const out = await execOk(
    `python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${port}/', timeout=60).read().decode().strip())"`,
    timeoutMs,
  );
  const [token = "", pid = "", memory = ""] = out.trim().split(" ");
  return { token, pid, memory };
}

for (const level of ["paused", "saved", "archived", "remote"]) {
  check(
    `sleep-${level}`,
    `sleep at ${level} (the host's journal shows it), then the next request wakes it with its files, processes and memory`,
    ["files"],
    async () => {
      const marker = `${level}-${rand()}`;
      const port = WITNESS_PORTS[level]!;
      await step("write before sleeping", async () => {
        await og("POST", `${ses()}/fs/write`, {
          path: `e2e/${level}.txt`,
          content: marker,
          encoding: "utf8",
        });
        await og("POST", `${ses()}/fs/write`, {
          path: "e2e/witness.py",
          content: WITNESS,
          encoding: "utf8",
        });
      });
      const token = `w-${rand()}`;
      const witness = await step("start a process that holds memory", async () => {
        // The pause lets it leave the command's process group before the command ends.
        await execOk(
          `(setsid nohup python3 e2e/witness.py ${token} ${port} >/tmp/witness-${port}.log 2>&1 &) && sleep 2`,
        );
        for (let tries = 0; ; tries += 1) {
          try {
            return await askWitness(port);
          } catch (error) {
            if (tries >= 20) throw error;
            await sleep(500);
          }
        }
      });
      if (witness.token !== token || witness.memory !== "intact")
        throw new Error(`witness answered ${JSON.stringify(witness)}`);
      const before = await sandbox();
      const boot = (await sandboxState()).generation;
      const from = new Date().toISOString();
      let start = Date.now();
      await step("sleep", () => fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level }));
      // A host acknowledges a sleep before it is done; its state says when
      // the level is reached, and the hosts' journals confirm it (verify.ts).
      const reached = await step(`reach ${level}`, () => reachLevel(level, REACH_MS[level]!));
      const to = new Date().toISOString();
      start = Date.now();
      const out = await step("first command after sleeping", () =>
        execOk(`cat e2e/${level}.txt e2e/hello.txt`, 120_000),
      );
      const woke = seconds(start);
      if (!out.includes(marker) || !out.includes(state.marker!))
        throw new Error(`after wake: ${out}`);
      const after = await step("the process after waking", () => askWitness(port, 120_000));
      if (after.token !== token || after.pid !== witness.pid) {
        throw new Error(
          `the process did not live through the sleep: before ${JSON.stringify(witness)}, after ${JSON.stringify(after)}`,
        );
      }
      if (after.memory !== "intact")
        throw new Error(`the process's memory changed across the sleep`);
      const awake = await sandboxState();
      if (boot !== null && awake.generation !== null && awake.generation !== boot) {
        throw new Error(
          `the sandbox rebooted across the sleep (generation ${boot} -> ${awake.generation})`,
        );
      }
      // A saved sleep's wake is a paged restore: this restore's pager, on
      // the host that restored it, must leave learned.json (written at or
      // after the suite's request) and not keep failing in pager.log.
      const pager =
        level === "saved"
          ? await step("the restore's pager", () => pagerAfter(awake.host!, Date.parse(to)))
          : "";
      proofs.push({ kind: "level", sandbox: state.sandbox!, level, from, to, by: "agent_link" });
      const moved = await sandbox();
      return (
        `${reached.state.level} in ${(reached.ms / 1000).toFixed(1)} s (${reached.seen.join(" -> ")}), held 3 s, ` +
        `then woke and answered in ${woke}; process ${after.pid} and its 32 MiB intact, generation ${boot}; ` +
        `host ${before.host} -> ${moved.host}${pager ? `; ${pager}` : ""}`
      );
    },
  );
}

/** Waits up to 60 s for the sandbox's pager on `host` to write learned.json
 * at or after `since` (ms), and fails if pager.log says "Permission
 * denied" more than once. */
async function pagerAfter(host: string, since: number): Promise<string> {
  const dir = vmDir(state.sandbox!);
  const start = Date.now();
  for (;;) {
    const [learned = "", denied = ""] = onHost(
      host,
      `sudo stat -c %Y ${dir}/pager/learned.json 2>/dev/null || echo none; ` +
        `sudo cat ${dir}/pager.log ${dir}/pager/pager.log 2>/dev/null | grep -c 'Permission denied' || true`,
    )
      .trim()
      .split("\n");
    if (Number(denied) > 1)
      throw new Error(`pager.log on ${host} says "Permission denied" ${denied} times`);
    // stat gives whole seconds.
    if (learned !== "none" && Number(learned) >= Math.floor(since / 1000)) {
      return `pager: learned.json on ${host} written ${(Number(learned) - since / 1000).toFixed(0)} s after the request, "Permission denied" ${denied} times`;
    }
    if (Date.now() - start > 60_000) {
      throw new Error(
        learned === "none"
          ? `no learned.json in the sandbox's pager directory on ${host} within 60 s of the wake`
          : `learned.json on ${host} is from before this wake (${new Date(Number(learned) * 1000).toISOString()})`,
      );
    }
    await sleep(3_000);
  }
}

// The agent's link through the guest is a set of resumable streams: they
// carry on across the host's checkpoints and a sleep on the same host. This
// moves 4 MiB files both ways through the files API (and the agent's link)
// for a while, under the run's one-minute checkpoints, then sleeps the
// sandbox to saved and wakes it with a read; every file must come back
// whole, both as the guest sees it and through the API, and the agent must
// not have had to reconnect anywhere in it.
// The transfers run at least LINK_WINDOW_MS, and on until the host's state
// has shown two checkpoints begin and end during them (a checkpoint under
// this load takes 20 to 30 s, so the minute's spacing alone can leave the
// second one finishing just after), at most LINK_WINDOW_MAX_MS.
const LINK_WINDOW_MS = 170_000;
const LINK_WINDOW_MAX_MS = 330_000;
const LINK_FILE_BYTES = 4 << 20;
const LINK_SLOTS = 6;
check(
  "link-stream",
  "4 MiB files both ways through the agent's link across at least two checkpoints and a saved sleep, with no reconnect",
  ["files"],
  async () => {
    const host = (await sandbox()).host!;
    const marked = await step("the guest console before", async () => consoleSince(host).mark);
    const boot = (await sandboxState()).generation;
    // What each file's sha256 must be: in/<n> written through the API, out/<n>
    // made in the guest and read through the API.
    const sums = new Map<string, string>();
    const roundTrip = async (
      path: string,
      expected: string,
      what: string,
      signal?: AbortSignal,
    ) => {
      const read = await og<any>(
        "POST",
        `${ses()}/fs/read`,
        { path, encoding: "base64", maxBytes: 2 * LINK_FILE_BYTES },
        { signal },
      );
      const bytes = Buffer.from(read.content, "base64");
      if (read.truncated || bytes.length !== LINK_FILE_BYTES || sha256(bytes) !== expected) {
        throw new Error(
          `${what}: ${path} read back ${bytes.length} bytes${read.truncated ? " (truncated)" : ""}, sha256 ${sha256(bytes).slice(0, 12)}, not ${expected.slice(0, 12)}`,
        );
      }
    };
    const guestSums = async () => {
      const out = await execOk("cd e2e/link && sha256sum in-* out-*", 120_000);
      const seen = new Map<string, string>(
        out
          .trim()
          .split("\n")
          .map((line) => {
            const [sum = "", name = ""] = line.trim().split(/\s+/);
            return [`e2e/link/${name}`, sum] as const;
          }),
      );
      for (const [path, sum] of sums) {
        if (seen.get(path) !== sum)
          throw new Error(
            `the guest has ${path} with sha256 ${seen.get(path)?.slice(0, 12) ?? "none"}, not ${sum.slice(0, 12)}`,
          );
      }
    };
    await execOk("rm -rf e2e/link && mkdir -p e2e/link");
    // One absolute deadline over every transfer and state request.
    const transfers = new AbortController();
    const windowTimer = setTimeout(
      () => transfers.abort(new Error(`the ${LINK_WINDOW_MAX_MS / 1000} s cap on the transfers`)),
      LINK_WINDOW_MAX_MS,
    );
    const start = Date.now();
    // The proof window is the transfers' own: from the first transfer's
    // start to the last one's end.
    const from = new Date(start).toISOString();
    let lastTransferEnd = start;
    let cycles = 0;
    const durations: number[] = [];
    // Checkpoints the host's state showed begin and end during the
    // transfers: the first look is taken after a transfer, and a checkpoint
    // counts only if it was seen not under way, then under way, then not
    // (one under way at the first look is not counted). At least one more
    // transfer runs after the second is seen to end, so it ended inside.
    let checkpointing: boolean | undefined;
    let checkpointSeenBegin = false;
    let checkpointsSeen = 0;
    let transfersAfterSecond = 0;
    try {
      while (
        lastTransferEnd - start < LINK_WINDOW_MS ||
        checkpointsSeen < 2 ||
        transfersAfterSecond < 1
      ) {
        const slot = cycles % LINK_SLOTS;
        const began = Date.now();
        const signal = transfers.signal;
        await step(`cycle ${cycles + 1}`, async () => {
          // In: random bytes written through the API, read back.
          const data = randomBytes(LINK_FILE_BYTES);
          const inPath = `e2e/link/in-${slot}`;
          sums.set(inPath, sha256(data));
          await og(
            "POST",
            `${ses()}/fs/write`,
            { path: inPath, content: data.toString("base64"), encoding: "base64" },
            { signal },
          );
          await roundTrip(inPath, sums.get(inPath)!, "written then read", signal);
          // Out: random bytes the guest makes, read through the API.
          const outPath = `e2e/link/out-${slot}`;
          const made = await execOk(
            `head -c ${LINK_FILE_BYTES} /dev/urandom > ${outPath} && sha256sum ${outPath}`,
            undefined,
            signal,
          );
          sums.set(outPath, made.trim().split(/\s+/)[0]!);
          await roundTrip(outPath, sums.get(outPath)!, "made in the guest", signal);
        });
        lastTransferEnd = Date.now();
        durations.push(lastTransferEnd - began);
        cycles += 1;
        if (checkpointsSeen >= 2) transfersAfterSecond += 1;
        const busy = (await sandboxState(signal)).step === "checkpoint";
        if (checkpointing !== undefined) {
          if (busy && !checkpointing) checkpointSeenBegin = true;
          if (!busy && checkpointing && checkpointSeenBegin) {
            checkpointsSeen += 1;
            checkpointSeenBegin = false;
          }
        }
        checkpointing = busy;
      }
    } catch (error) {
      if (!transfers.signal.aborted) throw error;
      throw new Error(
        `the host's state showed ${checkpointsSeen} checkpoint(s) begin and end during the transfers` +
          `${checkpointsSeen >= 2 ? " but no transfer after the second" : ""}, not two, within the ${LINK_WINDOW_MAX_MS / 1000} s cap (${cycles} cycles)`,
        { cause: error },
      );
    } finally {
      clearTimeout(windowTimer);
    }
    const to = new Date(lastTransferEnd).toISOString();
    const moved = cycles * LINK_FILE_BYTES;
    await step("the guest's sums after the transfers", guestSums);
    const during = await step("the guest console after the transfers", async () =>
      consoleSince(host, marked),
    );
    // Running checkpoints keep the VMM: a launch means it started over,
    // and the old console's last lines went uncounted.
    if (during.launches !== 0) {
      throw new Error(`the VMM launched again during the transfers: ${describeGrowth(during)}`);
    }
    if (connections(during) !== 0) {
      throw new Error(`the agent reconnected during the transfers: ${describeGrowth(during)}`);
    }
    // Then a saved sleep, woken by a read.
    const sleepFrom = new Date().toISOString();
    await step("sleep", () =>
      fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level: "saved" }),
    );
    const reached = await step("reach saved", () => reachLevel("saved", REACH_MS.saved!));
    // Saved, the VMM is gone and its console complete: read to its end
    // before the wake launches a new one.
    const asleep = await step("the guest console asleep", async () =>
      consoleSince(host, during.mark),
    );
    if (asleep.launches !== 0) {
      throw new Error(`the VMM launched again before it was saved: ${describeGrowth(asleep)}`);
    }
    if (connections(asleep) !== 0) {
      throw new Error(`the agent reconnected going to sleep: ${describeGrowth(asleep)}`);
    }
    const sleepTo = new Date().toISOString();
    const wakeStart = Date.now();
    await step("the read that wakes it", () =>
      roundTrip("e2e/link/in-0", sums.get("e2e/link/in-0")!, "after the saved sleep"),
    );
    const woke = seconds(wakeStart);
    await step("every file through the API after waking", async () => {
      for (const [path, sum] of sums) await roundTrip(path, sum, "after the saved sleep");
    });
    await step("the guest's sums after waking", guestSums);
    const awake = await sandboxState();
    if (boot !== null && awake.generation !== null && awake.generation !== boot) {
      throw new Error(`the sandbox rebooted (generation ${boot} -> ${awake.generation})`);
    }
    if (awake.host !== host)
      throw new Error(
        `the sandbox moved from ${host} to ${awake.host}; the check needs it on one host`,
      );
    const growth = await step("the guest console after", async () =>
      consoleSince(host, asleep.mark),
    );
    // The wake from Saved launches the VMM exactly once (none means the
    // journal missed it, more would hide the first launch's lines).
    if (growth.launches !== 1) {
      throw new Error(
        `the host journal records ${growth.launches} VMM launches for the wake from Saved, not one: ${describeGrowth(growth)}`,
      );
    }
    if (connections(growth) !== 0) {
      throw new Error(`the agent reconnected across the saved sleep: ${describeGrowth(growth)}`);
    }
    proofs.push({ kind: "checkpoint", sandbox: state.sandbox!, from, to, min: 2 });
    proofs.push({
      kind: "level",
      sandbox: state.sandbox!,
      level: "saved",
      from: sleepFrom,
      to: sleepTo,
      by: "agent_link",
    });
    const mib = (n: number) => `${(n / (1 << 20)).toFixed(0)} MiB`;
    return (
      `${cycles} cycles in ${((Date.parse(to) - start) / 1000).toFixed(0)} s (each ${mib(LINK_FILE_BYTES)} in and ${mib(2 * LINK_FILE_BYTES)} out, ` +
      `${(Math.min(...durations) / 1000).toFixed(1)}-${(Math.max(...durations) / 1000).toFixed(1)} s): ${mib(moved)} in, ${mib(2 * moved)} out, every sha256 matching; ` +
      `${checkpointsSeen} checkpoint(s) the host's state showed begin and end meanwhile; ` +
      `saved in ${(reached.ms / 1000).toFixed(1)} s, a read woke it in ${woke}, and all ${sums.size} files matched both ways after; ` +
      `generation ${boot}; on ${host} throughout; console during the transfers ${describeGrowth(during)}, going to sleep ${describeGrowth(asleep)}, after the wake ${describeGrowth(growth)}`
    );
  },
);

// A sandbox whose VMM dies while it runs boots again from its disk on the
// same host (ADR 10's crash table): its programs are lost and every write
// it made is kept, even one after its last running checkpoint (restoring
// that checkpoint would roll the disk back). A command in flight at the
// crash ends with an error within its timeout, and the new boot's agent
// connects exactly once.
check(
  "vm-crash",
  "a VMM killed while it runs boots again from its disk on the same host: every write kept, programs lost, the command in flight ends with an error, one reconnect",
  ["files"],
  async () => {
    const host = (await sandbox()).host!;
    const id = state.sandbox!;
    const marked = await step("the guest console before", async () => consoleSince(host).mark);
    const boot = (await sandboxState()).generation;
    if (boot === null) throw new Error("the host reports no boot generation");
    // A running process, which the crash must take with it.
    const token = `w-${rand()}`;
    await og("POST", `${ses()}/fs/write`, {
      path: "e2e/witness.py",
      content: WITNESS,
      encoding: "utf8",
    });
    await execOk(
      `(setsid nohup python3 e2e/witness.py ${token} ${VM_CRASH_PORT} >/tmp/witness-${VM_CRASH_PORT}.log 2>&1 &) && sleep 2`,
    );
    const witness = await step("the process before", async () => {
      for (let tries = 0; ; tries += 1) {
        try {
          return await askWitness(VM_CRASH_PORT);
        } catch (error) {
          if (tries >= 20) throw error;
          await sleep(500);
        }
      }
    });
    const first = `first-${rand()}`;
    const second = `second-${rand()}`;
    await execOk(`rm -f e2e/crash-*; printf ${first} > e2e/crash-1.txt && sync`);
    const firstAt = new Date().toISOString();
    // A checkpoint that begins after the first write and completes, so the
    // newest checkpoint holds the first write and not the second.
    const checkpointed = await step("a checkpoint after the first write", async () => {
      const limit = Date.now() + 150_000;
      let idle = false;
      let during = false;
      let poked = 0;
      for (;;) {
        if (Date.now() > limit) throw new Error("no checkpoint began and completed within 150 s");
        // A request now and then keeps it from pausing while idle (a
        // checkpoint is taken of a running sandbox); not awaited, so a
        // short checkpoint is not missed while one waits.
        if (Date.now() - poked > 4_000) {
          poked = Date.now();
          exec("true").catch(() => undefined);
        }
        const now = await sandboxState();
        if (now.level !== "running" && !now.step)
          throw new Error(`it went to ${now.level} while waiting for a checkpoint`);
        if (!now.step) {
          if (during) return Date.now();
          idle = true;
        } else if (idle && now.step === "checkpoint") {
          during = true;
        }
        await sleep(200);
      }
    });
    await execOk(`printf ${second} > e2e/crash-2.txt && sync`);
    const secondAt = new Date().toISOString();
    // A command running in the guest when the VMM dies: it says it began,
    // then would run on for 30 s.
    const inflightTimeoutMs = 60_000;
    const inflightAbort = new AbortController();
    const inflightSent = Date.now();
    // Its bound runs from when it is sent: its own timeout and 30 s for the
    // API. Past it the request is cut off, and a later answer fails.
    const inflightBound = inflightSent + inflightTimeoutMs + 30_000;
    let inflightCutAt: number | undefined;
    const inflightTimer = setTimeout(() => {
      inflightCutAt = Date.now();
      inflightAbort.abort();
    }, inflightBound - inflightSent);
    const inflight = exec(
      "touch e2e/crash-inflight; sleep 30; echo finished",
      inflightTimeoutMs,
      inflightAbort.signal,
    ).then(
      (result) => ({ settled: Date.now(), result, error: undefined as unknown }),
      (error: unknown) => ({ settled: Date.now(), result: undefined, error }),
    );
    await step("the command in flight is running", async () => {
      for (let tries = 0; ; tries += 1) {
        const seen = await exec("test -f e2e/crash-inflight && echo yes || echo no");
        if (seen.stdout.trim() === "yes") return;
        if (tries >= 20) throw new Error("the command in flight did not begin within 10 s");
        await sleep(500);
      }
    });
    // Kills the VMM the jail's pid file names, checked to be Firecracker
    // started for this sandbox (`--id <sandbox>`), with its console held
    // open, so what it wrote to its end is counted even if the host
    // launches a new one at once.
    const dir = vmDir(id);
    const killing = await step("kill the sandbox's Firecracker on its host", async () =>
      asRoot(
        host,
        [
          `pid=$(cat ${dir}/root/firecracker.pid); [ -n "$pid" ] || exit 3`,
          `[ "$(cat /proc/$pid/comm)" = firecracker ] || exit 4`,
          `tr '\\0' ' ' < /proc/$pid/cmdline | grep -q -- ' --id ${id} ' || exit 5`,
          launchesScript(marked),
          `i=$(stat -c %i ${dir}/console.log); exec 3< ${dir}/console.log`,
          `kill -9 $pid; for n in $(seq 50); do kill -0 $pid 2>/dev/null || break; sleep 0.1; done`,
          `kill -0 $pid 2>/dev/null && exit 6`,
          `echo $pid; f=/dev/fd/3`,
          countScript(marked),
        ].join("\n"),
      )
        .trim()
        .split("\n"),
    );
    const killedAt = Date.now();
    const killed = killing[0]!;
    // What the dead VMM's console gained since the mark, to its end.
    const dead = growthOf(host, killing.slice(1), marked);
    if (killedAt - checkpointed > 50_000)
      throw new Error(
        `the kill came ${((killedAt - checkpointed) / 1000).toFixed(0)} s after the checkpoint; the next one may have taken the second write`,
      );
    const failures: string[] = [];
    // The next command, within one bound for every attempt. Each attempt
    // asks for a 60 s timeout and is given 15 s more to answer; one that
    // does not is cut off and retried, and counts as a request that hung.
    const deadline = killedAt + 240_000;
    let out = "";
    let attempts = 0;
    const hung: string[] = [];
    await step("the next command", async () => {
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `no answer within 240 s of the kill (${attempts} tries${hung.length ? `; ${hung.join(", ")}` : ""})`,
          );
        }
        attempts += 1;
        const askedMs = Math.min(60_000, left);
        const sent = Date.now();
        const cut = AbortSignal.timeout(Math.min(askedMs + 15_000, left));
        const result = await exec(
          "cat e2e/crash-1.txt; echo; cat e2e/crash-2.txt 2>/dev/null || echo second-missing",
          askedMs,
          cut,
        ).catch((error) => ({ stdout: "", stderr: String(error), exitCode: -1 }));
        if (cut.aborted) {
          hung.push(
            `try ${attempts} had no answer ${((Date.now() - sent) / 1000).toFixed(0)} s after it was sent (timeout ${askedMs / 1000} s)`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `the answer came ${((Date.now() - killedAt) / 1000).toFixed(0)} s after the kill, past the 240 s bound (${attempts} tries${hung.length ? `; ${hung.join(", ")}` : ""})`,
          );
        }
        if (result.exitCode === 0 && !cut.aborted) {
          out = result.stdout.trim();
          return;
        }
        await sleep(Math.min(3_000, Math.max(0, deadline - Date.now())));
      }
    });
    if (hung.length > 0) failures.push(`the next command: ${hung.join(", ")}`);
    const answered = ((Date.now() - killedAt) / 1000).toFixed(1);
    if (out !== `${first}\n${second}`) {
      failures.push(
        `expected both writes kept (the disk is not rolled back to the checkpoint); the sandbox answered ${JSON.stringify(out.slice(0, 200))}`,
      );
    }
    const now = await sandboxState();
    if (now.host !== host) failures.push(`it came back on ${now.host}, not on ${host}`);
    if (now.generation !== boot + 1) {
      failures.push(`generation ${boot} -> ${now.generation}, not one reboot`);
    }
    // The process went with the crash.
    const survivors = (
      await execOk(
        `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '[w]itness.py ${token}' || true`,
      )
    ).trim();
    if (survivors !== "0") failures.push(`process ${witness.pid} (${token}) survived the crash`);
    // The host says so: running programs lost, files kept.
    const since = Math.floor(Date.parse(secondAt) / 1000);
    // Every host line about a sandbox's agent-link streams and connections
    // carries `sandbox=<id>` (the journal colours the field name, so the
    // colour codes go first); only lines naming this sandbox count.
    // Read after the reconnect: the host ends the old streams when the
    // rebooted guest's agent says hello, which can be logged after the
    // first command on the new boot has answered.
    const readJournal = () =>
      onHost(
        host,
        `j=$(sudo journalctl --no-pager -o cat -u 'compute-*' --since @${since}) || { echo "the host journal could not be read" >&2; exit 7; }; ` +
          `j=$(printf '%s\\n' "$j" | sed 's/\\x1b\\[[0-9;]*m//g'); ` +
          `printf '%s\\n' "$j" | grep '"compute.alarm":"programs_lost"' | grep -c '"compute.sandbox.id":"${id}"' || true; ` +
          `for p in 'an agent-link stream cannot go on' 'agent-link streams the guest no longer has ended' ` +
          `'broke the protocol' 'did not say hello' 'too many agent-link connections'; do ` +
          `printf '%s\\n' "$j" | grep "$p" | grep -c 'sandbox=${id}' || true; done`,
      )
        .trim()
        .split("\n")
        .map(Number);
    // The command in flight ends with an error within the bound armed when
    // it was sent, not a hang and not a run on the new boot.
    const settledInflight = await step("the command in flight ends", () => inflight);
    clearTimeout(inflightTimer);
    const inflightSeconds = ((settledInflight.settled - inflightSent) / 1000).toFixed(1);
    const boundSeconds = ((inflightBound - inflightSent) / 1000).toFixed(0);
    let inflightHow: string;
    const cutOff = inflightCutAt !== undefined && settledInflight.settled >= inflightCutAt;
    if (cutOff || settledInflight.settled > inflightBound) {
      failures.push(
        `the command in flight at the crash had no answer ${boundSeconds} s after it was sent (its timeout is ${inflightTimeoutMs / 1000} s): it hangs` +
          (cutOff ? "" : ` (it ended after ${inflightSeconds} s)`),
      );
      inflightHow = `no answer within ${boundSeconds} s`;
    } else if (settledInflight.result) {
      const { exitCode, stdout } = settledInflight.result;
      if (exitCode === 0 || stdout.includes("finished")) {
        failures.push(
          `the command in flight at the crash came back exit ${exitCode} ${JSON.stringify(stdout.trim().slice(0, 100))} after ${inflightSeconds} s, as if it had run to the end`,
        );
      }
      inflightHow = `exit ${exitCode} after ${inflightSeconds} s`;
    } else {
      inflightHow = `${String(settledInflight.error).slice(0, 160)} after ${inflightSeconds} s`;
    }
    // Wait out the agent's reconnect, then count it: the dead VMM's console
    // to its end (read through the descriptor held across the kill), then
    // the new launch's, whole.
    let restored = consoleSince(host, dead.mark);
    for (let tries = 0; dead.connected + restored.connected < 1 && tries < 12; tries += 1) {
      await sleep(5_000);
      restored = consoleSince(host, dead.mark);
    }
    let journal = readJournal();
    for (
      let tries = 0;
      tries < 6 &&
      ((journal[0] ?? 0) < 1 ||
        (dead.lost + restored.lost < 1 && (journal[1] ?? 0) + (journal[2] ?? 0) < 1));
      tries += 1
    ) {
      await sleep(5_000);
      journal = readJournal();
    }
    // Counted once the journal's evidence is in, from the same mark: a
    // reconnect while it was awaited counts too.
    restored = consoleSince(host, dead.mark);
    if (dead.launches !== 0) {
      failures.push(`the VMM launched again before the kill: ${describeGrowth(dead)}`);
    }
    if (restored.launches !== 1) {
      failures.push(
        `the host journal records ${restored.launches} VMM launches after the kill, not the one boot: ${describeGrowth(restored)}`,
      );
    }
    const growth: ConsoleGrowth = {
      connected: dead.connected + restored.connected,
      reconnecting: dead.reconnecting + restored.reconnecting,
      lost: dead.lost + restored.lost,
      how: `up to the kill: ${dead.how}; then ${restored.how}`,
      launches: restored.launches,
      mark: restored.mark,
    };
    if (growth.connected !== 1) {
      failures.push(
        `the agent connected ${growth.connected} times after the crash, not once: ${describeGrowth(growth)}`,
      );
    }
    const [lostAlarm = 0, cannotOwn = 0, endedOwn = 0, broke = 0, nohello = 0, tooMany = 0] =
      journal;
    if (lostAlarm < 1) failures.push(`the host journal has no programs_lost alarm for ${id}`);
    if (broke > 0 || nohello > 0 || tooMany > 0) {
      failures.push(
        `the host journal after the kill, for sandbox=${id}: ${broke} stream(s) broke the protocol, ${nohello} connection(s) did not say hello, ${tooMany} "too many agent-link connections"`,
      );
    }
    // The old streams ended, by evidence of this sandbox: its guest was
    // told the host lost its connections (its own console), or a host
    // journal line about ending streams carries sandbox=<this id>.
    let ending = "";
    if (growth.lost >= 1) {
      ending = `the guest was told the host lost its connections (${growth.lost} time(s))`;
    } else if (cannotOwn + endedOwn >= 1) {
      ending = `the host journal's lines with sandbox=${id} ("cannot go on" ${cannotOwn}, streams ended ${endedOwn})`;
    } else {
      failures.push(
        `no evidence of this sandbox that its old streams ended: its guest was not told they were lost, and no host journal line with sandbox=${id} ended them`,
      );
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    proofs.push({ kind: "checkpoint", sandbox: id, from: firstAt, to: secondAt });
    return (
      `killed Firecracker ${killed} on ${host} ${((killedAt - checkpointed) / 1000).toFixed(1)} s after a running checkpoint; ` +
      `the next command answered ${answered} s after the kill (${attempts} tries) on ${now.host}, generation ${boot} -> ${now.generation}: ` +
      `both writes kept (the one after the checkpoint too: the disk is not rolled back), process ${witness.pid} gone, programs_lost alarm ${lostAlarm}; ` +
      `the command in flight ended with ${inflightHow}; console ${describeGrowth(growth)}; old streams ended: ${ending}; host protocol errors 0`
    );
  },
);

check("move", "a move to another host keeps the sandbox's files", ["files", "hosts"], async () => {
  const before = await sandbox();
  const target = (await hosts()).find((host) => host.state === "live" && host.name !== before.host);
  if (!target) throw new Error("no other live host");
  // A sandbox is handed off only while it sleeps; an operator's drain
  // moves the sleeping ones, so the check puts it to sleep first.
  const start = Date.now();
  await step("sleep", () =>
    fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level: "saved" }),
  );
  await step("reach saved", () => reachLevel("saved", REACH_MS.saved!));
  await step("move", async () => {
    // A sleep the host is still finishing answers busy for a moment.
    for (let tries = 0; ; tries += 1) {
      try {
        return await fabric("POST", `/v1/sandboxes/${state.sandbox}/move`, { to: target.name });
      } catch (error) {
        if (tries >= 30 || !String(error).includes('"busy"')) throw error;
        await Bun.sleep(2_000);
      }
    }
  });
  const out = await step("first command after the move", () =>
    execOk("cat e2e/hello.txt", 120_000),
  );
  const after = await sandbox();
  if (!out.includes(state.marker!)) throw new Error(`after the move: ${out}`);
  if (after.host !== target.name) throw new Error(`on ${after.host}, not ${target.name}`);
  const now = await sandboxState();
  if (now.host !== target.name)
    throw new Error(`the fabric says ${target.name}, but ${now.host ?? "no host"} holds it`);
  return `${before.host} -> ${after.host} in ${seconds(start)}; the first command after it answered; ${describeState(now)}`;
});

/** The connection instance of the sandbox's active enrollment, as
 * Opengeni's database holds it ("" with none): each agent process that
 * connects gets a new one. */
function connectionInstance(): string {
  const group = state.session?.sandboxGroupId ?? state.session?.id;
  if (!group || !/^[0-9a-f-]{36}$/.test(group)) throw new Error(`no sandbox group (${group})`);
  const run = spawnSync(
    "kubectl",
    [
      "-n",
      "opengeni",
      "exec",
      "pod/og-opengeni-postgres-0",
      "-c",
      "postgres",
      "--",
      "psql",
      "-U",
      "opengeni",
      "-d",
      "opengeni",
      "-At",
      "-c",
      `select coalesce(connection_instance_id, '') from enrollments where kind = 'sandbox' and status = 'active' and sandbox_group_id = '${group}'`,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (run.status !== 0) {
    throw new Error(
      `reading the enrollment failed (${run.status ?? run.signal}): ${`${run.error ?? ""} ${run.stderr ?? ""}`.trim().slice(-300)}`,
    );
  }
  const rows = run.stdout.trim().split("\n").filter(Boolean);
  if (rows.length > 1) throw new Error(`${rows.length} active enrollments for ${group}`);
  return rows[0] ?? "";
}

/** How many processes in the guest have `pattern` in their command line
 * (a grep pattern written so it does not match itself, as `[h]l-x`). */
async function processesMatching(pattern: string): Promise<number> {
  const out = await execOk(
    `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '${pattern}' || true`,
  );
  return Number(out.trim());
}

/** A copy of a sandbox a host made, by its journal: a completed
 * checkpoint or archive, begun and ended at (ms). */
type Copy = { step: string; start: number; end: number };
/** The completed copies of `boxId` in a journal's compute events. */
function copiesIn(journal: string, boxId: string): Copy[] {
  const copies: Copy[] = [];
  for (const line of journal.split("\n")) {
    const at = line.indexOf("compute_event: ");
    if (at < 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.slice(at + "compute_event: ".length));
    } catch {
      continue;
    }
    const name = String(event["compute.step"]);
    if (
      event.event !== "compute.step" ||
      event["compute.outcome"] !== "done" ||
      event["compute.sandbox.id"] !== boxId ||
      (name !== "checkpoint" && name !== "archive")
    )
      continue;
    const end = Number(BigInt(String(event.time_unix_nano)) / 1_000_000n);
    copies.push({
      step: name,
      start: end - Number(event["compute.duration_us"] ?? 0) / 1_000,
      end,
    });
  }
  return copies;
}

/** What `host`'s journal since `sinceMs` says of `boxId`: its completed
 * steps in order, how many were boots and restores, and how many times it
 * was adopted from its files (its memory image left out). */
function adoptedSince(
  host: string,
  sinceMs: number,
  boxId: string,
): { steps: string[]; boots: number; restores: number; fromFiles: number } {
  const text = onHost(
    host,
    `j=$(sudo journalctl --no-pager -o cat -u 'compute-*' --since @${Math.floor(sinceMs / 1000)}) || { echo "the host journal could not be read" >&2; exit 7; }; ` +
      `printf '%s\\n' "$j" | sed 's/\\x1b\\[[0-9;]*m//g' | grep -F '${boxId}' || true`,
  );
  const steps: string[] = [];
  let fromFiles = 0;
  for (const line of text.split("\n")) {
    if (line.includes("adopted from its files") && line.includes(`id=${boxId}`)) fromFiles += 1;
    const at = line.indexOf("compute_event: ");
    if (at < 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line.slice(at + "compute_event: ".length));
    } catch {
      continue;
    }
    if (
      event.event === "compute.step" &&
      event["compute.outcome"] === "done" &&
      event["compute.sandbox.id"] === boxId
    )
      steps.push(String(event["compute.step"]));
  }
  return {
    steps,
    boots: steps.filter((name) => name === "boot").length,
    restores: steps.filter((name) => name === "restore").length,
    fromFiles,
  };
}

check(
  "host-loss",
  "a lost host's sandbox boots elsewhere from its last copy's files: those files kept, later writes and programs lost, a new agent connection, the command in flight ends with an error and is not run again",
  ["files", "hosts"],
  async () => {
    const id = state.sandbox!;
    const kept = `kept-${rand()}`;
    await og("POST", `${ses()}/fs/write`, {
      path: "e2e/kept.txt",
      content: kept,
      encoding: "utf8",
    });
    await fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level: "remote" });
    // The copy the sandbox comes back from is the one this sleep archives.
    await step("reach remote", () => reachLevel("remote", REACH_MS.remote!));
    await execOk("cat e2e/kept.txt", 120_000);
    const before = await sandbox();
    const lost = before.host!;
    // What the loss must change: the guest's boot, the host's boot
    // generation, and the agent's connection instance.
    const boot = (await sandboxState()).generation;
    if (boot === null) throw new Error("the host reports no boot generation");
    const bootId = (await execOk("cat /proc/sys/kernel/random/boot_id")).trim();
    const linkBefore = connectionInstance();
    if (!linkBefore) {
      throw new Error("the sandbox's enrollment has no agent connection instance before the stop");
    }
    // A running program, which a boot from files must not bring back.
    const token = rand();
    await execOk(
      `(setsid nohup python3 -c 'import time; time.sleep(100000)' hlw-${token} >/dev/null 2>&1 &) && sleep 1`,
    );
    if ((await processesMatching(`[h]lw-${token}`)) !== 1) {
      throw new Error(`the program hlw-${token} is not running before the stop`);
    }
    // A write a checkpoint then copies: written without a sync, so only the
    // host's request to the guest to write its disks out before the
    // capture puts it in the copy. The checkpoint holds the program's
    // memory too, which a boot from files must leave out.
    const copied = `copied-${rand()}`;
    await og("POST", `${ses()}/fs/write`, {
      path: "e2e/copied.txt",
      content: copied,
      encoding: "utf8",
    });
    const copiedAt = new Date().toISOString();
    // The last time the suite saw no step under way before the checkpoint
    // began: the next checkpoint is due a full minute of running after it.
    let checkpointAfter = 0;
    await step("a checkpoint after the copied write", async () => {
      const limit = Date.now() + 150_000;
      let idleAt = 0;
      let during = false;
      let poked = 0;
      for (;;) {
        if (Date.now() > limit) throw new Error("no checkpoint began and completed within 150 s");
        if (Date.now() - poked > 4_000) {
          poked = Date.now();
          exec("true").catch(() => undefined);
        }
        const seenAt = Date.now();
        const now = await sandboxState();
        if (now.level !== "running" && !now.step)
          throw new Error(`it went to ${now.level} while waiting for a checkpoint`);
        if (!now.step) {
          if (during) return;
          idleAt = seenAt;
        } else if (idleAt && now.step === "checkpoint" && !during) {
          during = true;
          checkpointAfter = idleAt;
        }
        await sleep(200);
      }
    });
    // A write after that checkpoint, which no copy holds if the host is
    // gone before the next one is due.
    const late = `late-${rand()}`;
    const lateFrom = Date.now();
    await og("POST", `${ses()}/fs/write`, {
      path: "e2e/late.txt",
      content: late,
      encoding: "utf8",
    });
    const lateDone = Date.now();
    // The journals show that checkpoint, begun after the copied write and
    // done before the late one, with the guest's disks written out first.
    proofs.push({
      kind: "checkpoint",
      sandbox: id,
      from: copiedAt,
      to: new Date(lateFrom).toISOString(),
    });
    const lostEpoch = (await hosts()).find((host) => host.name === lost)?.epoch;
    if (typeof lostEpoch !== "number") {
      throw new Error(`the fleet lists no host epoch for ${lost} before the stop`);
    }
    // The instance group heals a stopped host by recreating it under the
    // same name, so a name alone does not say which machine it is: the
    // instance id does.
    const instanceId = (name: string) => {
      const found = gcloud([
        "compute",
        "instances",
        "describe",
        name,
        "--zone",
        ZONE,
        "--project",
        PROJECT,
        "--format",
        "value(id)",
      ]);
      if (!/^[0-9]+$/.test(found)) {
        throw new Error(`${name}'s instance id reads ${JSON.stringify(found)}, not an id`);
      }
      return found;
    };
    const lostInstance = instanceId(lost);
    // Its journal goes with it when the instance group replaces it: keep
    // it, from the run's start, for the verifier (as host-<name>@<instance>),
    // read on the machine looked up: its metadata server names the
    // instance, and the journal is of its current boot, both in the header.
    let lostBoot = "";
    let keptJournal = "";
    try {
      const since = Math.floor(Date.parse(STARTED) / 1000) - 60;
      const journalText = onHost(
        lost,
        `iid=$(curl -fsS -m 10 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/id) || { echo "the metadata server gave no instance id" >&2; exit 8; }; ` +
          `[ "$iid" = "${lostInstance}" ] || { echo "this machine is instance $iid, not ${lostInstance}" >&2; exit 9; }; ` +
          `boot=$(cat /proc/sys/kernel/random/boot_id) || exit 10; ` +
          `echo "# instance=$iid boot=$boot"; ` +
          `sudo journalctl --no-pager -o short-iso-precise -b "$(printf %s "$boot" | tr -d -)" --since @${since} -u 'compute-*'`,
        300_000,
      );
      const header = /^# instance=([0-9]+) boot=([0-9a-f-]{36})\n/.exec(journalText);
      if (!header || header[1] !== lostInstance) {
        throw new Error(
          `the kept journal's header is ${JSON.stringify(journalText.split("\n")[0])}`,
        );
      }
      lostBoot = header[2]!;
      keptJournal = journalText;
      writeFileSync(`${OUT}/host-${lost}@${lostInstance}.log`, journalText);
    } catch (error) {
      throw new Error(`could not keep ${lost}'s journal before stopping it: ${error}`, {
        cause: error,
      });
    }
    proofs.push({ kind: "journal", host: lost, instance: lostInstance, boot: lostBoot });
    // The copies of this sandbox the lost host made after the late write
    // began (checkpoints and archives, by its kept journal): one begun after
    // the write returned holds it, one under way across it may or may not.
    const copies = copiesIn(keptJournal, id);
    const copiedAfter = copies.filter((copy) => copy.start > lateDone);
    const copiedAcross = copies.filter((copy) => copy.start <= lateDone && copy.end > lateFrom);
    // A command running in the guest when its host goes: it notes the
    // guest's boot, then would run on. Sent after the journal was kept, so
    // the stop follows at once and the loss, not its 120 s timeout, ends it.
    const inflightFile = `e2e/hl-inflight-${token}.txt`;
    const inflightAbort = new AbortController();
    const inflightSent = Date.now();
    const inflight = exec(
      `cat /proc/sys/kernel/random/boot_id >> ${inflightFile}; sleep 600; echo finished`,
      120_000,
      inflightAbort.signal,
    ).then(
      (result) => ({ settled: Date.now(), result, error: undefined as unknown }),
      (error: unknown) => ({ settled: Date.now(), result: undefined, error }),
    );
    await step("the command in flight is running", async () => {
      for (let tries = 0; ; tries += 1) {
        const seen = await exec(`test -s ${inflightFile} && echo yes || echo no`);
        if (
          seen.stdout.trim() === "yes" &&
          (await processesMatching(`[h]l-inflight-${token}`)) >= 1
        )
          return;
        if (tries >= 20) throw new Error("the command in flight did not begin within 10 s");
        await sleep(500);
      }
    });
    // Stopped, the machine is plainly gone: its lease lapses, the service
    // fences it (finds it stopped) and the sandbox wakes elsewhere.
    log(`stopping ${lost} (instance ${lostInstance})`);
    const start = Date.now();
    // Stopped by name, so the operation says which machine it stopped: the
    // one whose journal was kept, or the check fails.
    const started = JSON.parse(
      gcloud([
        "compute",
        "instances",
        "stop",
        lost,
        "--zone",
        ZONE,
        "--project",
        PROJECT,
        "--async",
        "--format",
        "json",
      ]),
    ) as { name?: string; targetId?: string } | { name?: string; targetId?: string }[];
    const operation = Array.isArray(started) ? started[0] : started;
    if (!operation?.name) throw new Error(`stop: no operation in ${JSON.stringify(started)}`);
    let stopped: { status?: string; targetId?: string; error?: unknown } = {};
    for (;;) {
      stopped = JSON.parse(
        gcloud([
          "compute",
          "operations",
          "describe",
          operation.name,
          "--zone",
          ZONE,
          "--project",
          PROJECT,
          "--format",
          "json",
        ]),
      ) as typeof stopped;
      if (stopped.status === "DONE") break;
      if (Date.now() - start > 300_000) throw new Error(`stop ${operation.name} not done in 300 s`);
      await sleep(2_000);
    }
    if (stopped.error) throw new Error(`stop ${operation.name}: ${JSON.stringify(stopped.error)}`);
    if (String(stopped.targetId ?? operation.targetId ?? "") !== lostInstance) {
      throw new Error(
        `the stop of ${lost} stopped instance ${stopped.targetId ?? "unknown"}, not ${lostInstance} whose journal was kept`,
      );
    }
    const stoppedAt = Date.now();
    hostAddresses.delete(lost);
    let out = "";
    for (;;) {
      if (Date.now() - start > 20 * 60_000) throw new Error("no recovery within 20 minutes");
      const result = await exec(
        "cat e2e/kept.txt; echo; cat e2e/copied.txt 2>/dev/null || echo copied-missing; echo; cat e2e/late.txt 2>/dev/null || echo late-missing",
        120_000,
      ).catch((error) => ({ stdout: "", stderr: String(error), exitCode: -1 }));
      if (result.exitCode === 0 && result.stdout.includes(kept)) {
        out = result.stdout;
        break;
      }
      // The sandbox answers, but from a copy older than the requested remote
      // sleep: that sleep never reached the archive, and waiting longer cannot
      // bring the file back.
      if (result.exitCode !== -1 && /No such file/.test(`${result.stdout}\n${result.stderr}`)) {
        const now = await sandbox();
        throw new Error(
          `back on ${now.host ?? "no host"} (owner epoch ${before.owner_epoch} -> ${now.owner_epoch}) in ${seconds(start)}, ` +
            `but from a copy older than the sleep to remote: e2e/kept.txt is missing`,
        );
      }
      await sleep(10_000);
    }
    const recoveredAt = Date.now();
    const failures: string[] = [];
    const after = await sandbox();
    const fleet = await hosts();
    const owner = fleet.find((host) => host.name === after.host);
    const old = fleet.find((host) => host.name === lost);
    // A different live owner, under a later owner epoch, and the lost host
    // fenced: given up on, or back only under a new host epoch. A new
    // machine under the lost one's name counts as different only by a new
    // instance id and a new host epoch.
    let ownerInstance = "";
    if (after.host === lost) {
      try {
        ownerInstance = instanceId(lost);
      } catch (error) {
        throw new Error(
          `answered on ${lost} again, and its instance id could not be read: ${error}`,
          { cause: error },
        );
      }
    }
    // Under the same name: a distinct instance id, and a host epoch known
    // and strictly higher than the lost machine's.
    const sameMachine =
      after.host === lost &&
      !(
        ownerInstance !== "" &&
        ownerInstance !== lostInstance &&
        typeof owner?.epoch === "number" &&
        owner.epoch > lostEpoch
      );
    if (!after.host || sameMachine || owner?.state !== "live") {
      throw new Error(
        `answered, but owned by ${after.host ?? "no host"} (${owner?.state ?? "unknown"}` +
          (after.host === lost
            ? `, instance ${lostInstance} -> ${ownerInstance}, host epoch ${lostEpoch} -> ${owner?.epoch}`
            : "") +
          `), not a different live host`,
      );
    }
    if (!(after.owner_epoch > before.owner_epoch)) {
      throw new Error(
        `owner epoch did not advance (${before.owner_epoch} -> ${after.owner_epoch})`,
      );
    }
    if (old && old.state === "live" && old.epoch === lostEpoch) {
      throw new Error(
        `${lost} is still live under its old epoch ${lostEpoch}, so it was never fenced`,
      );
    }
    const fenced =
      after.host === lost
        ? `replaced by the instance group: instance ${lostInstance} -> ${ownerInstance}, host epoch ${lostEpoch} -> ${owner?.epoch}`
        : old
          ? `${old.state} (host epoch ${lostEpoch} -> ${old.epoch})`
          : "gone from the fleet";
    const now = await sandboxState();
    if (now.host !== after.host)
      throw new Error(`the fabric says ${after.host}, but ${now.host ?? "no host"} holds it`);
    const newHost = after.host;
    // The command in flight ends with an error once its sandbox is back:
    // its connection was replaced, so the request is answered as lost, not
    // run on the new boot. It has 120 s from the recovery.
    const inflightBound = recoveredAt + 120_000;
    let settledInflight = await Promise.race([
      inflight,
      sleep(Math.max(0, inflightBound - Date.now())).then(() => undefined),
    ]);
    let inflightHow: string;
    if (!settledInflight) {
      inflightAbort.abort();
      settledInflight = await inflight;
      failures.push(
        `the command in flight at the loss had no answer 120 s after the sandbox was back (${((Date.now() - inflightSent) / 1000).toFixed(0)} s after it was sent): it hangs`,
      );
      inflightHow = "no answer";
    } else {
      const took = ((settledInflight.settled - inflightSent) / 1000).toFixed(1);
      if (settledInflight.settled < stoppedAt) {
        failures.push(
          `the command in flight ended ${took} s after it was sent, before its host was stopped, so the loss did not end it`,
        );
      }
      if (settledInflight.result) {
        const { exitCode, stdout, stderr } = settledInflight.result;
        if (exitCode === 0 || stdout.includes("finished")) {
          failures.push(
            `the command in flight at the loss came back exit ${exitCode} ${JSON.stringify(stdout.trim().slice(0, 100))} after ${took} s, as if it had run to the end`,
          );
        }
        inflightHow = `exit ${exitCode} ${JSON.stringify(`${stdout}${stderr}`.trim().slice(0, 160))} after ${took} s`;
      } else {
        const error = settledInflight.error;
        if (error instanceof Error && error.name === "TimeoutError") {
          failures.push(
            `the command in flight at the loss was cut off by the suite's 600 s request limit after ${took} s: it hangs`,
          );
        }
        inflightHow = `${String(error).slice(0, 200)} after ${took} s`;
      }
      if (settledInflight.settled > inflightBound) {
        failures.push(`the command in flight ended ${took} s after it was sent, past its bound`);
      }
    }
    // A new boot of the guest, under a later boot generation.
    const bootIdAfter = (await execOk("cat /proc/sys/kernel/random/boot_id")).trim();
    if (bootIdAfter === bootId) {
      failures.push(`the guest's boot id is ${bootId} before and after: it was not booted`);
    }
    if (!(typeof now.generation === "number" && now.generation > boot)) {
      failures.push(`generation ${boot} -> ${now.generation}, not a boot`);
    }
    // Programs end with the lost host; the command in flight is not run
    // again on the new boot (it would note that boot in its file).
    const witnessLeft = await processesMatching(`[h]lw-${token}`);
    if (witnessLeft !== 0) failures.push(`the program hlw-${token} runs again after the loss`);
    const inflightLeft = await processesMatching(`[h]l-inflight-${token}`);
    if (inflightLeft !== 0) failures.push(`the command in flight runs again after the loss`);
    const noted = (await execOk(`cat ${inflightFile} 2>/dev/null || true`))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (noted.includes(bootIdAfter)) {
      failures.push(
        `the command in flight ran again on the new boot (its file: ${noted.join(", ")})`,
      );
    }
    // Files as the last copy left them: the checkpointed write kept, and
    // the late write lost when the host was gone before the next
    // checkpoint was due (a minute of running after the last), or kept
    // when the kept journal shows a copy begun after it.
    if (!out.includes(copied)) {
      failures.push(
        "the write the last checkpoint copied is lost: that checkpoint's disk did not hold it (the guest did not write it out before the capture)",
      );
    }
    const lateKept = out.includes(late);
    const copyWords = (list: Copy[]) =>
      list
        .map((copy) => `${copy.step} ${new Date(copy.end).toISOString().slice(11, 22)}`)
        .join(", ");
    const stopAfterCheckpoint = ((stoppedAt - checkpointAfter) / 1000).toFixed(1);
    const noLaterCopy = copiedAfter.length === 0 && stoppedAt < checkpointAfter + 60_000;
    let lateHow: string;
    if (noLaterCopy) {
      if (lateKept) {
        failures.push(
          `the late write came back, though the host was stopped ${stopAfterCheckpoint} s after the last checkpoint began, before the next was due, and its kept journal has no copy after it: the sandbox was not booted from its last copy's files`,
        );
      }
      lateHow = `lost (stopped ${stopAfterCheckpoint} s after the last checkpoint began, before the next was due)`;
    } else if (copiedAfter.length > 0) {
      if (!lateKept) {
        failures.push(
          `the late write is lost, though the lost host copied the sandbox after it (${copyWords(copiedAfter)})`,
        );
      }
      lateHow = `kept, as a copy after it holds it (${copyWords(copiedAfter)})`;
    } else {
      // Stopped too late to rule out a copy after the journal was kept.
      lateHow = `${lateKept ? "kept" : "lost"}, either allowed: stopped ${stopAfterCheckpoint} s after the last checkpoint began${copiedAcross.length ? `; a copy under way across it: ${copyWords(copiedAcross)}` : ""}`;
    }
    // A new agent connection: the enrollment's connection instance changes.
    let linkAfter = connectionInstance();
    for (let tries = 0; (!linkAfter || linkAfter === linkBefore) && tries < 12; tries += 1) {
      await sleep(5_000);
      linkAfter = connectionInstance();
    }
    if (!linkAfter || linkAfter === linkBefore) {
      failures.push(
        `the agent's connection instance is ${linkBefore} before the loss and ${linkAfter || "none"} after: no new connection`,
      );
    }
    // The adopting host booted it from files, once, and its agent
    // connected once: its journal since the stop and the console of that
    // launch, whole.
    const fromStop: ConsoleMark = {
      host: newHost,
      inode: "none",
      bytes: 0,
      at: (start / 1000).toFixed(3),
    };
    let booted = consoleSince(newHost, fromStop);
    for (let tries = 0; booted.connected < 1 && tries < 12; tries += 1) {
      await sleep(5_000);
      booted = consoleSince(newHost, fromStop);
    }
    if (booted.launches !== 1) {
      failures.push(
        `the host journal of ${newHost} records ${booted.launches} VMM launches since the stop, not one boot: ${describeGrowth(booted)}`,
      );
    }
    if (booted.connected !== 1) {
      failures.push(
        `the agent connected ${booted.connected} times on ${newHost}, not once: ${describeGrowth(booted)}`,
      );
    }
    const adopting = adoptedSince(newHost, start, id);
    if (adopting.boots !== 1 || adopting.restores !== 0) {
      failures.push(
        `${newHost}'s journal since the stop has ${adopting.boots} boot(s) and ${adopting.restores} restore(s) of the sandbox, not one boot and no restore (steps: ${adopting.steps.join(", ") || "none"})`,
      );
    }
    if (adopting.fromFiles < 1) {
      failures.push(`${newHost}'s journal has no "adopted from its files" line for id=${id}`);
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    return (
      `${lost} stopped; back on ${after.host} (owner epoch ${before.owner_epoch} -> ${after.owner_epoch}) in ${seconds(start)}; ` +
      `booted from files (generation ${boot} -> ${now.generation}, guest boot id changed, steps ${adopting.steps.join(", ")}, "adopted from its files" ${adopting.fromFiles}); ` +
      `the archived file kept, the checkpointed write kept, the late write ${lateHow}; program and command in flight gone, not run again; ` +
      `the command in flight ended with ${inflightHow}; connection instance ${linkBefore} -> ${linkAfter}; console ${describeGrowth(booted)}; ${lost} is ${fenced}`
    );
  },
);

/** Deletes the session, retrying while the API answers 409 because its
 * sandbox is still being shut down (as the web app does). */
async function deleteSession(limitMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await og("DELETE", ses());
      state.session = undefined;
      return;
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 409) || Date.now() - start > limitMs)
        throw error;
    }
    await sleep(5_000);
  }
}

check("delete", "deleting the session deletes its sandbox on the fabric", ["create"], async () => {
  const start = Date.now();
  const id = state.sandbox!;
  await deleteSession(10 * 60_000);
  log(`session deleted after ${seconds(start)}`);
  for (;;) {
    try {
      await fabric("GET", `/v1/sandboxes/${id}`);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
        return `sandbox ${id} gone ${seconds(start)} after the delete`;
      }
      throw error;
    }
    if (Date.now() - start > 15 * 60_000)
      throw new Error(`sandbox ${id} is still on the fabric 15 min after the delete`);
    await sleep(5_000);
  }
});

/** Ends the Connected Machine's agent and waits until it has exited:
 * SIGTERM, then SIGKILL after 15 s; an agent still running is a cleanup
 * failure. */
async function stopAgent(agent: ReturnType<typeof spawn>): Promise<void> {
  const exited = (ms: number) =>
    agent.exitCode !== null || agent.signalCode !== null
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          agent.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
  agent.kill("SIGTERM");
  if (await exited(15_000)) return;
  agent.kill("SIGKILL");
  if (!(await exited(10_000)))
    cleanupErrors.push(
      `connected-machine: its agent (pid ${agent.pid}) did not exit after SIGKILL`,
    );
}

/** The machine states in which a Connected Machine is reachable. */
const ONLINE_MACHINE = new Set(["online", "display_unavailable"]);

check(
  "connected-machine",
  "the same agent build, enrolled as a Connected Machine, runs a session's turn and commands, and stays online and its agent unrestarted through 90 s idle",
  ["workspace"],
  async () => {
    if (!AGENT_BIN) throw new Error("AGENT_BIN is not set");
    // The suite's helpers follow state.session; this check borrows them for
    // its own session and gives the compute session back afterwards.
    const saved = { session: state.session, eventCursor };
    const config = mkdtempSync(`${tmpdir()}/e2e-machine-`);
    const agentEnv = {
      ...process.env,
      OPENGENI_CONFIG_DIR: config,
      OPENGENI_API_URL: OPENGENI_URL,
    };
    let agent: ReturnType<typeof spawn> | undefined;
    let enrollment: string | undefined;
    // What this check made, by id: its cleanup never goes through the
    // borrowed shared state.
    let own: string | undefined;
    try {
      const minted = await step("mint an enroll token", () =>
        og<any>("POST", `${ws()}/enrollments/token`, {}),
      );
      const before = new Set(
        ((await og<any>("GET", `${ws()}/enrollments`)).enrollments ?? []).map((one: any) => one.id),
      );
      const connect = spawnSync(
        AGENT_BIN,
        ["connect", "--token", minted.token, "--non-interactive"],
        {
          env: agentEnv,
          cwd: config,
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      if (connect.status !== 0)
        throw new Error(
          `connect exited ${connect.status}: ${(connect.stderr || connect.stdout).slice(0, 600)}`,
        );
      const logFile = openSync(`${OUT}/connected-machine-agent.log`, "a");
      agent = spawn(AGENT_BIN, ["run"], {
        env: agentEnv,
        cwd: config,
        stdio: ["ignore", logFile, logFile],
      });
      let machine: any;
      const start = Date.now();
      for (;;) {
        const listed = (await og<any>("GET", `${ws()}/enrollments`)).enrollments ?? [];
        enrollment ??= listed.find((one: any) => !before.has(one.id))?.id;
        if (enrollment) {
          const machines = (await og<any>("GET", `${ws()}/machines`)).machines ?? [];
          machine = machines.find((one: any) => one.enrollmentId === enrollment);
          // A machine without a display (this VM) is listed as
          // display_unavailable: online, with no desktop stream.
          if (machine && ONLINE_MACHINE.has(machine.state)) break;
        }
        if (Date.now() - start > 120_000) {
          throw new Error(
            `no online machine 120 s after connecting (enrollment ${enrollment ?? "none"}, state ${machine?.state ?? "unlisted"})`,
          );
        }
        await sleep(3_000);
      }
      if (machine.kind !== "selfhosted") throw new Error(`listed as ${machine.kind}`);
      const online = seconds(start);

      // A session started on the machine, as the "Run on" picker does: its
      // first turn runs there.
      const id = readFileSync("/etc/machine-id", "utf8").trim();
      const created = await step("start a session on the machine", () =>
        og<any>("POST", `${ws()}/sessions`, {
          initialMessage: "Run `cat /etc/machine-id` in the shell and reply with only its output.",
          model: MODEL,
          reasoningEffort: "low",
          targetSandboxId: machine.sandboxId,
        }),
      );
      own = created.id;
      state.session = { id: created.id };
      eventCursor = 0;
      const turn = await step("its first turn", () => nextTurn());
      if (!turn.text.includes(id))
        throw new Error(`the turn answered ${JSON.stringify(turn.text.slice(0, 200))}`);
      const name = hostname();
      const out = await step("a command", () => execOk("hostname"));
      if (out.trim() !== name) throw new Error(`hostname ${out.trim()}, not this VM's ${name}`);
      // A compute sandbox would sleep after this long idle; a machine stays
      // online (asked every 5 s) and the same agent process serves it.
      const idleFrom = Date.now();
      const states = new Set<string>();
      while (Date.now() - idleFrom < 90_000) {
        await sleep(5_000);
        const now = ((await og<any>("GET", `${ws()}/machines`)).machines ?? []).find(
          (one: any) => one.enrollmentId === enrollment,
        );
        states.add(String(now?.state ?? "unlisted"));
        if (!ONLINE_MACHINE.has(now?.state))
          throw new Error(
            `state ${now?.state ?? "unlisted"} ${seconds(idleFrom)} into the idle wait`,
          );
        if (agent!.exitCode !== null)
          throw new Error(`the agent exited (${agent!.exitCode}) during the idle wait`);
      }
      const idleStart = Date.now();
      await step("a command after 90 s idle", () => execOk("true"));
      const idle = Date.now() - idleStart;
      if (idle > 10_000)
        throw new Error(`the command after the idle wait took ${(idle / 1000).toFixed(1)} s`);
      await deleteSession(5 * 60_000).catch((error) =>
        cleanupErrors.push(`connected-machine: deleting its session: ${error}`),
      );
      own = undefined;
      return (
        `online ${online} after connecting; exec and a turn ran on ${name}; ${[...states].join("/")} at every 5 s look ` +
        `through 90 s idle with the same agent process (pid ${agent!.pid}), then exec in ${(idle / 1000).toFixed(1)} s`
      );
    } finally {
      // The compute session goes back first, whatever happens below.
      state.session = saved.session;
      eventCursor = saved.eventCursor;
      const ownSession = own;
      await Promise.all([
        ownSession
          ? og("DELETE", `${ws()}/sessions/${ownSession}`, undefined, { cleanup: true }).catch(
              (error) =>
                cleanupErrors.push(
                  `connected-machine: deleting its session ${ownSession}: ${error}`,
                ),
            )
          : undefined,
        agent ? stopAgent(agent) : undefined,
        enrollment
          ? og("POST", `${ws()}/enrollments/${enrollment}/revoke`, {}, { cleanup: true }).catch(
              (error) =>
                cleanupErrors.push(
                  `connected-machine: revoking enrollment ${enrollment}: ${error}`,
                ),
            )
          : undefined,
      ]);
    }
  },
);

// --- Run ------------------------------------------------------------------

function wanted(): Set<string> {
  if (ONLY.length === 0) return new Set(checks.map((c) => c.id));
  const set = new Set<string>();
  const add = (id: string) => {
    if (set.has(id)) return;
    set.add(id);
    for (const need of checks.find((c) => c.id === id)?.needs ?? []) add(need);
  };
  ONLY.forEach(add);
  return set;
}

const unknown = ONLY.filter((id) => !checks.some((c) => c.id === id));
if (unknown.length > 0) {
  console.error(
    `ONLY names unknown checks: ${unknown.join(", ")}; the checks are ${checks.map((c) => c.id).join(", ")}`,
  );
  process.exit(2);
}

const results: Result[] = [];
const selected = wanted();
for (const one of checks.filter((c) => selected.has(c.id))) {
  const unmet = one.needs.filter((need) => results.find((r) => r.id === need)?.status !== "pass");
  if (unmet.length > 0) {
    results.push({
      id: one.id,
      title: one.title,
      status: "skip",
      detail: `needs ${unmet.join(", ")}`,
      seconds: 0,
    });
    continue;
  }
  log(`check ${one.id}`);
  const start = Date.now();
  let status: Status = "pass";
  let detail: string;
  checkAbort = new AbortController();
  proofs = [];
  const running = one.run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    detail = await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const late = new Error(`no result within ${CHECK_TIMEOUT_MS / 60_000} min`);
          checkAbort.abort(late);
          reject(late);
        }, CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    status = error instanceof NotApplicable ? "n/a" : "fail";
    detail = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  if (checkAbort.signal.aborted) {
    // An aborted check's requests and waits end at once; its cleanup
    // (requests of at most 120 s each) runs on. The next check starts, and
    // the run ends, only once that cleanup is done; one that never ends is a
    // cleanup failure, not a pass.
    const unwound = await Promise.race([
      running.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CLEANUP_LIMIT_MS)),
    ]);
    if (!unwound)
      cleanupErrors.push(
        `${one.id}: its cleanup did not finish within ${CLEANUP_LIMIT_MS / 60_000} min of the timeout`,
      );
  }
  const result: Result = {
    id: one.id,
    title: one.title,
    status,
    detail,
    seconds: (Date.now() - start) / 1000,
  };
  if (status === "pass" && proofs.length > 0) result.proofs = proofs;
  results.push(result);
  log(`${status} ${one.id}: ${detail}`);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results }, null, 2));
}
checkAbort = new AbortController();

// A run that stopped before the delete check still deletes its session, so
// reruns do not leave sandboxes on the fleet; KEEP=1 keeps it (and its
// sandbox) to look at, and env.sh host-logs then copies the guest's console.
const KEEP = process.env.KEEP === "1";
if (KEEP && state.session) {
  log(
    `keeping session ${state.session.id} and sandbox ${state.sandbox ?? "none"} (KEEP=1); delete it when done`,
  );
} else if (state.workspace && state.session) {
  await deleteSession(5 * 60_000).catch((error) =>
    cleanupErrors.push(`deleting the suite's session: ${error}`),
  );
}
results.push({
  id: "cleanup",
  title: "what the run made is removed (sessions deleted, enrollments revoked)",
  status: cleanupErrors.length > 0 ? "fail" : KEEP && state.session ? "n/a" : "pass",
  detail:
    cleanupErrors.length > 0
      ? cleanupErrors.join("; ")
      : KEEP && state.session
        ? `session ${state.session.id} kept (KEEP=1)`
        : "nothing left behind",
  seconds: 0,
});

const meta = {
  opengeni: process.env.OPENGENI_SHA ?? "",
  compute: process.env.COMPUTE_SHA ?? "",
  model: MODEL,
  started: STARTED,
  finished: new Date().toISOString(),
};
writeFileSync(`${OUT}/results.json`, JSON.stringify({ ...meta, results }, null, 2));
writeFileSync(`${OUT}/results.md`, render(meta, results, false));
writeFileSync(`${OUT}/suite.log`, `${logLines.join("\n")}\n`);
process.exit(counts(results, "fail") + counts(results, "skip") > 0 ? 1 : 0);
