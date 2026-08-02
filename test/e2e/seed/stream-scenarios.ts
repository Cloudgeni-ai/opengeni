/**
 * Named live-stream scenarios for stream-session-events.ts.
 * Each exercises a different timeline motion/content/pacing combination so
 * watching the open session surfaces fold choreography, tool marathons,
 * markdown crystallize, fast vs slow models, laggy stalls, failures, memory,
 * sandbox, workers (spawn/message + inbound childCompletion cards) — not one
 * thin metronome pulse.
 */
import type { AppendEventInput } from "@opengeni/db";
import {
  applyPatch,
  applyPatchFail,
  computerClick,
  computerScreenshot,
  envSecret,
  execFail,
  execHuge,
  execOk,
  genericTool,
  mcpError,
  mcpIssue,
  mcpOk,
  sessionCreate,
  sessionSendMessage,
  viewImage,
  webSearch,
  writeStdin,
  type ToolSpec,
  SHOT_ERR,
} from "./monster/payloads.ts";

export type StreamCtx = {
  turnIndex: number;
  turnId: string;
  id: (label: string) => string;
  /**
   * Per-turn scratch so later phases can reuse ids minted earlier
   * (e.g. child session ids from spawn tools → worker-completion cards).
   */
  scratch: Record<string, string>;
};

/** Named pacing presets — resolved against OPENGENI_SEED_STREAM_TOKEN_MS. */
export type StreamPacingPreset = "fast" | "normal" | "slow" | "crawl" | "laggy" | "burst" | "yank";

export type StreamPacing = {
  /** Delay between token deltas (ms). */
  tokenMs?: number;
  /** Target characters per delta (smaller = more yanky). */
  chunkChars?: number;
  /** 0–1 multiplicative jitter on token delay. */
  jitter?: number;
  /** Every N chunks, add an extra stall. */
  stallEvery?: number;
  stallMs?: number;
  /** After every N chunks, pause (machinegun + think). */
  burstSize?: number;
  burstPauseMs?: number;
};

export type StreamPacingInput = StreamPacingPreset | StreamPacing;

export type StreamScenario = {
  id: string;
  title: string;
  /** User prompt that opens the turn. */
  userText: (ctx: StreamCtx) => string;
  /** Ordered phases the runner plays after turn.started. */
  phases: StreamPhase[];
};

export type StreamPhase =
  | { kind: "sleep"; ms: number }
  | { kind: "reason"; text: string }
  | {
      kind: "message";
      text: string;
      stream?: boolean;
      /** Per-section pacing; omit for baseline env token delay. */
      pacing?: StreamPacingInput;
    }
  | {
      kind: "tools";
      tools: (ctx: StreamCtx) => ToolSpec[];
      /** Delay from tool created → output. Number or per-index. */
      settleMs?: number | ((index: number) => number);
      /** Pause after each tool settles, before the next. Number or per-index. */
      gapMs?: number | ((index: number) => number);
    }
  | { kind: "memory-save"; kindLabel: string; preview: string }
  | { kind: "memory-correct"; kindLabel: string; oldPreview: string; preview: string }
  | {
      kind: "sandbox";
      operation: string;
      outcome: "completed" | "failed";
      detail?: string;
    }
  | { kind: "goal-set"; text: string }
  | { kind: "goal-update"; text: string }
  /**
   * Inbound feedback from a child session — a `user.message` with
   * `childCompletion` that projects to a worker-completion card (not a user bubble).
   */
  | {
      kind: "worker-completion";
      childSessionId: (ctx: StreamCtx) => string;
      text: string;
      childStatus: string;
      goal?: {
        status: string;
        text?: string;
        evidence?: string;
        pausedReason?: string;
        rationale?: string;
      };
    }
  | { kind: "raw"; events: (ctx: StreamCtx) => AppendEventInput[] };

