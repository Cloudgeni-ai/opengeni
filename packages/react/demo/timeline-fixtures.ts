import type { SessionEvent } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Timeline fixtures

   Real-shaped `SessionEvent[]` covering every tool × state. These are fed
   through the SAME `buildTimeline` projection the live app uses, into the SAME
   renderer components — so the demo is not a fork, it is the real pipeline with
   captured-shape inputs. Every entry mirrors a real captured payload or a
   documented SDK wire shape (see the `// REAL:` annotations).
   -------------------------------------------------------------------------- */

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "04033e3e-7c1f-4a3b-8c4d-5e6f7a8b9c0d";

/** A tiny ordered event-log builder mirroring the server's per-session sequence. */
export class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  push(type: string, payload: unknown, turnId: string | null = null): this {
    this.seq += 1;
    this.events.push({
      id: `evt-${this.seq}`,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      sequence: this.seq,
      type,
      payload,
      occurredAt: new Date(Date.now() - (200 - this.seq) * 1000).toISOString(),
      turnId,
    });
    return this;
  }

  /** A settled tool call: created (+raw) then output. */
  tool(
    args: { name: string; id: string; arguments?: unknown; raw?: unknown; output?: unknown; error?: boolean },
    turnId: string | null = null,
  ): this {
    this.push("agent.toolCall.created", { id: args.id, name: args.name, arguments: args.arguments ?? null, raw: args.raw }, turnId);
    if (args.output !== undefined || args.error) {
      this.push("agent.toolCall.output", { id: args.id, output: args.output ?? null, error: args.error ?? false }, turnId);
    }
    return this;
  }

  /** A still-running tool call: created, no output. */
  toolRunning(args: { name: string; id: string; arguments?: unknown; raw?: unknown }, turnId: string | null = null): this {
    return this.push("agent.toolCall.created", { id: args.id, name: args.name, arguments: args.arguments ?? null, raw: args.raw }, turnId);
  }
}

/* --- offline screenshots (data-uri SVG; the real shape is data:image/png;base64) --- */

