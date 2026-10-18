// The end-to-end suite: real agent sessions through Opengeni's public API on
// the compute backend, with the fabric's own API to sleep, wake, move and
// lose what those sessions run on. It runs on the stack VM (stack/suite.sh)
// and writes results.json and results.md into $OUT.
//
// Each check names the checks it needs; one whose needs did not pass is
// skipped, so a run always reports every check. ONLY=a,b runs a subset (and
// what it needs). A check passes, fails, is skipped, or is n/a when the
// product has no surface for it (the reason is in its detail).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";

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

mkdirSync(OUT, { recursive: true });
const logLines: string[] = [];
function log(message: string): void {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  logLines.push(line);
  console.log(line);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function og<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${OPENGENI_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-opengeni-api-contract": API_CONTRACT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Longer than any request's own timeout (a 120 s command), so a request
    // that never answers fails its check instead of stopping the run.
    signal: AbortSignal.timeout(600_000),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, text, `${method} ${path}`);
  return (text ? JSON.parse(text) : undefined) as T;
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

let seen = 0;
/** Waits for the session's next turn to end; returns the agent's reply. */
async function nextTurn(timeoutS = TURN_TIMEOUT_S): Promise<{ text: string; tools: string[] }> {
  const deadline = Date.now() + timeoutS * 1000;
  const texts: string[] = [];
  const tools: string[] = [];
  for (;;) {
    for (const event of await eventsAfter(seen)) {
      seen = Math.max(seen, event.sequence);
      if (event.type === "agent.message.completed") texts.push(String(event.payload?.text ?? ""));
      if (event.type === "agent.toolCall.created") {
        tools.push(String(event.payload?.raw?.name ?? event.payload?.name ?? "?"));
      }
      if (event.type === "turn.completed") return { text: texts.join("\n"), tools };
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
    throw new Error(`\`${command}\` exited ${result.exitCode}: ${result.stderr.slice(0, 400)}`);
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

type Status = "pass" | "fail" | "skip" | "n/a";
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

check("commands", "commands run in the sandbox", ["create"], async () => {
  const out = await execOk("echo e2e-ok; id -un; uname -m");
  if (!out.includes("e2e-ok")) throw new Error(`stdout ${out}`);
  return out.trim().replaceAll("\n", " | ");
});

check("background", "a background command runs, is listed while it runs, and stops when asked", ["create"], async () => {
  const marker = `bg-${rand()}`;
  const turn = await say(
    "Start this command with your exec_command tool with yield_time_ms 1000, so that it keeps running in the " +
      `background, and do not wait for it or stop it; reply with its command ID only: \`sh -c 'echo ${marker}; sleep 900'\``,
  );
  const active = async () => {
    const listed = await og<any>("GET", `${ses()}/background-commands`);
    return (listed.commands ?? []) as any[];
  };
  const mine = (await active()).filter((one) => JSON.stringify(one).includes(marker));
  if (mine.length === 0) {
    throw new Error(`not listed while running; reply "${turn.text.slice(0, 200)}"; tools ${turn.tools.join(", ")}`);
  }
  const command = mine[0];
  const id = command.commandId ?? command.id;
  await og("DELETE", `${ses()}/background-commands/${id}`);
  const deadline = Date.now() + 60_000;
  while ((await active()).some((one) => (one.commandId ?? one.id) === id)) {
    if (Date.now() > deadline) throw new Error(`command ${id} still listed 60 s after it was stopped`);
    await sleep(2_000);
  }
  return `command ${id} listed as ${command.state ?? command.status} and gone after the stop`;
});

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

check("terminal", "an interactive terminal echoes what is typed", ["create"], async () => {
  const marker = `pty-${rand()}`;
  const controller = new AbortController();
  const stream = await fetch(`${OPENGENI_URL}${ses()}/events/stream?after=${seen}`, {
    headers: { accept: "text/event-stream", "x-opengeni-api-contract": API_CONTRACT },
    signal: controller.signal,
  });
  if (!stream.ok || !stream.body) throw new Error(`events stream HTTP ${stream.status}`);
  const opened = await og<any>("POST", `${ses()}/terminal/pty`, { cols: 100, rows: 30 });
  const found = (async () => {
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      text += decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:") || !line.includes("terminal.pty.output")) continue;
        let data = line;
        try {
          const event = JSON.parse(line.slice(5));
          const raw = event.payload?.data ?? event.payload?.chunk ?? "";
          data += Buffer.from(String(raw), "base64").toString("utf8");
        } catch {}
        if (data.includes(`${marker}-done`)) return true;
      }
      text = text.slice(text.lastIndexOf("\n") + 1);
    }
  })();
  await sleep(1500);
  await og("POST", `${ses()}/terminal/pty/write`, { ptyId: opened.ptyId, data: `echo ${marker}-$((1+1)) && echo ${marker}-done\r` });
  const timeout = sleep(60_000).then(() => false);
  const ok = await Promise.race([found, timeout]);
  controller.abort();
  await og("POST", `${ses()}/terminal/pty/close`, { ptyId: opened.ptyId }).catch(() => undefined);
  if (!ok) throw new Error("the typed command's output never arrived");
  return `pty ${opened.ptyId} echoed the typed command`;
});

check("port", "a port in the sandbox is reachable through the fabric's front door", ["files"], async () => {
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

check("browser", "the agent browses with the in-sandbox browser", ["create"], async () => {
  const turn = await say(
    "Use your browser to open https://example.com and reply with the exact title of the page.",
  );
  if (!turn.text.includes("Example Domain")) {
    throw new Error(`reply "${turn.text.slice(0, 300)}"; tools ${turn.tools.join(", ")}`);
  }
  return `tools ${turn.tools.join(", ")}`;
});

check("desktop", "the agent opens the desktop and sees it", ["create"], async () => {
  const turn = await say(
    "Open a computer (desktop) session for this sandbox, take a screenshot and describe in one sentence what is on the screen.",
  );
  const listed = await og<any>("GET", `${ws()}/computer-sessions`);
  const sessions = Array.isArray(listed) ? listed : (listed.computerSessions ?? listed.items ?? listed.sessions ?? []);
  const mine = sessions.filter((one: any) => JSON.stringify(one).includes(state.session!.id));
  if (mine.length === 0) throw new Error(`no computer session; reply "${turn.text.slice(0, 200)}"; tools ${turn.tools.join(", ")}`);
  const working = mine.filter((one: any) => !["failed", "closed", "ended"].includes(String(one.lifecycle)));
  if (working.length === 0) {
    const how = mine.map((one: any) => `${one.lifecycle} ${one.failure ?? one.failureReason ?? ""}`.trim()).join(", ");
    throw new Error(`computer session ${how}; reply "${turn.text.slice(0, 200)}"; tools ${turn.tools.join(", ")}`);
  }
  if (!turn.tools.some((name) => /computer_(observe|screenshot|act)/.test(name))) {
    throw new Error(`no screenshot taken; reply "${turn.text.slice(0, 200)}"; tools ${turn.tools.join(", ")}`);
  }
  return `computer session ${working[0].lifecycle}; reply "${turn.text.trim().slice(0, 120)}"`;
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

for (const level of ["paused", "saved", "archived", "remote"]) {
  check(`sleep-${level}`, `sleep at ${level} and wake on the next request`, ["files"], async () => {
    const marker = `${level}-${rand()}`;
    await step("write before sleeping", () =>
      og("POST", `${ses()}/fs/write`, { path: `e2e/${level}.txt`, content: marker, encoding: "utf8" }),
    );
    const before = await sandbox();
    let start = Date.now();
    await step("sleep", () => fabric("POST", `/v1/sandboxes/${state.sandbox}/sleep`, { level }));
    const slept = seconds(start);
    start = Date.now();
    const out = await step("first command after sleeping", () =>
      execOk(`cat e2e/${level}.txt e2e/hello.txt`, 120_000),
    );
    const woke = seconds(start);
    if (!out.includes(marker) || !out.includes(state.marker!)) throw new Error(`after wake: ${out}`);
    const after = await sandbox();
    return `slept in ${slept}, woke and answered in ${woke}; host ${before.host} -> ${after.host}`;
  });
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
  // Stopped, the machine is plainly gone: its lease lapses, the service
  // fences it (finds it stopped) and the sandbox wakes elsewhere.
  log(`stopping ${lost}`);
  const start = Date.now();
  const stop = spawnSync("gcloud", ["compute", "instances", "stop", lost, "--zone", ZONE, "--project", PROJECT, "--quiet"], {
    encoding: "utf8",
  });
  if (stop.status !== 0) throw new Error(`stop: ${stop.stderr}`);
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
  const lostState = (await hosts()).find((host) => host.name === lost)?.state ?? "gone";
  return `${lost} stopped; back on ${after.host} (epoch ${before.owner_epoch} -> ${after.owner_epoch}) in ${seconds(start)}; ` +
    `the save kept, the late write ${out.includes(late) ? "kept too" : "lost (after the last save)"}; ${lost} is now ${lostState}`;
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

type Result = { id: string; title: string; status: Status; detail: string; seconds: number };
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
  try {
    detail = await Promise.race([
      one.run(),
      sleep(CHECK_TIMEOUT_MS).then(() => {
        throw new Error(`no result within ${CHECK_TIMEOUT_MS / 60_000} min`);
      }),
    ]);
  } catch (error) {
    status = error instanceof NotApplicable ? "n/a" : "fail";
    detail = error instanceof Error ? error.message : String(error);
  }
  const result = { id: one.id, title: one.title, status, detail, seconds: (Date.now() - start) / 1000 };
  results.push(result);
  log(`${status} ${one.id}: ${detail}`);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results }, null, 2));
}

// A run that stopped before the delete check still deletes its session, so
// reruns do not leave sandboxes on the fleet.
if (state.workspace && state.session) {
  await deleteSession(5 * 60_000).catch((error) => log(`cleanup: deleting the session failed: ${error}`));
}

const counts = (status: Status) => results.filter((r) => r.status === status).length;
const table = [
  `| check | result | seconds | detail |`,
  `| --- | --- | ---: | --- |`,
  ...results.map((r) => `| ${r.id} | ${r.status} | ${r.seconds.toFixed(1)} | ${r.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
];
const meta = {
  opengeni: process.env.OPENGENI_SHA ?? "",
  compute: process.env.COMPUTE_SHA ?? "",
  model: MODEL,
  started: STARTED,
  finished: new Date().toISOString(),
};
writeFileSync(`${OUT}/results.json`, JSON.stringify({ ...meta, results }, null, 2));
writeFileSync(
  `${OUT}/results.md`,
  [
    `Opengeni ${meta.opengeni}, compute ${meta.compute.slice(0, 12)}, model ${MODEL}, ${meta.finished}`,
    "",
    `${counts("pass")} passed, ${counts("fail")} failed, ${counts("skip")} skipped, ${counts("n/a")} not applicable.`,
    "",
    ...table,
    "",
  ].join("\n"),
);
writeFileSync(`${OUT}/suite.log`, `${logLines.join("\n")}\n`);
process.exit(counts("fail") + counts("skip") > 0 ? 1 : 0);
