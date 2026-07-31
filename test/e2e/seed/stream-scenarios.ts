/**
 * Named live-stream scenarios for stream-session-events.ts.
 * Each exercises a different timeline motion/content/pacing combination so
 * watching the open session surfaces fold choreography, tool marathons,
 * markdown crystallize, fast vs slow models, laggy stalls, failures, memory,
 * sandbox, and workers — not one thin metronome pulse.
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
};

/** Named pacing presets — resolved against OPENGENI_SEED_STREAM_TOKEN_MS. */
export type StreamPacingPreset =
  | "fast"
  | "normal"
  | "slow"
  | "crawl"
  | "laggy"
  | "burst"
  | "yank";

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
  | { kind: "tools"; tools: (ctx: StreamCtx) => ToolSpec[]; settleMs?: number }
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
      return { tokenMs: Math.max(8, Math.floor(baselineTokenMs * 0.35)), chunkChars: 28, jitter: 0.1 };
    case "yank":
      // Tiny tokens, slightly uneven — soft word reveal under stress.
      return { tokenMs: Math.max(10, Math.floor(baselineTokenMs * 0.55)), chunkChars: 3, jitter: 0.35 };
    case "slow":
      return { tokenMs: Math.max(70, Math.floor(baselineTokenMs * 2.2)), chunkChars: 8, jitter: 0.2 };
    case "crawl":
      // Intentionally glacial so markdown structure can be watched materializing.
      return { tokenMs: Math.max(110, Math.floor(baselineTokenMs * 3.4)), chunkChars: 4, jitter: 0.25 };
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
  return Array.from({ length: n }, (_, i) =>
    execOk(ctx.id(`m-${i}`), cmds[i % cmds.length]!),
  );
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

export const STREAM_SCENARIOS: StreamScenario[] = [
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
      { kind: "reason", text: "Draw the box diagram fence first; stalls later simulate provider lag." },
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
    userText: () =>
      "Scenario: simulate a lagging provider (stalls) then a bursty think-stream.",
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
        text:
          "All ten checks passed. The activity cluster above should settle into a quiet summary chip while this reply streams in.\n\n",
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
        text:
          "First pass looks good — cookie path updated. Starting a second verification cluster now.\n\n",
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
        text:
          "Second cluster done (one expected DNS miss, recovered). Ready for your next instruction.\n",
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
        text:
          "Catalog pass complete — you should have seen terminal, patch, search, screenshot, MCP, secret, image, issue, generic, and stdin rows.\n",
        stream: true,
        pacing: "fast",
      },
    ],
  },
  {
    id: "failures-and-recovery",
    title: "Failures, interrupted rows, then recovery",
    userText: () =>
      "Scenario: show failed tools, a bad patch, MCP error, then recover cleanly.",
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
    userText: () =>
      "Scenario: save memories, correct one, and exercise a short goal lifecycle.",
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
        text:
          "Memories saved/corrected and the goal advanced. The goal pill above the composer should reflect the update.\n",
        stream: true,
        pacing: "normal",
      },
    ],
  },
  {
    id: "sandbox-ops",
    title: "Sandbox ops + fat exec output",
    userText: () =>
      "Scenario: sandbox warm/exec noise plus a huge command output row.",
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
        text:
          "Sandbox ops mixed with a truncated fat log. Expand the huge exec row to stress disclosure height animation.\n",
        stream: true,
        pacing: "burst",
      },
    ],
  },
  {
    id: "worker-spawn",
    title: "Spawn worker + send message",
    userText: () =>
      "Scenario: spawn a child session worker and send it a follow-up.",
    phases: [
      { kind: "reason", text: "Delegate the e2e assertion pass to a worker." },
      {
        kind: "tools",
        settleMs: 320,
        tools: (ctx) => {
          const child = crypto.randomUUID();
          return [
            sessionCreate(ctx.id("w0"), child, "verify login flow end-to-end"),
            sessionSendMessage(ctx.id("w1"), child, "please finish assertions and report"),
            execOk(ctx.id("w2"), "echo waiting-on-worker"),
          ];
        },
      },
      {
        kind: "message",
        text:
          "Worker spawned. The worker row should deep-link; parent narration continues here.\n",
        stream: true,
        pacing: "yank",
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
        text:
          "## Visual pass\n\nDashboard and login captured. The error screenshot is attached via `view_image`.\n\n![error](artifacts/login-error.png)\n",
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
        text:
          "### Mid-turn checkpoint\n\nFirst ten tools settled. Watching the cluster fold while this paragraph streams…\n\n- soft row entrance\n- settle beat\n- slow collapse\n\n",
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

export function scenarioForTurn(turnIndex: number): StreamScenario {
  return STREAM_SCENARIOS[(turnIndex - 1) % STREAM_SCENARIOS.length]!;
}
