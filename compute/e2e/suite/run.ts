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
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { describeFrame, frameStats, notAFrame } from "./frame.ts";
import { counts, render, type LevelProof, type Result, type Status } from "./report.ts";

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
async function og<T = any>(method: string, path: string, body?: unknown, { cleanup = false } = {}): Promise<T> {
  const response = await fetch(`${OPENGENI_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-opengeni-api-contract": API_CONTRACT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Longer than any request's own timeout (a 120 s command), so a request
    // that never answers fails its check instead of stopping the run.
    signal: cleanup ? AbortSignal.timeout(120_000) : AbortSignal.any([AbortSignal.timeout(600_000), checkAbort.signal]),
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
  return { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") ?? "" };
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
  const text = typeof output === "string" ? output : typeof output?.text === "string" ? output.text : null;
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
const invoked = (payload: any) => String(payload?.name ?? payload?.raw?.name ?? "?") === "tool_invoke";
/** A deferred tool reached through tool_invoke is named by its target. */
function toolName(payload: any): string {
  const args = parsedArgs(payload);
  return invoked(payload) && typeof args?.name === "string" ? args.name : String(payload?.name ?? payload?.raw?.name ?? "?");
}
function toolArgs(payload: any): any {
  const args = parsedArgs(payload);
  return invoked(payload) && args?.arguments ? args.arguments : args;
}

const callsText = (calls: ToolCall[]) =>
  calls.map((call) => `${call.name}${call.ok === undefined ? "" : call.ok ? " ok" : " failed"}`).join(", ") || "none";

let seen = 0;
/** Waits for the session's next turn to end; returns the agent's reply and
 * its tool calls with their results. */
async function nextTurn(timeoutS = TURN_TIMEOUT_S): Promise<Turn> {
  const deadline = Date.now() + timeoutS * 1000;
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  for (;;) {
    for (const event of await eventsAfter(seen)) {
      seen = Math.max(seen, event.sequence);
      if (event.type === "agent.message.completed") texts.push(String(event.payload?.text ?? ""));
      if (event.type === "agent.toolCall.created") {
        calls.push({ id: String(event.payload?.id ?? ""), name: toolName(event.payload), args: toolArgs(event.payload) });
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
async function exec(command: string, timeoutMs = 60_000): Promise<Exec> {
  return og<Exec>("POST", `${ses()}/terminal/exec`, { command, timeoutMs, emitStream: false });
}
async function execOk(command: string, timeoutMs?: number): Promise<string> {
  const result = await exec(command, timeoutMs);
  if (result.exitCode !== 0) {
    // A traceback's last lines say what went wrong.
    throw new Error(`\`${command}\` exited ${result.exitCode}: ${result.stderr.trim().slice(-400)}`);
  }
  return result.stdout;
}

// --- The fabric's API (at its cluster address, verified as its service name) --

function fabric<T = any>(method: string, path: string, body?: unknown, key = OPENGENI_KEY): Promise<T> {
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
    request.setTimeout(900_000, () => request.destroy(new Error(`fabric ${method} ${path} timed out`)));
    onCheckAbort((reason) => request.destroy(reason instanceof Error ? reason : new Error(String(reason))));
    if (payload) request.write(payload);
    request.end();
  });
}

type Host = { name: string; state: string; epoch: number; sandboxes: number; awake: number };
type Sandbox = { id: string; host: string | null; owner_epoch: number; metadata: Record<string, string> };
const hosts = () => fabric<Host[]>("GET", "/v1/hosts", undefined, OPERATOR_KEY);
const sandbox = () => fabric<Sandbox>("GET", `/v1/sandboxes/${state.sandbox}`);

/**
 * One HTTP GET to a TCP port inside the sandbox, over the fabric's connect
 * stream. connect/<n> reaches guest vsock port n; a guest TCP port is reached
 * through the guest's gateway (vsock 57), whose first line names it.
 */
