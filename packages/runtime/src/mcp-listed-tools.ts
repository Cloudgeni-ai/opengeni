import { createHash } from "node:crypto";

type ListedMcpTool = { name: string };

/**
 * One entry per tool name, keeping the first. A remote server can list a name
 * more than once: the SDK concatenates `tools/list` pages as returned, so a
 * server whose list changes while pages are fetched (offset cursors) repeats
 * the tools that shifted across a page boundary. MCP addresses tools by name,
 * so a repeat can only ever reach the same server tool; keeping one is exact.
 * A repeat whose definition differs is still collapsed, and logged, because
 * the server will run the one tool of that name whatever schema it showed.
 */
export function uniqueListedMcpTools<T extends ListedMcpTool>(
  serverId: string,
  tools: readonly T[],
): T[] {
  const first = new Map<string, { tool: T; digest: string | null }>();
  const unique: T[] = [];
  let repeated = 0;
  const repeatedNames = new Set<string>();
  const conflicting = new Set<string>();
  for (const tool of tools) {
    const seen = first.get(tool.name);
    if (!seen) {
      first.set(tool.name, { tool, digest: null });
      unique.push(tool);
      continue;
    }
    repeated += 1;
    repeatedNames.add(tool.name);
    seen.digest ??= listedToolDigest(seen.tool);
    if (listedToolDigest(tool) !== seen.digest && conflicting.size < 16) {
      conflicting.add(tool.name.slice(0, 256));
    }
  }
  if (repeated > 0) {
    console.warn("[mcp] server listed some tools more than once; keeping the first of each", {
      event: "mcp_tools_list_duplicates",
      serverId,
      repeated,
      names: [...repeatedNames].slice(0, 16).map((name) => name.slice(0, 256)),
      ...(conflicting.size > 0 ? { conflicting: [...conflicting] } : {}),
    });
  }
  return unique;
}

function listedToolDigest(tool: ListedMcpTool): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(tool) ?? "";
  } catch {
    serialized = tool.name;
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * The pattern Zod emits beside `format: "uuid"` for a field that accepts any
 * 8-4-4-4-12 hexadecimal UUID (`z.guid()`). It states exactly what the format
 * states, so listing both only costs tokens.
 */
const ANY_HEX_UUID_PATTERN =
  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$";

/**
 * A first-party tool's input schema without the regular expression that only
 * repeats `format: "uuid"`. The server's own schema still validates every
 * call. A stricter pattern, such as the RFC version and variant check of
 * `z.string().uuid()`, tells the model something the format does not and is
 * kept, as are other patterns and every other keyword.
 */
export function withoutRedundantUuidPatterns<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(withoutRedundantUuidPatterns) as T;
  if (schema === null || typeof schema !== "object") return schema;
  const node = schema as Record<string, unknown>;
  const redundant = node.format === "uuid" && node.pattern === ANY_HEX_UUID_PATTERN;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (redundant && key === "pattern") continue;
    out[key] = withoutRedundantUuidPatterns(value);
  }
  return out as T;
}
