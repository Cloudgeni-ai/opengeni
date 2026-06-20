# Module: Agent computer-use + recording  (computer-use)

## Specification

# MODULE SPEC — Agent computer-use + recording

**Scope.** The agent drives the SAME shared X display that human viewers watch (Channel B). This module specifies: (1) the **computer-use tool surface** — a `Computer` impl backed by `xdotool`/`scrot` issued through the *externally-owned* sandbox session, exposed to the Agents SDK as a `computerTool` carried by a new `ComputerUseCapability` on `SandboxAgent`; (2) the **recording loop** — `ffmpeg x11grab` → mp4/webm artifact → `@opengeni/storage` → Channel-A `recording.*` events → client watch/replay; (3) **lifetime/cost** of recording riding the held-open box; (4) the "agent films itself proving the fix" UX.

This module **builds on** (does not re-derive): the singleton lease + the **per-turn resume-by-id non-owned handle** (under the stateless-workers ruling, any pool worker resumes the box by id per turn and holds the one `{client, session, sessionState}` only for that turn — there is **no persistent `SandboxOwner` actor**); the in-box desktop stack (`Xvfb :0` → XFCE → x11vnc → websockify, established in GROUND:desktop-stack); `session.resolveExposedPort(6080)` for the pixel tunnel; ownership inversion at `packages/runtime/src/index.ts:1006/1044`; the Channel-A event spine (`packages/events/src/index.ts:30`, `apps/api/src/http/sse.ts:5`).

> **SUPERSEDED transport note (API-direct control-plane ruling — see `00-master-spine.md` §B.1/§B.2/§B.3 and `modules/02-owner.md`).** Written before the rulings, the body below routes recording/pixel work through an in-worker `SandboxOwner` on a per-session `sandbox-owner::<sessionId>` queue (and an intermediate recast onto a `sandboxOwnerRpcWorkflow` global-queue hop). **All of those transports are gone:** there is **no `SandboxOwner` actor**, **no per-session `sandbox-owner::<sessionId>` queue**, and **no `sandboxOwnerRpcWorkflow`**. The **computer-use + recording capability content is unchanged and not weakened** — only the placement is restated to the **AUTHORITATIVE CORRECTED MODEL: the control plane is API-direct.** Non-turn recording finalize (read bytes → PUT to object storage → `updateRecording(available)`) runs **on the process that already holds the resumed-by-id handle**: the `apps/api` process in-process (via the thin `@opengeni/runtime/sandbox` module) for an off-turn/manual finalize, or the agent **turn's own activity** for an on-turn recording. The bytes go straight from box → process memory → object-storage PUT and are **never serialized as a Temporal activity result**, so the 256 MB-vs-payload-limit concern dissolves (see F10). **Temporal is used for exactly two things:** the long-running agent **turn** (`sessionWorkflow`) and **one global reaper Schedule** (crosscut module). Read "`SandboxOwner`" / "activity on `sandbox-owner::<sessionId>`" / "`owner_task_queue`" / any "`sandboxOwnerRpcWorkflow`" below as **"the per-turn resume-by-id handle (turn activity) or the API-direct in-process resume-by-id handle (off-turn)"**; retained verbatim for provenance.

The single load-bearing seam this module exploits: **`buildAgentCapabilities()`** (`packages/runtime/src/index.ts:494`) returns a `Capability[]` that `SandboxAgent` (`agent.d.ts:15`) merges into the agent's tool set via `tools = [...agent.tools, ...capability.tools()]`. A `Capability` subclass is `bind(session)`-ed to the live session (`base.d.ts:14`) and exposes `tools(): Tool<any>[]` (`base.d.ts:18`). **This is exactly where computer-use attaches** — no new tool-plumbing path, no MCP round-trip; the capability's `_session` IS the externally-owned session, so the agent's actions and the viewers' pixels are one display.

---

## 1. Computer-use: the `Computer` implementation

### 1.1 Type contract (verified `@openai/agents-core@0.11.6/dist/computer.d.ts:1-39`)

```ts
export type Environment = 'mac' | 'windows' | 'ubuntu' | 'browser';  // we use 'ubuntu'
export type Button = 'left' | 'right' | 'wheel' | 'back' | 'forward';
interface ComputerBase {
  environment?: Environment;
  dimensions?: [number, number];
  initRun?(rc?): Promisable<void>;
  screenshot(rc?): Promisable<string>;                      // base64 PNG, no data: prefix
  click(x, y, button: Button, rc?): Promisable<void>;
  doubleClick(x, y, rc?): Promisable<void>;
  scroll(x, y, scrollX, scrollY, rc?): Promisable<void>;
  type(text, rc?): Promisable<void>;
  wait(rc?): Promisable<void>;
  move(x, y, rc?): Promisable<void>;
  keypress(keys: string[], rc?): Promisable<void>;
  drag(path: [number,number][], rc?): Promisable<void>;
}
export type Computer = Expand<ComputerBase & Record<Exclude<ActionNames, keyof ComputerBase>, never>>;
```

The `never`-constraint on `Computer` means **every** `ComputerAction.type` (snake→camel) must be implemented and no extras may appear. The 9 action methods above are exhaustive for `ComputerAction` (`protocol.d.ts:162`). `screenshot()` returns a **base64 PNG string** (the SDK wraps it into the `computer_call_result` image payload, `protocol.d.ts:654`).

### 1.2 New file: `packages/runtime/src/sandbox-computer.ts`

The `Computer` impl issues every action through one private primitive — `session.exec({cmd})` (`@openai/agents-core/dist/sandbox/session.d.ts:108`, `ExecCommandArgs`/`SandboxExecResult` at `:42/:56`). The `session` is the live `SandboxSessionLike` owned by `SandboxOwner` (NOT a per-call client).

