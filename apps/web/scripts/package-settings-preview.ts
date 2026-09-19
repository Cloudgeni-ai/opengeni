import { resolve, relative } from "node:path";
import { mkdir } from "node:fs/promises";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");
const output = resolve(webRoot, "dist-settings-preview");
const input = Bun.file(resolve(output, "settings-preview.html"));
// Parse the generated document rather than matching arbitrary HTML with regex.
const html = await new HTMLRewriter()
  .on("script[src]", {
    async element(element) {
      const src = element.getAttribute("src")!;
      if (!src.startsWith("/assets/")) throw new Error(`Unexpected runtime script: ${src}`);
      const code = await Bun.file(resolve(output, src.slice(1))).text();
      element.removeAttribute("src");
      element.setInnerContent(code.replaceAll("</script", "<\\/script"), { html: true });
    },
  })
  .on('link[rel="stylesheet"]', {
    async element(element) {
      const href = element.getAttribute("href")!;
      if (!href.startsWith("/assets/")) throw new Error(`Unexpected stylesheet: ${href}`);
      const css = await Bun.file(resolve(output, href.slice(1))).text();
      element.replace(`<style>${css.replaceAll("</style", "<\\/style")}</style>`, { html: true });
    },
  })
  .transform(new Response(input))
  .text();
if (html.includes('src="/assets/') || html.includes('href="/assets/'))
  throw new Error("Runtime is not self-contained");
await Bun.write(resolve(output, "index.html"), html);

const paths = [
  "apps/web/settings-preview.html",
  "apps/web/vite.settings-preview.config.ts",
  "apps/web/scripts/package-settings-preview.ts",
  "apps/web/src/styles.css",
  "apps/web/src/lib/utils.ts",
];
for (const pattern of [
  "apps/web/src/settings-preview/*.{ts,tsx}",
  "apps/web/src/components/ui/*.{ts,tsx}",
  "packages/react/styles/*.css",
]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: repoRoot })) paths.push(path);
}
const files = await Promise.all(
  paths
    .sort()
    .filter((path) => !path.includes(".test."))
    .map(async (path) => ({ path, content: await Bun.file(resolve(repoRoot, path)).text() })),
);
// Retain exact source and a minimal build boundary, without the application backend.
const webPackage = await Bun.file(resolve(webRoot, "package.json")).json();
const dependencyNames = [
  "react",
  "react-dom",
  "radix-ui",
  "lucide-react",
  "class-variance-authority",
  "clsx",
  "tailwind-merge",
  "@fontsource-variable/inter",
  "@fontsource-variable/jetbrains-mono",
  "tailwindcss",
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "vite",
  "typescript",
];
const dependencies: Record<string, string> = {};
for (const name of dependencyNames) {
  const localPackagePath = resolve(webRoot, "node_modules", name, "package.json");
  const packagePath = await Bun.file(localPackagePath).exists() ? localPackagePath : resolve(repoRoot, "node_modules", name, "package.json");
  const pkg = await Bun.file(packagePath).json();
  if (!webPackage.dependencies?.[name] && !webPackage.devDependencies?.[name])
    throw new Error(`Unknown dependency ${name}`);
  dependencies[name] = pkg.version;
}
files.push({
  path: "package.json",
  content: JSON.stringify(
    {
      name: "opengeni-settings-review",
      private: true,
      type: "module",
      workspaces: ["packages/react"],
      scripts: {
        build:
          "cd apps/web && vite build --config vite.settings-preview.config.ts && bun scripts/package-settings-preview.ts",
        dev: "cd apps/web && vite --config vite.settings-preview.config.ts --host 0.0.0.0",
      },
      dependencies: { ...dependencies, "@opengeni/react": "workspace:*" },
    },
    null,
    2,
  ),
});
files.push({
  path: "apps/web/package.json",
  content: JSON.stringify(
    { name: "opengeni-settings-preview-source", private: true, type: "module", dependencies },
    null,
    2,
  ),
});
files.push({
  path: "packages/react/package.json",
  content: JSON.stringify(
    {
      name: "@opengeni/react",
      version: "0.0.0-review",
      private: true,
      exports: {
        "./styles.css": "./styles/index.css",
        "./responsive.css": "./styles/responsive.css",
      },
    },
    null,
    2,
  ),
});
files.push({
  path: "apps/web/tsconfig.json",
  content: JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        paths: { "@/*": ["./src/*"] },
      },
    },
    null,
    2,
  ),
});
await mkdir(output, { recursive: true });
await Bun.write(
  resolve(output, "source.json"),
  JSON.stringify({ entrypoint: "apps/web/settings-preview.html", files }),
);
console.log(
  JSON.stringify({
    html: relative(repoRoot, resolve(output, "index.html")),
    bytes: Buffer.byteLength(html),
    sourceFiles: files.length,
  }),
);
