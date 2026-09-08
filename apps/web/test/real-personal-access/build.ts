import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const app = path.resolve(import.meta.dir, "../..");
const repo = path.resolve(app, "../..");
const out = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "dist"));
const baseline = Bun.spawnSync(
  ["git", "show", "380bba5:apps/web/src/components/personal-resource-scope-choice.tsx"],
  { cwd: repo },
);
if (baseline.exitCode !== 0) throw new Error("Could not resolve exact baseline source");
const baselineSource = baseline.stdout.toString();
const ids = new Set<string>();
const results = await build({
  configFile: false,
  root: app,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "retained-preview-source",
      resolveId(id) {
        if (id === "virtual:personal-access-baseline") return "\0personal-access-baseline";
      },
      load(id) {
        if (id === "\0personal-access-baseline") return { code: baselineSource, moduleType: "tsx" };
      },
      moduleParsed(info) {
        if (info.id.startsWith(repo) && !info.id.includes("node_modules"))
          ids.add(info.id.split("?")[0]!);
      },
    },
  ],
  resolve: {
    alias: [
      { find: "@/context", replacement: path.join(import.meta.dir, "context.ts") },
      { find: "@", replacement: path.join(app, "src") },
    ],
  },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    lib: { entry: path.join(import.meta.dir, "fixture.tsx"), formats: ["es"] },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
const outputs = (Array.isArray(results) ? results : [results]).flatMap((result) =>
  "output" in result ? result.output : [],
);
const js = outputs.filter((item) => item.type === "chunk");
const css = outputs.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"));
const other = outputs.filter((item) => item.type === "asset" && !item.fileName.endsWith(".css"));
if (js.length !== 1 || other.length)
  throw new Error(`Not self-contained: ${js.length} JS chunks, ${other.map((x) => x.fileName)}`);
const html = `<!doctype html><html lang="en" data-og-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actual composer · Before / after</title><style>${css
  .map((x) => (x.type === "asset" ? x.source.toString() : ""))
  .join("\n")
  .replaceAll(
    "</style",
    "<\\/style",
  )}</style></head><body><div id="root"></div><script type="module">${js[0]!.code.replaceAll("</script", "<\\/script")}</script></body></html>`;
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "index.html"), html);
for (const file of [
  "fixture.tsx",
  "context.ts",
  "proposed-access.tsx",
  "virtual.d.ts",
  "build.ts",
  "check.ts",
  "tsconfig.json",
  "README.md",
])
  ids.add(path.join(import.meta.dir, file));
ids.add(path.join(app, "src/styles.css"));
ids.add(path.join(repo, "packages/react/src/styles.css"));
ids.add(path.join(repo, "packages/react/src/responsive.css"));
for (const rel of [
  "package.json",
  "bun.lock",
  "apps/web/package.json",
  "packages/react/package.json",
  "packages/sdk/package.json",
])
  ids.add(path.join(repo, rel));
const files = [];
for (const id of [...ids].sort()) {
  try {
    files.push({ path: path.relative(repo, id), content: await readFile(id, "utf8") });
  } catch {}
}
files.push({ path: "BASELINE-scope.tsx", content: baselineSource });
files.push({
  path: "PREVIEW-README.md",
  content:
    "Production-component review fixture. Restore into Cloudgeni-ai/opengeni checkout at 380bba5 (or checkout 69964a4; the imported production composer/control source files are identical). Run bun install --frozen-lockfile, then bun apps/web/test/real-personal-access/build.ts. The build-only context alias replaces data, not UI. Baseline scope is loaded verbatim from git. ProposedAccess is not wired into any production route. Runtime requires no network or storage. Do not treat preview behavior as live authorization evidence.",
});
await writeFile(
  path.join(out, "source.json"),
  JSON.stringify({ entrypoint: "apps/web/test/real-personal-access/fixture.tsx", files }),
);
console.log(
  `Retained ${files.length} source files; standalone HTML ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB`,
);
