import { resolve } from "node:path";
const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");
const output = resolve(webRoot, "dist-component-gallery");
const html = await new HTMLRewriter()
  .on("script[src]", {
    async element(element) {
      const src = element.getAttribute("src")!;
      if (!src.startsWith("/assets/")) throw new Error("Unexpected runtime script");
      element.removeAttribute("src");
      element.setInnerContent(
        (await Bun.file(resolve(output, src.slice(1))).text()).replaceAll("</script", "<\\/script"),
        { html: true },
      );
    },
  })
  .on('link[rel="stylesheet"]', {
    async element(element) {
      const href = element.getAttribute("href")!;
      if (!href.startsWith("/assets/")) throw new Error("Unexpected runtime stylesheet");
      element.replace(
        `<style>${(await Bun.file(resolve(output, href.slice(1))).text()).replaceAll("</style", "<\\/style")}</style>`,
        { html: true },
      );
    },
  })
  .transform(new Response(Bun.file(resolve(output, "component-gallery.html"))))
  .text();
if (html.includes('src="/assets/') || html.includes('href="/assets/'))
  throw new Error("Runtime not self-contained");
await Bun.write(resolve(output, "index.html"), html);
const paths = [
  "packages/react/src/capability-catalog-row.tsx",
  "apps/web/component-gallery.html",
  "apps/web/vite.component-gallery.config.ts",
  "apps/web/scripts/package-component-gallery.ts",
  "apps/web/src/styles.css",
  "apps/web/src/lib/utils.ts",
];
for (const pattern of [
  "apps/web/src/component-gallery/*.{ts,tsx,css}",
  "apps/web/src/components/ui/*.{ts,tsx}",
  "packages/react/styles/*.css",
])
  for await (const path of new Bun.Glob(pattern).scan({ cwd: repoRoot }))
    if (!path.includes(".test.")) paths.push(path);
const files = await Promise.all(
  paths
    .sort()
    .map(async (path) => ({ path, content: await Bun.file(resolve(repoRoot, path)).text() })),
);
const dependencies: Record<string, string> = {};
for (const name of [
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
]) {
  const local = resolve(webRoot, "node_modules", name, "package.json");
  dependencies[name] = (
    await Bun.file(
      (await Bun.file(local).exists())
        ? local
        : resolve(repoRoot, "node_modules", name, "package.json"),
    ).json()
  ).version;
}
files.push({
  path: "package.json",
  content: JSON.stringify(
    {
      name: "opengeni-component-studio",
      private: true,
      type: "module",
      workspaces: ["packages/react"],
      scripts: {
        build:
          "cd apps/web && vite build --config vite.component-gallery.config.ts && bun scripts/package-component-gallery.ts",
        dev: "cd apps/web && vite --config vite.component-gallery.config.ts --host 0.0.0.0",
      },
      dependencies: { ...dependencies, "@opengeni/react": "workspace:*" },
    },
    null,
    2,
  ),
});
files.push({
  path: "packages/react/package.json",
  content: JSON.stringify(
    {
      name: "@opengeni/react",
      version: "0.0.0-gallery",
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
await Bun.write(
  resolve(output, "source.json"),
  JSON.stringify({ entrypoint: "apps/web/component-gallery.html", files }),
);
console.log(JSON.stringify({ htmlBytes: Buffer.byteLength(html), sourceFiles: files.length }));
