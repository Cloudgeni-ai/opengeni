/**
 * Tool/event payload factories adapted from packages/react/demo/timeline-fixtures.ts.
 * Shapes stay under the ~64 KiB session_events payload cap (aim ~60 KiB max).
 */

const HUGE_LINES = Array.from(
  { length: 80 },
  (_, i) =>
    `  installed package-${String(i).padStart(3, "0")}@${(i % 4) + 1}.${i % 9}.${(i * 3) % 9}`,
).join("\n");

function screenshot(title: string, kind: "dash" | "login" | "err"): string {
  const body =
    kind === "dash"
      ? `<rect x="24" y="70" width="170" height="90" rx="8" fill="#1f2733"/>`
      : `<rect x="180" y="84" width="222" height="210" rx="10" fill="#1a212b"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="582" height="320"><rect width="582" height="320" fill="#0e141c"/><text x="120" y="26" fill="#67768c" font-size="11">${title}</text>${body}</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

export const SHOT_DASH = screenshot("localhost:5173/dashboard", "dash");
export const SHOT_LOGIN = screenshot("localhost:5173/login", "login");
export const SHOT_ERR = screenshot("localhost:5173/login x invalid", "err");

/** Near-cap string (~55–58 KiB) for payload-heavy / truncated cases. */
export function fatText(seed: number, targetBytes = 55_000): string {
  const unit = `line-${seed}-abcdefghijklmnopqrstuvwxyz0123456789\n`;
  const repeats = Math.ceil(targetBytes / unit.length);
  return unit.repeat(repeats).slice(0, targetBytes);
}

export type ToolSpec = {
  name: string;
  id: string;
  arguments?: unknown;
  raw?: unknown;
  output?: unknown;
  error?: boolean;
  running?: boolean;
};

export function execOk(id: string, cmd: string): ToolSpec {
  return {
    name: "exec_command",
    id,
    arguments: { cmd, workdir: "/workspace" },
    output: `Chunk ID: ${id.slice(0, 6)}\nWall time: 0.4200 seconds\nProcess exited with code 0\nOutput:\nok\n`,
  };
}

export function execFail(id: string, cmd: string): ToolSpec {
  return {
    name: "exec_command",
    id,
    arguments: { cmd, workdir: "/workspace" },
    output: `Chunk ID: ${id.slice(0, 6)}\nWall time: 0.3100 seconds\nProcess exited with code 6\nOutput:\ncurl: (6) Could not resolve host\n`,
  };
}

export function execHuge(id: string): ToolSpec {
  return {
    name: "exec_command",
    id,
    arguments: { cmd: "npm ci --verbose", workdir: "/workspace" },
    output: `Chunk ID: aaa111\nWall time: 18.4400 seconds\nProcess exited with code 0\nOutput:\nTotal output lines: 412\n${HUGE_LINES}\n...3200 tokens truncated...\nadded 412 packages\n`,
  };
}

export function execFat(id: string, seed: number): ToolSpec {
  return {
    name: "exec_command",
    id,
    arguments: { cmd: "cat /tmp/fat.log", workdir: "/workspace" },
    output: `Chunk ID: fat\nWall time: 2.0\nProcess exited with code 0\nOutput:\n${fatText(seed)}\n`,
  };
}

export function execRunning(id: string, cmd: string): ToolSpec {
  return {
    name: "exec_command",
    id,
    arguments: { cmd, workdir: "/workspace" },
    running: true,
  };
}

export function writeStdin(id: string): ToolSpec {
  return {
    name: "write_stdin",
    id,
    arguments: { session_id: 1, chars: "\u0003" },
    output:
      "Chunk ID: ccc333\nWall time: 1.0010 seconds\nProcess exited with code 130\nOutput:\n^C\n",
  };
}

export function applyPatch(id: string, path: string, n: number): ToolSpec {
  return {
    name: "apply_patch_call",
    id,
    raw: {
      type: "apply_patch_call",
      operation: {
        type: "update_file",
        path,
        diff: `@@ -1,3 +1,4 @@\n import { x } from "./y";\n+const n = ${n};\n export const z = 1;`,
      },
    },
    output: "Patch applied.",
  };
}

export function applyPatchFail(id: string): ToolSpec {
  return {
    name: "apply_patch_call",
    id,
    raw: {
      type: "apply_patch_call",
      operation: { type: "update_file", path: "src/auth/guard.ts", diff: "@@ ..." },
    },
    output: "Patch failed: Update File patch must include a hunk.",
    error: true,
  };
}

export function computerScreenshot(id: string, shot: string = SHOT_DASH): ToolSpec {
  return {
    name: "computer_call",
    id,
    raw: {
      type: "computer_call",
      action: { type: "screenshot" },
      actions: [{ type: "screenshot" }],
    },
    output: shot,
  };
}

export function computerClick(id: string): ToolSpec {
  return {
    name: "computer_call",
    id,
    raw: {
      type: "computer_call",
      action: { x: 425, y: 157, type: "click", button: "left" },
      actions: [{ x: 425, y: 157, type: "click", button: "left" }],
    },
    output: SHOT_LOGIN,
  };
}

export function computerRunning(id: string): ToolSpec {
  return {
    name: "computer_call",
    id,
    raw: { type: "computer_call", action: { type: "screenshot" } },
    running: true,
  };
}

export function webSearch(id: string, query: string): ToolSpec {
  return {
    name: "web_search_call",
    id,
    raw: {
      type: "hosted_tool_call",
      providerData: { action: { type: "search", query } },
    },
    output: {
      results: [
        {
          title: "SameSite cookies explained",
          domain: "web.dev",
          snippet: "Lax vs Strict vs None — when to set each for session handles.",
        },
        {
          title: "Secure session tokens",
          domain: "owasp.org",
          snippet: "Rotate the handle on privilege change.",
        },
      ],
    },
  };
}

export function webSearchRunning(id: string, query: string): ToolSpec {
  return {
    name: "web_search_call",
    id,
    raw: {
      type: "hosted_tool_call",
      providerData: {
        action: { type: "search", query, queries: [query] },
      },
    },
    running: true,
  };
}

export function viewImage(id: string, ok = true): ToolSpec {
  return ok
    ? {
        name: "view_image",
        id,
        arguments: { path: "artifacts/login-error.png" },
        output: SHOT_ERR,
      }
    : {
        name: "view_image",
        id,
        arguments: { path: "artifacts/full-page.png" },
        output:
          "image path `artifacts/full-page.png` exceeded the allowed size of 10MB; resize or compress",
      };
}

export function envSecret(id: string): ToolSpec {
  return {
    name: "environment_set_variable",
    id,
    arguments: {
      environmentName: "preview",
      name: "SESSION_SIGNING_KEY",
      value: "sk_live_REDACTED",
    },
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ variable: { name: "SESSION_SIGNING_KEY" } }, null, 2),
        },
      ],
    },
  };
}

export function mcpOk(id: string): ToolSpec {
  return {
    name: "environment_list",
    id,
    arguments: {},
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            environments: [{ id: "env_1", name: "preview", variables: [{ name: "DATABASE_URL" }] }],
          }),
        },
      ],
    },
  };
}

export function mcpError(id: string): ToolSpec {
  return {
    name: "fetch_document_chunk",
    id,
    arguments: { chunkId: "chk_404" },
    output: { content: [{ type: "text", text: "chunk not found: chk_404" }], isError: true },
    error: true,
  };
}

export function mcpIssue(id: string, title: string): ToolSpec {
  return {
    name: "create_issue",
    id,
    arguments: { title, team: "ENG", priority: 2 },
    output: {
      content: [
        {
          type: "text",
          text: `Created ENG-482 · "${title}"\nhttps://linear.app/eng/issue/ENG-482`,
        },
      ],
    },
  };
}

