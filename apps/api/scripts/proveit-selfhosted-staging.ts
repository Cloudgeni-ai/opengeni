/**
 * proveit-selfhosted-staging — LIVE end-to-end verification of the bring-your-own
 * compute (selfhosted) fleet against the DEPLOYED, MANAGED-MODE control plane
 * (point it at your deployment via OGE_API / OGE_RELAY_HOST / OGE_NS). A single
 * matrix run; proveit-staging-x5.sh seeds the account+workspace, runs this 5×, tears down.
 *
 * Proves, against a REAL external Linux VM running the agent that was
 * INSTALLED FROM THE DEPLOYMENT ITSELF (`curl <OGE_API>/install.sh | sh` — the real
 * product path, which also proves the install-from-control-plane fix: the per-SHA
 * baked agent is pulled from /agent/* on the same host, no external download host dep):
 *   V2  device-flow enroll → enrollments + sandboxes rows (LOUD consent via the
 *       real workspace-scoped approve API, authorised by a minted workspace:admin
 *       delegated token).
 *   V3  sandboxes_list shows the session's Modal group box + the enrolled machine
 *       with REAL liveness (a live ControlRpc ping over NATS); heterogeneous
 *       sandbox_swap Modal<->selfhosted bumps the epoch under the CAS fence.
 *   V4  run_on exec / write / read / git execute on the external VM (hostname proves
 *       it is the remote machine, not an in-cluster box) WITHOUT moving the pointer.
 *   V5/V6  interactive PTY + desktop framebuffer over the RELAY.
 *   V9  fleet metrics; liveness/resiliency swap-back; revoke.
 *
 * Managed deployment is PUBLIC (no basic-auth edge): the agent's control-plane HTTP
 * dials OGE_API DIRECTLY — NO kubectl port-forward, NO
 * reverse tunnel. The DATA plane (NATS/relay)
 * dials the public auth=none ingress (the relay, NATS) from the VM.
 *
 * The control-plane Postgres is firewalled (reachable only from inside the api
 * pod), so seeding/reads run a small `postgres`-pkg helper INSIDE the api pod via
 * `kubectl exec` (see db()), not a direct psql.
 *
 * Config is read from env (the x5 orchestrator supplies it):
 *   OGE_WS, OGE_ACCOUNT  (seeded once by the orchestrator), OGE_RUN_INDEX,
 *   OGE_API, OGE_RELAY_HOST, OGE_VM_IP, OGE_VM_USER, OGE_VM_HOST,
 *   OGE_SSH_KEY, OGE_EVID_BASE, OGE_DEPLOYED_SHA.
 *
 * Run:  OGE_WS=… OGE_ACCOUNT=… OGE_VM_IP=… OGE_API=… OGE_RELAY_HOST=… bun apps/api/scripts/proveit-selfhosted-staging.ts
 * NO secret VALUE is ever printed or written to evidence (tokens are redacted).
 */
import { signDelegatedAccessToken } from "../../../packages/contracts/src/index.ts";
import {
  StreamOpen,
  StreamOpenAck,
  StreamFrame,
  StreamRole,
  StreamKind,
} from "../../../packages/agent-proto/src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ---- config (env-driven; the x5 orchestrator supplies the seeded ws/account) --
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(
      `missing required env ${name} — run via proveit-staging-x5.sh (it self-provisions the workspace + sources proveit.local.env)`,
    );
  return v;
}
const NS = process.env.OGE_NS ?? "opengeni"; // staging namespace
const WS = reqEnv("OGE_WS"); // seeded workspace (managed mode)
const ACCOUNT = reqEnv("OGE_ACCOUNT"); // seeded managed_accounts.id
const RELAY_HOST = reqEnv("OGE_RELAY_HOST");
const RUN_INDEX = process.env.OGE_RUN_INDEX ?? "1";
const API = reqEnv("OGE_API").replace(/\/+$/, "");
const VM_IP = reqEnv("OGE_VM_IP");
const VM_USER = reqEnv("OGE_VM_USER");
const VM_HOST = reqEnv("OGE_VM_HOST"); // expected `hostname` — exec + PTY proof
const SSH_KEY = process.env.OGE_SSH_KEY ?? "/tmp/staging-verify/vm_key";
const DEPLOYED_SHA = process.env.OGE_DEPLOYED_SHA ?? "unknown";
const EVID_BASE =
  process.env.OGE_EVID_BASE ?? "docs/design/sandbox-surfacing/evidence/selfhosted-staging";
const EVID = `${EVID_BASE}/run-${RUN_INDEX}`;
// Fresh per-run config dir on the VM → a clean device-flow enroll each run.
const REMOTE_CFG = `$HOME/.oge-proveit-run${RUN_INDEX}`;
// The agent is installed from staging into the per-user dir (install.sh default).
const REMOTE_AGENT = "$HOME/.local/bin/opengeni-agent";