export function resolveStreamPacing(
  input: StreamPacingInput | undefined,
  baselineTokenMs: number,
): StreamPacing {
  if (input === undefined) {
    return { tokenMs: baselineTokenMs, chunkChars: 10, jitter: 0.15 };
  }
  if (typeof input !== "string") {
    return {
      tokenMs: input.tokenMs ?? baselineTokenMs,
      chunkChars: input.chunkChars ?? 10,
      jitter: input.jitter ?? 0,
      ...(input.stallEvery !== undefined ? { stallEvery: input.stallEvery } : {}),
      ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
      ...(input.burstSize !== undefined ? { burstSize: input.burstSize } : {}),
      ...(input.burstPauseMs !== undefined ? { burstPauseMs: input.burstPauseMs } : {}),
    };
  }
  switch (input) {
    case "fast":
      // Fast model: large chunks, short gaps.
      return {
        tokenMs: Math.max(8, Math.floor(baselineTokenMs * 0.35)),
        chunkChars: 28,
        jitter: 0.1,
      };
    case "yank":
      // Tiny tokens, slightly uneven — soft word reveal under stress.
      return {
        tokenMs: Math.max(10, Math.floor(baselineTokenMs * 0.55)),
        chunkChars: 3,
        jitter: 0.35,
      };
    case "slow":
      return {
        tokenMs: Math.max(48, Math.floor(baselineTokenMs * 1.7)),
        chunkChars: 10,
        jitter: 0.2,
      };
    case "crawl":
      // Still slow enough to watch structure land, but not glacial.
      return {
        tokenMs: Math.max(72, Math.floor(baselineTokenMs * 2.4)),
        chunkChars: 6,
        jitter: 0.22,
      };
    case "laggy":
      // Provider hiccups: normal-ish tokens with periodic multi-second stalls.
      return {
        tokenMs: Math.max(30, baselineTokenMs),
        chunkChars: 9,
        jitter: 0.45,
        stallEvery: 7,
        stallMs: 900,
      };
    case "burst":
      // Machinegun tokens then a think pause.
      return {
        tokenMs: Math.max(8, Math.floor(baselineTokenMs * 0.4)),
        chunkChars: 14,
        jitter: 0.05,
        burstSize: 6,
        burstPauseMs: 650,
      };
    case "normal":
    default:
      return { tokenMs: baselineTokenMs, chunkChars: 10, jitter: 0.2 };
  }
}

const MARKDOWN_KITCHEN_SINK = `## Auth middleware plan

Here is the **full** shape — note _emphasis_, ~~strikethrough~~, and \`inline code\`.

### Checklist
- [x] Read current guard
- [ ] Patch session cookie
- [ ] Capture dashboard screenshot

> Prefer short-lived signed handles over opaque server sessions when the
> edge can verify without a round-trip.

\`\`\`ts
export function issueHandle(userId: string) {
  return sign({ sub: userId, exp: Date.now() + 3_600_000 });
}
\`\`\`

| Layer | Choice | Note |
| --- | --- | --- |
| Cookie | \`SameSite=Lax\` | CSRF on navigations |
| Header | \`Authorization\` | API clients |
| Rotate | on privilege change | OWASP |

A [reference](https://web.dev/samesite-cookies-explained/) and a nested list:

1. Verify login
2. Then:
   - dashboard loads
   - no flash of guest chrome
3. Ship

---

Final note: this phrase is **bold mid-stream`;

// Continues the previous chunk so the open `**` closes, then opens+closes a
// fence. Mid-stream the UI softens unfinished markers; once these land the
// true parse matches and crystallizes — never leaves raw `**` in the final body.
const MARKDOWN_CLOSING = `** until the closer lands.

\`\`\`bash
bun test packages/react
\`\`\`

**Done** — bold closed, fence closed, table intact.
`;

/** Dense GFM meant to crawl so tables/fences/lists crystallize visibly. */
const MARKDOWN_SLOW_SPEC = `## Session chrome hardening spec

This section is intentionally dense — watch headings, tables, and fences
resolve as tokens land.

### Goals
1. Keep the tip pinned while streaming
2. Never yank a history reader on \`loadNewer\`
3. Soft-reveal words, then **crystallize** once the body settles

### Threat model

| Risk | Severity | Mitigations |
| --- | --- | --- |
| Scroll pin on history bottom | High | \`hasNewer\` disables live follow |
| Fence flash (open triple-backtick) | Med | soften + settle breath |
| Table row half-paint | Med | crawl pacing in seeds |
| Bold opener without closer | Low | soften \`**\` until pair lands |

> Blockquote with a nested thought: if the reader scrolled *up* before the
> page arrived, \`scrollTop\` must stay put — growth below is free.

### Reference implementation

\`\`\`tsx
function followTip(node: HTMLElement) {
  if (hasNewerRef.current) return; // history page ≠ live tip
  const target = node.scrollHeight - node.clientHeight;
  if (Math.abs(target - node.scrollTop) > 1) {
    writeScrollTop(node, target);
  }
}
\`\`\`

### Nested checklist
- [x] Pin only on live tip
- [x] Overflow anchor auto in history
- [ ] Visual QA: crawl this table under lag
- [ ] Visual QA: yank mode on prose

### Deep tree

1. Admission
   1. Claim turn
   2. Freeze principal
2. Inference
   - stream deltas
   - tool calls
   - settle fold
3. Terminal
   - \`turn.completed\`
   - status → idle

---

See also: [GFM tables](https://github.github.com/gfm/#tables-extension-) ·
\`packages/react/src/components/markdown.tsx\`
`;

