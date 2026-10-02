import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";
import { rewriteWorkspaceDependenciesToConcrete } from "./rewrite-workspace-deps";
import { workspaceVersionMap } from "./publishable-workspaces";

const reactRoot = join(import.meta.dir, "../packages/react");
const reactRequire = createRequire(join(reactRoot, "package.json"));
const { build } = (await import(reactRequire.resolve("vite"))) as typeof import("vite");
const manifest = JSON.parse(await readFile(join(reactRoot, "package.json"), "utf8"));
const optionalPeers = Object.entries(
  manifest.peerDependenciesMeta as Record<string, { optional?: boolean }>,
)
  .filter(([, meta]) => meta.optional)
  .map(([name]) => name);
const required = [
  ...Object.keys(manifest.dependencies),
  ...Object.keys(manifest.peerDependencies).filter((name) => !optionalPeers.includes(name)),
];
const belongsTo = (specifier: string, names: string[]) =>
  names.some((name) => specifier === name || specifier.startsWith(`${name}/`));

async function bundleRoot(root: string, entry: string): Promise<void> {
  const result = await build({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [
      {
        name: "react-root-without-optional-peers",
        resolveId(id) {
          // Reject even in the source fixture where workspace peers may be installed.
          // Required dependencies stay external; no optional peer gets that escape.
          if (belongsTo(id, optionalPeers))
            throw new Error(`Root reached absent optional peer: ${id}`);
          if (id === "root-consumer") return "\0root-consumer";
          if (id === "@opengeni/react") return entry;
          return null;
        },
        load(id) {
          if (id !== "\0root-consumer") return null;
          // Retain the entire public namespace, not only tree-shaken chat exports.
          return 'export * from "@opengeni/react"; import * as root from "@opengeni/react"; globalThis.OpenGeniRoot = root;';
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: "root-consumer",
        preserveEntrySignatures: "strict",
        external: (id) => belongsTo(id, required),
        output: { format: "es" },
      },
    },
  });
  if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one Vite build");
  const exports = result.output
    .filter((item) => item.type === "chunk")
    .flatMap((chunk) => chunk.exports);
  for (const name of [
    "OpenGeniProvider",
    "OpenGeniChat",
    "SessionConversation",
    "SandboxWorkspace",
    "SandboxTerminal",
    "DesktopViewer",
    "CodeEditor",
    "languageForPath",
    "registerPierreDiffs",
  ])
    expect(exports).toContain(name);
}

test("the full React root namespace builds without resolving optional peers", async () => {
  await bundleRoot(reactRoot, join(reactRoot, "src/index.ts"));
});

const requireBuilt = process.env.OPENGENI_VERIFY_BUILT_EMBEDDING_PACKAGES === "1";
test.skipIf(!requireBuilt && !existsSync(join(reactRoot, "dist/index.js")))(
  "the release-shaped packed React root builds with optional peers absent",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "opengeni-react-root-"));
    const staging = join(fixture, "staging");
    const tarballs = join(fixture, "tarballs");
    const consumer = join(fixture, "consumer");
    const installed = join(consumer, "node_modules/@opengeni/react");
    const run = async (cmd: string[], cwd: string) => {
      const child = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (status !== 0) throw new Error(`${cmd.join(" ")} failed: ${stdout}\n${stderr}`);
    };
    try {
      await mkdir(staging);
      await mkdir(tarballs);
      await mkdir(installed, { recursive: true });
      for (const directory of ["dist", "src", "styles"]) {
        await cp(join(reactRoot, directory), join(staging, directory), { recursive: true });
      }
      const published = structuredClone(manifest);
      delete published.devDependencies;
      rewriteWorkspaceDependenciesToConcrete(published, workspaceVersionMap());
      rewriteEntryPointsToDist(published);
      await writeFile(join(staging, "package.json"), JSON.stringify(published));
      await run(
        ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballs],
        staging,
      );
      const archives = (await readdir(tarballs)).filter((file) => file.endsWith(".tgz"));
      expect(archives).toHaveLength(1);
      await run(
        ["tar", "-xzf", join(tarballs, archives[0]!), "--strip-components=1", "-C", installed],
        consumer,
      );
      for (const peer of optionalPeers)
        expect(existsSync(join(consumer, "node_modules", peer))).toBe(false);
      const packed = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
      const rootEntry = packed.exports["."].import ?? packed.exports["."].default;
      expect(rootEntry).toBe("./dist/index.js");
      await bundleRoot(consumer, join(installed, rootEntry));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
  30_000,
);
