import type { AgentSettings } from "./acme-script";
import type { ChatStyle } from "./style-knobs";

/* ----------------------------------------------------------------------------
   The code a product writes to get the playground's chat: a server route that
   keeps the API key, and the page that renders <OpenGeniChat /> with its theme
   and brand tokens right next to it. It follows docs/product-integration.md
   and updates with every playground control, so each change shows the line it
   takes.
   -------------------------------------------------------------------------- */

/** What a line depends on, so the panel can mark the lines a change touched. */
export type CodeKey = "accent" | "corners" | "theme" | "tools" | "memory" | "thinking";
export type CodeLine = Readonly<{ text: string; key?: CodeKey }>;
export type CodeFileId = "page" | "server";
export type CodeFile = Readonly<{ id: CodeFileId; name: string; lines: readonly CodeLine[] }>;

export const INSTALL_COMMAND = "npm i @opengeni/sdk @opengeni/react";

/** Which file shows a control's line: styling is on the component itself. */
export const FILE_FOR_KEY: Record<CodeKey, CodeFileId> = {
  accent: "page",
  corners: "page",
  theme: "page",
  tools: "server",
  memory: "server",
  thinking: "server",
};

const line = (text: string, key?: CodeKey): CodeLine => (key ? { text, key } : { text });

export function integrationCode(
  style: ChatStyle,
  settings: AgentSettings,
  apiOrigin: string,
): CodeFile[] {
  const page: CodeLine[] = [
    line('import { OpenGeniClient } from "@opengeni/sdk";'),
    line('import { OpenGeniChat, OpenGeniProvider } from "@opengeni/react/session-ui";'),
    line('import "@opengeni/react/compiled.css";'),
    line(""),
    line('const client = new OpenGeniClient({ baseUrl: "/api/opengeni" });'),
    line(""),
    line("export const Support = ({ workspaceId }) => ("),
    line("  <OpenGeniProvider client={client} workspaceId={workspaceId}>"),
    line("    <div"),
    style.theme === "light"
      ? line('      data-og-theme="light"', "theme")
      : line("      /* dark is the default theme */", "theme"),
    line("      style={{"),
    line(`        "--og-color-accent": "${style.accent.value}",`, "accent"),
    line(`        "--og-color-primary": "${style.accent.value}",`, "accent"),
    line(`        "--og-radius-md": "${style.corners.md}px",`, "corners"),
    line(`        "--og-radius-lg": "${style.corners.lg}px",`, "corners"),
    line("      }}"),
    line("    >"),
    line("      <OpenGeniChat />"),
    line("    </div>"),
    line("  </OpenGeniProvider>"),
    line(");"),
  ];
  const server: CodeLine[] = [
    line('import { OpenGeniClient, createSessionProxyHandler } from "@opengeni/sdk";'),
    line(""),
    line("const og = new OpenGeniClient({"),
    line(`  baseUrl: "${apiOrigin}",`),
    line("  apiKey: process.env.OPENGENI_API_KEY, // stays on your server"),
    line("});"),
    line(""),
    line("// Your page talks to /api/opengeni, as the signed-in user"),
    line("export const handler = createSessionProxyHandler(og, {"),
    line('  resolve: async (req) => ({ workspaceId, user: await userId(req), source: "acme" }),'),
    ...(settings.memory ? [line('  chats: "private", // memory is per customer', "memory")] : []),
    line("  createSession: (chat) => ({"),
    line("    ...chat,"),
    line(`    reasoningEffort: "${settings.thinking ? "high" : "low"}",`, "thinking"),
    settings.memory
      ? line('    agent: { capabilities: { from: "none", knowledge: true } },', "memory")
      : line('    agent: { capabilities: "none" },', "memory"),
    ...(settings.tools
      ? [line('    mcpServers: [{ id: "acme", url: "https://acme.com/mcp" }],', "tools")]
      : []),
    line("  }),"),
    line("});"),
  ];
  return [
    { id: "page", name: "Support.jsx", lines: page },
    { id: "server", name: "server.ts", lines: server },
  ];
}

/** The plain text of a file, for copying. */
export function codeText(file: CodeFile): string {
  return file.lines.map((entry) => entry.text).join("\n");
}

/**
 * The lines a change added or edited, per file: what the panel marks so a
 * visitor sees the one line their click took.
 */
export function changedLines(
  previous: readonly CodeFile[],
  next: readonly CodeFile[],
): Partial<Record<CodeFileId, number[]>> {
  const out: Partial<Record<CodeFileId, number[]>> = {};
  for (const file of next) {
    const before = previous.find((candidate) => candidate.id === file.id);
    if (!before) continue;
    const seen = new Set(before.lines.map((entry) => entry.text));
    const changed = file.lines.flatMap((entry, index) => (seen.has(entry.text) ? [] : [index]));
    if (changed.length > 0) out[file.id] = changed;
  }
  return out;
}
