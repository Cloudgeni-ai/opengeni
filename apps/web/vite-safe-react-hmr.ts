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

/**
 * Shared `@opengeni/react/app/*` modules are all `.tsx` (the package export
 * pattern names one extension), including plain helpers. Only a module that
 * renders JSX is a Fast Refresh candidate; any JSX element or fragment closes
 * with `</`, `/>` or opens with `<>`. Helpers keep Vite's ordinary propagation.
 */
export function isReactModule(file: string, source: string): boolean {
  if (!/\.[jt]sx$/u.test(file) || file.includes("/node_modules/")) return false;
  return /<\/|\/>|<>/u.test(source);
}

export function safeReactHmrPlugin(): Plugin {
  return {
    name: "opengeni-safe-react-hmr",
    enforce: "post",
    async handleHotUpdate(context) {
      if (!/\.[jt]sx$/u.test(context.file) || context.file.includes("/node_modules/")) return;
      const source = await context.read();
      if (!isReactModule(context.file, source) || !reactModuleNeedsFullReload(source)) return;
      context.server.ws.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}
