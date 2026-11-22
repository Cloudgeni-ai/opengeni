import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/* ----------------------------------------------------------------------------
   `opengeni connect`: add the Opengeni MCP server to the coding agents on
   this computer (Claude Code, Codex, Cursor, VS Code with Copilot) and
   install a short Opengeni skill for them. Each agent signs in through the
   browser with Opengeni's own sign-in the first time it uses the server,
   where the person picks the organization and what the agent may do; this
   command never handles a credential.
   -------------------------------------------------------------------------- */

export const CONNECT_CLIENTS = ["claude", "codex", "cursor", "vscode"] as const;
export type ConnectClient = (typeof CONNECT_CLIENTS)[number];

const CLIENT_LABELS: Record<ConnectClient, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code (Copilot)",
};

/** The short skill every agent gets: when to hand work to Opengeni, and how. */
export const OPENGENI_CONNECT_SKILL = `---
name: opengeni
description: >-
  Hand work to Opengeni agents in the cloud and use the Opengeni workspace's
  apps, tools, Skills and Knowledge. Use when the user asks to run something
  in the cloud, in the background or in parallel, "on Opengeni", to check on
  or follow up an Opengeni chat, to share Skills, Knowledge, apps or files
  with the workspace, or to change its schedules or agents.
---

# Opengeni

The \`opengeni\` MCP server runs agents in the user's Opengeni workspace, each
with its own cloud sandbox and connected tools. The remote agent doesn't see
this conversation or this computer: give it a self-contained brief.

- **Delegate**: \`delegate\` with \`message\` (goal, repository and branch,
  constraints, acceptance checks, what to deliver), optionally \`repository\`
  (owner/name), \`branch\`, \`agent\` (name or id from \`agents_list\`) and
  \`sandboxEnvironment\`. Push local commits the work needs first, with the
  user's permission. Report the returned \`url\`.
- **Follow**: \`wait_for\` with the \`sessionId\` and \`cursor\`; call again with
  the new cursor until \`done\` is true, then relay \`finalAnswer\`.
  \`needs_attention\` means the user must answer in the chat: give them the url.
  Stopping your wait doesn't stop the chat; \`session_pause\` does.
- **Follow up**: \`session_send\`, then \`wait_for\` with its cursor and turnId.
- **Apps**: \`apps_list\`, \`app_describe\`, \`app_query\`, \`app_write\`.
- **Share**: \`app_save\` (an app or a new version), \`app_publish\` (who can
  open it), \`file_save\` (a file and its link).
- **Tools**: \`tools_search\`, then \`tool_call\`. If it returns
  \`needsApproval\`, show the user \`approvalUrl\`; after they approve, call again
  with the same \`operationId\`.
- **Skills and Knowledge**: \`skills_sync\` uploads local Skill folders as
  Personal unless \`scope\` is \`workspace\` or \`organization\` (which may wait
  for review, per the workspace's Agent learning setting);
  \`direction: "pull"\` gets the workspace's Skills; \`direction: "repository"\`
  syncs a GitHub repository's Skill folders. Knowledge:
  \`knowledge_search\`, \`knowledge_get\`, \`knowledge_save\`.
- **Schedules, agents and workspace instructions**: change them with
  \`opengeni_actions_search\`, then \`opengeni_action_call\`.
- Several workspaces: pass \`workspaceId\`, or \`workspace_use\` once.

Retrying a call with the same input doesn't start the work twice. Never put
secrets in a message. If a tool reports the connection isn't signed in, ask
the user to sign in to the \`opengeni\` MCP server in this agent.
`;

export type ConnectDeps = {
  home: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  exists(path: string): boolean;
  read(path: string): string | null;
  write(path: string, content: string): void;
  /** Runs a command; null when it isn't installed. */
  run(command: string, args: readonly string[]): { status: number; output: string } | null;
};