const MARKDOWN_SLOW_DIAGRAM = `## Architecture sketch (slow materialize)

\`\`\`
+------------+     SSE      +-----------------+
|  Web app   | <----------- |  API /events    |
+-----+------+              +--------+--------+
      | pin/follow                   | NATS
      v                              v
+------------+              +-----------------+
| Timeline   |              |  Event bus      |
| Markdown   |              |  Postgres store |
+------------+              +-----------------+
\`\`\`

### Flow (as a fence)

\`\`\`
reader @ tip --> stream --> soft words --> complete --> crystallize
reader @ history --> loadNewer --> append below --> no follow --> stay
\`\`\`

### Comparison matrix

| Mode | tokenMs | chunk | Feel |
| --- | --- | --- | --- |
| fast | ~14ms | large | model snappy |
| yank | ~22ms | tiny | word stutter |
| crawl | ~140ms | tiny | markdown theater |
| laggy | mixed | med | stall + catch-up |
| burst | fast+pause | med | think bursts |

**Watch this paragraph crystallize** after the unfinished emphasis opens —
it stays soft until the closer arrives: _partial emphasis
`;

const MARKDOWN_SLOW_DIAGRAM_CLOSE = ` closes cleanly_.

Then a final fence settles:

\`\`\`json
{ "follow": "live-tip-only", "historyBottom": "loadNewer-sentinel" }
\`\`\`

Ship it.
`;

const MARKDOWN_FAST_PROSE = `## Quick take

Cookie path is fine. Rotate on privilege change, keep \`SameSite=Lax\`, and
prefer short-lived signed handles at the edge. No further blockers — ready to
land the patch and capture the dashboard proof in the next turn.
`;

/** Long prose wall — stress tip-follow under mostly-fast streaming. */
const MARKDOWN_HUGE_WALL = `## Long-form streaming stress

This answer is intentionally **huge**: several dense paragraphs at near-model
speed so tip-follow, soft ink, and crystallize get a real workout. Skim the
shape; the point is motion under load, not the prose itself.

The session timeline has to stay honest while an agent narrates for a long
time. That means the pinned tip must float upward as content grows, never
teleport by a full line on every token batch, and never yank a reader who
scrolled up into history. When the model is slow, each new line should ease
into place without a strange laggy chase. When the model is fast, debt to the
bottom must clear quickly so the reader never feels stuck watching the tip
race away below the fold. Those two regimes share one glide; only the time
constant changes with recent growth velocity and how far we are from the tip.

In practice a turn rarely stays pure prose. Tools interrupt, reasoning opens
and closes, sandboxes warm, and mid-turn clusters fold while the live tail
keeps streaming. The outer settle fold has to choreograph that handoff: hold
the rows the reader was watching, ease the summary chip in, then glide closed
without remounting nested chips mid-collapse. If any of that snaps, the whole
stream reads as jagged even when the scroll math is fine. So this wall of
text is also a rehearsal for the quieter moments that follow — a long calm
stretch, then a soft landing.

Deployment notes belong in the same breath. The API remains the only public
surface; Postgres is durable truth; NATS is live fanout; Temporal orchestrates
but never carries token streams in workflow history. Context compaction is one
portable plaintext checkpoint, not an opaque provider blob, because sessions
rotate across subscription identities. Goals wake through a Postgres
obligation, never a polling loop. None of that changes because we are
stressing the UI — it is the reason the UI must stay calm under long runs.

Sandbox targets stay pluggable. Docker is the local default; Modal and the
other cloud boxes are swappable; a Connected Machine is a co-equal primary
compute target, not a phantom box behind a lease. Machine-primary turns never
clone repos onto the user's disk and never export platform git credentials.
The control plane talks NATS; heartbeats stay off the work pool so a full
queue cannot mark the machine offline. When this wall mentions sandboxes, it
is only to keep those invariants in the reader's peripheral vision while the
paragraphs keep arriving.

Markdown itself is part of the stress. Headings, emphasis, inline code like
\`overflow-anchor\`, and occasional links such as
[GFM](https://github.github.com/gfm/) all reflow while tokens land. Softening
unfinished markers prevents punctuation flashes; tip ink washes the young
suffix; crystallize settles the body when the stream ends. A fast wall should
still feel like one surface being painted, not a stack of cards slamming in.

Here is another block at the same density. Imagine the agent is explaining a
migration plan across API, worker, and web: expand columns, dual-write, cut
readers over, then contract. Every step emits timeline evidence. The reader
pinned at the tip watches narration grow for minutes. Soft follow must absorb
multi-line bursts without jagged ratchets, and a slow trailing sentence must
not revive burst urgency from a hundred milliseconds ago. Velocity decays when
growth pauses; debt urgency only spikes when the tip actually falls behind.

Keep going through the middle of the essay. Product copy often underestimates
how long a competent agent will talk when the task is open-ended. Days-long
runs are in scope. The UI cannot treat a long answer as an edge case. Scroll
ownership stays simple: pinned tip is scripted glide; history is native
anchoring; \`hasNewer\` pages never pretend to be the live tip. If those rules
hold, a wall like this is boring in the best way — content moves, the tip
stays readable, nothing fights the reader.

One more large paragraph before the close. Think about queue edits, Agent
Steer, approvals, and capacity waits all landing while prose continues. The
timeline projects them into clusters and notices without feeding audit events
back into model memory. Human-facing motion and model-facing truth stay on
separate rails. Watching this paragraph stream is a cheap proxy for that
separation holding under speed: layout can churn; authority cannot.

### Why the length

1. Tip-follow under sustained growth
2. Ink band under large append batches
3. Crystallize after a long body
4. No history yank if you scroll away mid-wall
`;

