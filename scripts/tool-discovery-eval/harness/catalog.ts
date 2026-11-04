import { createHash } from "node:crypto";
import type { Tool } from "@openai/agents";
import { prefixedMcpToolName } from "../../../packages/runtime/src/index";
import type { Catalog, CatalogTool } from "./types";

/**
 * Accepted files: a JSON array, `{ tools: [...] }`, or JSON Lines with one entry per line.
 * Accepted entries:
 * - `{ server, tool, description, inputSchema }`: an MCP tool as its server publishes it.
 *   The model name is derived exactly as the runtime derives it.
 * - `{ name | modelName, description, parameters | inputSchema, identity?: { serverId, toolName? } }`:
 *   a tool already under its model name, such as an attempt tool-catalog entry.
 * Either may set `eager: true` for a tool sent on every request instead of searched.
 */
type RawEntry = {
  name?: string;
  modelName?: string;
  server?: string;
  tool?: string;
  description?: string | null;
  parameters?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  identity?: { serverId?: string; toolName?: string };
  eager?: boolean;
};

const EMPTY_SCHEMA = { type: "object", properties: {} };

export function normalizedName(reference: string): string {
  return reference
    .trim()
    .toLowerCase()
    .replace(/[.\-/\s]+/g, "_");
}

export async function loadCatalog(path: string): Promise<Catalog> {
  const text = await Bun.file(path).text();
  const entries = parseEntries(text);
  const tools: CatalogTool[] = entries.map((entry, index) => {
    const server = entry.server ?? entry.identity?.serverId;
    const published = entry.tool ?? entry.identity?.toolName;
    const name =
      entry.name ??
      entry.modelName ??
      (server && published ? prefixedMcpToolName(server, published) : undefined);
    if (!name) throw new Error(`Catalog entry ${index} has neither a name nor a server and tool`);
    return {
      name,
      description: entry.description ?? "",
      parameters: entry.parameters ?? entry.inputSchema ?? EMPTY_SCHEMA,
      ...(server ? { server } : {}),
      ...(published ? { published } : {}),
      eager: entry.eager === true,
    };
  });
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new Error("The catalog has duplicate model names");
  const functionTools = tools.map(
    (t) =>
      ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }) as Tool,
  );
  // Every spelling a person or a Skill might use for a tool, mapped to its model name.
  const references = new Map<string, Set<string>>();
  const add = (reference: string, name: string) => {
    for (const key of [reference, normalizedName(reference)]) {
      const names = references.get(key) ?? new Set<string>();
      names.add(name);
      references.set(key, names);
    }
  };
  for (const tool of tools) {
    add(tool.name, tool.name);
    if (tool.published) add(tool.published, tool.name);
    if (tool.server && tool.published) add(`${tool.server}.${tool.published}`, tool.name);
  }
  return {
    tools,
    functionTools,
    sha256: createHash("sha256").update(text).digest("hex"),
    resolve(reference) {
      const exact = references.get(reference) ?? references.get(normalizedName(reference));
      return exact ? [...exact] : [];
    },
  };
}

function parseEntries(text: string): RawEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON Lines: several top-level values.
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RawEntry);
  }
  if (Array.isArray(parsed)) return parsed as RawEntry[];
  const tools = (parsed as { tools?: unknown }).tools;
  return Array.isArray(tools) ? (tools as RawEntry[]) : [parsed as RawEntry];
}