const GATEWAY_PORT = 57;
function connectGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: COMPUTE_ADDRESS, port: COMPUTE_PORT, servername: COMPUTE_SERVICE, ca: COMPUTE_CA });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => socket.destroy(new Error("connect timed out")), 120_000);
    onCheckAbort((reason) => socket.destroy(reason instanceof Error ? reason : new Error(String(reason))));
    socket.on("secureConnect", () => {
      socket.write(
        `GET /v1/sandboxes/${state.sandbox}/connect/${GATEWAY_PORT} HTTP/1.1\r\nHost: ${COMPUTE_SERVICE}\r\n` +
          `X-API-Key: ${OPENGENI_KEY}\r\nConnection: Upgrade\r\nUpgrade: compute-stream\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
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
  if (live.length < HOSTS) throw new Error(`${live.length} live: ${live.map((h) => h.name).join(", ")}`);
  return live.map((host) => host.name).join(", ");
});

check("workspace", "a workspace to work in", ["health"], async () => {
  const listed = await og<any>("GET", "/v1/workspaces");
  const workspaces = Array.isArray(listed) ? listed : (listed.workspaces ?? listed.items ?? []);
  if (workspaces.length === 0) throw new Error("no workspace");
  state.workspace = workspaces[0].id;
  return state.workspace!;
});

check("create", "a session on the compute backend runs its first turn", ["workspace", "hosts"], async () => {
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
  const box = boxes.find((one) => one.metadata?.opengeni_sandbox_group_id === session.sandboxGroupId);
  if (!box) throw new Error(`no fabric sandbox for sandbox group ${session.sandboxGroupId}`);
  state.sandbox = box.id;
  return `first turn in ${seconds(start)}; sandbox ${box.id} on ${box.host}; reply "${turn.text.trim().slice(0, 80)}"`;
});

check("commands", "commands run in the sandbox and report their output and exit status", ["create"], async () => {
  const out = await execOk("echo e2e-ok; id -un; uname -m");
  if (!out.includes("e2e-ok")) throw new Error(`stdout ${out}`);
  const token = rand();
  const failed = await exec(`echo out-${token}; echo err-${token} >&2; exit 7`);
  if (failed.exitCode !== 7 || !failed.stdout.includes(`out-${token}`) || !failed.stderr.includes(`err-${token}`)) {
    throw new Error(`a failing command answered ${JSON.stringify(failed).slice(0, 300)}`);
  }
  return `${out.trim().replaceAll("\n", " | ")}; a failing command kept its stdout, stderr and exit status 7`;
});

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
    const started = turn.calls.find((call) => /exec_command$/.test(call.name) && call.output?.includes(`${done}-start`));
    const startedId = started?.output?.match(UUID)?.[0];
    if (!startedId) {
      throw new Error(`no background start of the finishing command with a command id; tools ${callsText(turn.calls)}`);
    }
    const reads = turn.calls.filter(
      (call) => /command_(wait|read)$/.test(call.name) && JSON.stringify(call.args ?? "").includes(startedId),
    );
    const finished = reads.find(
      (call) => call.ok && call.output?.includes(`${done}-end`) && /exit[_ ]?code\\?"?\s*[:=]?\s*3\b|exited with (code )?3\b/i.test(call.output),
    );
    if (!finished) {
      throw new Error(
        `reading command ${startedId} by its id gave no output with ${done}-end and exit status 3: ` +
          (reads.map((call) => `${call.name} ${call.ok ? "ok" : "failed"} ${call.output?.slice(0, 200)}`).join(" / ") || "no read by id"),
      );
    }
    // The running one: listed, then stopped through the API, and its process gone.
    const active = async () => ((await og<any>("GET", `${ses()}/background-commands`)).commands ?? []) as any[];
    const mine = (await active()).filter((one) => JSON.stringify(one).includes(marker));
    if (mine.length === 0) {
      throw new Error(`not listed while running; reply "${turn.text.slice(0, 200)}"; tools ${callsText(turn.calls)}`);
    }
    const command = mine[0];
    const id = command.commandId ?? command.id;
    // pgrep's pattern does not match itself in the command line that runs it.
    const pattern = `[${marker[0]}]${marker.slice(1)}`;
    if (!(await exec(`pgrep -f '${pattern}'`)).stdout.trim()) throw new Error(`command ${id} is listed but no process runs it`);
    await og("DELETE", `${ses()}/background-commands/${id}`);
    const stopped = Date.now();
    for (;;) {
      const listed = (await active()).some((one) => (one.commandId ?? one.id) === id);
      const running = (await exec(`pgrep -f '${pattern}'; pgrep -fx 'sleep 900'`)).stdout.trim();
      if (!listed && !running) break;
      if (Date.now() - stopped > 60_000) {
        throw new Error(
          `60 s after the stop, command ${id} is ${listed ? "still listed" : "unlisted"} and ` +
            (running ? `its processes still run (${running.replaceAll("\n", " ")})` : "its process is gone"),
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
  await og("POST", `${ses()}/fs/write`, { path: "e2e/hello.txt", content: state.marker, encoding: "utf8" });
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
  if (!JSON.stringify(history).includes("first")) throw new Error(`log ${JSON.stringify(history).slice(0, 300)}`);
  return `head ${status.head}, untracked b.txt, one commit`;
});

check("terminal", "a command typed into the interactive terminal runs in the sandbox", ["create"], async () => {
  // The web app's way in: attach a terminal viewer, which mints the terminal
  // plane, then speak that plane. On a compute sandbox the agent serves it as a
  // relay PTY (packages/react/src/hooks/use-terminal-stream.ts); the relay
  // messages come from the same checkout's hand-mirrored wire module.
  const wire = await import(`${OPENGENI_DIR}/packages/react/src/lib/relay-wire.ts`);
  const marker = `pty-${rand()}`;
  const viewer = await og<any>("POST", `${ses()}/viewers`, { terminal: true });
  try {
    if (viewer.terminalTransport !== "relay-pty" || !viewer.terminalUrl) {
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
    // What the socket saw, for a failure's message.
    const seenOnSocket: string[] = [];
    const outcome = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `no echo within 60 s; socket ${seenOnSocket.join(", ") || "never opened"}; output ${JSON.stringify(output.slice(-300))}`,
            ),
          ),
        60_000,
      );
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("the relay socket failed"));
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        reject(new Error(`the relay socket closed (${event.code} ${event.reason})`));
      };
      socket.onopen = () => {
        seenOnSocket.push("open");
        socket.send(
          datagram(1, wire.encodeStreamOpen({ channel, token: viewer.terminalToken ?? "", role: wire.STREAM_ROLE_CLIENT, resumeFromSeq: "0" })),
        );
      };
      let inputSeq = 0n;
      let typed = false;
      // Type the command the way a person would, keystrokes ending in Enter,
      // once the shell has printed something (its prompt) or after 3 s.
      const type = () => {
        if (typed) return;
        typed = true;
        seenOnSocket.push("typed");
        socket.send(
          datagram(
            3,
            wire.encodeStreamFrame({
              channelId: channel.channelId,
              seq: (inputSeq++).toString(),
              data: new TextEncoder().encode(`echo ${marker}-$((1+1)) | tee e2e/${marker}.txt && echo ${marker}-done\r`),
              producedAtMs: String(Date.now()),
            }),
          ),
        );
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          seenOnSocket.push(`text ${event.data.slice(0, 80)}`);
          return;
        }
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.length < 1) return;
        const body = bytes.subarray(1);
        if (bytes[0] === 2) {
          const ack = wire.decodeStreamOpenAck(body);
          seenOnSocket.push(`ack ${ack.accepted ? "accepted" : "refused"}`);
          if (!ack.accepted) {
            clearTimeout(timer);
            reject(new Error(`the relay refused the terminal: ${ack.error?.message ?? "no reason"}`));
            return;
          }
          setTimeout(type, 3_000);
        } else if (bytes[0] === 3) {
          if (!output) seenOnSocket.push("output");
          setTimeout(type, 300);
          output += decoder.decode(wire.decodeStreamFrame(body).data, { stream: true });
          if (output.includes(`${marker}-2`) && output.includes(`${marker}-done`)) {
            clearTimeout(timer);
            resolve(`relay PTY echoed the typed command (${output.length} bytes of output)`);
          }
        } else {
          seenOnSocket.push(`tag ${bytes[0]}`);
        }
      };
    });
    socket.onclose = null;
    socket.close();
    // What proves the command ran, not just that its input was echoed: the
    // file it wrote, holding the shell's own arithmetic.
    const file = await og<any>("POST", `${ses()}/fs/read`, { path: `e2e/${marker}.txt`, encoding: "utf8" });
    if (String(file?.content ?? "").trim() !== `${marker}-2`) {
      throw new Error(`the typed command's file holds ${JSON.stringify(String(file?.content ?? "").slice(0, 80))}`);
    }
    return `${outcome}; its file e2e/${marker}.txt holds ${marker}-2`;
  } catch (error) {
    // Whether the typed command ran tells input from output apart.
    const ran = await og<any>("POST", `${ses()}/fs/read`, { path: `e2e/${marker}.txt`, encoding: "utf8" })
      .then((file) => JSON.stringify(file ?? "").includes(`${marker}-2`))
      .catch(() => false);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; the typed command ${ran ? "ran (its file exists)" : "did not run"}`);
  } finally {
    await og("DELETE", `${ses()}/viewers/${viewer.viewerId}`, undefined, { cleanup: true }).catch((error) =>
      cleanupErrors.push(`terminal: closing its viewer: ${error}`),
    );
  }
});

check("port", "a guest TCP port answers through the fabric's connect stream (not an Opengeni preview URL)", ["files"], async () => {
  await execOk(
    "cd e2e && (setsid nohup python3 -m http.server 8765 --bind 127.0.0.1 >/tmp/e2e-http.log 2>&1 &) && sleep 2",
  );
  const response = await connectGet(8765, "/hello.txt").catch(async (error) => {
    const inside = await exec("grep -i ':223D ' /proc/net/tcp; curl -sS -m 5 http://127.0.0.1:8765/hello.txt; cat /tmp/e2e-http.log").catch(
      (failed) => ({ stdout: `(could not look: ${failed})`, stderr: "" }),
    );
    throw new Error(`${error}; inside the sandbox: ${(inside.stdout + inside.stderr).slice(0, 600)}`);
  });
  if (!response.includes(state.marker!)) throw new Error(`answer ${response.slice(0, 300)}`);
  return "GET /hello.txt to guest port 8765 through the gateway (connect/57) returned the file";
});

check("browser", "the agent's browser opens a page in the sandbox and reads what only that page says", ["create"], async () => {
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
  await execOk("cd e2e && (setsid nohup python3 -m http.server 8767 --bind 127.0.0.1 >/tmp/e2e-browser-http.log 2>&1 &) && sleep 2");
  const turn = await say(
    `Use your browser to open http://127.0.0.1:8767/${page}.html and reply with the exact title of the page. Do not use the shell or read files for this.`,
  );
  const browsing = turn.calls.filter((call) => /browser/.test(call.name));
  const receipt = browsing.find((call) => call.ok && call.output?.includes(title));
  if (!receipt) throw new Error(`no browser tool result shows the page's title; tools ${callsText(turn.calls)}`);
  if (!turn.text.includes(title)) throw new Error(`reply "${turn.text.slice(0, 300)}"`);
  return `${receipt.name} loaded the page and the reply names its title; tools ${callsText(turn.calls)}`;
});

