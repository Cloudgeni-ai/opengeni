import { describe, expect, test } from "bun:test";

import * as sdk from "@opengeni/sdk";
import * as sessionUi from "@opengeni/react/session-ui";

import { DEFAULT_AGENT_SETTINGS } from "./acme-script";
import {
  FILE_FOR_KEY,
  INSTALL_COMMAND,
  changedLines,
  codeText,
  integrationCode,
  type CodeFile,
  type CodeFileId,
} from "./integration-code";
import { ACCENTS, CORNERS, defaultChatStyle } from "./style-knobs";

const ORIGIN = "https://app.opengeni.ai";
const style = defaultChatStyle("dark");
const text = (files: CodeFile[], id: CodeFileId) => codeText(files.find((file) => file.id === id)!);

describe("playground integration code", () => {
  test("is the documented integration: key on the server, OpenGeniChat on the page", () => {
    const files = integrationCode(style, DEFAULT_AGENT_SETTINGS, ORIGIN);
    expect(files.map((file) => file.name)).toEqual(["server.ts", "Support.tsx", "styles.css"]);
    const server = text(files, "server");
    expect(server).toContain(`baseUrl: "${ORIGIN}"`);
    expect(server).toContain("apiKey: process.env.OPENGENI_API_KEY");
    expect(server).toContain("createSessionProxyHandler(og, {");
    expect(server).toContain('agent: { capabilities: "none" }');
    expect(server).toContain('reasoningEffort: "low"');
    expect(server).not.toContain("mcpServers");
    const page = text(files, "page");
    expect(page).toContain('new OpenGeniClient({ baseUrl: "/api/opengeni" })');
    expect(page).toContain("<OpenGeniChat />");
    expect(page).not.toContain("apiKey");
    expect(page).not.toContain("data-og-theme");
    expect(text(files, "styles")).toContain(`--og-color-accent: ${style.accent.value};`);
    expect(INSTALL_COMMAND).toBe("npm i @opengeni/sdk @opengeni/react");
  });

  test("names only exports the packages really have", () => {
    expect(typeof sdk.OpenGeniClient).toBe("function");
    expect(typeof sdk.createSessionProxyHandler).toBe("function");
    expect(typeof sessionUi.OpenGeniChat).toBe("function");
    expect(typeof sessionUi.OpenGeniProvider).toBe("function");
  });

  test("each setting writes its line", () => {
    const all = integrationCode(
      { accent: ACCENTS[1]!, corners: CORNERS[2]!, theme: "light" },
      { tools: true, memory: true, thinking: true },
      ORIGIN,
    );
    const server = text(all, "server");
    expect(server).toContain('mcpServers: [{ id: "acme", url: "https://acme.com/mcp" }]');
    expect(server).toContain('agent: { capabilities: { from: "none", knowledge: true } }');
    expect(server).toContain('chats: "private"');
    expect(server).toContain('reasoningEffort: "high"');
    expect(text(all, "page")).toContain('data-og-theme="light"');
    expect(text(all, "styles")).toContain(`--og-color-accent: ${ACCENTS[1]!.value};`);
    expect(text(all, "styles")).toContain(`--og-radius-lg: ${CORNERS[2]!.lg}px;`);
    // Every keyed line lives in the file the panel opens for that control.
    for (const file of all)
      for (const line of file.lines) if (line.key) expect(FILE_FOR_KEY[line.key]).toBe(file.id);
  });

  test("marks only the lines a change touched", () => {
    const before = integrationCode(style, DEFAULT_AGENT_SETTINGS, ORIGIN);
    const recolored = integrationCode(
      { ...style, accent: ACCENTS[2]! },
      DEFAULT_AGENT_SETTINGS,
      ORIGIN,
    );
    expect(changedLines(before, recolored)).toEqual({ styles: [1, 2] });
    const tooled = integrationCode(style, { ...DEFAULT_AGENT_SETTINGS, tools: true }, ORIGIN);
    const changed = changedLines(before, tooled);
    expect(Object.keys(changed)).toEqual(["server"]);
    const server = tooled.find((file) => file.id === "server")!;
    expect(changed.server!.map((index) => server.lines[index]!.key)).toEqual(["tools"]);
    const lit = integrationCode({ ...style, theme: "light" }, DEFAULT_AGENT_SETTINGS, ORIGIN);
    expect(Object.keys(changedLines(before, lit))).toEqual(["page"]);
    expect(changedLines(before, before)).toEqual({});
  });
});