```ts
// packages/runtime/src/sandbox-computer.ts
import type { Computer, Button } from "@openai/agents/computer";
import type { SandboxSessionLike } from "@openai/agents/sandbox";

const DEFAULT_DISPLAY = ":0";
const DEFAULT_DIMENSIONS: [number, number] = [1024, 768];

export type SandboxComputerOptions = {
  display?: string;                 // ":0"
  dimensions?: [number, number];    // must match Xvfb geometry
  runAs?: string;                   // provider runAs (modal/docker:"sandbox")
  typeDelayMs?: number;             // xdotool type --delay (default 12)
  readOnly?: boolean;               // v1 security: when true, all input no-ops + throws
  screenshotTmpDir?: string;        // "/tmp"
};

// X keysym map for keypress() — model key names → xdotool keysyms.
const KEYSYM: Record<string, string> = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift",
  cmd: "super", meta: "super", win: "super", super: "super",
  enter: "Return", return: "Return", tab: "Tab", esc: "Escape", escape: "Escape",
  backspace: "BackSpace", delete: "Delete", space: "space",
  up: "Up", down: "Down", left: "Left", right: "Right",
  pageup: "Prior", pagedown: "Next", home: "Home", end: "End",
  // letters/digits pass through lowercased; F-keys F1..F12 pass through.
};
function toKeysym(k: string): string {
  const low = k.toLowerCase();
  if (KEYSYM[low]) return KEYSYM[low];
  if (/^f([1-9]|1[0-2])$/.test(low)) return low.toUpperCase();
  return low.length === 1 ? low : k;
}
const BUTTON_NUM: Record<Button, number> = { left: 1, wheel: 2, right: 3, back: 8, forward: 9 };

export class SandboxComputer implements Computer {
  readonly environment = "ubuntu" as const;
  readonly dimensions: [number, number];
  private readonly display: string;
  private readonly runAs?: string;
  private readonly typeDelayMs: number;
  private readonly readOnly: boolean;
  private readonly tmp: string;

  constructor(private session: SandboxSessionLike, opts: SandboxComputerOptions = {}) {
    this.display = opts.display ?? DEFAULT_DISPLAY;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.runAs = opts.runAs;
    this.typeDelayMs = opts.typeDelayMs ?? 12;
    this.readOnly = opts.readOnly ?? false;
    this.tmp = opts.screenshotTmpDir ?? "/tmp";
  }

  /** Rebind to a freshly re-elected session after owner re-establish / box rollover. */
  rebind(session: SandboxSessionLike) { this.session = session; }

  private async x(cmd: string): Promise<string> {
    if (!this.session.exec) throw new ComputerUnavailableError("session has no exec");
    const r = await this.session.exec({
      cmd: `DISPLAY=${this.display} ${cmd}`,
      ...(this.runAs ? { runAs: this.runAs } : {}),
      yieldTimeMs: 15_000,
    });
    if (r.exitCode != null && r.exitCode !== 0)
      throw new ComputerActionError(cmd, r.exitCode, r.stderr);
    return r.stdout;
  }
  private guardWrite() {
    if (this.readOnly) throw new ComputerReadOnlyError();
  }
  private shq(s: string) { return `'${s.replace(/'/g, `'\\''`)}'`; } // single-quote escape

  async screenshot(): Promise<string> {
    // scrot --pointer → file → base64 → delete (one shell line; cursor included).
    const f = `${this.tmp}/og-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const out = await this.x(`bash -lc ${this.shq(
      `scrot --pointer --overwrite ${f} && base64 -w0 ${f}; rm -f ${f}`)}`);
    return out.trim();
  }
  async click(xp: number, yp: number, button: Button) {
    this.guardWrite();
    await this.x(`xdotool mousemove --sync ${xp} ${yp} click ${BUTTON_NUM[button] ?? 1}`);
  }
  async doubleClick(xp: number, yp: number) {
    this.guardWrite();
    await this.x(`xdotool mousemove --sync ${xp} ${yp} click --repeat 2 --delay 60 1`);
  }
  async move(xp: number, yp: number) {
    this.guardWrite();
    await this.x(`xdotool mousemove --sync ${xp} ${yp}`);
  }
  async scroll(xp: number, yp: number, sx: number, sy: number) {
    this.guardWrite();
    const vBtn = sy < 0 ? 4 : 5, vN = Math.abs(sy);
    const hBtn = sx < 0 ? 6 : 7, hN = Math.abs(sx);
    let cmd = `xdotool mousemove --sync ${xp} ${yp}`;
    if (vN) cmd += ` click --repeat ${vN} ${vBtn}`;
    if (hN) cmd += ` click --repeat ${hN} ${hBtn}`;
    await this.x(cmd);
  }
  async type(text: string) {
    this.guardWrite();
    await this.x(`xdotool type --delay ${this.typeDelayMs} -- ${this.shq(text)}`);
  }
  async keypress(keys: string[]) {
    this.guardWrite();
    const combo = keys.map(toKeysym).join("+");
    await this.x(`xdotool key -- ${this.shq(combo)}`);
  }
  async drag(path: [number, number][]) {
    this.guardWrite();
    if (path.length === 0) return;
    const [sx0, sy0] = path[0];
    let cmd = `xdotool mousemove --sync ${sx0} ${sy0} mousedown 1`;
    for (const [px, py] of path.slice(1)) cmd += ` mousemove --sync ${px} ${py}`;
    cmd += ` mouseup 1`;
    await this.x(cmd);
  }
  async wait() { await new Promise((r) => setTimeout(r, 1000)); }
}
```

**Error taxonomy** (new, in same file):

```ts
export class ComputerUnavailableError extends Error {}   // no exec / display not up
export class ComputerReadOnlyError extends Error {}      // readOnly + write action
export class ComputerActionError extends Error {         // nonzero xdotool/scrot exit
  constructor(public cmd: string, public exitCode: number, public stderr: string) { super(`computer action failed (${exitCode}): ${cmd}`); }
}
```

### 1.3 The capability: `ComputerUseCapability` (the SDK seam)

A `Capability` subclass (`@openai/agents-core/dist/sandbox/capabilities/base.d.ts:8-23`). `bind(session)` hands it the live session; `tools()` returns one `computerTool`. Added in `buildAgentCapabilities` so it rides the existing `SandboxAgent.capabilities` merge.

```ts
// packages/runtime/src/sandbox-computer.ts (cont.)
import { Capability } from "@openai/agents/sandbox";
import { computerTool } from "@openai/agents";
import type { Tool } from "@openai/agents";

export type ComputerUseArgs = {
  dimensions?: [number, number];
  readOnly?: boolean;
  display?: string;
  needsApproval?: boolean | ((ctx: unknown, action: unknown) => boolean | Promise<boolean>);
};

export function computerUse(args: ComputerUseArgs = {}): ComputerUseCapability {
  return new ComputerUseCapability(args);
}

export class ComputerUseCapability extends Capability {
  readonly type = "computer-use";
  constructor(private args: ComputerUseArgs) { super(); }

  tools(): Tool<any>[] {
    const session = requireBoundSession("computer-use", this._session); // base.d.ts:25
    const computer = new SandboxComputer(session, {
      dimensions: this.args.dimensions,
      readOnly: this.args.readOnly,
      display: this.args.display,
      runAs: typeof this._runAs === "string" ? this._runAs : undefined,
    });
    return [computerTool({
      computer,
      // approvals gate destructive write actions; in read-only mode there are none.
      ...(this.args.needsApproval !== undefined ? { needsApproval: this.args.needsApproval } : {}),
    })];
  }
}
```

`computerTool` is `@openai/agents-core/dist/tool.d.ts:249`; `requireBoundSession` is `base.d.ts:25`. The SDK's `name` defaults to `'computer_use_preview'` (`tool.d.ts:229`) — the wire format that requires `environment` + `dimensions`, which `SandboxComputer` supplies.

### 1.4 Wiring into `buildAgentCapabilities` (`packages/runtime/src/index.ts:494`)

```ts
export function buildAgentCapabilities(settings: Settings, packSkills: PackSkill[]): ReturnType<typeof Capabilities.default> {
  const mode = resolveContextCompactionMode(settings);
  const caps: ReturnType<typeof Capabilities.default> = [filesystem(), shell()];
  if (mode === "server") caps.push(compaction({ policy: new StaticCompactionPolicy(contextServerCompactThreshold(settings)) }));
  caps.push(skills({ lazyFrom: lazySkillSourceWithPackSkills(packSkills) }));
  // NEW: computer-use only where the backend is desktop-capable AND enabled.
  if (settings.computerUseEnabled && desktopCapableBackend(settings.sandboxBackend)) {
    caps.push(computerUse({
      dimensions: [settings.desktopWidth, settings.desktopHeight],
      readOnly: settings.computerUseReadOnly,   // v1 default: false for the agent driver
    }));
  }
  return caps;
}
```

`desktopCapableBackend(b)` = `b ∈ {modal, daytona, runloop, e2b, blaxel}` (the matrix from GROUND:sdk-clients; cloudflare/vercel `resolveExposedPort` throws → headless, so no desktop = no computer-use). Crucially: the desktop *driver* capability does NOT require the pixel tunnel — `xdotool`/`scrot` work against `:0` regardless of whether any viewer is attached. The desktop-capable gate here is only to ensure the **image** has the X stack; for `docker`/`local` you gate on `settings.desktopImage` instead.

### 1.5 Computer-use observability on Channel A

`computerTool` calls already surface as `agent.toolCall.created` / `agent.toolCall.output` (`SessionEventType`, `contracts/src/index.ts:1289-1290`) via the normal stream loop in `agent-turn.ts` — **no new event type needed for the actions themselves**. A `screenshot()` result is a `computer_call_result` image item that flows through `reconcileConversationTruth` like any other tool output. The timeline already renders `ToolCallItem` (`packages/react/src/timeline.ts`). The only *new* Channel-A signals are the **recording** events (§3).

---

## 2. The in-box display readiness (what computer-use depends on)

Computer-use and recording both require `Xvfb :0` + XFCE running. The `SandboxOwner` runs the desktop chain idempotently after box-create and after every resume/rollover (the "re-establish-from-envelope" replay, GROUND:desktop-stack §1 startup order). This module adds **one owner method** the capability/recording depend on:

```ts
// apps/worker/src/sandbox-owner.ts (method on SandboxOwner; owner already holds {client, sessionState})
async ensureDisplayStack(): Promise<{ display: string; dimensions: [number, number] }> {
  if (this.displayReady) return this.displayInfo;
  const W = this.settings.desktopWidth, H = this.settings.desktopHeight;
  const sh = (cmd: string) => this.session.exec!({ cmd, ...(this.runAs ? { runAs: this.runAs } : {}), yieldTimeMs: 30_000 });
  // Idempotent: pgrep-guard each process so re-resume after rollover is a no-op when already up.
  await sh(`bash -lc 'pgrep -x Xvfb >/dev/null || (Xvfb :0 -ac -screen 0 ${W}x${H}x24 -retro -dpi 96 -nolisten tcp -nolisten unix & )'`);
  await sh(`bash -lc 'for i in $(seq 1 50); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.1; done'`);
  await sh(`bash -lc 'pgrep -f startxfce4 >/dev/null || (DISPLAY=:0 dbus-launch startxfce4 >/tmp/xfce.log 2>&1 & )'`);
  await sh(`bash -lc 'pgrep -x x11vnc >/dev/null || x11vnc -bg -display :0 -forever -wait 50 -shared -rfbport 5900 -nopw -noxdamage -speeds lan 2>/tmp/x11vnc.log'`);
  await sh(`bash -lc 'pgrep -f novnc_proxy >/dev/null || (/opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6080 --web /opt/noVNC >/tmp/novnc.log 2>&1 & )'`);
  this.displayReady = true;
  this.displayInfo = { display: ":0", dimensions: [W, H] };
  return this.displayInfo;
}
```

**Failure handling:** if `xdpyinfo` never returns 0 within 5s → throw `DisplayStartupError`; the capability's `tools()` is unaffected (computer-use tool is still *registered*; the *first action* fails with `ComputerUnavailableError`, surfaced as a `agent.toolCall.output` error the agent can read and retry). The owner re-runs `ensureDisplayStack()` on the next turn after a `markDisplayDirty()` (set on box rollover / resume).

---

## 3. Recording loop — `ffmpeg x11grab` → artifact → storage → events

### 3.1 State machine

```
                  start()                  stop()/turn-end/box-death
  idle ──────────────────────► recording ──────────────────────► finalizing ──► available
   ▲                              │  ▲                                              │
   │  finalize done / failed      │  │ owner re-elected → rebind ffmpeg PID lost    │
   └──────────────────────────────┘  └── (box rollover) → recording marked        │
                                          'interrupted' → finalize partial ────────┘
                                                                          └──► failed
```

States: `idle | recording | finalizing | available | failed`. Transitions:
- `idle → recording`: `startRecording()` succeeds (ffmpeg pid alive); emit `recording.started`.
- `recording → finalizing`: explicit `stopRecording()`, OR turn completes with `recordOnTurn` mode, OR owner drain. Send `SIGINT` to ffmpeg (clean MP4 trailer), wait for pid exit.
- `finalizing → available`: file pulled from box → uploaded to storage → emit `recording.available` with the artifact key + signed URL.
- `recording → failed` / `finalizing → failed`: ffmpeg died nonzero, or box died mid-record (partial), or upload failed. On box-death mid-record we attempt a **partial finalize** (the file on the dead box is unrecoverable → `failed` with `reason:"box-death"`; no artifact). Emit `recording.failed`.
- Box rollover (Modal 24h) during `recording`: the ffmpeg pid is on the old box; the new box has no file. → `recording → failed{reason:"box-rollover"}` then auto-restart a fresh recording on the new box if the originating turn is still live (mode-dependent).

### 3.2 New owner methods (`apps/worker/src/sandbox-owner.ts`)

```ts
type RecordingMode = "manual" | "on-turn" | "on-verify";
type RecordingCodec = "h264-mp4" | "vp9-webm";

interface RecordingHandle {
  recordingId: string;          // uuid
  turnId: string | null;
  boxPath: string;              // "/tmp/og-rec-<id>.mp4"
  pidFile: string;              // "/tmp/og-rec-<id>.pid"
  codec: RecordingCodec;
  startedAt: number;
  state: "recording" | "finalizing" | "available" | "failed";
}

async startRecording(opts: { recordingId: string; turnId: string | null; codec?: RecordingCodec; framerate?: number; maxSeconds?: number }): Promise<RecordingHandle> {
  await this.ensureDisplayStack();
  if (this.recordings.size >= this.settings.recordingMaxConcurrent) throw new RecordingLimitError();
  const [W, H] = this.displayInfo.dimensions;
  const codec = opts.codec ?? "h264-mp4";
  const ext = codec === "vp9-webm" ? "webm" : "mp4";
  const boxPath = `/tmp/og-rec-${opts.recordingId}.${ext}`;
  const pidFile = `/tmp/og-rec-${opts.recordingId}.pid`;
  const enc = codec === "vp9-webm"
    ? `-c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1`
    : `-c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart`;
  const dur = opts.maxSeconds ?? this.settings.recordingMaxSeconds; // hard ceiling
  // -t <dur> bounds runaway; ffmpeg self-exits → finalize watcher fires.
  await this.session.exec!({ cmd: `bash -lc ${this.shq(
    `nohup ffmpeg -hide_banner -loglevel error -f x11grab -draw_mouse 1 -framerate ${opts.framerate ?? 15} ` +
    `-video_size ${W}x${H} -i :0.0 -t ${dur} ${enc} ${boxPath} </dev/null >/tmp/og-rec-${opts.recordingId}.log 2>&1 & echo $! > ${pidFile}`
  )}`, ...(this.runAs ? { runAs: this.runAs } : {}) });
  const h: RecordingHandle = { recordingId: opts.recordingId, turnId: opts.turnId, boxPath, pidFile, codec, startedAt: Date.now(), state: "recording" };
  this.recordings.set(opts.recordingId, h);
  return h;
}

async stopRecording(recordingId: string): Promise<void> {
  const h = this.recordings.get(recordingId);
  if (!h || h.state !== "recording") return;          // idempotent
  h.state = "finalizing";
  // SIGINT → ffmpeg writes moov atom / webm trailer cleanly, then exits.
  await this.session.exec!({ cmd: `bash -lc ${this.shq(`kill -INT "$(cat ${h.pidFile})" 2>/dev/null; for i in $(seq 1 50); do kill -0 "$(cat ${h.pidFile})" 2>/dev/null || break; sleep 0.1; done`)}`, ...(this.runAs ? { runAs: this.runAs } : {}) });
}

// Pulls bytes off the box and hands them to the activity for storage upload.
async readRecordingBytes(recordingId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const h = this.recordings.get(recordingId);
  if (!h) return null;
  if (!this.session.readFile) throw new RecordingUnavailableError("session has no readFile");
  const data = await this.session.readFile({ path: h.boxPath, maxBytes: this.settings.recordingMaxBytes, ...(this.runAs ? { runAs: this.runAs } : {}) });
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  await this.session.exec?.({ cmd: `rm -f ${h.boxPath} ${h.pidFile}`, ...(this.runAs ? { runAs: this.runAs } : {}) });
  return { bytes, contentType: h.codec === "vp9-webm" ? "video/webm" : "video/mp4" };
}
```

Owner adds field `private recordings = new Map<string, RecordingHandle>()`. The byte transfer uses `session.readFile` (`session.d.ts:120`, `ReadFileArgs.maxBytes`) — present on all desktop-capable providers. **Why a hard `-t` ceiling:** ffmpeg keeps recording until SIGINT; bounding with `-t` guarantees the box doesn't accumulate an unbounded file across a multi-day turn.

### 3.3 Storage write (uses `@opengeni/storage`, `packages/storage/src/index.ts:32`)

The activity (not the owner — owner holds no storage client) does the upload via the existing `ObjectStorage` already on `ActivityServices`:

```ts
// in agent-turn / verify activity:
const rec = await owner.readRecordingBytes(recordingId);            // {bytes, contentType}
if (!rec) { /* failed */ }
const key = `recordings/${workspaceId}/${sessionId}/${recordingId}.${ext}`;
const put = await objectStorage.createPutUrl({ key, contentType: rec.contentType });   // storage:36
await fetch(put.url, { method: "PUT", headers: put.requiredHeaders, body: rec.bytes });
const get = await objectStorage.createGetUrl({ key, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS }); // storage:37, 300s
```

Key convention mirrors `recordings/<workspaceId>/<sessionId>/<recordingId>.<ext>` (parallels file-asset layout). The signed GET URL is short-TTL (5 min, `DOWNLOAD_URL_TTL_SECONDS`); clients re-fetch a fresh URL via a route (§5.2) rather than the event carrying a long-lived link.

### 3.4 Channel-A event schemas (NEW — contracts)

Append three event types to `SessionEventType` (`packages/contracts/src/index.ts:1303`, before the closing `]`):

```ts
  "recording.started",
  "recording.available",
  "recording.failed",
```

Payload Zod (new objects in contracts, exported; mirrored in `packages/sdk/src/types.ts` per the parity test):

```ts
export const RecordingStartedPayload = z.object({
  recordingId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  mode: z.enum(["manual", "on-turn", "on-verify"]),
  codec: z.enum(["h264-mp4", "vp9-webm"]),
  dimensions: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  framerate: z.number().int().positive(),
  startedAt: z.string(),                 // ISO
  reason: z.string().nullable().optional(),  // e.g. "agent-verification: tf apply succeeded"
});
export const RecordingAvailablePayload = z.object({
  recordingId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  codec: z.enum(["h264-mp4", "vp9-webm"]),
  contentType: z.enum(["video/mp4", "video/webm"]),
  storageKey: z.string(),
  durationSeconds: z.number().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  dimensions: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  // NO long-lived URL in the event; clients mint one via GET /recordings/:id/url.
});
export const RecordingFailedPayload = z.object({
  recordingId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  reason: z.enum(["ffmpeg-error", "box-death", "box-rollover", "upload-failed", "timeout", "display-unavailable"]),
  detail: z.string().nullable().optional(),
});
```

Emitted from the activity via the existing `publish([...])` helper (`agent-turn.ts:324`) → `appendAndPublishEvents` → SSE. **Redaction note:** `publish` runs `redact(event.payload)` (`agent-turn.ts:327`); recording payloads carry no secrets (the *video* may, but it rides storage, not the event), so they pass through. The pixel plane being un-redacted is the §6 security concern, not an event-payload concern.

### 3.5 Recording row — DB (optional but recommended)

A durable index so a client can list a session's recordings without scanning events, and so the signed-URL route has a source of truth. New table mirrors `sandbox_session_envelopes` FK chain (`packages/db/src/schema.ts:360`):

```sql
CREATE TABLE session_recordings (
  id            uuid PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES sessions(id)         ON DELETE CASCADE,
  turn_id       uuid REFERENCES session_turns(id) ON DELETE SET NULL,
  state         text NOT NULL,            -- recording|finalizing|available|failed
  mode          text NOT NULL,            -- manual|on-turn|on-verify
  codec         text NOT NULL,            -- h264-mp4|vp9-webm
  storage_key   text,
  size_bytes    bigint,
  duration_seconds double precision,
  width         int NOT NULL,
  height        int NOT NULL,
  reason        text,                     -- failure reason / verification rationale
  created_at    timestamptz NOT NULL DEFAULT now(),
  finalized_at  timestamptz
);
CREATE INDEX session_recordings_session_idx ON session_recordings (workspace_id, session_id, created_at DESC);
```

RLS via the existing `withWorkspaceRls` wrapper (the pattern at `packages/db/src/index.ts`). Drizzle schema addition in `schema.ts` beside `sandboxSessionEnvelopes`.

---

## 4. Lifetime & cost — recording rides the held-open box

**Liveness coupling.** A recording exists ONLY while the box is held open (lease `warm`). Recording does NOT itself create a holder — it piggybacks on whatever already holds the lease:
- **`on-turn` / `on-verify` modes:** the originating *turn holder* keeps the box alive; recording starts/stops inside the turn's activity lifecycle. No extra refcount.
- **`manual` mode (client asked to record):** the recording must add a **viewer-style holder** so the box can't drain mid-record. Reuse `sandbox_lease_holders` with `kind:'viewer'` (or a new `kind:'recording'`) keyed by `recordingId`; release = delete-holder-row on finalize. This makes recording lifetime obey the exact same refcount/TTL/drain rules as a viewer (GROUND:prior-docs §E).

**Box rollover (Modal 24h).** ffmpeg is a userspace pid on the old box; on snapshot-rollover the new box has no ffmpeg and no file. The owner's `markDisplayDirty()` already fires on rollover; recording extends it: on rollover, every `recording`-state handle → `recording.failed{reason:"box-rollover"}`, partial file discarded, and (if the turn is still live and mode is `on-turn`) a fresh `startRecording` on the new box with a new `recordingId`. **Recordings never span a rollover** — they are bounded to one box generation.

**Cost.** ffmpeg `-preset veryfast` at 15fps/1024×768 H.264 is ~5-15% of one vCPU; it shares the box already billed for the turn, so the *compute* marginal cost is the box being held a few extra seconds during `finalizing`. The real cost is **storage egress + retention**: cap with `recordingMaxSeconds` (default 600s) and `recordingMaxBytes` (default 256 MB → `readFile` rejects beyond), and a retention sweep on `session_recordings` (e.g. delete storage objects + rows older than N days — out of this module's hot path, a scheduled job). The per-call billing check (`ensureRunAllowed`, `agent-turn.ts:294`) is unaffected; recording is not a model call.

---

## 5. API routes & client contract

### 5.1 Capability advertisement (`ClientConfig` / `SessionCapabilities`)

Extend the settled `SessionCapabilities` (GROUND:prior-docs §H) with a `Recording` block and surface computer-use availability:

```ts
interface SessionCapabilities {
  // ...FileSystem, Terminal, Git, DesktopStream...
  Recording: {
    available: boolean;                       // backend desktop-capable + recordingEnabled
    modes: ("manual" | "on-turn" | "on-verify")[];
    codecs: ("h264-mp4" | "vp9-webm")[];
  };
  ComputerUse: {
    available: boolean;                       // desktopCapableBackend && computerUseEnabled
    readOnly: boolean;                        // agent drives; human is read-only viewer (§6)
  };
}
```

Computed in the stream-capabilities handler from `settings` + the resolved backend. Degradation is a value, never silent: headless backend → `Recording.available:false`, `ComputerUse.available:false`.

### 5.2 Routes (`apps/api/src/routes/sessions.ts`, behind `requireAccessGrant`)

```
POST   /sessions/:id/recordings            sessions:control   body: { mode?, codec?, framerate?, maxSeconds?, reason? }
         → signalWithStart(sessionWorkflow, startRecordingRequest{recordingId, ...}) → owner.startRecording
         → 202 { recordingId }
DELETE  /sessions/:id/recordings/:rid       sessions:control
         → signal stopRecordingRequest{rid} → owner.stopRecording + finalize
         → 202
GET     /sessions/:id/recordings            sessions:read   → list from session_recordings
GET     /sessions/:id/recordings/:rid/url   sessions:read
         → look up storage_key, objectStorage.createGetUrl(300s) → 200 { url, expiresAt, contentType }
```

The API holds NO sandbox client (per the split-plane ruling). It signals the owner workflow exactly like the stream-capabilities handshake (`signalWithStart`, `apps/api/src/index.ts:49-69`); the pixel/recording work happens inside the activity invocation on `sandbox-owner::<sessionId>`. The signed-URL route reads `session_recordings.storage_key` and mints a fresh short-TTL GET — the durable replay path.

### 5.3 React (`packages/react`)

- New timeline item variant `RecordingItem` in the `TimelineItem` union (`packages/react/src/timeline.ts:113`) + `case "recording.started"|"recording.available"|"recording.failed"` in the fold (`:163`). The `available` event upgrades the same item (matched by `recordingId`) from "recording…" → a play affordance.
- New hook `useSessionRecordings(sessionId)` — folds `recording.*` events into a `{recordingId, state, …}[]`, and exposes `record()/stop()` calling the routes; `playUrl(recordingId)` calls `GET …/url`.
- Mirror payload types into `packages/sdk/src/types.ts` (`SESSION_EVENT_TYPES` array + the three payload types) and re-export from `packages/sdk/src/index.ts` (the parity test `test/contract-parity.test.ts` enforces this).

---

## 6. "Agent films itself proving the fix" UX + security

**The flow.** When the agent completes a verification step (e.g. `terraform apply` succeeded, an app deployed, a UI bug fixed), the verification skill instructs it to: (1) call `startRecording` (mode `on-verify`, with a `reason` describing what it's about to prove); (2) drive the desktop via computer-use to open the proof surface (browser to the deployed URL, run the failing-then-passing command in a terminal, click through the fixed UI); (3) call `stopRecording`. The result is a `recording.available` event the human watches as **literal evidence**, with the agent's `reason` as the caption. Because the agent draws to `:0` and ffmpeg reads `:0`, the recording is exactly what a live viewer would have seen — no projection.

**Exposing record/stop to the agent.** Two clean options; v1 picks (a):
- **(a) First-party MCP tools** `opengeni__recording_start` / `opengeni__recording_stop` (parallels the existing `opengeni__goal_*` tools, `runtime/src/index.ts:386`) routed through the API → owner signal. This keeps the agent's recording control on the same authenticated first-party MCP channel as goals, with the same session-scoped permission. **Preferred** — no new tool-transport surface in the runtime.
- (b) A `recordTool` function tool added to the capability alongside `computerTool`. Rejected for v1: it would need the owner handle inside the runtime, duplicating the API-signal path.

**Security (v1-pragmatic, from GROUND:prior-docs §J(h)):**
- The **agent driver** runs with `readOnly:false` (it must click/type). The **human viewer** plane is **read-only by default** — desktop stream is noVNC view-only; a human writer would bypass `approvalQueue`/`interrupt` and race the agent on the same `:0`. Human write is an explicit, acknowledged opt-in, not the default.
- `computerTool` `needsApproval` gates destructive actions; in the verification UX the agent is *observing/proving*, so actions are benign, but the approval predicate remains available for write-heavy computer-use.
- The pixel plane (and therefore the recording) is **un-redacted** — a recording can capture live cloud credentials on screen. Recording is therefore **opt-in/acknowledged** at the workspace level (`recordingEnabled` default per deployment), and the signed-URL route enforces `sessions:read` per fetch. Tie recording-artifact access to grant revocation: deleting the grant → the GET-url route 403s.
- Storage objects inherit workspace RLS via the `session_recordings` row + per-read signed URLs (5-min TTL), never a public URL.

---

## 7. Config additions (`packages/config/src/index.ts`)

New settings fields (after `:244`), env mappings (after `:481`):

```ts
computerUseEnabled:      z.boolean().default(true),        // OPENGENI_COMPUTER_USE_ENABLED
computerUseReadOnly:     z.boolean().default(false),       // OPENGENI_COMPUTER_USE_READONLY (agent driver)
desktopWidth:            z.number().int().default(1024),   // OPENGENI_DESKTOP_WIDTH
desktopHeight:           z.number().int().default(768),    // OPENGENI_DESKTOP_HEIGHT
recordingEnabled:        z.boolean().default(true),        // OPENGENI_RECORDING_ENABLED
recordingDefaultCodec:   z.enum(["h264-mp4","vp9-webm"]).default("h264-mp4"),
recordingMaxSeconds:     z.number().int().default(600),    // OPENGENI_RECORDING_MAX_SECONDS
recordingMaxBytes:       z.number().int().default(268_435_456), // 256 MB
recordingMaxConcurrent:  z.number().int().default(1),
recordingFramerate:      z.number().int().default(15),
```

Cross-field validation: `desktopWidth/Height` must match the Xvfb geometry used in `ensureDisplayStack` (they're the same settings — that IS the coupling). `recordingMaxBytes` ≤ storage `MAX_SINGLE_PUT_SIZE_BYTES`.

---

## 8. File-by-file change list

| File | Change |
|---|---|
| `packages/runtime/src/sandbox-computer.ts` **(NEW)** | `SandboxComputer implements Computer` (xdotool/scrot via `session.exec`); `ComputerUseCapability extends Capability` + `computerUse()`; error classes; `KEYSYM`/`BUTTON_NUM` maps |
| `packages/runtime/src/index.ts:494` | `buildAgentCapabilities`: push `computerUse({dimensions, readOnly})` when `computerUseEnabled && desktopCapableBackend`; import `computerUse`; add `desktopCapableBackend()` helper |
| `apps/worker/src/sandbox-owner.ts` **(NEW, per lease module)** | add `ensureDisplayStack()`, `markDisplayDirty()`, `startRecording()`, `stopRecording()`, `readRecordingBytes()`, `recordings: Map`, `displayReady`/`displayInfo` |
| `packages/contracts/src/index.ts:1303` | add `recording.started|available|failed` to `SessionEventType`; add `RecordingStartedPayload`/`RecordingAvailablePayload`/`RecordingFailedPayload`; extend `SessionCapabilities` with `Recording`+`ComputerUse` blocks |
| `packages/sdk/src/types.ts` | mirror 3 event-type literals into `SESSION_EVENT_TYPES`; add the 3 payload types (parity test gate) |
| `packages/sdk/src/index.ts:21` | re-export the 3 payload types |
| `packages/db/src/schema.ts` (~`:360`) | add `session_recordings` table (drizzle) beside `sandboxSessionEnvelopes` |
| `packages/db/src/index.ts` | `insertRecording`/`updateRecording`/`listRecordings`/`getRecording` (withWorkspaceRls) |
| `apps/worker/src/activities/agent-turn.ts` | `on-turn`/`on-verify` lifecycle: call `owner.startRecording` at trigger, `stopRecording`+`readRecordingBytes`+storage upload+`recording.available` publish in the turn `finally` (`:855`); box-death → `recording.failed` |
| `apps/worker/src/activities.ts` (or a new `recording.ts` activity) | `finalizeRecording` activity: `readRecordingBytes` → `createPutUrl`+PUT → `updateRecording(available)` → publish `recording.available` |
| `apps/api/src/routes/sessions.ts` | `POST/DELETE /sessions/:id/recordings`, `GET …/recordings`, `GET …/recordings/:rid/url`; all behind `requireAccessGrant`; signal owner via `signalWithStart` |
| `apps/api/src/index.ts:49` | `startRecordingRequest`/`stopRecordingRequest` signals on `SessionWorkflowClient` |
| `apps/worker/src/workflows/session.ts` | handle `startRecordingRequest`/`stopRecordingRequest` signals → schedule recording activity on `owner_task_queue`; finalize stale recordings on drain |
| `packages/runtime/src/index.ts` (first-party MCP) | register `opengeni__recording_start`/`opengeni__recording_stop` MCP tools (parallels `opengeni__goal_*`) for the agent-driven verification UX |
| `packages/react/src/timeline.ts:113,163` | `RecordingItem` variant + 3 `case`s in the fold |
| `packages/react/src/index.ts` | export `useSessionRecordings` hook + `RecordingItem` |
| `packages/config/src/index.ts:244,481` | the 10 settings fields + `OPENGENI_*` env mappings + geometry/byte-cap validation |

---

## 9. Failure / edge-case matrix

| Case | Detection | Handling |
|---|---|---|
| Display not up when action fires | `xdotool`/`scrot` nonzero exit | `ComputerActionError` → owner `ensureDisplayStack()` retry once → re-issue; persistent → `agent.toolCall.output` error item the agent reads |
| `session.exec` missing (provider lacks exec) | guard in `SandboxComputer.x` | `ComputerUnavailableError`; capability still registers but actions fail loud — only happens on misconfigured non-desktop backend (gated out by `desktopCapableBackend`) |
| Read-only mode + write action | `guardWrite()` | `ComputerReadOnlyError` (used for human-viewer-driven attempts; agent driver is `readOnly:false`) |
| ffmpeg dies mid-record | pid gone before `stop` | `recording.failed{reason:"ffmpeg-error"}` + `/tmp/og-rec-*.log` tail in `detail` |
| Box dies under recording | `readFile`/`exec` throws box-dead | `recording.failed{reason:"box-death"}`, no artifact (file unrecoverable) |
| Box rollover (Modal 24h) | owner `markDisplayDirty` on rollover | all `recording`-state → `failed{box-rollover}`; auto-restart fresh recording if turn live + mode `on-turn` |
| Recording exceeds `maxSeconds` | ffmpeg `-t` self-exit | finalize watcher detects pid exit → `finalizing` → `available` (clean partial up to ceiling) |
| File exceeds `recordingMaxBytes` | `readFile maxBytes` rejects | `recording.failed{reason:"timeout"/"upload-failed"}`, detail "exceeds max bytes" |
| Storage upload fails | PUT nonzero | `recording.failed{reason:"upload-failed"}`; row stays `finalizing` for retry by a sweep |
| Owner re-elected mid-record | new owner has empty `recordings` Map | the in-flight ffmpeg is orphaned on the box; finalize on the next turn discovers `/tmp/og-rec-*` by glob OR (simpler v1) treats it as `failed{box-death}` — recordings do not survive owner re-election in v1 |
| Concurrent record requests | `recordings.size >= max` | `RecordingLimitError` → route 409 |
| Signed URL expired | client GET 200 with TTL; re-fetch | client re-calls `GET …/url` (no event re-emit) |
| Two writers on `:0` (agent + human) | not prevented (last-writer, OS-implicit) | human plane read-only by default (§6); concurrent write is acknowledged-opt-in only |

---

## Key file references (load-bearing)

- `Computer` interface: `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/computer.d.ts:1-39`
- `computerTool`: `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/tool.d.ts:249` (name default `'computer_use_preview'` at `:229`)
- `Capability` base (`bind`/`tools`/`requireBoundSession`): `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/sandbox/capabilities/base.d.ts:8-25`
- `SandboxAgent` (`capabilities` → tool merge): `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/sandbox/agent.d.ts:15`
- `session.exec`/`readFile`/`ExecCommandArgs`/`SandboxExecResult`: `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/sandbox/session.d.ts:42,56,108,120`
- Capability wiring seam: `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/runtime/src/index.ts:466-474` (SandboxAgent ctor), `:494-502` (`buildAgentCapabilities`)
- `ObjectStorage` (`createPutUrl`/`createGetUrl`/TTLs): `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/storage/src/index.ts:32-40,22-24`
- Event spine: `packages/events/src/index.ts:30`; `apps/api/src/http/sse.ts:5`; `publish` helper `apps/worker/src/activities/agent-turn.ts:324`; `AppendEventInput` `packages/db/src/index.ts:836`
- `SessionEventType` enum to extend: `packages/contracts/src/index.ts:1270-1304`
- Envelope table to parallel for `session_recordings`: `packages/db/src/schema.ts:360`
- Modal tunnel port-resolve (pixel path, not needed for recording but co-located): `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/modal/sandbox.js:271-301`

**Single biggest dependency on a sibling module:** `SandboxOwner` (lease module) must hold the live `SandboxSessionLike` and expose it for `bind()` — the `ComputerUseCapability._session` and all owner recording methods operate on that one externally-owned session. **Single biggest open risk inherited:** recordings do not survive owner re-election or box rollover in v1 (bounded to one box generation); accepted, with auto-restart for `on-turn` mode.

---

## Adversarial Review

# Adversarial Review — Agent computer-use + recording spec

## BLOCKER findings (won't compile / won't run as written)

### F1 — `session.exec({cmd})` does not exist on any provider; the entire `Computer` impl is built on a phantom primitive
The spec's single load-bearing primitive is `session.exec({cmd})` returning `{stdout, exitCode, stderr}` (`SandboxExecResult`). **No provider implements the canonical `exec(args)`.** Verified: Modal's session declares only `execCommand(args: ExecCommandArgs): Promise<string>` (`@openai/agents-extensions@0.11.6/dist/sandbox/modal/sandbox.d.ts:167`); e2b/daytona/runloop/blaxel all extend `RemoteSandboxSessionBase` which provides `execCommand` only (`shared/sessionBase.d.ts:43`). The `exec(...)` entries in runloop/blaxel `.d.ts` are the internal provider-SDK process spawn with a different signature (`exec(command: string[], ...)`), not the SDK contract. On the `SandboxSession` interface `exec?` is *optional* (`session.d.ts:112`) and Modal leaves it unimplemented.

The existing codebase already handles this correctly: `session.exec ? await session.exec({...}) : await session.execCommand!({...})` (`packages/runtime/src/index.ts:1242-1250`, `:1904-1914`, `:2029-2039`). The spec's `SandboxComputer.x()` calls `this.session.exec({...})` unconditionally and only guards `if (!this.session.exec)`. On Modal/e2b/etc., `this.session.exec` is `undefined`, so **every computer-use action throws `ComputerUnavailableError`** — the tool never works on the primary provider.

**Fix:** mirror the codebase's dual-path: `const result = session.exec ? await session.exec(args) : await session.execCommand!(args)`. Type the helper to accept `SandboxExecResult | string`.

### F2 — `execCommand` returns a *formatted string with a metadata preamble*, not stdout; `screenshot()` returns garbage and `x()`'s exit-code check is wrong
`execCommand` returns the output of `formatExecResponse` (`@openai/agents-core/dist/sandbox/shared/output.js`), which is a single string shaped:
```
Chunk ID: a1b2c3
Wall time: 0.0421 seconds
Process exited with code 0
Output:
<actual stdout>
```
The spec's `screenshot()` does `return out.trim()` on `r.stdout` and feeds it to the SDK as a base64 PNG. The result is the entire preamble + base64, so **the image payload is corrupt** and the model gets an invalid `computer_call_result`. Even via the (nonexistent) `exec` object path, `r.stdout` is *also* the formatted string, not raw bytes — there is no field carrying raw stdout.

The spec's `x()` does `if (r.exitCode != null && r.exitCode !== 0) throw` — but `execCommand` returns a *string* with no `.exitCode` property, so `r.exitCode` is `undefined` and **no failure is ever detected**. The codebase solves this with `sandboxCommandExitCode(result)` (regex `/Process exited with code (-?\d+)/`), `sandboxCommandOutput`, and `sandboxCommandStillRunning` (`packages/runtime/src/index.ts:1990`, and the parser helpers). The spec uses none of them.

**Fix:** for `screenshot()`, parse out the `Output:` body (or, far better, use `session.readFile({path, maxBytes})` to read the PNG bytes directly and base64-encode in JS, avoiding the string-preamble problem entirely — `viewImage` is also available and returns a `ToolOutputImage`). For `x()`, replace the `r.exitCode` check with the established `sandboxCommandExitCode`/`sandboxCommandStillRunning` parsing (export them, they exist).

### F3 — `exec`/`execCommand` *yields*, it does not wait for completion; long actions silently return partial output with no error
`waitForProcessOrTimeout(activeProcess, yieldTimeMs)` (`modal/sandbox.js:157`) waits *up to* `yieldTimeMs` then returns. If the command hasn't finished, the response has **no exit code** and only a `sessionId` ("Process running with session ID N") plus whatever output was captured so far. The spec sets `yieldTimeMs: 15_000` for screenshots; a `scrot`+`base64 -w0` of a 1024×768 PNG is normally fast, but under load or for the recording `stop()` wait-loop (`for i in $(seq 1 50); do kill -0 ...; sleep 0.1; done` ≈ up to 5s) there is a real risk the command exceeds the yield and returns a still-running marker that the spec treats as success (because `r.exitCode` is `undefined`, F2). The spec never handles the "still running" case.

**Fix:** detect `sandboxCommandStillRunning(result)` and treat it as a retriable/failed action; bound the screenshot/stop commands to complete well under `yieldTimeMs`.

### F4 — Wrong import paths; `@openai/agents/computer` does not exist and `Button`/`Capability`/`computerTool` come from different subpaths
The spec imports:
- `import type { Computer, Button } from "@openai/agents/computer";` — **`@openai/agents/computer` is not an exported subpath** (`package.json` exports are only `.`, `./sandbox`, `./sandbox/local`, `./realtime`, `./utils`). `Computer` is re-exported from the top-level `@openai/agents` (`agents-core/dist/index.d.ts:4`). **`Button` is NOT exported from the index at all** (grep of `agents-core/dist/index.d.ts` shows no `Button` export — it lives only in `computer.d.ts` which is not a public subpath). So `Button` is unimportable as written.
- `import { Capability } from "@openai/agents/sandbox";` — correct (`Capability` is in `agents-core/sandbox`).
- `import { computerTool } from "@openai/agents";` — correct (top-level).

The repo's own convention imports sandbox symbols from `@openai/agents/sandbox` and `SandboxSessionLike` from there too (`packages/runtime/src/index.ts:31-56`), NOT from `@openai/agents/sandbox` as the spec writes `import type { SandboxSessionLike } from "@openai/agents/sandbox"` (that one is fine). But `import type { Computer } from "@openai/agents/computer"` and `Button` will fail to resolve.

**Fix:** `import { computerTool, type Computer } from "@openai/agents";` and either drop `Button` (inline the union `'left'|'right'|'wheel'|'back'|'forward'`) or re-derive it. `SandboxSessionLike` import path should match the repo (`@openai/agents/sandbox`).

### F5 — `scroll()` uses model pixel deltas as literal wheel-click `--repeat` counts → runaway scrolling
The SDK passes `action.scroll_x`/`action.scroll_y` straight through (`agents-core/dist/runner/toolExecution.js:358`). The OpenAI `computer_use_preview` model emits these as pixel/notch deltas, routinely in the hundreds. The spec does `const vN = Math.abs(sy); ... click --repeat ${vN} ${vBtn}` — a single model scroll of `scroll_y: 300` becomes **300 discrete wheel clicks**. This is a correctness bug, not just inefficiency.

**Fix:** divide by a notch constant (e2b uses a divisor; a common choice is `Math.max(1, Math.round(Math.abs(sy)/ STEP))` with `STEP` ≈ 60–120), clamp to a sane max.

---

## CORRECTNESS / DDL findings

### F6 — `session_recordings` references `session_turns(id)` but the real table/column must be verified; FK chain is otherwise correct
The FK targets `managed_accounts(id)`, `workspaces(id)`, `sessions(id)`, `session_turns(id)` all exist (`packages/db/src/schema.ts:13,24,107,245`) — good. But the spec writes raw SQL DDL while the repo is **100% Drizzle** (`pgTable(...)`), and the change-list row says "Drizzle schema addition." Hand-written `CREATE TABLE` will not be picked up by the Drizzle migration tooling and will drift from `schema.ts`. The `turn_holders`/sandbox lease tables in GROUND are all Drizzle.

**Fix:** specify the table as a `pgTable("session_recordings", {...})` Drizzle definition (mirroring `sandboxSessionEnvelopes`), not raw DDL. Add the `uniqueIndex`/`index` via the Drizzle table-callback form.

### F7 — `recording.failed{reason:"timeout"}` reused for "exceeds max bytes" contradicts the schema enum semantics
§9 maps "File exceeds `recordingMaxBytes`" to `reason:"timeout"/"upload-failed"`. But `timeout` semantically means the `-t` ceiling hit (which §9 elsewhere maps to a *successful* `available` finalize). Using `timeout` for an oversize file is self-contradictory and will confuse clients/timeline rendering. The enum has no `oversize`/`too-large` value.

**Fix:** add `"max-bytes-exceeded"` to the `RecordingFailedPayload.reason` enum; map the `readFile maxBytes` rejection to it.

### F8 — `readFile maxBytes` rejection behavior is assumed, not verified
The spec asserts "`readFile maxBytes` rejects beyond" and builds the oversize-failure path on it. The `ReadFileArgs.maxBytes` field exists (`session.d.ts:71`), but the spec does not establish *how* over-limit is signaled (throw vs truncate). Modal's `readFile` returns `Promise<Uint8Array>` (`modal/sandbox.d.ts:170`) — if it silently truncates rather than throwing, the spec uploads a corrupt-but-"successful" video. This is hand-waved.

**Fix:** verify the over-limit semantics per provider; if truncating, check `bytes.length >= maxBytes` and fail explicitly.

### F9 — `readRecordingBytes` deletes the file before the activity confirms a successful upload → no retry possible
`readRecordingBytes` does `rm -f ${h.boxPath} ${h.pidFile}` immediately after reading bytes into memory. But §3.5/§9 claim "row stays `finalizing` for retry by a sweep" on upload failure. After `rm`, the box file is gone and the bytes live only in the activity's memory — if the activity process dies between read and a failed upload, **the recording is unrecoverable** despite the row saying "retryable." The retry story is incoherent with the eager delete.

**Fix:** delete the box file only after `updateRecording(available)` commits, or accept that there is no retry and remove the "stays finalizing for retry" claim.

---

## ARCHITECTURE / CONSTRAINT-VIOLATION findings

### F10 — [RESOLVED under the API-direct model] recording finalize reads bytes + PUTs to object storage on the process holding the resumed-by-id handle; the bytes never become a Temporal payload, so the 256 MB-vs-Temporal-payload-limit concern dissolves
`readRecordingBytes` returns `{bytes: Uint8Array}` up to `recordingMaxBytes` (256 MB default). The original concern assumed this byte read crossed a Temporal *activity*/queue boundary on `sandbox-owner::<sessionId>` — i.e. that 256 MB would be returned as an activity result and blow Temporal's payload limit (default 2 MB, hard 4 MB blob limit). **That routing no longer exists.** Under the finalized API-direct control-plane model there is no `SandboxOwner` actor and no per-session task queue: non-turn operations run on the process that already holds the box handle resumed-by-id (the `apps/api` process for an off-turn/manual finalize via the thin `@opengeni/runtime/sandbox` module; the agent turn's own activity for an on-turn recording). In both cases the read-bytes step and the storage PUT happen **in the same process** — `readRecordingBytes(...)` then `fetch(put.url, body: bytes)` straight to object storage — so the bytes go directly from box → process memory → object-storage PUT and are **never serialized as a Temporal activity result**. The payload-limit math is therefore irrelevant; the only real bounds are process memory (one `recordingMaxBytes` buffer at a time) and the storage PUT.

**Resolution:** recording finalize = resume-the-box-by-id on the holding process (API-direct for off-turn, the turn activity for on-turn) → `readRecordingBytes` into memory → PUT to object storage → `updateRecording(available)`. No owner method invoked across an activity/queue boundary, no bytes through a Temporal result. (Still observe F9: delete the box file only after the `available` row commits.)

### F11 — `recordingMaxConcurrent` default 1 + the `on-verify` UX both start recordings → the agent's own verification recording can collide with a `manual` recording and 409
`startRecording` throws `RecordingLimitError` at `recordings.size >= recordingMaxConcurrent` (default 1). The headline UX (§6) has the agent call `opengeni__recording_start` mid-turn. If a human already started a `manual` recording (or an `on-turn` recording is active), the agent's `on-verify` start throws, the MCP tool returns an error, and the "films itself proving the fix" flow silently fails. With default concurrency 1 these collisions are routine, not edge cases.

**Fix:** either reserve a slot for agent-driven `on-verify` recordings, or raise the default, or make the agent-start preempt/queue rather than hard-fail. Specify the precedence.

### F12 — `ensureDisplayStack` uses `session.exec!` unconditionally — same F1 bug, plus `DisplayStartupError` is referenced but never defined
`ensureDisplayStack` calls `this.session.exec!({...})` (note the `!`). On Modal `session.exec` is `undefined` → `TypeError: this.session.exec is not a function`. Must use the `exec ?? execCommand` fallback. Separately, the §2 prose says "throw `DisplayStartupError`" but no such class is defined anywhere in the spec (the error taxonomy in §1.2 defines only `ComputerUnavailableError`/`ComputerReadOnlyError`/`ComputerActionError`).

Also `this.displayInfo`/`this.displayReady`/`this.runAs`/`this.settings`/`this.shq` are referenced as owner fields but the spec only lists "add `recordings: Map`, `displayReady`/`displayInfo`" — `shq` (shell-quote) is used in `startRecording`/`stopRecording` but never defined on the owner (it's defined on `SandboxComputer`, a different class).

**Fix:** define `DisplayStartupError`; add `shq` to the owner; use the exec-fallback; declare all referenced fields.

### F13 — `x11vnc` flag mismatch with GROUND:desktop-stack causes a hang
`ensureDisplayStack` runs `x11vnc ... -wait 50 ... 2>/tmp/x11vnc.log` **without `-bg`** but the GROUND startup uses `-bg`. Without `-bg`, `x11vnc` runs in the foreground and the `execCommand` call **blocks until `yieldTimeMs` (30s) elapses**, then returns "still running" — which F2/F3 mean is treated as success but actually leaves the readiness ambiguous, and the novnc step may race. The spec's own §2 code omits `-bg` while GROUND mandates it. (The recording/novnc lines correctly background with `&`.)

**Fix:** add `-bg` to the `x11vnc` invocation (matching GROUND), or background it explicitly.

---

## EVENT / CONTRACT findings

### F14 — `durationSeconds` is emitted as a payload field but never computed
`RecordingAvailablePayload.durationSeconds` and the DB `duration_seconds` are required-ish, but nothing in the spec computes duration. ffmpeg is launched with `-t <dur>` (the ceiling), but actual duration = stop_time − start_time (or read from the file via `ffprobe`). The spec never calls `ffprobe` and never tracks wall time. It will always be `null` or wrong.

**Fix:** either `ffprobe -show_entries format=duration` on the finalized file before upload, or compute `(stoppedAt - startedAt)/1000` and accept the SIGINT-flush imprecision; document which.

### F15 — `sizeBytes` parity: `RecordingAvailablePayload.sizeBytes` is `z.number().int().nonnegative()` but bytes come from `Uint8Array.length` — fine; however the parity test (`test/contract-parity.test.ts`) requires the SDK mirror to byte-match
The spec says "mirror into `packages/sdk/src/types.ts`" but the three payloads use `z.tuple([z.number().int().positive(), ...])` for `dimensions` and `.uuid()`/`.nullable().optional()` chains. The SDK mirror is **hand-written, zero-runtime-dep** (per the GROUND: `sdk/src/types.ts` header) — it cannot use Zod. The spec shows Zod objects "mirrored in `packages/sdk/src/types.ts` per the parity test," which is a category error: the SDK side is plain TS types + a `SESSION_EVENT_TYPES` string array, not Zod. The spec must specify the plain-TS shape, not "mirror the Zod."

**Fix:** specify the SDK side as `export type RecordingAvailablePayload = { recordingId: string; ... dimensions: [number, number]; ... }` plus the 3 literals appended to `SESSION_EVENT_TYPES`, and note the parity test compares the *type*, not the Zod.

### F16 — `redact()` runs on every published payload; `storageKey` may be redaction-sensitive but `reason`/`detail` free-text can leak
§3.4 claims "recording payloads carry no secrets." But `RecordingStartedPayload.reason` and `RecordingFailedPayload.detail` are **free-text** the agent/ffmpeg controls (e.g. `detail: "<ffmpeg log tail>"` per §9). An ffmpeg error log or an agent-authored `reason` could contain a path or URL with embedded creds. The spec asserts these "pass through" redaction without checking that `redact()` actually scrubs free-text (it operates on `event.payload`, `agent-turn.ts:327`). This is an unverified assumption, not a finding of safety.

**Fix:** confirm `redact()` recurses string values; cap/scrub `detail` to a known-safe ffmpeg-stderr tail; don't claim "no secrets" for agent-controlled free text.

---

## SMALLER GAPS

- **F17 — `buildAgentCapabilities` reproduction drifts from real code.** The spec's version uses a one-line `if (mode === "server") caps.push(...)`; the real code (`packages/runtime/src/index.ts:494-503`) uses a braced block. Cosmetic, but the spec also omits that `Capabilities`/`filesystem`/`shell`/`skills`/`compaction` are imported from `@openai/agents/sandbox` (verified `:33-55`) — the new `computerUse` import must be added to *that* import block or a local file, and the spec doesn't say where `computerUse` is imported from in `index.ts` (it's the new `sandbox-computer.ts`).

- **F18 — `desktopCapableBackend` self-contradiction.** §1.4 gates on `desktopCapableBackend(b) = b ∈ {modal, daytona, runloop, e2b, blaxel}` then immediately says "for `docker`/`local` you gate on `settings.desktopImage` instead" — but the gate as written returns `false` for docker/local, so the `desktopImage` branch is unreachable. And `daytona/runloop/e2b/blaxel` are **not in the `SandboxBackend` enum** (`["docker","modal","local","none"]`, `contracts:13`) — they don't exist as backends yet (that's a sibling module). So today the gate only ever admits `modal`. Spec should state the gate is `modal` (+`docker`/`local` with `desktopImage`) until the provider-wiring module lands.

- **F19 — `keypress` `xdotool key -- '<combo>'` with `--` then a single `+`-joined token is wrong.** `xdotool key` treats `--` as end-of-options, then `ctrl+c` as one keystroke spec — that's actually correct for a chord. But `toKeysym` maps `cmd→super`; on Linux/XFCE the model rarely sends `cmd`, and mapping `meta→super` may mis-fire app shortcuts. Minor, but the `shq` single-quoting of a combo containing no special chars is harmless. Low priority.

- **F20 — `drag`/`click` build multi-action `xdotool` command lines** (`mousemove ... mousedown 1 mousemove ... mouseup 1`). If `runAs` is set, `sandboxUserShellCommand` wraps the whole thing in `su/sudo ... sh -lc '<quoted>'` (`shared` impl). The `DISPLAY=:0` prefix from `x()` lands *inside* that quoted command, which works, but the spec never accounts for the double shell-wrapping (`bash -lc '<shq>'` for screenshot, then `sh -lc` from runAs). Verify quoting survives two levels for inputs containing quotes (the `type` text path is highest-risk: `shq(text)` then wrapped again).

---

## Summary
The recording loop, event schemas, DB row, lifetime/cost coupling, and security model are largely sound and consistent with the settled architecture. **The computer-use core (§1) does not run as written**: F1 (no `session.exec`), F2 (string-not-object exec result corrupting screenshots and defeating error detection), F4 (unresolvable imports), and F5 (runaway scroll) are independent blockers, each fatal on the primary provider (Modal). All four have a clear fix grounded in the existing codebase pattern (`session.exec ?? session.execCommand!`, plus `sandboxCommandExitCode`/`sandboxCommandStillRunning`/`sandboxCommandOutput` parsers at `packages/runtime/src/index.ts:1990` and helpers; or `readFile`/`viewImage` for screenshots). F10 (Temporal payload size for 256 MB byte returns) and F9 (eager file delete vs claimed retry) are architecture-level and must be resolved before the recording finalize path is implementable.

Key citations: `@openai/agents-extensions@0.11.6/dist/sandbox/modal/sandbox.d.ts:167` (only `execCommand`), `@openai/agents-core@0.11.6/dist/sandbox/shared/output.js` (formatExecResponse preamble), `dist/sandbox/modal/sandbox.js:157` (yield-not-wait), `dist/runner/toolExecution.js:358` (raw scroll deltas), `@openai/agents@0.11.6/package.json` exports (no `/computer` subpath), `packages/runtime/src/index.ts:1242-1250,1990` (the correct established pattern).