export const nodeConnectDeps = (
  env: Readonly<Record<string, string | undefined>>,
): ConnectDeps => ({
  home: homedir(),
  platform: process.platform,
  env,
  exists: existsSync,
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  write: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    // Whole or not at all: an agent's config is never left half written.
    const temporary = `${path}.opengeni-${process.pid}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  },
  run: (command, args) => {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  },
});

export type ConnectStep = {
  client: ConnectClient;
  label: string;
  status: "configured" | "already" | "manual" | "failed";
  detail: string;
};

export function mcpServerUrl(baseUrl: string): string {
  return new URL("/v1/mcp", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
}

function vscodeUserDir(deps: ConnectDeps): string {
  if (deps.platform === "darwin")
    return join(deps.home, "Library", "Application Support", "Code", "User");
  if (deps.platform === "win32")
    return join(deps.env.APPDATA ?? join(deps.home, "AppData", "Roaming"), "Code", "User");
  return join(deps.env.XDG_CONFIG_HOME ?? join(deps.home, ".config"), "Code", "User");
}

/** The clients that look installed here: their config folder exists. */
export function detectClients(deps: ConnectDeps): ConnectClient[] {
  const found: ConnectClient[] = [];
  if (deps.exists(join(deps.home, ".claude")) || deps.exists(join(deps.home, ".claude.json")))
    found.push("claude");
  if (deps.exists(join(deps.home, ".codex"))) found.push("codex");
  if (deps.exists(join(deps.home, ".cursor"))) found.push("cursor");
  if (deps.exists(vscodeUserDir(deps))) found.push("vscode");
  return found;
}

/** JSON with line and block comments and trailing commas, as editors allow. */
function parseJsonc(text: string): unknown {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = index;
      const match = end.exec(text);
      if (!match) throw new Error("it has an unterminated string");
      out += match[0];
      index += match[0].length - 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? text.length : close + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, "$1"));
}

/**
 * Add one server to a JSON config's server map, keeping everything else. A
 * different `opengeni` entry is the person's to change (a conflict), and a
 * file with comments is left for them to edit (`manual`), so nothing they
 * wrote is lost.
 */
export function withJsonServer(
  existing: string | null,
  mapKey: "mcpServers" | "servers",
  server: Record<string, unknown>,
): { content: string; changed: boolean; conflict?: boolean; manual?: boolean } {
  let config: Record<string, unknown> = {};
  let commented = false;
  if (existing && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      parsed = parseJsonc(existing);
      commented = true;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("it isn't a JSON object");
    config = parsed as Record<string, unknown>;
  }
  const servers =
    config[mapKey] && typeof config[mapKey] === "object" && !Array.isArray(config[mapKey])
      ? (config[mapKey] as Record<string, unknown>)
      : {};
  const current = servers.opengeni as Record<string, unknown> | undefined;
  if (current !== undefined) {
    const same = Object.entries(server).every(
      ([key, value]) => JSON.stringify(current?.[key]) === JSON.stringify(value),
    );
    return { content: existing ?? "", changed: false, conflict: !same };
  }
  if (commented) return { content: existing ?? "", changed: false, manual: true };
  config[mapKey] = { ...servers, opengeni: server };
  return { content: `${JSON.stringify(config, null, 2)}\n`, changed: true };
}

/** Add the server to a Codex config.toml, or report that one is already there. */
export function withCodexServer(
  existing: string | null,
  url: string,
): { content: string; changed: boolean; conflict: boolean } {
  const text = existing ?? "";
  const header = /^\[mcp_servers\.opengeni\]\s*$/mu;
  // Other ways TOML can name the same server: a quoted table, dotted keys,
  // or an inline table. Never add a second one; report it instead.
  const otherForms = [
    /^\s*\[\s*mcp_servers\s*\.\s*["']opengeni["']\s*\]/mu,
    /^\s*mcp_servers\s*\.\s*["']?opengeni["']?\s*[.=]/mu,
    /^\s*\[\s*mcp_servers\s*\][^[]*^\s*["']?opengeni["']?\s*[.=]/msu,
  ];
  if (!header.test(text) && otherForms.some((form) => form.test(text)))
    return { content: text, changed: false, conflict: !text.includes(JSON.stringify(url)) };
  if (header.test(text)) {
    const section = text.split(header)[1]!.split(/^\[/mu)[0]!;
    const same = section.includes(`url = ${JSON.stringify(url)}`);
    return { content: text, changed: false, conflict: !same };
  }
  const separator = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return {
    content: `${text}${separator}[mcp_servers.opengeni]\nurl = ${JSON.stringify(url)}\n`,
    changed: true,
    conflict: false,
  };
}

/** A JSON config this command must not rewrite, as the step that says what to do. */
function jsonBlocked(
  step: (status: ConnectStep["status"], detail: string) => ConnectStep,
  path: string,
  next: { conflict?: boolean; manual?: boolean },
  entry: string,
  mapKey: string,
): ConnectStep | null {
  if (next.conflict)
    return step(
      "manual",
      `${path} already has an opengeni server with other settings. Change it to ${entry}.`,
    );
  if (next.manual)
    return step(
      "manual",
      `${path} has comments, so it was left as is. Add ${entry} under "${mapKey}".`,
    );
  return null;
}

function writeSkill(deps: ConnectDeps, directory: string): boolean {
  const path = join(directory, "opengeni", "SKILL.md");
  if (deps.read(path) === OPENGENI_CONNECT_SKILL) return false;
  deps.write(path, OPENGENI_CONNECT_SKILL);
  return true;
}

export function connectClient(
  deps: ConnectDeps,
  client: ConnectClient,
  url: string,
  options: { skill: boolean; signIn: boolean },
): ConnectStep {
  const label = CLIENT_LABELS[client];
  const step = (status: ConnectStep["status"], detail: string): ConnectStep => ({
    client,
    label,
    status,
    detail,
  });
  try {
    let configured: "configured" | "already" = "already";
    let signInNote = "";
    if (client === "claude") {
      const listed = deps.run("claude", ["mcp", "get", "opengeni"]);
      if (listed === null)
        return step(
          "manual",
          `Claude Code's command isn't on PATH. Run: claude mcp add --transport http --scope user opengeni ${url}`,
        );
      if (listed.status === 0 && !listed.output.includes(url))
        return step(
          "manual",
          `Claude Code already has an opengeni server with another URL. Remove it (claude mcp remove opengeni) and run connect again, or point it at ${url}.`,
        );
      if (listed.status !== 0) {
        const added = deps.run("claude", [
          "mcp",
          "add",
          "--transport",
          "http",
          "--scope",
          "user",
          "opengeni",
          url,
        ]);
        if (!added || added.status !== 0)
          return step("failed", `claude mcp add failed: ${added?.output.trim() || "no output"}`);
        configured = "configured";
      }
      signInNote = " In Claude Code, type /mcp and sign in to opengeni.";
      if (options.skill) writeSkill(deps, join(deps.home, ".claude", "skills"));
    } else if (client === "codex") {
      const path = join(deps.home, ".codex", "config.toml");
      const next = withCodexServer(deps.read(path), url);
      if (next.conflict)
        return step(
          "manual",
          `${path} already has an [mcp_servers.opengeni] with another URL. Change its url to ${url}.`,
        );
      if (next.changed) {
        deps.write(path, next.content);
        configured = "configured";
      }
      if (options.signIn) {
        const login = deps.run("codex", ["mcp", "login", "opengeni"]);
        signInNote =
          login && login.status === 0 ? " Signed in." : " Run codex mcp login opengeni to sign in.";
      } else signInNote = " Run codex mcp login opengeni to sign in.";
      if (options.skill) writeSkill(deps, join(deps.home, ".agents", "skills"));
    } else if (client === "cursor") {
      const path = join(deps.home, ".cursor", "mcp.json");
      const next = withJsonServer(deps.read(path), "mcpServers", { url });
      const blocked = jsonBlocked(
        step,
        path,
        next,
        `"opengeni": { "url": "${url}" }`,
        "mcpServers",
      );
      if (blocked) return blocked;
      if (next.changed) {
        deps.write(path, next.content);
        configured = "configured";
      }
      signInNote = " In Cursor Settings > MCP, select Connect next to opengeni.";
      if (options.skill) writeSkill(deps, join(deps.home, ".cursor", "skills"));
    } else {
      const path = join(vscodeUserDir(deps), "mcp.json");
      const next = withJsonServer(deps.read(path), "servers", {
        type: "http",
        url,
      });
      const blocked = jsonBlocked(
        step,
        path,
        next,
        `"opengeni": { "type": "http", "url": "${url}" }`,
        "servers",
      );
      if (blocked) return blocked;
      if (next.changed) {
        deps.write(path, next.content);
        configured = "configured";
      }
      signInNote = " VS Code asks you to sign in the first time Copilot uses it.";
      if (options.skill) writeSkill(deps, join(deps.home, ".copilot", "skills"));
    }
    return step(
      configured,
      `${configured === "configured" ? "Added" : "Already has"} the opengeni server.${signInNote}`,
    );
  } catch (error) {
    return step("failed", error instanceof Error ? error.message : String(error));
  }
}

export function parseClients(value: string | undefined): ConnectClient[] | string {
  if (value === undefined) return [];
  const wanted = value
    .split(",")
    .map((each) => each.trim().toLowerCase())
    .filter(Boolean)
    .map((each) =>
      each === "copilot" || each === "vs-code"
        ? "vscode"
        : each === "claude-code"
          ? "claude"
          : each,
    );
  if (wanted.includes("all")) return [...CONNECT_CLIENTS];
  const unknown = wanted.filter((each) => !(CONNECT_CLIENTS as readonly string[]).includes(each));
  if (unknown.length > 0)
    return `unknown client ${unknown.join(", ")}; use ${CONNECT_CLIENTS.join(", ")} or all.`;
  return [...new Set(wanted)] as ConnectClient[];
}

export function runConnect(
  deps: ConnectDeps,
  input: {
    baseUrl: string;
    clients: ConnectClient[];
    skill: boolean;
    signIn: boolean;
  },
  io: { stdout(text: string): void; stderr(text: string): void },
): number {
  const url = mcpServerUrl(input.baseUrl);
  const clients = input.clients.length > 0 ? input.clients : detectClients(deps);
  if (clients.length === 0) {
    io.stderr(
      `No coding agent found here. Pass --client ${CONNECT_CLIENTS.join(",")} to set one up anyway.\n`,
    );
    return 1;
  }
  io.stdout(`Connecting to ${url}\n`);
  let failed = false;
  for (const client of clients) {
    const step = connectClient(deps, client, url, input);
    failed ||= step.status === "failed";
    io.stdout(`  ${step.label}: ${step.detail}\n`);
  }
  io.stdout(
    `\nEach agent opens Opengeni sign-in in your browser the first time, where you pick the organization and what it may do.${input.skill ? " The opengeni skill tells each agent when to hand work over." : ""}\n`,
  );
  return failed ? 1 : 0;
}