mkdirSync(EVID, { recursive: true });
const RUN_LOG = `${EVID}/driver.run.log`;
writeFileSync(RUN_LOG, "");
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync(RUN_LOG, line);
  process.stdout.write(line);
}
function evidence(name: string, value: unknown) {
  writeFileSync(`${EVID}/${name}`, JSON.stringify(value, null, 2));
  log(`evidence → ${name}`);
}
function redactToken(t: string): string {
  return `${t.slice(0, 4)}<REDACTED:${t.length}b>`;
}

// ---- subprocess helpers -----------------------------------------------------
async function sh(
  cmd: string[],
  opts: { input?: string; quiet?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.input ? new TextEncoder().encode(opts.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (!opts.quiet) log(`$ ${cmd[0]} ${cmd.slice(1, 4).join(" ")}… → exit ${code}`);
  return { code, stdout, stderr };
}
// ---- control-plane DB access via the api pod --------------------------------
// Staging's Postgres is firewalled (reachable ONLY from inside the api pod, which
// has bun + the workspace-hoisted `postgres` pkg but no psql). So we run a tiny
// helper INSIDE the pod via `kubectl exec`, query on stdin, `|`-joined rows on
// stdout — identical shape to psql -At -F '|', so every caller is unchanged.
const OGQ_HELPER = `import postgres from "postgres";
const sql = postgres(process.env.OPENGENI_DATABASE_URL, { ssl: "require", max: 1 });
const q = await Bun.stdin.text();
try {
  // RLS context: sessions/credit_ledger enforce opengeni_private.workspace_rls_visible,
  // which reads the opengeni.account_id / opengeni.workspace_id GUCs. Set them (session
  // scope on this max:1 connection) BEFORE the caller's query so its result still renders
  // as a single statement. No-ops when the env vars are absent (permissive tables).
  const rlsAcct = process.env.OGE_RLS_ACCOUNT, rlsWs = process.env.OGE_RLS_WS;
  if (rlsAcct) await sql.unsafe("select set_config('opengeni.account_id', $1, false)", [rlsAcct]);
  if (rlsWs) await sql.unsafe("select set_config('opengeni.workspace_id', $1, false)", [rlsWs]);
  const rows = await sql.unsafe(q);
  const out = (Array.isArray(rows) ? rows : []).map((r) => Object.values(r).map((v) => v === null ? "" : String(v)).join("|")).join("\\n");
  process.stdout.write(out);
} catch (e) { process.stderr.write("OGQ_ERR " + e.message); process.exit(3); } finally { await sql.end(); }
`;
let apiPod: string | undefined;
async function dbSetup(): Promise<void> {
  const r = await sh(
    [
      "kubectl",
      "get",
      "pods",
      "-n",
      NS,
      "-l",
      "app.kubernetes.io/component=api",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
    { quiet: true },
  );
  apiPod = r.stdout.trim();
  if (!apiPod) throw new Error("could not resolve api pod in ns " + NS);
  const w = await sh(
    ["kubectl", "exec", "-i", "-n", NS, apiPod, "--", "bash", "-lc", "cat > /tmp/ogq.mjs"],
    { input: OGQ_HELPER, quiet: true },
  );
  if (w.code !== 0) throw new Error(`failed to stage db helper: ${w.stderr}`);
  log(`db helper staged in api pod ${apiPod}`);
}
async function db(query: string): Promise<string> {
  if (!apiPod) await dbSetup();
  const r = await sh(
    [
      "kubectl",
      "exec",
      "-i",
      "-n",
      NS,
      apiPod as string,
      "--",
      "bash",
      "-lc",
      `cd /app && OGE_RLS_ACCOUNT='${ACCOUNT}' OGE_RLS_WS='${WS}' bun /tmp/ogq.mjs`,
    ],
    { input: query, quiet: true },
  );
  if (r.code !== 0 || r.stderr.includes("OGQ_ERR"))
    throw new Error(`db failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// ---- background process registry + cleanup ----------------------------------
const children: { name: string; proc: Bun.Subprocess }[] = [];
let cleaned = false;
async function cleanup(enrollmentId?: string, sessionId?: string, token?: string) {
  if (cleaned) return;
  cleaned = true;
  log("── cleanup ──");
  // Revoke the enrollment (flip the machine offline + free the sandbox).
  if (enrollmentId && token) {
    try {
      const r = await fetch(`${API}/v1/workspaces/${WS}/enrollments/${enrollmentId}/revoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      log(`revoke enrollment ${enrollmentId} → ${r.status}`);
    } catch (e) {
      log(`revoke error: ${e}`);
    }
  }
  // Delete the seeded session row (+ its device request) so the workspace is clean.
  if (sessionId) {
    try {
      await db(`delete from sessions where id='${sessionId}';`);
      log(`deleted seeded session ${sessionId}`);
    } catch (e) {
      log(`session delete error: ${e}`);
    }
  }
  for (const c of children.reverse()) {
    try {
      c.proc.kill("SIGTERM");
      log(`killed ${c.name}`);
    } catch {}
  }
}

// ---- step assertions --------------------------------------------------------
type Check = { id: string; what: string; pass: boolean; detail: string };
const checks: Check[] = [];
function check(id: string, what: string, pass: boolean, detail = "") {
  checks.push({ id, what, pass, detail });
  log(`${pass ? "PASS" : "FAIL"} [${id}] ${what}${detail ? ` — ${detail}` : ""}`);
}

function toolJson(res: any): any {
  const text = res?.content?.find((c: any) => c.type === "text")?.text;
  if (typeof text !== "string")
    throw new Error(`tool result had no text content: ${JSON.stringify(res)}`);
  return JSON.parse(text);
}

// ---- relay stream client (M8b) ---------------------------------------------
// Each relay WS message is one binary datagram: `tag:u8 ‖ protobuf-body`.
// Tags: Open=1, OpenAck=2, Frame=3 (Close=4, DesktopInput=5 unused here).
const TAG_OPEN = 1,
  TAG_OPENACK = 2,
  TAG_FRAME = 3;
function datagram(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}
type RelayChannel = {
  channelId: string;
  frames: Uint8Array[]; // accumulated inbound StreamFrame.data
  sendData: (data: Uint8Array) => void;
  close: () => void;
};
// Open a relay channel as a CLIENT against `url` (a wss .../stream?ws=&agent=&port=&channel=
// address) authorized by the in-band `token`. Resolves once the relay ACKs accepted,
// rejects on a rejection/timeout/socket error. `kind` is StreamKind (PTY or DESKTOP).
async function openRelayChannel(
  url: string,
  token: string,
  kind: number,
  timeoutMs = 20000,
): Promise<RelayChannel> {
  const u = new URL(url);
  const workspaceId = u.searchParams.get("ws") ?? "";
  const agentId = u.searchParams.get("agent") ?? "";
  const port = Number(u.searchParams.get("port") ?? "0");
  const channelId = u.searchParams.get("channel") ?? "";
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const frames: Uint8Array[] = [];
  let seq = 1;
  const sendData = (data: Uint8Array) => {
    const body = StreamFrame.encode({
      channelId,
      seq: String(seq++),
      data,
      producedAtMs: "0",
    }).finish();
    ws.send(datagram(TAG_FRAME, body).buffer as ArrayBuffer);
  };
  return await new Promise<RelayChannel>((resolve, reject) => {
    let acked = false;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("relay open timed out"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      const open = {
        channel: { channelId, workspaceId, agentId, kind, port },
        token,
        role: StreamRole.STREAM_ROLE_CLIENT,
        resumeFromSeq: "0",
      };
      ws.send(datagram(TAG_OPEN, StreamOpen.encode(open as any).finish()).buffer as ArrayBuffer);
    });
    ws.addEventListener("message", (ev: any) => {
      const buf = new Uint8Array(ev.data as ArrayBuffer);
      if (buf.length === 0) return;
      const tag = buf[0];
      const bodyBytes = buf.subarray(1);
      if (tag === TAG_OPENACK) {
        const ack = StreamOpenAck.decode(bodyBytes);
        if (!ack.accepted) {
          clearTimeout(timer);
          reject(new Error(`relay rejected open: ${ack.error?.message ?? "?"}`));
          return;
        }
        acked = true;
        clearTimeout(timer);
        resolve({
          channelId,
          frames,
          sendData,
          close: () => {
            try {
              ws.close();
            } catch {}
          },
        });
      } else if (tag === TAG_FRAME) {
        const fr = StreamFrame.decode(bodyBytes);
        if (fr.data && fr.data.length > 0) frames.push(fr.data);
      }
    });
    ws.addEventListener("error", (e: any) => {
      if (!acked) {
        clearTimeout(timer);
        reject(new Error(`relay ws error: ${e?.message ?? String(e)}`));
      }
    });
    ws.addEventListener("close", () => {
      if (!acked) {
        clearTimeout(timer);
        reject(new Error("relay ws closed before ack"));
      }
    });
  });
}
function framesToString(frames: Uint8Array[]): string {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const f of frames) {
    merged.set(f, o);
    o += f.length;
  }
  return new TextDecoder().decode(merged);
}
// GET the session's stream-capabilities (the minted desktop/terminal cells).
async function getCaps(sessionId: string, token: string): Promise<any> {
  const r = await fetch(`${API}/v1/workspaces/${WS}/sessions/${sessionId}/stream-capabilities`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`stream-capabilities ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function main() {
  let enrollmentId: string | undefined;
  let sessionId: string | undefined;
  let token: string | undefined;
  try {
    // 0) confirm the PUBLIC managed control plane is reachable directly (no
    //    port-forward, no basic-auth edge — staging is the real product path).
    log(`probing public control plane ${API}/healthz …`);
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${API}/healthz`);
        if (r.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await Bun.sleep(1000);
    }
    if (!healthy) throw new Error(`public control plane ${API} never became healthy`);
    log("public control plane reachable");

    // 1) seed a session row (its Modal group box is synthesized by the fleet layer).
    sessionId = randomUUID();
    const groupId = randomUUID();
    await db(
      `insert into sessions
        (id, status, initial_message, model, sandbox_backend, account_id, workspace_id,
         sandbox_group_id, sandbox_os, active_sandbox_id, active_epoch)
       values
        ('${sessionId}','running','proveit-selfhosted','', 'modal','${ACCOUNT}','${WS}',
         '${groupId}','linux', NULL, 0);`,
    );
    evidence("01-seed-session.json", { sessionId, groupId, accountId: ACCOUNT, workspaceId: WS });
    check(
      "SEED",
      "seeded session row with a synthesized Modal group box",
      true,
      `session=${sessionId}`,
    );

    // 2) mint a workspace:admin delegated token bound to this session (worker-style claim).
    const delegationSecretB64 = (
      await sh(
        [
          "kubectl",
          "get",
          "secret",
          "opengeni-runtime",
          "-n",
          NS,
          "-o",
          "jsonpath={.data.OPENGENI_DELEGATION_SECRET}",
        ],
        { quiet: true },
      )
    ).stdout.trim();
    const delegationSecret = Buffer.from(delegationSecretB64, "base64").toString("utf8");
    if (!delegationSecret) throw new Error("could not read OPENGENI_DELEGATION_SECRET");
    token = await signDelegatedAccessToken(delegationSecret, {
      accountId: ACCOUNT,
      workspaceId: WS,
      subjectId: "proveit-selfhosted",
      subjectLabel: "proveit-selfhosted (ephemeral verification)",
      permissions: ["workspace:admin"],
      sessionId,
      exp: Math.floor(Date.now() / 1000) + 2 * 3600,
    });
    evidence("02-mint-token.json", {
      tokenPrefix: redactToken(token),
      permissions: ["workspace:admin"],
      sessionId,
      note: "ephemeral in-memory token; never persisted; 2h TTL; verification-only",
    });
    check(
      "MINT",
      "minted workspace:admin delegated token (in-memory, redacted)",
      token.startsWith("ogd_"),
    );

    // 2b) empirical MCP envelope probe — confirm the stateless mount answers tools/list.
    const mkClient = async () => {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${API}/v1/workspaces/${WS}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } },
      );
      const client = new Client({ name: "proveit-selfhosted", version: "1.0.0" });
      await client.connect(transport);
      return client;
    };
    {
      const client = await mkClient();
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      evidence("03-mcp-tools.json", { tools: names });
      check(
        "MCP",
        "MCP mount answers tools/list (stateless envelope OK)",
        names.length > 0,
        `${names.length} tools`,
      );
      check(
        "MCP-FLEET",
        "fleet tools registered (sandboxes_list/sandbox_swap/run_on)",
        ["sandboxes_list", "sandbox_swap", "run_on"].every((n) => names.includes(n)),
        names
          .filter((n) =>
            [
              "sandboxes_list",
              "sandbox_swap",
              "run_on",
              "sandbox_attach",
              "sandbox_provision",
            ].includes(n),
          )
          .join(","),
      );
      // Create-time machine targeting (#44): the DEPLOYED build's session_create
      // tool must advertise targetSandboxId in its inputSchema, so an MCP-spawned
      // session can pin a specific enrolled machine. (The behavior — field →
      // domain seedTargetSandbox → swapActiveSandbox — is unit/integration-tested
      // against real PG, and the swap path itself is live-proven by V3-SWAP below.)
      const sc = tools.tools.find((t) => t.name === "session_create");
      const scProps =
        (sc?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      check(
        "MCP-TARGET",
        "session_create advertises targetSandboxId (create-time machine targeting)",
        "targetSandboxId" in scProps,
        `schema-has=${"targetSandboxId" in scProps} props=${Object.keys(scProps).length}`,
      );
      await client.close();
    }

    // 2c) prove the install-from-control-plane fix at the HTTP layer: the matching
    //     per-SHA agent is BAKED into THIS deployment's image and self-served from
    //     /agent/* (header x-opengeni-agent-source: baked) — no external download host dep.
    const bakedHead = await sh(
      ["curl", "-fsSI", `${API}/agent/latest/opengeni-agent-x86_64-unknown-linux-musl`],
      { quiet: true },
    );
    const bakedSource = (
      /x-opengeni-agent-source:\s*(\S+)/i.exec(bakedHead.stdout)?.[1] ?? ""
    ).trim();
    evidence("02c-agent-baked-head.json", { status: bakedHead.code, source: bakedSource });
    check(
      "INSTALL-BAKED",
      "control plane self-serves the per-SHA agent from /agent/* (source=baked, no external download host dep)",
      bakedHead.code === 0 && bakedSource === "baked",
      `source=${bakedSource || "(missing)"}`,
    );

    // 3) install the agent ON THE VM via the REAL product path — `curl <staging>/
    //    install.sh | sh`. The served install.sh defaults its asset base to staging's
    //    OWN origin (the install.ts rewrite), so it pulls the baked agent from
    //    ${API}/agent/* and minisign-verifies it. Zero external download host dependency.
    log(`installing agent on VM from ${API}/install.sh (real product path) …`);
    const installCmd =
      `set -o pipefail; rm -rf ${REMOTE_CFG}; ` +
      `curl -fsSL ${API}/install.sh | sh; ` +
      `${REMOTE_AGENT} --version`;
    const install = await sh([
      "ssh",
      "-i",
      SSH_KEY,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      `${VM_USER}@${VM_IP}`,
      `bash -lc '${installCmd}'`,
    ]);
    appendFileSync(
      `${EVID}/03-install.log`,
      `# exit=${install.code}\n${install.stdout}\n--- stderr ---\n${install.stderr}\n`,
    );
    check(
      "INSTALL",
      "agent installed on the VM via curl <deployment>/install.sh | sh (no external download host dep)",
      install.code === 0 && /opengeni-agent/i.test(install.stdout),
      `exit=${install.code} version=${JSON.stringify((install.stdout.trim().split("\n").pop() ?? "").slice(0, 80))}`,
    );
    if (install.code !== 0)
      throw new Error(`install-from-staging failed: ${install.stderr || install.stdout}`);

    // 4) launch the installed agent — it dials the PUBLIC control plane DIRECTLY
    //    (OPENGENI_API_URL=${API}); NO reverse tunnel (the preview edge is gone).
    const startMarker = await db("select now()::text;");
    log("launching agent on VM (direct public control plane, no tunnel) …");
    const agentProc = Bun.spawn(
      [
        "ssh",
        "-i",
        SSH_KEY,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ServerAliveInterval=15",
        `${VM_USER}@${VM_IP}`,
        `OPENGENI_API_URL=${API} OPENGENI_CONFIG_DIR=${REMOTE_CFG} RUST_LOG=info ` +
          `${REMOTE_AGENT} run --workspace-id ${WS} --machine-name ${process.env.OGE_MACHINE_NAME ?? "verify-linux"} --virtual-desktop --virtual-display :99 --virtual-geometry 1280x800 2>&1`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    children.push({ name: "agent-ssh", proc: agentProc });
    // tee agent stdout to a log file
    (async () => {
      const reader = agentProc.stdout.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        appendFileSync(`${EVID}/agent.stdout.log`, dec.decode(value));
      }
    })();

    // 5) read the pending userCode from the DB (robust automation of the human step).
    let userCode = "";
    for (let i = 0; i < 45; i++) {
      const row = await db(
        `select user_code from device_enrollment_requests
         where workspace_id='${WS}' and status='pending' and created_at > '${startMarker}'
         order by created_at desc limit 1;`,
      );
      if (row) {
        userCode = row.split("|")[0].trim();
        break;
      }
      await Bun.sleep(2000);
    }
    if (!userCode) throw new Error("agent never created a pending device-enrollment request");
    evidence("04-device-start.json", {
      userCode,
      note: "agent device/start landed; awaiting LOUD-consent approve",
    });
    check(
      "V2-START",
      "agent device/start created a pending enrollment request",
      true,
      `userCode=${userCode}`,
    );

    // 6) LOUD consent — approve via the real workspace-scoped API (enrollments:manage).
    const approveRes = await fetch(`${API}/v1/workspaces/${WS}/enrollments/device/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userCode, allowScreenControl: false }),
    });
    const approveBody = await approveRes.json();
    evidence("05-approve.json", { status: approveRes.status, body: approveBody });
    check(
      "V2-APPROVE",
      "device-flow approve succeeded (201, enrollment + sandbox created)",
      approveRes.status === 201 && approveBody?.approved === true,
      `enrollmentId=${approveBody?.enrollmentId} sandboxId=${approveBody?.sandboxId}`,
    );
    enrollmentId = approveBody?.enrollmentId;
    const selfhostedSandboxId: string = approveBody?.sandboxId;

    // 6b) confirm the DB rows (V2 acceptance: enrollments + sandboxes rows).
    const enrollRow = await db(
      `select id,status,os,arch from enrollments where id='${enrollmentId}';`,
    );
    const sbxRow = await db(
      `select id,kind,name,enrollment_id from sandboxes where id='${selfhostedSandboxId}';`,
    );
    evidence("06-db-rows.json", { enrollment: enrollRow, sandbox: sbxRow });
    check(
      "V2-ROWS",
      "enrollments + sandboxes rows persisted (kind=selfhosted, enrollment bound)",
      enrollRow.includes("active") &&
        sbxRow.includes("selfhosted") &&
        sbxRow.includes(enrollmentId ?? "###"),
      `enroll=[${enrollRow}] sbx=[${sbxRow}]`,
    );

    // 7) wait for the agent to connect → sandboxes_list shows it ONLINE (real NATS ping).
    let listResult: any;
    let online = false;
    for (let i = 0; i < 40; i++) {
      const client = await mkClient();
      try {
        listResult = toolJson(await client.callTool({ name: "sandboxes_list", arguments: {} }));
      } finally {
        await client.close();
      }
      const sh = listResult.sandboxes?.find((s: any) => s.id === selfhostedSandboxId);
      if (sh && sh.liveness === "online") {
        online = true;
        break;
      }
      await Bun.sleep(3000);
    }
    evidence("07-sandboxes_list.json", listResult);
    const groupEntry = listResult.sandboxes?.find((s: any) => s.isSessionGroup === true);
    const shEntry = listResult.sandboxes?.find((s: any) => s.id === selfhostedSandboxId);
    check(
      "V3-LIST",
      "sandboxes_list shows the Modal group box + the enrolled machine",
      !!groupEntry && !!shEntry,
      `group(kind=${groupEntry?.kind},active=${groupEntry?.active}) selfhosted(kind=${shEntry?.kind})`,
    );
    check(
      "V3-LIVENESS",
      "enrolled machine is ONLINE via a real ControlRpc ping over NATS",
      online && shEntry?.liveness === "online" && shEntry?.attachable === true,
      `liveness=${shEntry?.liveness} attachable=${shEntry?.attachable}`,
    );

    if (!online)
      throw new Error("agent never reached online liveness; aborting interactive checks");

    // 8) heterogeneous swap Modal(group) → selfhosted; epoch must bump under the CAS fence.
    const epoch0 = listResult.activeEpoch ?? 0;
    let client = await mkClient();
    const swapToSelf = toolJson(
      await client.callTool({ name: "sandbox_swap", arguments: { target: selfhostedSandboxId } }),
    );
    await client.close();
    evidence("08-swap-to-selfhosted.json", swapToSelf);
    check(
      "V3-SWAP",
      "heterogeneous sandbox_swap Modal→selfhosted succeeded + epoch bumped",
      swapToSelf.swapped === true &&
        swapToSelf.activeSandboxId === selfhostedSandboxId &&
        swapToSelf.activeEpoch > epoch0,
      `active=${swapToSelf.activeSandboxId} epoch ${epoch0}→${swapToSelf.activeEpoch}`,
    );

    // 9) run_on exec — hostname proves it executed on the EXTERNAL VM (not in-cluster).
    client = await mkClient();
    const execRes = toolJson(
      await client.callTool({
        name: "run_on",
        arguments: {
          target: selfhostedSandboxId,
          op: { kind: "exec", cmd: "hostname; id -un; uname -sm; pwd" },
        },
      }),
    );
    await client.close();
    evidence("09-run_on-exec.json", execRes);
    check(
      "V4-EXEC",
      `run_on exec ran on the external VM (hostname matches ${VM_HOST})`,
      execRes.ok === true && typeof execRes.stdout === "string" && execRes.stdout.includes(VM_HOST),
      `exit=${execRes.exitCode} stdout=${JSON.stringify(execRes.stdout?.slice(0, 120))}`,
    );

    // 10) run_on write + read — filesystem round-trip on the VM.
    const marker = `proveit-${sessionId}`;
    const markerPath = `/tmp/${marker}.txt`;
    client = await mkClient();
    const writeRes = toolJson(
      await client.callTool({
        name: "run_on",
        arguments: {
          target: selfhostedSandboxId,
          op: { kind: "write", path: markerPath, content: marker },
        },
      }),
    );
    await client.close();
    client = await mkClient();
    const readRes = toolJson(
      await client.callTool({
        name: "run_on",
        arguments: { target: selfhostedSandboxId, op: { kind: "read", path: markerPath } },
      }),
    );
    await client.close();
    evidence("10-run_on-fs.json", { write: writeRes, read: readRes });
    check(
      "V4-FS",
      "run_on write+read round-trips a file on the VM filesystem",
      writeRes.ok === true && readRes.ok === true && readRes.content === marker,
      `wrote=${writeRes.bytesWritten} read=${JSON.stringify(readRes.content)}`,
    );

    // 11) run_on git — git works on the VM (init/commit/log).
    const gitCmd =
      "cd /tmp && rm -rf rgproveit && mkdir rgproveit && cd rgproveit && git init -q && " +
      "printf hi > a.txt && git add -A && " +
      "git -c user.email=t@example.com -c user.name=proveit commit -qm seed && " +
      "git log --oneline && git status --porcelain=v1";
    client = await mkClient();
    const gitRes = toolJson(
      await client.callTool({
        name: "run_on",
        arguments: { target: selfhostedSandboxId, op: { kind: "exec", cmd: gitCmd } },
      }),
    );
    await client.close();
    evidence("11-run_on-git.json", gitRes);
    check(
      "V4-GIT",
      "run_on git init/commit/log succeeds on the VM",
      gitRes.ok === true && gitRes.exitCode === 0 && /seed/.test(gitRes.stdout ?? ""),
      `exit=${gitRes.exitCode} stdout=${JSON.stringify((gitRes.stdout ?? "").slice(0, 120))}`,
    );

    // ── V5 — interactive terminal/PTY over the RELAY (the gap-closing headline) ──
    // The session's ACTIVE sandbox is the selfhosted VM (swapped in step 8). The
    // deployed fix dispatches the terminal mint to mintSelfhostedStream, so the
    // terminalStream cell must be the RELAY pty-ws (port 7681) — NOT a Modal tunnel.
    const caps1 = await getCaps(sessionId, token);
    const tUrl: string = caps1.Terminal?.url ?? "";
    // DIAGNOSTIC: dump the COMPLETE caps response verbatim (every key + typed
    // reason) so a null terminalStream is never ambiguous between "mint degraded"
    // vs "client read the wrong field/shape".
    evidence("14b-caps-terminal-FULL.json", caps1);
    evidence("14-caps-terminal.json", {
      terminalStream: caps1.Terminal
        ? { url: tUrl, hasToken: !!caps1.Terminal.token, expiresAt: caps1.Terminal.expiresAt }
        : null,
      backend: caps1.backend,
      terminalTransport: caps1.Terminal?.transport,
    });
    check(
      "V5-CAPS",
      "stream-capabilities terminalStream is the RELAY pty-ws (port 7681), not a Modal tunnel",
      tUrl.startsWith("wss://") &&
        tUrl.includes("/stream?") &&
        tUrl.includes("port=7681") &&
        tUrl.includes(`agent=${enrollmentId}`) &&
        tUrl.includes(`ws=${WS}`) &&
        tUrl.includes(RELAY_HOST),
      `url=${tUrl}`,
    );

    // V5-PTY: a live PTY round-trip over the relay to the external VM's shell.
    let ptyOut = "";
    if (tUrl && caps1.Terminal?.token) {
      try {
        const ch = await openRelayChannel(
          tUrl,
          caps1.Terminal.token,
          StreamKind.STREAM_KIND_PTY,
          25000,
        );
        await Bun.sleep(1500); // let the shell emit its initial prompt
        ch.sendData(new TextEncoder().encode("hostname\n"));
        for (let i = 0; i < 40 && !framesToString(ch.frames).includes(VM_HOST); i++)
          await Bun.sleep(500);
        ptyOut = framesToString(ch.frames);
        ch.close();
      } catch (e) {
        ptyOut = `ERROR: ${e}`;
      }
    } else {
      ptyOut = "ERROR: no terminalStream cell minted";
    }
    evidence("15-pty-roundtrip.json", {
      tail: ptyOut.slice(-500),
      containsHost: ptyOut.includes(VM_HOST),
    });
    check(
      "V5-PTY",
      `live PTY round-trip over the relay reached the external VM shell (hostname matches ${VM_HOST})`,
      ptyOut.includes(VM_HOST),
      `tail=${JSON.stringify(ptyOut.slice(-160))}`,
    );

    // ── V6 — desktop/VNC framebuffer over the RELAY ──
    // Desktop requires the un-redacted consent ack first (P3.2 gate); the fresh
    // synthetic session is NOT shared, so only acknowledgeUnredacted is needed.
    const ackRes = await fetch(
      `${API}/v1/workspaces/${WS}/sessions/${sessionId}/stream-capabilities/acknowledge`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ acknowledgeUnredacted: true, acknowledgeShared: false }),
      },
    );
    const ackBody = await ackRes.json().catch(() => ({}));
    check(
      "V6-ACK",
      "recorded un-redacted desktop consent (P3.2 gate)",
      ackRes.ok && ackBody?.acknowledged === true,
      `status=${ackRes.status}`,
    );

    const caps2 = await getCaps(sessionId, token);
    const dUrl: string = caps2.DesktopStream?.url ?? "";
    // DIAGNOSTIC: full caps response post-ack. caps2 ALSO carries the terminal cell
    // (terminal has no ack gate) — so this reveals terminalStream POST-ack, isolating
    // whether the terminal mint differs pre-ack (V5) vs post-ack.
    evidence("16b-caps-desktop-FULL.json", caps2);
    const tUrl2: string = caps2.Terminal?.url ?? "";
    check(
      "V5b-CAPS-POSTACK",
      "terminalStream present in the POST-ack caps response (terminal has no ack gate)",
      tUrl2.startsWith("wss://") && tUrl2.includes("port=7681"),
      `url=${tUrl2}`,
    );
    evidence("16-caps-desktop.json", {
      desktopStream: caps2.DesktopStream
        ? {
            url: dUrl,
            hasToken: !!caps2.DesktopStream.token,
            resolution: caps2.DesktopStream.resolution,
          }
        : null,
    });
    check(
      "V6-CAPS",
      "stream-capabilities desktopStream is the RELAY framebuffer (port 6080), not a Modal tunnel",
      dUrl.startsWith("wss://") &&
        dUrl.includes("/stream?") &&
        dUrl.includes("port=6080") &&
        dUrl.includes(`agent=${enrollmentId}`) &&
        dUrl.includes(RELAY_HOST) &&
        Array.isArray(caps2.DesktopStream?.resolution),
      `url=${dUrl} resolution=${JSON.stringify(caps2.DesktopStream?.resolution)}`,
    );

    // V6-FB: ≥1 framebuffer frame from the VM's virtual desktop (Xvfb :99).
    let fbFrames = 0,
      fbBytes = 0,
      fbErr = "";
    if (dUrl && caps2.DesktopStream?.token) {
      try {
        const ch = await openRelayChannel(
          dUrl,
          caps2.DesktopStream.token,
          StreamKind.STREAM_KIND_DESKTOP,
          25000,
        );
        for (let i = 0; i < 50 && ch.frames.length === 0; i++) await Bun.sleep(500);
        fbFrames = ch.frames.length;
        fbBytes = ch.frames.reduce((n, f) => n + f.length, 0);
        ch.close();
      } catch (e) {
        fbErr = String(e);
      }
    } else {
      fbErr = "no desktopStream cell minted";
    }
    evidence("17-desktop-fb.json", { frames: fbFrames, bytes: fbBytes, error: fbErr || undefined });
    check(
      "V6-FB",
      "received ≥1 framebuffer frame from the VM virtual desktop over the relay",
      fbFrames >= 1 && fbBytes > 0,
      `frames=${fbFrames} bytes=${fbBytes}${fbErr ? ` err=${fbErr}` : ""}`,
    );

    // 12) swap back to the session box (resiliency / single-active flip) — epoch bumps again.
    client = await mkClient();
    const swapBack = toolJson(
      await client.callTool({ name: "sandbox_swap", arguments: { target: "session" } }),
    );
    await client.close();
    evidence("12-swap-to-session.json", swapBack);
    check(
      "V3-SWAPBACK",
      "sandbox_swap back to the Modal group box flips the pointer + bumps epoch",
      swapBack.swapped === true &&
        swapBack.activeSandboxId === null &&
        swapBack.activeEpoch > swapToSelf.activeEpoch,
      `active=${swapBack.activeSandboxId} epoch ${swapToSelf.activeEpoch}→${swapBack.activeEpoch}`,
    );

    // ── V9 — fleet metrics: GET /machines surfaces a heartbeat sample; series ≥1 ──
    // The machine is still enrolled + online here. The dashboard list carries the
    // latest MetricSample under `metrics` (cpuPct/memUsedBytes…); the series
    // endpoint returns `{ samples: MetricSample[] }`. Robust: never abort the run.
    try {
      const machinesRes = await fetch(`${API}/v1/workspaces/${WS}/machines`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const machinesBody = await machinesRes.json();
      const machine = Array.isArray(machinesBody?.machines)
        ? machinesBody.machines.find((m: any) => m.enrollmentId === enrollmentId)
        : undefined;
      evidence(
        "18-machines.json",
        machine ?? {
          error: `no machine entry for enrollmentId=${enrollmentId}`,
          status: machinesRes.status,
        },
      );
      const m = machine?.metrics;
      check(
        "V9-METRICS",
        "fleet GET /machines surfaces the enrolled machine with a heartbeat metrics sample (cpu/mem)",
        machinesRes.ok &&
          !!machine &&
          !!m &&
          typeof m.cpuPct === "number" &&
          typeof m.memUsedBytes === "number" &&
          m.memUsedBytes > 0,
        machine
          ? `state=${machine.state} cpuPct=${m?.cpuPct} memUsed=${m?.memUsedBytes} memTotal=${m?.memTotalBytes} sampledAt=${m?.sampledAt}`
          : `status=${machinesRes.status} machines=${Array.isArray(machinesBody?.machines) ? machinesBody.machines.length : "n/a"}`,
      );

      const seriesRes = await fetch(
        `${API}/v1/workspaces/${WS}/machines/${enrollmentId}/metrics/series?window=1h`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      const seriesBody = await seriesRes.json();
      evidence("19-metrics-series.json", seriesBody);
      const samples = Array.isArray(seriesBody?.samples) ? seriesBody.samples : [];
      check(
        "V9-SERIES",
        "metrics time-series endpoint returns ≥1 sample for the machine",
        seriesRes.ok && samples.length >= 1,
        `status=${seriesRes.status} samples=${samples.length}`,
      );
    } catch (e) {
      evidence("18-machines.json", { error: String(e) });
      check(
        "V9-METRICS",
        "fleet GET /machines surfaces the enrolled machine with a heartbeat metrics sample (cpu/mem)",
        false,
        `error=${e}`,
      );
      check(
        "V9-SERIES",
        "metrics time-series endpoint returns ≥1 sample for the machine",
        false,
        `error=${e}`,
      );
    }

    // 13) revoke the enrollment via the real API (leaves the workspace clean).
    const revokeRes = await fetch(`${API}/v1/workspaces/${WS}/enrollments/${enrollmentId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    evidence("13-revoke.json", { status: revokeRes.status });
    check(
      "REVOKE",
      "enrollment revoked via the real workspace-scoped API",
      revokeRes.status === 200 || revokeRes.status === 204,
      `status=${revokeRes.status}`,
    );
    enrollmentId = undefined; // already revoked; skip in cleanup
  } finally {
    // summary first (before cleanup may kill things)
    const passed = checks.filter((c) => c.pass).length;
    const summary = {
      deployedSha: DEPLOYED_SHA,
      env: `${NS} (managed mode)`,
      api: API,
      relayHost: RELAY_HOST,
      runIndex: RUN_INDEX,
      installPath: `curl ${API}/install.sh | sh (baked, no external download host dep)`,
      vm: { ip: VM_IP, host: VM_HOST, user: VM_USER, arch: "x86_64" },
      workspace: WS,
      account: ACCOUNT,
      total: checks.length,
      passed,
      failed: checks.length - passed,
      checks,
      generatedAt: new Date().toISOString(),
    };
    evidence("00-summary.json", summary);
    log(`\n=== RESULT: ${passed}/${checks.length} checks passed ===`);
    await cleanup(enrollmentId, sessionId, token);
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exitCode = 1;
});