check("desktop", "the agent opens the sandbox's desktop, and its screen is a real frame", ["create"], async () => {
  const turn = await say(
    "Open a computer (desktop) session for this sandbox, take a screenshot and describe in one sentence what is on the screen.",
  );
  const listed = await og<any>("GET", `${ws()}/computer-sessions`);
  const sessions = Array.isArray(listed) ? listed : (listed.computerSessions ?? listed.items ?? listed.sessions ?? []);
  const mine = sessions.filter((one: any) => JSON.stringify(one).includes(state.session!.id));
  if (mine.length === 0) throw new Error(`no computer session; reply "${turn.text.slice(0, 200)}"; tools ${callsText(turn.calls)}`);
  const active = mine.find((one: any) => one.lifecycle === "active");
  if (!active) {
    const how = mine.map((one: any) => `${one.lifecycle}${one.failureCode ? ` (${one.failureCode})` : ""}`).join(", ");
    throw new Error(`computer session ${how}; reply "${turn.text.slice(0, 200)}"; tools ${callsText(turn.calls)}`);
  }
  const shot = turn.calls.find((call) => /computer_(observe|screenshot)/.test(call.name) && call.ok);
  if (!shot) throw new Error(`no successful screenshot; tools ${callsText(turn.calls)}`);
  // The screen through the API, decoded: a desktop that never drew fails.
  const targets = (await og<any>("GET", `${ws()}/computer-sessions/${active.id}/targets`)).targets ?? [];
  const target = targets.find((one: any) => one.kind === "screen") ?? targets[0];
  if (!target) throw new Error(`computer session ${active.id} has no targets`);
  const frame = await ogBytes(`${ws()}/computer-sessions/${active.id}/targets/${encodeURIComponent(target.id)}/screenshot`);
  writeFileSync(`${OUT}/desktop-frame.${frame.type.split("/")[1]?.split(";")[0] ?? "bin"}`, frame.bytes);
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
});

