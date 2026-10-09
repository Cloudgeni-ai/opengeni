import catalog from "./cua-desktop-tools.gen.json";
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
export function isCuaDesktopModelTool(name: string | null): boolean {
  return (
    name !== null && CUA_DESKTOP_TOOLS.some((tool) => name === "interaction__cua_" + tool.name)
  );
}