const MARKDOWN_HUGE_WALL_CLOSE = `### Soft landing

That was the fast pass. This coda arrives slower on purpose — let the glide
calm down, watch the last lines ease in, then crystallize. If follow still
feels jagged here, the slow path is the bug; if the wall above raced away,
the fast catch-up path needs more urgency.
`;

function marathonTools(ctx: StreamCtx, n: number): ToolSpec[] {
  const cmds = [
    "git status -sb",
    "bun install",
    "bun run typecheck",
    "bun test packages/react",
    "rg -n SameSite apps packages",
    "cat src/auth/middleware.ts | head -40",
    "mkdir -p artifacts",
    "curl -fsS http://127.0.0.1:3000/healthz || true",
    "docker ps --format '{{.Names}}'",
    "bun run lint --fix",
    "git diff --stat",
    "ls -la artifacts",
  ];
  return Array.from({ length: n }, (_, i) => execOk(ctx.id(`m-${i}`), cmds[i % cmds.length]!));
}

function mixedToolTour(ctx: StreamCtx): ToolSpec[] {
  return [
    execOk(ctx.id("t-exec"), "git status -sb"),
    applyPatch(ctx.id("t-patch"), "src/auth/middleware.ts", ctx.turnIndex),
    webSearch(ctx.id("t-search"), "SameSite Lax session cookie"),
    computerScreenshot(ctx.id("t-shot")),
    mcpOk(ctx.id("t-mcp")),
    envSecret(ctx.id("t-secret")),
    viewImage(ctx.id("t-img"), true),
    mcpIssue(ctx.id("t-issue"), `Follow-up from stream turn ${ctx.turnIndex}`),
    genericTool(ctx.id("t-gen")),
    writeStdin(ctx.id("t-stdin")),
  ];
}

/** Temporary: tools only, free-varying cadence — scrub tip-follow / row enter. */
function verticalScrutinyTools(ctx: StreamCtx, count: number): ToolSpec[] {
  const cmds = [
    "git status -sb",
    "bun install",
    "bun run typecheck",
    "rg -n SameSite apps packages",
    "cat src/auth/middleware.ts | head -40",
    "mkdir -p artifacts/stream",
    "curl -fsS http://127.0.0.1:3000/healthz || true",
    "docker ps --format '{{.Names}}'",
    "bun test packages/react/test/tip-follow-glide.test.ts",
    "git diff --stat",
    "ls -la artifacts/stream",
    "bun run lint",
  ];
  const out: ToolSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = ctx.id(`v-${i}`);
    switch (i % 10) {
      case 0:
        out.push(execOk(id, cmds[i % cmds.length]!));
        break;
      case 1:
        out.push(applyPatch(id, `src/stream/row-${i}.ts`, ctx.turnIndex + i));
        break;
      case 2:
        out.push(webSearch(id, `vertical scroll scrutiny pulse ${i}`));
        break;
      case 3:
        out.push(mcpOk(id));
        break;
      case 4:
        out.push(genericTool(id));
        break;
      case 5:
        out.push(writeStdin(id));
        break;
      case 6:
        out.push(execFail(id, "curl -fsS http://missing.invalid/healthz"));
        break;
      case 7:
        out.push(envSecret(id));
        break;
      case 8:
        out.push(mcpIssue(id, `Scrutiny note ${i}`));
        break;
      default:
        out.push(viewImage(id, i % 20 !== 19));
        break;
    }
  }
  return out;
}

/** Free-form settle: mix snappy, medium, and laggy tool completions. */
function freeToolSettleMs(index: number): number {
  const band = index % 7;
  if (band === 0) return 35 + (index % 3) * 12;
  if (band === 1) return 90 + (index % 5) * 18;
  if (band === 2) return 160 + (index % 4) * 40;
  if (band === 3) return 280 + (index % 3) * 60;
  if (band === 4) return 420 + (index % 4) * 80;
  if (band === 5) return 60 + ((index * 37) % 200);
  return 520 + ((index * 53) % 380);
}

/** Free-form gap between tools (after settle). */
function freeToolGapMs(index: number): number {
  const band = index % 5;
  if (band === 0) return 15 + (index % 4) * 8;
  if (band === 1) return 80 + (index % 6) * 25;
  if (band === 2) return 180 + (index % 5) * 45;
  if (band === 3) return 40 + ((index * 41) % 160);
  return 300 + ((index * 29) % 450);
}