check("ui", "the web UI: file browser, terminal and desktop (Playwright)", ["files"], async () => {
  const run = spawnSync("bun", [`${import.meta.dir}/ui.ts`], {
    encoding: "utf8",
    env: { ...process.env, WORKSPACE: state.workspace!, SESSION: state.session!.id, MARKER: state.marker! },
    timeout: 15 * 60_000,
  });
  writeFileSync(`${OUT}/ui.log`, `${run.stdout}\n${run.stderr}`);
  const parsed = JSON.parse(readFileSync(`${OUT}/ui.json`, "utf8")) as Record<string, string>;
  const failed = Object.entries(parsed).filter(([, value]) => !value.startsWith("pass"));
  const summary = Object.entries(parsed).map(([name, value]) => `${name}: ${value}`).join("; ");
  if (run.status !== 0 || failed.length > 0) throw new Error(summary || `ui.ts exited ${run.status}`);
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
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// What the running check claims that only the hosts' journals can prove
// (verify.ts checks it once env.sh has copied them).
let proofs: LevelProof[] = [];

// How long each level takes to reach after the request, so the next command
// finds the sandbox asleep at that level rather than racing the sleep (a save
// writes the memory locally, an archive also uploads it). The fabric's API
// does not report a sandbox's level, and a host acknowledges a sleep before
// it is done: the hosts' journals show whether the level was reached
// (verify.ts).
const SETTLE_MS: Record<string, number> = { paused: 2_000, saved: 15_000, archived: 45_000, remote: 60_000 };

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
const WITNESS_PORTS: Record<string, number> = { paused: 8771, saved: 8772, archived: 8773, remote: 8774 };
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
        await og("POST", `${ses()}/fs/write`, { path: `e2e/${level}.txt`, content: marker, encoding: "utf8" });
        await og("POST", `${ses()}/fs/write`, { path: "e2e/witness.py", content: WITNESS, encoding: "utf8" });
      });
      const token = `w-${rand()}`;
      const witness = await step("start a process that holds memory", async () => {
        // The pause lets it leave the command's process group before the command ends.
        await execOk(`(setsid nohup python3 e2e/witness.py ${token} ${port} >/tmp/witness-${port}.log 2>&1 &) && sleep 2`);
        for (let tries = 0; ; tries += 1) {
          try {
            return await askWitness(port);
          } catch (error) {
            if (tries >= 20) throw error;
            await sleep(500);
          }
        }
      });
      if (witness.token !== token || witness.memory !== "intact") throw new Error(`witness answered ${JSON.stringify(witness)}`);
      const before = await sandbox();
      const from = new Date().toISOString();
      let start = Date.now();
      await step("sleep", () => fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level }));
      const slept = seconds(start);
      await sleep(SETTLE_MS[level]!);
      const to = new Date().toISOString();
      start = Date.now();
      const out = await step("first command after sleeping", () => execOk(`cat e2e/${level}.txt e2e/hello.txt`, 120_000));
      const woke = seconds(start);
      if (!out.includes(marker) || !out.includes(state.marker!)) throw new Error(`after wake: ${out}`);
      const after = await step("the process after waking", () => askWitness(port, 120_000));
      if (after.token !== token || after.pid !== witness.pid) {
        throw new Error(`the process did not live through the sleep: before ${JSON.stringify(witness)}, after ${JSON.stringify(after)}`);
      }
      if (after.memory !== "intact") throw new Error(`the process's memory changed across the sleep`);
      proofs.push({ kind: "level", sandbox: state.sandbox!, level, from, to });
      const moved = await sandbox();
      return (
        `asked to sleep in ${slept}, left ${SETTLE_MS[level]! / 1000} s, then woke and answered in ${woke}; ` +
        `process ${after.pid} and its 32 MiB intact; host ${before.host} -> ${moved.host}`
      );
    },
  );
}

