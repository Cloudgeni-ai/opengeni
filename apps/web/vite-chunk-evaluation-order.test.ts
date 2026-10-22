import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Plugin } from "vite";

import {
  type BundleChunk,
  chunkEvaluationOrderPlugin,
  chunkImportCycles,
  describeChunkEvaluationOrderHazards,
  findChunkEvaluationOrderHazards,
} from "./vite-chunk-evaluation-order";

const peer = "assets/peer.js";
const self = "assets/self.js";

/** `self` and `peer` import each other; `self` holds the code under test. */
function cycleWith(code: string, extra: readonly BundleChunk[] = []): BundleChunk[] {
  return [
    { fileName: self, code, imports: [peer] },
    {
      fileName: peer,
      code: `import { helper } from "./self.js"; export const Icon = 1; export function use() { return helper(); }`,
      imports: [self],
    },
    ...extra,
  ];
}

function hazardsIn(code: string) {
  return findChunkEvaluationOrderHazards(cycleWith(code)).filter((hazard) => hazard.chunk === self);
}

describe("chunk import cycles", () => {
  test("finds strongly connected chunks and ignores acyclic ones", () => {
    const cycles = chunkImportCycles([
      { fileName: "a.js", code: "", imports: ["b.js"] },
      { fileName: "b.js", code: "", imports: ["c.js"] },
      { fileName: "c.js", code: "", imports: ["a.js", "d.js"] },
      { fileName: "d.js", code: "", imports: [] },
    ]);
    expect(cycles).toEqual([["a.js", "b.js", "c.js"]]);
  });
});

describe("load-time reads of cycle peers", () => {
  test("flags a module-level table that captures a peer binding", () => {
    const hazards = hazardsIn(
      `import { Icon as t } from "./peer.js"; const table = { document: t }; export function helper() { return table; }`,
    );
    expect(hazards).toHaveLength(1);
    expect(hazards[0]).toMatchObject({ chunk: self, from: peer, importedName: "Icon" });
    expect(hazards[0]!.cycle).toEqual([peer, self]);
    expect(describeChunkEvaluationOrderHazards(hazards)).toContain(`reads "Icon" from ${peer}`);
  });

  test("allows reads deferred into functions, methods and getters", () => {
    expect(
      hazardsIn(`import { Icon } from "./peer.js";
        export function helper(kind) { switch (kind) { case "document": return Icon; } }
        const arrow = () => Icon;
        const object = { method() { return Icon; }, get icon() { return Icon; } };
        class Lazy { render() { return Icon; } }
        export { arrow, object, Lazy };`),
    ).toEqual([]);
  });

  test("ignores imports from chunks outside the cycle", () => {
    const chunks = cycleWith(
      `import { Leaf } from "./leaf.js"; import "./peer.js"; const table = { document: Leaf }; export function helper() { return table; }`,
      [{ fileName: "assets/leaf.js", code: "export const Leaf = 1;", imports: [] }],
    );
    chunks[0] = { ...chunks[0]!, imports: [peer, "assets/leaf.js"] };
    expect(findChunkEvaluationOrderHazards(chunks)).toEqual([]);
  });

  test("flags reads that run during evaluation through calls, spreads and classes", () => {
    const cases = [
      `import { Icon } from "./peer.js"; const value = (() => Icon)();`,
      `import { Icon } from "./peer.js"; function labels() { return { icon: Icon }; } const defaults = { ...labels() };`,
      `import { Icon } from "./peer.js"; const mapped = [1].map(() => Icon);`,
      `import { Icon } from "./peer.js"; class Widget extends Icon {}`,
      `import { Icon } from "./peer.js"; class Widget { static icon = Icon; }`,
      `import { Icon } from "./peer.js"; class Widget { static { this.icon = Icon; } }`,
      `import { Icon } from "./peer.js"; Icon.displayName = "icon";`,
    ];
    for (const code of cases) {
      expect({ code, hazards: hazardsIn(`${code} export function helper() {}`).length }).toEqual({
        code,
        hazards: 1,
      });
    }
  });

  test("does not confuse shadowed names with peer bindings", () => {
    expect(
      hazardsIn(`import { Icon } from "./peer.js";
        const value = ((Icon) => Icon)(2);
        { const Icon = 3; console.log(Icon); }
        for (const Icon of [4]) console.log(Icon);
        export function helper() {}`),
    ).toEqual([]);
  });
});

/**
 * A miniature of the production failure: the route reaches chunk B first, B
 * imports chunk A, and A builds a module-level table from a component that
 * lives in B, which has not run yet.
 */
