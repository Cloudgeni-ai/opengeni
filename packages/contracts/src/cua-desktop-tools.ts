import catalog from "./cua-desktop-tools.gen.json";
import linuxCatalog from "./cua-desktop-tools.linux.gen.json";
/** Generated from the bundled CUA worker's listToolsJson(). Never from a live desktop. */
export type CuaDesktopTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, boolean>;
  capabilities: string[];
};
export const CUA_DESKTOP_TOOLS: readonly CuaDesktopTool[] = catalog;
export const CUA_LINUX_DESKTOP_TOOLS: readonly CuaDesktopTool[] = linuxCatalog;

/** Keep platform contracts intact; the session's worker enforces its own variant. */
export function cuaDesktopToolVariants(name: string): readonly CuaDesktopTool[] {
  return [CUA_DESKTOP_TOOLS, CUA_LINUX_DESKTOP_TOOLS].flatMap((tools) =>
    tools.filter((tool) => tool.name === name),
  );
}
export function isCuaDesktopModelTool(name: string | null): boolean {
  return (
    name !== null && CUA_DESKTOP_TOOLS.some((tool) => name === "interaction__cua_" + tool.name)
  );
}