check("move", "a move to another host keeps the sandbox's files", ["files", "hosts"], async () => {
  const before = await sandbox();
  const target = (await hosts()).find((host) => host.state === "live" && host.name !== before.host);
  if (!target) throw new Error("no other live host");
  // A sandbox is handed off only while it sleeps; an operator's drain
  // moves the sleeping ones, so the check puts it to sleep first.
  const start = Date.now();
  await step("sleep", () => fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level: "saved" }));
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
  const out = await step("first command after the move", () => execOk("cat e2e/hello.txt", 120_000));
  const after = await sandbox();
  if (!out.includes(state.marker!)) throw new Error(`after the move: ${out}`);
  if (after.host !== target.name) throw new Error(`on ${after.host}, not ${target.name}`);
  return `${before.host} -> ${after.host} in ${seconds(start)}`;
});

check("host-loss", "a lost host's sandbox comes back elsewhere from its last archived copy", ["files", "hosts"], async () => {
  const kept = `kept-${rand()}`;
  await og("POST", `${ses()}/fs/write`, { path: "e2e/kept.txt", content: kept, encoding: "utf8" });
  await fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level: "remote" });
  await execOk("cat e2e/kept.txt", 120_000);
  const late = `late-${rand()}`;
  await og("POST", `${ses()}/fs/write`, { path: "e2e/late.txt", content: late, encoding: "utf8" });
  const before = await sandbox();
  const lost = before.host!;
  const lostEpoch = (await hosts()).find((host) => host.name === lost)?.epoch;
  // Stopped, the machine is plainly gone: its lease lapses, the service
  // fences it (finds it stopped) and the sandbox wakes elsewhere.
  log(`stopping ${lost}`);
  const start = Date.now();
  const stop = spawnSync("gcloud", ["compute", "instances", "stop", lost, "--zone", ZONE, "--project", PROJECT, "--quiet"], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (stop.status !== 0) throw new Error(`stop: ${stop.error ?? ""} ${stop.stderr}`);
  let out = "";
  for (;;) {
    if (Date.now() - start > 20 * 60_000) throw new Error("no recovery within 20 minutes");
    const result = await exec("cat e2e/kept.txt; cat e2e/late.txt 2>/dev/null || echo late-missing", 120_000).catch(
      (error) => ({ stdout: "", stderr: String(error), exitCode: -1 }),
    );
    if (result.exitCode === 0 && result.stdout.includes(kept)) {
      out = result.stdout;
      break;
    }
    await sleep(10_000);
  }
  const after = await sandbox();
  const fleet = await hosts();
  const owner = fleet.find((host) => host.name === after.host);
  const old = fleet.find((host) => host.name === lost);
  // A different live owner, under a later owner epoch, and the lost host
  // fenced: given up on, or back only under a new host epoch.
  if (!after.host || after.host === lost || owner?.state !== "live") {
    throw new Error(`answered, but owned by ${after.host ?? "no host"} (${owner?.state ?? "unknown"}), not a different live host`);
  }
  if (!(after.owner_epoch > before.owner_epoch)) {
    throw new Error(`owner epoch did not advance (${before.owner_epoch} -> ${after.owner_epoch})`);
  }
  if (old && old.state === "live" && old.epoch === lostEpoch) {
    throw new Error(`${lost} is still live under its old epoch ${lostEpoch}, so it was never fenced`);
  }
  const fenced = old ? `${old.state} (host epoch ${lostEpoch} -> ${old.epoch})` : "gone from the fleet";
  return `${lost} stopped; back on ${after.host} (owner epoch ${before.owner_epoch} -> ${after.owner_epoch}) in ${seconds(start)}; ` +
    `the archived copy's file kept, the late write ${out.includes(late) ? "kept too" : "lost (after the last save)"}; ${lost} is ${fenced}`;
});

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
      if (!(error instanceof HttpError && error.status === 409) || Date.now() - start > limitMs) throw error;
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
    if (Date.now() - start > 15 * 60_000) throw new Error(`sandbox ${id} is still on the fabric 15 min after the delete`);
    await sleep(5_000);
  }
});

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
    const saved = { session: state.session, seen };
    const config = mkdtempSync(`${tmpdir()}/e2e-machine-`);
    const agentEnv = { ...process.env, OPENGENI_CONFIG_DIR: config, OPENGENI_API_URL: OPENGENI_URL };
    let agent: ReturnType<typeof spawn> | undefined;
    let enrollment: string | undefined;
    try {
      const minted = await step("mint an enroll token", () => og<any>("POST", `${ws()}/enrollments/token`, {}));
      const before = new Set(
        ((await og<any>("GET", `${ws()}/enrollments`)).enrollments ?? []).map((one: any) => one.id),
      );
      const connect = spawnSync(AGENT_BIN, ["connect", "--token", minted.token, "--non-interactive"], {
        env: agentEnv,
        cwd: config,
        encoding: "utf8",
        timeout: 120_000,
      });
      if (connect.status !== 0) throw new Error(`connect exited ${connect.status}: ${(connect.stderr || connect.stdout).slice(0, 600)}`);
      const logFile = openSync(`${OUT}/connected-machine-agent.log`, "a");
      agent = spawn(AGENT_BIN, ["run"], { env: agentEnv, cwd: config, stdio: ["ignore", logFile, logFile] });
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
          throw new Error(`no online machine 120 s after connecting (enrollment ${enrollment ?? "none"}, state ${machine?.state ?? "unlisted"})`);
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
      state.session = { id: created.id };
      seen = 0;
      const turn = await step("its first turn", () => nextTurn());
      if (!turn.text.includes(id)) throw new Error(`the turn answered ${JSON.stringify(turn.text.slice(0, 200))}`);
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
        if (!ONLINE_MACHINE.has(now?.state)) throw new Error(`state ${now?.state ?? "unlisted"} ${seconds(idleFrom)} into the idle wait`);
        if (agent!.exitCode !== null) throw new Error(`the agent exited (${agent!.exitCode}) during the idle wait`);
      }
      const idleStart = Date.now();
      await step("a command after 90 s idle", () => execOk("true"));
      const idle = Date.now() - idleStart;
      if (idle > 10_000) throw new Error(`the command after the idle wait took ${(idle / 1000).toFixed(1)} s`);
      await deleteSession(5 * 60_000).catch((error) => cleanupErrors.push(`connected-machine: deleting its session: ${error}`));
      return (
        `online ${online} after connecting; exec and a turn ran on ${name}; ${[...states].join("/")} at every 5 s look ` +
        `through 90 s idle with the same agent process (pid ${agent!.pid}), then exec in ${(idle / 1000).toFixed(1)} s`
      );
    } finally {
      if (state.session && state.session.id !== saved.session?.id) {
        await og("DELETE", ses(), undefined, { cleanup: true }).catch((error) =>
          cleanupErrors.push(`connected-machine: deleting its session: ${error}`),
        );
      }
      state.session = saved.session;
      seen = saved.seen;
      agent?.kill("SIGTERM");
      if (enrollment) {
        await og("POST", `${ws()}/enrollments/${enrollment}/revoke`, {}, { cleanup: true }).catch((error) =>
          cleanupErrors.push(`connected-machine: revoking enrollment ${enrollment}: ${error}`),
        );
      }
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
  console.error(`ONLY names unknown checks: ${unknown.join(", ")}; the checks are ${checks.map((c) => c.id).join(", ")}`);
  process.exit(2);
}

const results: Result[] = [];
const selected = wanted();
for (const one of checks.filter((c) => selected.has(c.id))) {
  const unmet = one.needs.filter((need) => results.find((r) => r.id === need)?.status !== "pass");
  if (unmet.length > 0) {
    results.push({ id: one.id, title: one.title, status: "skip", detail: `needs ${unmet.join(", ")}`, seconds: 0 });
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
    // An aborted check's requests and waits end at once; let it unwind
    // (its own cleanup included) before the next check starts.
    await Promise.race([running.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 60_000))]);
  }
  const result: Result = { id: one.id, title: one.title, status, detail, seconds: (Date.now() - start) / 1000 };
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
  log(`keeping session ${state.session.id} and sandbox ${state.sandbox ?? "none"} (KEEP=1); delete it when done`);
} else if (state.workspace && state.session) {
  await deleteSession(5 * 60_000).catch((error) => cleanupErrors.push(`deleting the suite's session: ${error}`));
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