const fixtureSources = (deferredRead: boolean): Record<string, string> => ({
  // Like an icon component: a value created when its chunk runs, not a
  // hoisted function declaration.
  "glyph.js": `export const Glyph = Object.assign(() => "glyph", { displayName: "Glyph" });\n`,
  "helper-a.js": `export function helperA() { return "a"; }\n`,
  "table.js": deferredRead
    ? `import { Glyph } from "./glyph.js";\nexport function documentGlyph() { return Glyph; }\n`
    : `import { Glyph } from "./glyph.js";\nconst table = { document: Glyph };\nexport function documentGlyph() { return table.document; }\n`,
  "user-b.js": `import { helperA } from "./helper-a.js";\nexport function userB() { return helperA(); }\n`,
  "route.js": `import { userB } from "./user-b.js";\nimport { documentGlyph } from "./table.js";\nglobalThis.__chunkOrderFixture = { b: userB(), documentGlyph: typeof documentGlyph() };\n`,
});

async function buildFixture(deferredRead: boolean, plugins: Plugin[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "chunk-evaluation-order-"));
  for (const [name, source] of Object.entries(fixtureSources(deferredRead))) {
    await writeFile(path.join(root, name), source);
  }
  const outDir = path.join(root, "dist");
  const chunks: BundleChunk[] = [];
  const collect: Plugin = {
    name: "collect-chunks",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          chunks.push({ fileName: output.fileName, code: output.code, imports: output.imports });
        }
      }
    },
  };
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [collect, ...plugins],
      build: {
        outDir,
        emptyOutDir: true,
        modulePreload: false,
        minify: false,
        rolldownOptions: {
          input: path.join(root, "route.js"),
          output: {
            format: "es",
            codeSplitting: {
              groups: [
                {
                  name: "group-a",
                  test: /(table|helper-a)\.js$/,
                  includeDependenciesRecursively: false,
                },
                {
                  name: "group-b",
                  test: /(glyph|user-b)\.js$/,
                  includeDependenciesRecursively: false,
                },
              ],
            },
          },
        },
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  const assets = path.join(outDir, "assets");
  const files = await readdir(assets);
  const chunkFile = (prefix: string) =>
    path.join(assets, files.find((file) => file.startsWith(prefix))!);
  /**
   * Loads `firstChunk` the way another route would have, then the route.
   * Each built fixture is a fresh module graph, so call this once per build.
   */
  const run = async (firstChunk: string) => {
    const scope = globalThis as { __chunkOrderFixture?: unknown };
    delete scope.__chunkOrderFixture;
    try {
      await import(pathToFileURL(chunkFile(firstChunk)).href);
      await import(pathToFileURL(chunkFile("route")).href);
      return scope.__chunkOrderFixture;
    } catch (error) {
      return { error: String(error) };
    }
  };
  return { chunks, run, cleanup };
}

describe("bundles whose chunks import each other", () => {
  test("a module-level read of a cycle peer loses the value and is flagged", async () => {
    const fixture = await buildFixture(false);
    try {
      expect(chunkImportCycles(fixture.chunks)).toHaveLength(1);
      // Another route loaded the glyph's chunk first: it imports the table's
      // chunk, which runs before the glyph exists and keeps `undefined`.
      expect(await fixture.run("group-b-")).toEqual({ b: "a", documentGlyph: "undefined" });
      const hazards = findChunkEvaluationOrderHazards(fixture.chunks);
      expect(hazards).toHaveLength(1);
      expect(hazards[0]!.chunk).toStartWith("assets/group-a-");
      expect(hazards[0]!.from).toStartWith("assets/group-b-");
      expect(hazards[0]!.excerpt).toContain("document: Glyph");
    } finally {
      await fixture.cleanup();
    }
  });

  test("reading the peer when called works and passes the check", async () => {
    const fixture = await buildFixture(true);
    try {
      expect(chunkImportCycles(fixture.chunks)).toHaveLength(1);
      expect(await fixture.run("group-b-")).toEqual({ b: "a", documentGlyph: "function" });
      expect(findChunkEvaluationOrderHazards(fixture.chunks)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("the build plugin rejects the hazardous bundle", async () => {
    await expect(buildFixture(false, [chunkEvaluationOrderPlugin()])).rejects.toThrow(
      /group-a-[\w-]+\.js reads "\w+" from assets\/group-b-/,
    );
    const fixture = await buildFixture(true, [chunkEvaluationOrderPlugin()]);
    await fixture.cleanup();
  });
});

describe("web build configuration", () => {
  test("registers the chunk evaluation order check", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "vite.config.ts")).text();
    expect(source).toContain("chunkEvaluationOrderPlugin()");
  });
});
