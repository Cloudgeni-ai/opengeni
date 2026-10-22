// Shared Vite wiring for the web app's preview and browser-test pages.
//
// The session UI lives in `@opengeni/react/app` and imports its app state,
// rail state and hooks through relative paths, so a preview's `@/context`-style
// alias no longer reaches it. `previewHost()` redirects those modules by their
// resolved file to the same stub the preview already aliases, and runs the web
// app's host setup (router-backed navigation, API helpers, optional surfaces)
// before the page's own script, as `main.tsx` does in the app.
import path from "node:path";
import type { Alias, Plugin } from "vite";

const appRoot = path.resolve(import.meta.dirname, "../../../packages/react/src/app");
const hostSetup = path.resolve(import.meta.dirname, "preview-host-setup.ts");

/** The web app specifiers previews stub, and the shared files they now name. */
const MOVED_MODULES: Record<string, string> = {
  "@/context": "app-context.tsx",
  "@/components/rail/rail-context": "components/rail/rail-context.tsx",
  "@/lib/use-workspace-rigs": "lib/use-workspace-rigs.tsx",
  "@/lib/use-workspace-machines": "lib/use-workspace-machines.tsx",
  "@/lib/appearance": "lib/appearance.tsx",
};

function aliasTarget(aliases: readonly Alias[], specifier: string): string | null {
  for (const alias of aliases) {
    const matches =
      typeof alias.find === "string" ? alias.find === specifier : alias.find.test(specifier);
    if (matches && alias.replacement !== path.resolve(import.meta.dirname, "../src")) {
      return alias.replacement;
    }
  }
  return null;
}

export function previewHost(): Plugin {
  const redirects = new Map<string, string>();
  return {
    name: "opengeni-preview-host",
    enforce: "pre",
    configResolved(config) {
      for (const [specifier, file] of Object.entries(MOVED_MODULES)) {
        const stub = aliasTarget(config.resolve.alias, specifier);
        if (stub) redirects.set(path.join(appRoot, file), stub);
      }
    },
    async resolveId(source, importer, options) {
      if (redirects.size === 0 || !importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const stub = redirects.get(resolved.id.split("?")[0]!);
      // A stub may import the real module it stands in for (its types, a helper).
      if (!stub || importer.split("?")[0] === stub) return null;
      return stub;
    },
    transformIndexHtml: {
      // After React Refresh's preamble (head-prepend), before the page's own script.
      order: "post",
      handler: () => [
        {
          tag: "script",
          attrs: { type: "module", src: `/@fs${hostSetup}` },
          injectTo: "head",
        },
      ],
    },
  };
}