/**
 * TEMPORARY scrutiny scenario: only tool rows, one after another, free speed.
 * Enable with `--tools-only` or `OPENGENI_SEED_STREAM_MODE=tools`.
 */
export const SCENARIO_TOOL_VERTICAL_SCRUTINY: StreamScenario = {
  id: "tool-vertical-scrutiny",
  title: "TEMP tools-only vertical scrutiny (free varying speed)",
  userText: (ctx) =>
    `TEMP scrutiny ${ctx.turnIndex}: stream tools only — watch tip-follow / row enter smoothness.`,
  phases: [
    { kind: "reason", text: "Tool marathon only — no prose wall. Varying settle + gap." },
    { kind: "sleep", ms: 220 },
    {
      kind: "tools",
      tools: (ctx) => verticalScrutinyTools(ctx, 36),
      settleMs: freeToolSettleMs,
      gapMs: freeToolGapMs,
    },
  ],
};

const SCENARIO_HUGE_FAST_WALL: StreamScenario = {
  id: "markdown-huge-fast-wall",
  title: "Huge prose wall (mostly fast, soft landing)",
  userText: () =>
    "Scenario: dump a very long multi-paragraph answer mostly at fast-model speed, then ease the last beat.",
  phases: [
    { kind: "reason", text: "Long narration wall — tip-follow + ink under sustained growth." },
    { kind: "sleep", ms: 180 },
    {
      kind: "message",
      text: MARKDOWN_HUGE_WALL,
      stream: true,
      // Faster + fatter than preset "fast": big batches, short gaps.
      pacing: { tokenMs: 8, chunkChars: 52, jitter: 0.08 },
    },
    { kind: "sleep", ms: 400 },
    { kind: "message", text: MARKDOWN_HUGE_WALL_CLOSE, stream: true, pacing: "slow" },
  ],
};

const SCENARIO_WORKER_FLEET: StreamScenario = {
  id: "worker-spawn",
  title: "Workers: spawn, message, inbound completions",
  userText: () =>
    "Scenario: spawn workers, message one, then show completed / paused / failed feedback cards.",
  phases: [
    {
      kind: "reason",
      text: "Delegate login verification and a staging baseline to workers; keep coordinating here.",
    },
    {
      kind: "tools",
      settleMs: 280,
      gapMs: 180,
      tools: (ctx) => {
        const login = crypto.randomUUID();
        const migrate = crypto.randomUUID();
        const load = crypto.randomUUID();
        ctx.scratch.loginWorker = login;
        ctx.scratch.migrateWorker = migrate;
        ctx.scratch.loadWorker = load;
        return [
          sessionCreate(ctx.id("w0"), login, "verify login flow end-to-end"),
          sessionCreate(ctx.id("w1"), migrate, "migrate billing service to new Postgres"),
          sessionCreate(ctx.id("w2"), load, "capture a p95 latency baseline against staging"),
          sessionSendMessage(
            ctx.id("w3"),
            login,
            "please finish assertions and report — include screenshot evidence",
          ),
          execOk(ctx.id("w4"), "echo waiting-on-workers"),
        ];
      },
    },
    {
      kind: "message",
      text: "Three workers are up. The **Messaging worker** row is `session_send_message` — same bot card as spawn, different title, prompt under it, deep-link into the child.\n\nWaiting on inbound completions…\n",
      stream: true,
      pacing: "yank",
    },
    { kind: "sleep", ms: 700 },
    {
      kind: "worker-completion",
      childSessionId: (ctx) => ctx.scratch.loginWorker!,
      text: "Login flow verified end-to-end across Chromium, Firefox, and WebKit. All 128 assertions passed; the dashboard screenshot is attached. No flakes on three reruns.",
      childStatus: "idle",
      goal: {
        status: "completed",
        text: "verify login flow end-to-end",
        evidence:
          "128/128 assertions green on 3 consecutive runs; screenshot dashboard-2026-07-07.png captured.",
      },
    },
    { kind: "sleep", ms: 480 },
    {
      kind: "worker-completion",
      childSessionId: (ctx) => ctx.scratch.migrateWorker!,
      text: "I paused the migration worker — it needs the GHCR pull credentials before it can pull the base image, and I did not want to burn continuations retrying a blocked step.",
      childStatus: "idle",
      goal: {
        status: "paused",
        text: "migrate the billing service to the new Postgres cluster",
        pausedReason: "missing GHCR pull credentials — cannot pull ghcr.io/acme/billing base image",
      },
    },
    { kind: "sleep", ms: 480 },
    {
      kind: "worker-completion",
      childSessionId: (ctx) => ctx.scratch.loadWorker!,
      text: "The load-test worker failed: the staging target returned 503 for the whole window, so I could not gather a clean baseline.",
      childStatus: "failed",
      goal: {
        status: "active",
        text: "capture a p95 latency baseline against staging",
      },
    },
    {
      kind: "message",
      text: "Inbound cards landed: one **Worker completed**, one **Worker paused**, one **Worker failed**. Expand any for the full report; **View session** deep-links into the child.\n",
      stream: true,
      pacing: "fast",
    },
  ],
};