export function sessionCreate(id: string, childSessionId: string, message: string): ToolSpec {
  return {
    // Live wire uses the prefixed first-party MCP name.
    name: "opengeni__session_create",
    id,
    arguments: { initialMessage: message },
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sessionId: childSessionId, status: "running" }),
        },
      ],
    },
  };
}

export function sessionCreateRunning(id: string, message: string): ToolSpec {
  return {
    name: "opengeni__session_create",
    id,
    arguments: { initialMessage: message },
    running: true,
  };
}

export function sessionSendMessage(id: string, childSessionId: string, text: string): ToolSpec {
  return {
    name: "opengeni__session_send_message",
    id,
    arguments: { sessionId: childSessionId, text },
    output: {
      content: [{ type: "text", text: JSON.stringify({ ok: true, sessionId: childSessionId }) }],
    },
  };
}

export function genericTool(id: string): ToolSpec {
  return {
    name: "workspace_provision_db",
    id,
    arguments: { engine: "postgres", size: "small", region: "eu-north" },
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "db_9f2a", status: "provisioning" }),
        },
      ],
    },
  };
}

/** Full tool-tour catalog (one of each special renderer × key states). */
export function toolTourSpecs(id: (label: string) => string): ToolSpec[] {
  return [
    execOk(id("exec-0"), "/opt/chrome/chrome --headless &"),
    execFail(id("exec-1"), "curl -fsS https://internal.invalid/health"),
    {
      name: "exec_command",
      id: id("exec-2"),
      arguments: { cmd: "npm run dev", workdir: "/workspace", tty: true },
      output:
        "Chunk ID: 778899\nWall time: 1.0040 seconds\nProcess running with session ID 1\nOutput:\n  VITE ready\n",
    },
    {
      name: "exec_command",
      id: id("exec-3"),
      arguments: { cmd: "mkdir -p artifacts", workdir: "/workspace" },
      output: "Chunk ID: 0a0b0c\nWall time: 0.0050 seconds\nProcess exited with code 0\nOutput:\n",
    },
    execHuge(id("exec-4")),
    {
      name: "exec_command",
      id: id("exec-5"),
      arguments: { cmd: "cat /tmp/chrome.bin | head -c 200", workdir: "/tmp" },
      output:
        "Chunk ID: bbb222\nWall time: 0.0200 seconds\nProcess exited with code 0\nOutput:\n\u0000\u0001\u0002binary\u0000blob",
    },
    execRunning(id("exec-run"), "npm run e2e"),
    writeStdin(id("ws-0")),
    {
      name: "write_stdin",
      id: id("ws-1"),
      arguments: { session_id: 1, chars: "ls\n" },
      output: "write_stdin failed: session not found: 1",
    },
    applyPatch(id("ap-0"), "src/auth/middleware.ts", 1),
    {
      name: "apply_patch_call",
      id: id("ap-1"),
      raw: {
        type: "apply_patch_call",
        operation: {
          type: "create_file",
          path: "src/auth/session.ts",
          diff: "+export const sessionApi = { resolve() { return { valid: true }; } };",
        },
      },
      output: "Patch applied.",
    },
    {
      name: "apply_patch_call",
      id: id("ap-2"),
      raw: {
        type: "apply_patch_call",
        operations: [
          {
            type: "update_file",
            path: "src/routes/login.tsx",
            diff: '@@ -1,3 +1,4 @@\n import { sessionApi } from "../auth/session";\n+import { redirect } from "../router";\n',
          },
          { type: "delete_file", path: "src/auth/legacy-token.ts", diff: "" },
        ],
      },
      output: "Patch applied.",
    },
    applyPatchFail(id("ap-3")),
    computerScreenshot(id("cc-0")),
    computerClick(id("cc-1")),
    {
      name: "computer_call",
      id: id("cc-2"),
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
    {
      name: "computer_call",
      id: id("cc-3"),
      raw: {
        type: "computer_call",
        action: { type: "screenshot" },
        actions: [{ type: "screenshot" }],
      },
      output: "",
    },
    {
      name: "computer_call",
      id: id("cc-4"),
      raw: { type: "computer_call", action: { x: 200, y: 300, type: "click", button: "left" } },
      output: "computer-use is read-only — write actions are disabled",
    },
    computerRunning(id("cc-run")),
    webSearchRunning(id("search-run"), '"naughty-engelbart"'),
    webSearch(id("search-0"), "signed session handle cookie SameSite"),
    {
      name: "web_search_call",
      id: id("search-1"),
      raw: {
        type: "hosted_tool_call",
        providerData: {
          action: {
            type: "search",
            query: '"naughty-engelbart" deploy log',
            queries: ['"naughty-engelbart" deploy log'],
          },
        },
      },
      output: null,
    },
    viewImage(id("vi-0"), true),
    viewImage(id("vi-1"), false),
    {
      name: "view_image",
      id: id("vi-2"),
      arguments: { path: "uploads/spec.png" },
      output: "OpenAI file reference: file-9aF2bQ",
    },
    envSecret(id("sec-0")),
    mcpOk(id("mcp-0")),
    mcpError(id("mcp-1")),
    mcpIssue(id("mcp-2"), "Auth refactor follow-up"),
    {
      name: "create_issue",
      id: id("mcp-run"),
      arguments: { title: "Flaky e2e on CI", team: "ENG" },
      running: true,
    },
    genericTool(id("gen-0")),
  ];
}