function screenshot(title: string, kind: "dash" | "login" | "err"): string {
  const body =
    kind === "dash"
      ? `<rect x="24" y="70" width="170" height="90" rx="8" fill="#1f2733"/><rect x="206" y="70" width="170" height="90" rx="8" fill="#1f2733"/><rect x="388" y="70" width="170" height="90" rx="8" fill="#1f2733"/>
         <rect x="40" y="86" width="60" height="10" rx="3" fill="#3d6df0"/><rect x="40" y="110" width="110" height="22" rx="4" fill="#e6ebf5"/>
         <rect x="222" y="86" width="60" height="10" rx="3" fill="#27c498"/><rect x="222" y="110" width="90" height="22" rx="4" fill="#e6ebf5"/>
         <rect x="404" y="86" width="60" height="10" rx="3" fill="#e0a030"/><rect x="404" y="110" width="100" height="22" rx="4" fill="#e6ebf5"/>
         <rect x="24" y="180" width="534" height="120" rx="8" fill="#1a212b"/>
         <polyline points="40,280 110,250 180,265 250,220 320,235 390,200 460,215 540,190" fill="none" stroke="#3d6df0" stroke-width="3"/>`
      : `<rect x="180" y="84" width="222" height="210" rx="10" fill="#1a212b"/>
         <rect x="206" y="112" width="170" height="14" rx="4" fill="${kind === "err" ? "#e0533a" : "#e6ebf5"}"/>
         <rect x="206" y="146" width="170" height="30" rx="6" fill="#0e141c" stroke="#33405288"/>
         <rect x="206" y="186" width="170" height="30" rx="6" fill="#0e141c" stroke="#33405288"/>
         <rect x="206" y="234" width="170" height="32" rx="6" fill="#3d6df0"/>
         <rect x="244" y="244" width="94" height="12" rx="3" fill="#e6ebf5"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="582" height="320" viewBox="0 0 582 320">
    <rect width="582" height="320" fill="#0e141c"/>
    <rect width="582" height="44" fill="#161d27"/>
    <circle cx="22" cy="22" r="5" fill="#e0533a"/><circle cx="42" cy="22" r="5" fill="#e0a030"/><circle cx="62" cy="22" r="5" fill="#27c498"/>
    <rect x="100" y="14" width="382" height="16" rx="8" fill="#0e141c"/>
    <text x="120" y="26" font-family="monospace" font-size="11" fill="#67768c">${title}</text>
    ${body}
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

export const SHOT_DASH = screenshot("localhost:5173/dashboard", "dash");
export const SHOT_LOGIN = screenshot("localhost:5173/login", "login");
export const SHOT_ERR = screenshot("localhost:5173/login  x invalid", "err");

const HUGE_OUTPUT = Array.from(
  { length: 80 },
  (_, i) => `  installed package-${String(i).padStart(3, "0")}@${(i % 4) + 1}.${i % 9}.${(i * 3) % 9}`,
).join("\n");

/* ----------------------------------------------------------------------------
   Segment A — the full tool x state reference rail (one streaming turn).
   Every captured shape, projected through buildTimeline.
   -------------------------------------------------------------------------- */

export function tourEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-tour";
  log.push("user.message", {
    text: "Refactor the auth module to use the new session API, verify the login flow in the browser, and file any follow-ups.",
  });

  // reasoning
  log.push(
    "agent.reasoning.delta",
    {
      text: "The session API swaps the token cookie for a signed handle; I'll thread it through the route guard, update both call-sites in auth/middleware.ts, then drive the browser to confirm the redirect still lands on /dashboard.",
    },
    turn,
  );

  // exec_command — exit 0 (REAL: Chrome launch)
  log.tool(
    {
      name: "exec_command",
      id: "call-exec-0",
      arguments: { cmd: "/opt/chrome/chrome --headless --remote-debugging-port=9222 &", workdir: "/workspace" },
      output:
        "Chunk ID: a1b2c3\nWall time: 2.5210 seconds\nProcess exited with code 0\nOutput:\nDevTools listening on ws://127.0.0.1:9222/devtools/browser/8f3a\n",
    },
    turn,
  );
  // exec_command — non-zero exit (REAL: curl resolve failure, code 6)
  log.tool(
    {
      name: "exec_command",
      id: "call-exec-1",
      arguments: { cmd: "curl -fsS https://internal.invalid/health", workdir: "/workspace" },
      output:
        "Chunk ID: d4e5f6\nWall time: 0.3100 seconds\nProcess exited with code 6\nOutput:\ncurl: (6) Could not resolve host: internal.invalid\n",
    },
    turn,
  );
  // exec_command — backgrounded (REAL: Process running with session ID 1)
  log.tool(
    {
      name: "exec_command",
      id: "call-exec-2",
      arguments: { cmd: "npm run dev", workdir: "/workspace", tty: true },
      output:
        "Chunk ID: 778899\nWall time: 1.0040 seconds\nProcess running with session ID 1\nOutput:\n  VITE v5.2.0  ready in 412 ms\n  Local:   http://localhost:5173/\n",
    },
    turn,
  );
  // exec_command — empty output
  log.tool(
    {
      name: "exec_command",
      id: "call-exec-3",
      arguments: { cmd: "mkdir -p artifacts", workdir: "/workspace" },
      output: "Chunk ID: 0a0b0c\nWall time: 0.0050 seconds\nProcess exited with code 0\nOutput:\n",
    },
    turn,
  );
  // exec_command — huge output, truncated + tail peek
  log.tool(
    {
      name: "exec_command",
      id: "call-exec-4",
      arguments: { cmd: "npm ci --verbose", workdir: "/workspace" },
      output: `Chunk ID: aaa111\nWall time: 18.4400 seconds\nProcess exited with code 0\nOutput:\nTotal output lines: 412\n${HUGE_OUTPUT}\n...3200 tokens truncated...\nadded 412 packages, audited 413 packages in 18s\n`,
    },
    turn,
  );
  // exec_command — binary/garbled output suppressed
  log.tool(
    {
      name: "exec_command",
      id: "call-exec-5",
      arguments: { cmd: "cat /tmp/chrome.bin | head -c 200", workdir: "/tmp" },
      // a NUL byte in the stream classifies as binary
      output: "Chunk ID: bbb222\nWall time: 0.0200 seconds\nProcess exited with code 0\nOutput:\n\u0000\u0001\u0002binary\u0000blob",
    },
    turn,
  );
  // exec_command — RUNNING (no output event)
  log.toolRunning(
    { name: "exec_command", id: "call-exec-run", arguments: { cmd: "npm run e2e", workdir: "/workspace" } },
    turn,
  );

  // write_stdin — Ctrl-C (REAL chars:"")
  log.tool(
    {
      name: "write_stdin",
      id: "call-ws-0",
      arguments: { session_id: 1, chars: "" },
      output: "Chunk ID: ccc333\nWall time: 1.0010 seconds\nProcess exited with code 130\nOutput:\n^C\n",
    },
    turn,
  );
  // write_stdin — session lost
  log.tool(
    {
      name: "write_stdin",
      id: "call-ws-1",
      arguments: { session_id: 1, chars: "ls\n" },
      output: "write_stdin failed: session not found: 1",
    },
    turn,
  );

  // apply_patch — single update_file -> Pierre diff
  log.tool(
    {
      name: "apply_patch_call",
      id: "call-ap-0",
      raw: {
        type: "apply_patch_call",
        operation: {
          type: "update_file",
          path: "src/auth/middleware.ts",
          diff: `@@ -14,7 +14,9 @@ export function withSession(req) {
   const raw = req.cookies.get("og_token");
-  if (!raw) return redirect("/login");
-  const user = verifyToken(raw);
+  if (!raw) return redirect("/login");
+  const handle = sessionApi.resolve(raw);
+  if (!handle.valid) return redirect("/login");
+  const user = handle.user;
   return next({ ...req, user });
 }`,
        },
      },
      output: "Patch applied.",
    },
    turn,
  );
  // apply_patch — create_file
  log.tool(
    {
      name: "apply_patch_call",
      id: "call-ap-1",
      raw: {
        type: "apply_patch_call",
        operation: {
          type: "create_file",
          path: "src/auth/session.ts",
          diff: `+export const sessionApi = {
+  resolve(token: string) {
+    return { valid: true, user: decode(token) };
+  },
+};`,
        },
      },
      output: "Patch applied.",
    },
    turn,
  );
  // apply_patch — multi-file (operations[])
  log.tool(
    {
      name: "apply_patch_call",
      id: "call-ap-2",
      raw: {
        type: "apply_patch_call",
        operations: [
          {
            type: "update_file",
            path: "src/routes/login.tsx",
            diff: `@@ -1,3 +1,4 @@\n import { sessionApi } from "../auth/session";\n+import { redirect } from "../router";\n const x = 1;`,
          },
          {
            type: "update_file",
            path: "src/routes/logout.tsx",
            diff: `@@ -8,2 +8,3 @@\n   await sessionApi.revoke(handle);\n+  return redirect("/login");`,
          },
          { type: "delete_file", path: "src/auth/legacy-token.ts", diff: "" },
        ],
      },
      output: "Patch applied.",
    },
    turn,
  );
  // apply_patch — FAILED
  log.tool(
    {
      name: "apply_patch_call",
      id: "call-ap-3",
      raw: { type: "apply_patch_call", operation: { type: "update_file", path: "src/auth/guard.ts", diff: "@@ ..." } },
      output: "Patch failed: Update File patch for src/auth/guard.ts must include a hunk.",
      error: true,
    },
    turn,
  );
  // apply_patch — malformed V4A -> raw fallback
  log.tool(
    {
      name: "apply_patch_call",
      id: "call-ap-4",
      raw: {
        type: "apply_patch_call",
        operation: {
          type: "update_file",
          path: "src/weird.ts",
          diff: `+++ this is not a valid hunk header\n+added thing\n-removed thing\nplain context with no @@ marker`,
        },
      },
      output: "Patch applied.",
    },
    turn,
  );

  // computer_call — screenshot with image
  log.tool(
    {
      name: "computer_call",
      id: "call-cc-0",
      raw: { type: "computer_call", action: { type: "screenshot" }, actions: [{ type: "screenshot" }] },
      output: SHOT_DASH,
    },
    turn,
  );
  // computer_call — click action with resulting frame
  log.tool(
    {
      name: "computer_call",
      id: "call-cc-1",
      raw: {
        type: "computer_call",
        action: { x: 425, y: 157, type: "click", button: "left" },
        actions: [{ x: 425, y: 157, type: "click", button: "left" }],
      },
      output: SHOT_LOGIN,
    },
    turn,
  );
  // computer_call — keypress + batched actions
  log.tool(
    {
      name: "computer_call",
      id: "call-cc-2",
      raw: {
        type: "computer_call",
        action: { keys: ["CTRL", "L"], type: "keypress" },
        actions: [
          { keys: ["CTRL", "L"], type: "keypress" },
          { text: "localhost:5173/login", type: "type" },
          { keys: ["ENTER"], type: "keypress" },
        ],
      },
      output: SHOT_LOGIN,
    },
    turn,
  );
  // computer_call — EMPTY screenshot output (REAL "")
  log.tool(
    {
      name: "computer_call",
      id: "call-cc-3",
      raw: { type: "computer_call", action: { type: "screenshot" }, actions: [{ type: "screenshot" }] },
      output: "",
    },
    turn,
  );
  // computer_call — read-only blocked
  log.tool(
    {
      name: "computer_call",
      id: "call-cc-4",
      raw: { type: "computer_call", action: { x: 200, y: 300, type: "click", button: "left" } },
      output: "computer-use is read-only — write actions are disabled",
    },
    turn,
  );
  // computer_call — approval rejected
  log.tool(
    {
      name: "computer_call",
      id: "call-cc-5",
      raw: { type: "computer_call", action: { x: 300, y: 400, type: "click", button: "left" }, providerData: { approvalStatus: "rejected" } },
      output: "",
    },
    turn,
  );
  // computer_call — RUNNING (skeleton)
  log.toolRunning(
    { name: "computer_call", id: "call-cc-run", raw: { type: "computer_call", action: { type: "screenshot" } } },
    turn,
  );

  // web_search — RUNNING (no output event ever)
  log.toolRunning(
    {
      name: "web_search_call",
      id: "call-ws-run",
      raw: { type: "hosted_tool_call", providerData: { action: { type: "search", query: '"naughty-engelbart"', queries: ['"naughty-engelbart"'] } } },
    },
    turn,
  );
  // web_search — complete WITH results
  log.tool(
    {
      name: "web_search_call",
      id: "call-search-0",
      raw: { type: "hosted_tool_call", providerData: { action: { type: "search", query: "signed session handle cookie SameSite best practice" } } },
      output: {
        results: [
          { title: "SameSite cookies explained", domain: "web.dev", snippet: "Lax vs Strict vs None — when to set each for session handles." },
          { title: "Secure session tokens", domain: "owasp.org", snippet: "Rotate the handle on privilege change; bind to the user agent where feasible." },
        ],
      },
    },
    turn,
  );
  // web_search — complete, folded into context (no results list)
  log.tool(
    {
      name: "web_search_call",
      id: "call-search-1",
      raw: {
        type: "hosted_tool_call",
        providerData: { action: { type: "search", query: '"naughty-engelbart" deploy log', queries: ['"naughty-engelbart" deploy log', "naughty engelbart preview"] } },
      },
      output: null,
    },
    turn,
  );

  // view_image — ok
  log.tool({ name: "view_image", id: "call-vi-0", arguments: { path: "artifacts/login-error.png" }, output: SHOT_ERR }, turn);
  // view_image — too large
  log.tool(
    {
      name: "view_image",
      id: "call-vi-1",
      arguments: { path: "artifacts/full-page.png" },
      output: "image path `artifacts/full-page.png` exceeded the allowed size of 10MB; resize or compress the image and try again",
    },
    turn,
  );
  // view_image — OpenAI file reference
  log.tool({ name: "view_image", id: "call-vi-2", arguments: { path: "uploads/spec.png" }, output: "OpenAI file reference: file-9aF2bQ" }, turn);

  // environment_set_variable — secret-safe write-only
  log.tool(
    {
      name: "environment_set_variable",
      id: "call-sec-0",
      arguments: { environmentName: "preview", name: "SESSION_SIGNING_KEY", value: "sk_live_9f2a7c1e8b4d_REDACTED" },
      output: { content: [{ type: "text", text: JSON.stringify({ variable: { name: "SESSION_SIGNING_KEY" } }, null, 2) }] },
    },
    turn,
  );
  // first-party MCP — environment_list (generic fallback)
  log.tool(
    {
      name: "environment_list",
      id: "call-mcp-0",
      arguments: {},
      output: { content: [{ type: "text", text: JSON.stringify({ environments: [{ id: "env_1", name: "preview", variables: [{ name: "DATABASE_URL" }] }] }, null, 2) }] },
    },
    turn,
  );
  // docs MCP — error (isError)
  log.tool(
    {
      name: "fetch_document_chunk",
      id: "call-mcp-1",
      arguments: { chunkId: "chk_404" },
      output: { content: [{ type: "text", text: "chunk not found: chk_404" }], isError: true },
    },
    turn,
  );
  // external MCP — linear:create_issue
  log.tool(
    {
      name: "create_issue",
      id: "call-mcp-2",
      arguments: { title: "Auth refactor follow-up", team: "ENG", priority: 2 },
      output: { content: [{ type: "text", text: 'Created ENG-482 · "Auth refactor follow-up"\nhttps://linear.app/eng/issue/ENG-482' }] },
    },
    turn,
  );
  // external MCP — RUNNING
  log.toolRunning({ name: "create_issue", id: "call-mcp-run", arguments: { title: "Flaky e2e on CI", team: "ENG" } }, turn);
  // generic / unknown tool fallback
  log.tool(
    {
      name: "workspace_provision_db",
      id: "call-gen-0",
      arguments: { engine: "postgres", size: "small", region: "eu-north" },
      output: { content: [{ type: "text", text: JSON.stringify({ id: "db_9f2a", status: "provisioning" }, null, 2) }] },
    },
    turn,
  );

  return log.events;
}

/* ----------------------------------------------------------------------------
   Segment B — workers + goal landmarks.
   -------------------------------------------------------------------------- */

export function workerGoalEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-workers";
  log.push("user.message", { text: "Spin up a browser-verify worker and set a goal for the suite." });
  log.push("goal.set", { text: "test suite green & dashboard captured" }, turn);

  // session_create -> WorkerItem (running)
  log.toolRunning(
    { name: "session_create", id: "call-wk-0", arguments: { initialMessage: "verify login flow end-to-end" } },
    turn,
  );
  // a completed worker (spawn + output carrying the worker session id)
  log.tool(
    {
      name: "session_create",
      id: "call-wk-1",
      arguments: { initialMessage: "verify login flow end-to-end" },
      output: { content: [{ type: "text", text: JSON.stringify({ sessionId: "9efcd759-1e2f-4a3b-8c4d-5e6f7a8b9c0d", status: "running" }) }] },
    },
    turn,
  );
  log.push("goal.updated", { text: "also wire CI on green" }, turn);
  log.push("goal.paused", { text: "blocked on missing GHCR pull credentials" }, turn);
  log.push("goal.resumed", { text: "credentials restored — continuing the suite" }, turn);
  log.push("goal.continuation", { text: "still wiring CI on green" }, turn);
  log.push("goal.completed", { text: "suite green (128/128), dashboard captured" }, turn);
  return log.events;
}

/* ----------------------------------------------------------------------------
   Segment C/D/E — completed / failed / cancelled turns (fold to a chip).
   These are full event runs; MessageTimeline folds them through the live pipeline.
   -------------------------------------------------------------------------- */

export function completedTurnEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-done";
  log.push("user.message", { text: "Set up the project, get the test suite green, and screenshot the dashboard." });
  log.push(
    "agent.reasoning.delta",
    { text: "I'll scaffold the repo, install deps, then run the suite. The failing tests look like a missing fixture import, so I'll patch the helper first." },
    turn,
  );
  log.tool(
    {
      name: "exec_command",
      id: "td-0",
      arguments: { cmd: "npm ci", workdir: "/workspace" },
      output: "Chunk ID: 111\nWall time: 8.1\nProcess exited with code 0\nOutput:\nadded 412 packages, audited 413 packages in 8s\nfound 0 vulnerabilities\n",
    },
    turn,
  );
  log.tool(
    {
      name: "apply_patch_call",
      id: "td-1",
      raw: {
        type: "apply_patch_call",
        operation: {
          type: "update_file",
          path: "src/lib/test-helpers.ts",
          diff: `@@ -1,2 +1,3 @@\n import { render } from "@testing-library/react";\n+import { mockSession } from "./fixtures";\n export { render };`,
        },
      },
      output: "Patch applied.",
    },
    turn,
  );
  log.tool(
    {
      name: "exec_command",
      id: "td-2",
      arguments: { cmd: "npm test", workdir: "/workspace" },
      output: "Chunk ID: 222\nWall time: 6.4\nProcess exited with code 0\nOutput:\nTest Suites: 14 passed, 14 total\nTests:       128 passed, 128 total\n",
    },
    turn,
  );
  log.tool(
    { name: "computer_call", id: "td-3", raw: { type: "computer_call", action: { type: "screenshot" } }, output: SHOT_DASH },
    turn,
  );
  log.push("turn.completed", {}, turn);
  log.push("agent.message.completed", {
    text: "Done. The suite is green (128/128) after patching the missing fixture import in `test-helpers.ts`, and here is the dashboard once it built. Want me to wire up CI next?",
  }, turn);
  return log.events;
}

export function failedTurnEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-fail";
  log.push("user.message", { text: "Deploy the preview to staging." });
  log.tool(
    {
      name: "exec_command",
      id: "tf-0",
      arguments: { cmd: "helm upgrade preview ./chart", workdir: "/workspace" },
      output:
        "Chunk ID: f1\nWall time: 120.0\nProcess exited with code 1\nOutput:\nError: UPGRADE FAILED: timed out waiting for the condition\npod opengeni-desktop-7d9: ImagePullBackOff — ghcr.io/cloudgeni/desktop:sha-abc not found (private, anonymous pull denied)\n",
    },
    turn,
  );
  log.push("turn.failed", { error: "helm upgrade failed — ImagePullBackOff (desktop image not found)" }, turn);
  return log.events;
}

export function cancelledTurnEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-cancel";
  log.push("user.message", { text: "Tail the prod logs forever." });
  log.toolRunning({ name: "exec_command", id: "tc-0", arguments: { cmd: "kubectl logs -f deploy/api", workdir: "/workspace" } }, turn);
  log.push("turn.cancelled", {}, turn);
  return log.events;
}

/* ----------------------------------------------------------------------------
   Segment F — a LIVE streaming turn (running tools, streaming final message).
   -------------------------------------------------------------------------- */

export function liveTurnEvents(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-live";
  log.push("user.message", { text: "Now run the e2e suite and confirm the login redirect." });
  log.push("agent.reasoning.delta", { text: "Running the suite now and watching for the redirect assertion…" }, turn);
  log.toolRunning({ name: "exec_command", id: "lv-0", arguments: { cmd: "npm run e2e", workdir: "/workspace" } }, turn);
  log.toolRunning({ name: "computer_call", id: "lv-1", raw: { type: "computer_call", action: { type: "screenshot" } } }, turn);
  log.push("agent.message.delta", { text: "Kicking off the e2e suite and driving the browser to the login page" }, turn);
  return log.events;
}