export const STREAM_SCENARIOS: StreamScenario[] = [
  // Listed twice so the long wall runs ~2× as often as sibling scenarios.
  SCENARIO_HUGE_FAST_WALL,
  SCENARIO_HUGE_FAST_WALL,
  // Early in the cycle so the live harness shows fleet orchestration soon.
  SCENARIO_WORKER_FLEET,
  {
    id: "markdown-kitchen-sink",
    title: "Markdown kitchen sink (mixed pacing + crystallize)",
    userText: (ctx) =>
      `Scenario 1/${SCENARIO_COUNT}: stream rich markdown with mixed pacing for pulse ${ctx.turnIndex}.`,
    phases: [
      { kind: "reason", text: "Compose a markdown-dense answer; vary token speed mid-body." },
      { kind: "sleep", ms: 280 },
      { kind: "message", text: MARKDOWN_KITCHEN_SINK, stream: true, pacing: "yank" },
      { kind: "sleep", ms: 500 },
      { kind: "message", text: MARKDOWN_CLOSING, stream: true, pacing: "slow" },
    ],
  },
  {
    id: "markdown-slow-spec",
    title: "Slow markdown theater (tables/fences crawl)",
    userText: () =>
      "Scenario: crawl a dense GFM spec so I can watch tables, fences, and lists materialize.",
    phases: [
      { kind: "reason", text: "Stream the hardening spec very slowly — crystallize is the point." },
      { kind: "sleep", ms: 350 },
      { kind: "message", text: MARKDOWN_SLOW_SPEC, stream: true, pacing: "crawl" },
    ],
  },
  {
    id: "markdown-slow-diagram",
    title: "Slow architecture diagram + laggy close",
    userText: () =>
      "Scenario: stream an ASCII architecture diagram slowly, then finish with laggy stalls.",
    phases: [
      {
        kind: "reason",
        text: "Draw the box diagram fence first; stalls later simulate provider lag.",
      },
      { kind: "sleep", ms: 300 },
      { kind: "message", text: MARKDOWN_SLOW_DIAGRAM, stream: true, pacing: "crawl" },
      { kind: "sleep", ms: 700 },
      { kind: "message", text: MARKDOWN_SLOW_DIAGRAM_CLOSE, stream: true, pacing: "laggy" },
    ],
  },
  {
    id: "fast-model-prose",
    title: "Fast model prose (snappy large chunks)",
    userText: () =>
      "Scenario: answer like a fast model — big chunks, short gaps, little hesitation.",
    phases: [
      { kind: "reason", text: "Snappy summary; no tools." },
      { kind: "sleep", ms: 120 },
      { kind: "message", text: MARKDOWN_FAST_PROSE, stream: true, pacing: "fast" },
    ],
  },
  {
    id: "laggy-burst-narration",
    title: "Laggy stalls + burst think pauses",
    userText: () => "Scenario: simulate a lagging provider (stalls) then a bursty think-stream.",
    phases: [
      { kind: "reason", text: "Tokens arrive in uneven waves — stalls then catch-up bursts." },
      { kind: "sleep", ms: 400 },
      {
        kind: "message",
        text:
          "## Laggy pass\n\nWaiting on the provider… then a rush of tokens.\n\n" +
          "When stalls land mid-paragraph the soft reveal should **hold** without jumping the scroll.\n\n" +
          "Checklist while we wait:\n- [ ] pin stays honest\n- [ ] tip glide does not teleport\n- [x] reader can scroll up mid-stall\n\n",
        stream: true,
        pacing: "laggy",
      },
      { kind: "sleep", ms: 500 },
      {
        kind: "message",
        text:
          "### Burst coda\n\nNow machinegun tokens with think pauses between bursts — closer to how some models pulse.\n\n" +
          "```ts\nfor (const burst of bursts) {\n  emit(burst);\n  await think();\n}\n```\n",
        stream: true,
        pacing: "burst",
      },
    ],
  },
  {
    id: "ten-tools-then-fold",
    title: "Ten tools in a row → narrate → fold",
    userText: () =>
      "Scenario: run a long tool marathon, then summarize — I want to watch the outer steps arrive and the cluster fold.",
    phases: [
      { kind: "reason", text: "Kick off a ten-step verification pass before narrating." },
      { kind: "sleep", ms: 200 },
      {
        kind: "tools",
        settleMs: 220,
        tools: (ctx) => marathonTools(ctx, 10),
      },
      { kind: "sleep", ms: 500 },
      {
        kind: "message",
        text: "All ten checks passed. The activity cluster above should settle into a quiet summary chip while this reply streams in.\n\n",
        stream: true,
        pacing: "yank",
      },
      {
        kind: "message",
        text: "Next I'll keep going with a shorter follow-up pass.\n",
        stream: true,
        pacing: "fast",
      },
    ],
  },
  {
    id: "tools-message-tools-message",
    title: "Tools → message → tools → message → finish",
    userText: () =>
      "Scenario: alternate tool clusters with agent narration so I can see mid-turn folds and soft follow.",
    phases: [
      { kind: "reason", text: "First cluster: inspect + patch." },
      {
        kind: "tools",
        settleMs: 180,
        tools: (ctx) => [
          execOk(ctx.id("a0"), "ls src/auth"),
          execOk(ctx.id("a1"), "rg -n cookie src/auth"),
          applyPatch(ctx.id("a2"), "src/auth/session.ts", 2),
          execOk(ctx.id("a3"), "bun test src/auth"),
          webSearch(ctx.id("a4"), "rotate session token privilege change"),
        ],
      },
      {
        kind: "message",
        text: "First pass looks good — cookie path updated. Starting a second verification cluster now.\n\n",
        stream: true,
        pacing: "burst",
      },
      {
        kind: "tools",
        settleMs: 180,
        tools: (ctx) => [
          execOk(ctx.id("b0"), "bun run typecheck"),
          computerScreenshot(ctx.id("b1")),
          computerClick(ctx.id("b2")),
          viewImage(ctx.id("b3"), true),
          execOk(ctx.id("b4"), "git diff --stat"),
          mcpOk(ctx.id("b5")),
          execFail(ctx.id("b6"), "curl -fsS https://internal.invalid/health"),
          execOk(ctx.id("b7"), "echo recovered"),
        ],
      },
      {
        kind: "message",
        text: "Second cluster done (one expected DNS miss, recovered). Ready for your next instruction.\n",
        stream: true,
        pacing: "slow",
      },
    ],
  },
  {
    id: "mixed-tool-catalog",
    title: "One of each major tool renderer",
    userText: () =>
      "Scenario: exercise every major tool row type in one turn (exec, patch, search, computer, mcp, secrets, images).",
    phases: [
      { kind: "reason", text: "Walk the tool catalog so each special renderer paints once." },
      { kind: "tools", settleMs: 260, tools: mixedToolTour },
      {
        kind: "message",
        text: "Catalog pass complete — you should have seen terminal, patch, search, screenshot, MCP, secret, image, issue, generic, and stdin rows.\n",
        stream: true,
        pacing: "fast",
      },
    ],
  },
  {
    id: "failures-and-recovery",
    title: "Failures, interrupted rows, then recovery",
    userText: () => "Scenario: show failed tools, a bad patch, MCP error, then recover cleanly.",
    phases: [
      { kind: "reason", text: "Expect a few failures; recover without hiding them." },
      {
        kind: "tools",
        settleMs: 240,
        tools: (ctx) => [
          execFail(ctx.id("f0"), "curl -fsS https://internal.invalid/health"),
          applyPatchFail(ctx.id("f1")),
          mcpError(ctx.id("f2")),
          viewImage(ctx.id("f3"), false),
          execOk(ctx.id("f4"), "echo backoff"),
          applyPatch(ctx.id("f5"), "src/auth/guard.ts", 3),
          execOk(ctx.id("f6"), "bun test src/auth/guard.test.ts"),
        ],
      },
      {
        kind: "message",
        text:
          "Recovered after the failed curl/patch/MCP/image. Failures stay visible in the fold; green steps follow.\n\n" +
          "Error excerpt:\n\n```\ncurl: (6) Could not resolve host\n```\n",
        stream: true,
        pacing: "laggy",
      },
    ],
  },
  {
    id: "memory-and-goal",
    title: "Memory save/correct + goal lifecycle",
    userText: () => "Scenario: save memories, correct one, and exercise a short goal lifecycle.",
    phases: [
      { kind: "reason", text: "Capture preferences, then set a short goal." },
      {
        kind: "memory-save",
        kindLabel: "preference",
        preview: "Prefer Terraform over Pulumi for new infrastructure in this workspace.",
      },
      {
        kind: "memory-save",
        kindLabel: "semantic",
        preview: "Staging deploys run from the main branch only.",
      },
      {
        kind: "memory-correct",
        kindLabel: "semantic",
        oldPreview: "Staging deploys run from the main branch only.",
        preview: "Staging deploys run from main, after CI is green.",
      },
      { kind: "goal-set", text: "Land auth cookie harden + capture dashboard proof" },
      {
        kind: "tools",
        settleMs: 200,
        tools: (ctx) => [
          applyPatch(ctx.id("g0"), "src/auth/cookie.ts", 4),
          computerScreenshot(ctx.id("g1")),
        ],
      },
      { kind: "goal-update", text: "Cookie hardened; capturing dashboard proof" },
      {
        kind: "message",
        text: "Memories saved/corrected and the goal advanced. The goal pill above the composer should reflect the update.\n",
        stream: true,
        pacing: "normal",
      },
    ],
  },
  {
    id: "sandbox-ops",
    title: "Sandbox ops + fat exec output",
    userText: () => "Scenario: sandbox warm/exec noise plus a huge command output row.",
    phases: [
      { kind: "reason", text: "Warm the sandbox, run a noisy install, then summarize." },
      {
        kind: "sandbox",
        operation: "create",
        outcome: "completed",
        detail: "docker box ready",
      },
      {
        kind: "sandbox",
        operation: "exec",
        outcome: "completed",
        detail: "npm ci",
      },
      {
        kind: "tools",
        settleMs: 280,
        tools: (ctx) => [
          execHuge(ctx.id("s0")),
          execOk(ctx.id("s1"), "df -h /workspace"),
          execOk(ctx.id("s2"), "du -sh node_modules | head"),
        ],
      },
      {
        kind: "sandbox",
        operation: "exec",
        outcome: "failed",
        detail: "transient DNS blip",
      },
      {
        kind: "message",
        text: "Sandbox ops mixed with a truncated fat log. Expand the huge exec row to stress disclosure height animation.\n",
        stream: true,
        pacing: "burst",
      },
    ],
  },
  {
    id: "computer-and-images",
    title: "Computer-use + screenshots + view_image",
    userText: () =>
      "Scenario: click through login UI, capture screenshots, inspect an error image.",
    phases: [
      { kind: "reason", text: "Drive the browser path and gather visual evidence." },
      {
        kind: "tools",
        settleMs: 240,
        tools: (ctx) => [
          computerScreenshot(ctx.id("c0")),
          computerClick(ctx.id("c1")),
          computerScreenshot(ctx.id("c2"), SHOT_ERR),
          viewImage(ctx.id("c3"), true),
          viewImage(ctx.id("c4"), false),
          execOk(ctx.id("c5"), "mkdir -p artifacts && echo ok > artifacts/note.txt"),
        ],
      },
      {
        kind: "message",
        text: "## Visual pass\n\nDashboard and login captured. The error screenshot is attached via `view_image`.\n\n![error](artifacts/login-error.png)\n",
        stream: true,
        pacing: "slow",
      },
    ],
  },
  {
    id: "grand-finale",
    title: "Grand finale: tools → slow markdown → tools → fast close",
    userText: () =>
      "Scenario: full choreography — tool marathon, crawl markdown fold, more tools, snappy close.",
    phases: [
      {
        kind: "reason",
        text: "Tool marathon, then crawl a dense markdown body so fold + crystallize both show.",
      },
      { kind: "tools", settleMs: 160, tools: (ctx) => marathonTools(ctx, 10) },
      {
        kind: "message",
        text: "### Mid-turn checkpoint\n\nFirst ten tools settled. Watching the cluster fold while this paragraph streams…\n\n- soft row entrance\n- settle beat\n- slow collapse\n\n",
        stream: true,
        pacing: "crawl",
      },
      { kind: "sleep", ms: 600 },
      {
        kind: "tools",
        settleMs: 160,
        tools: (ctx) => [
          ...marathonTools(ctx, 6),
          applyPatch(ctx.id("z-patch"), "src/routes/login.tsx", 9),
          webSearch(ctx.id("z-search"), "OpenGeni session chrome"),
          computerScreenshot(ctx.id("z-shot")),
          mcpIssue(ctx.id("z-issue"), "Polish stream settle fold"),
        ],
      },
      {
        kind: "message",
        text:
          "Second marathon complete. **Turn finished** — next user message should land under a fully folded history.\n\n" +
          "```ts\nconsole.log('finale');\n```\n",
        stream: true,
        pacing: "fast",
      },
    ],
  },
];

export const SCENARIO_COUNT = STREAM_SCENARIOS.length;

export type StreamScenarioMode = "all" | "tools";

export function resolveStreamScenarioMode(
  raw: string | undefined = process.env.OPENGENI_SEED_STREAM_MODE,
): StreamScenarioMode {
  const value = (raw ?? "all").trim().toLowerCase();
  if (value === "tools" || value === "tools-only" || value === "tool") {
    return "tools";
  }
  return "all";
}

export function scenarioForTurn(
  turnIndex: number,
  mode: StreamScenarioMode = resolveStreamScenarioMode(),
): StreamScenario {
  if (mode === "tools") {
    return SCENARIO_TOOL_VERTICAL_SCRUTINY;
  }
  return STREAM_SCENARIOS[(turnIndex - 1) % STREAM_SCENARIOS.length]!;
}
