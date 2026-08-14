import type { Plugin } from "vite";

const REACT_VALUE_EXPORT =
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;

/**
 * React Fast Refresh is only a safe update boundary when every runtime export
 * is a component. Mixed component/helper modules are valid application code,
 * but react-refresh invalidates them and Vite's cascading update can otherwise
 * strand the app on an empty root. Those edits must use Vite's reliable full
 * page reload path instead.
 */
export function reactModuleNeedsFullReload(source: string): boolean {
  for (const match of source.matchAll(REACT_VALUE_EXPORT)) {
    const name = match[1] ?? "";
    if (!/^[A-Z][a-z0-9]/u.test(name)) return true;
  }
  return false;
}

export function safeReactHmrPlugin(): Plugin {
  return {
    name: "opengeni-safe-react-hmr",
    enforce: "post",
    async handleHotUpdate(context) {
      if (!/\.[jt]sx$/u.test(context.file) || context.file.includes("/node_modules/")) return;
      const source = await context.read();
      if (!reactModuleNeedsFullReload(source)) return;
      context.server.ws.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}
