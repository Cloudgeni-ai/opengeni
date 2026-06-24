import type { ComponentType } from "react";
import type { ToolCallItem } from "./types";

/* ----------------------------------------------------------------------------
   Tool renderer registry

   The extension point. A `ToolRenderer` is a React component fed one projected
   `ToolCallItem`; the registry resolves which renderer handles a given call,
   keyed on the tool `name` and (secondarily) its provider-native `raw.type`.

   Resolution order (most → least specific):
     1. exact match on `raw.type`        (e.g. "apply_patch_call", "computer_call")
     2. exact match on the tool `name`   (e.g. "exec_command", "web_search_call")
     3. the registry's generic fallback

   A consumer extends the defaults without forking by passing overrides to
   `createToolRegistry` — e.g. a custom renderer for their own MCP tool, or a
   replacement for a built-in one. The registry is immutable and fully typed.
   -------------------------------------------------------------------------- */

export type ToolRendererProps = {
  item: ToolCallItem;
};

export type ToolRenderer = ComponentType<ToolRendererProps>;

/** A registry entry: which key it matches and the component that renders it. */
export type ToolRegistryEntry =
  | { match: "rawType"; type: string; render: ToolRenderer }
  | { match: "name"; name: string; render: ToolRenderer };

export type ToolRegistry = {
  /** Resolve the renderer for a call (never null — falls back to generic). */
  resolve: (item: ToolCallItem) => ToolRenderer;
  /** The generic fallback renderer. */
  fallback: ToolRenderer;
};

export type CreateToolRegistryOptions = {
  /**
   * Entries that take precedence over the built-ins. Earlier entries win, so a
   * consumer can shadow a default renderer for the same key.
   */
  entries?: ToolRegistryEntry[] | undefined;
  /** Replace the generic fallback used for unmatched tools. */
  fallback?: ToolRenderer | undefined;
};

/** The `raw.type` of a projected tool call, when the provider item carries one. */
export function rawTypeOf(item: ToolCallItem): string | null {
  const raw = item.raw;
  if (raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string") {
    return (raw as { type: string }).type;
  }
  return null;
}

/**
 * Build a tool registry from a set of entries and a fallback. The returned
 * registry resolves in priority order: `raw.type` entries first, then `name`
 * entries, then the fallback. Consumer `entries` are consulted before the
 * built-in `baseEntries`, so they shadow defaults cleanly.
 */
export function createToolRegistry(
  baseEntries: ToolRegistryEntry[],
  baseFallback: ToolRenderer,
  options: CreateToolRegistryOptions = {},
): ToolRegistry {
  const entries = [...(options.entries ?? []), ...baseEntries];
  const fallback = options.fallback ?? baseFallback;

  const byRawType = new Map<string, ToolRenderer>();
  const byName = new Map<string, ToolRenderer>();
  for (const entry of entries) {
    if (entry.match === "rawType") {
      if (!byRawType.has(entry.type)) {
        byRawType.set(entry.type, entry.render);
      }
    } else if (!byName.has(entry.name)) {
      byName.set(entry.name, entry.render);
    }
  }

  const resolve = (item: ToolCallItem): ToolRenderer => {
    const rawType = rawTypeOf(item);
    if (rawType) {
      const byType = byRawType.get(rawType);
      if (byType) {
        return byType;
      }
    }
    return byName.get(item.name) ?? fallback;
  };

  return { resolve, fallback };
}
