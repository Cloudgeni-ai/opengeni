import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { build, type Plugin } from "vite";

import {
  describeEagerGraphOverflow,
  type EagerGraphChunk,
  eagerGraphPlugin,
  measureEagerGraphs,
} from "./vite-eager-graph";

const imports: Record<string, readonly string[]> = {
  "/app/main.js": ["/app/needed.js"],
  "/app/needed.js": [],
  "/app/route.js": ["/app/heavy.js", "/app/needed.js"],
  "/app/heavy.js": [],
  "/app/elsewhere.js": [],
};
const staticImports = (id: string) => imports[id] ?? [];

describe("eager graph measurement", () => {
  test("counts loaded modules that the graph never imports", () => {
    const chunks: EagerGraphChunk[] = [
      {
        fileName: "main.js",
        isEntry: true,
        imports: ["shared.js"],
        modules: { "/app/main.js": 50 },
      },
      {
        fileName: "shared.js",
        isEntry: false,
        imports: [],
        modules: { "/app/needed.js": 20, "/app/heavy.js": 900 },
      },
      {
        fileName: "route.js",
        isEntry: false,
        imports: ["shared.js"],
        modules: { "/app/route.js": 30 },
      },
      { fileName: "other.js", isEntry: false, imports: [], modules: { "/app/elsewhere.js": 400 } },
    ];
    const [initial, direct] = measureEagerGraphs(chunks, staticImports, [
      { name: "initial load", roots: ["/app/main.js"] },
      { name: "direct route", roots: ["/app/main.js", "/app/route.js"] },
    ]);
    expect(initial).toEqual({
      name: "initial load",
      files: 2,
      unusedBytes: 900,
      chunks: [
        {
          fileName: "shared.js",
          unusedBytes: 900,
          unusedModules: [{ id: "/app/heavy.js", bytes: 900 }],
        },
      ],
    });
    // The route imports the heavy module itself, so loading it is not waste.
    expect(direct).toMatchObject({ name: "direct route", files: 3, unusedBytes: 0, chunks: [] });
    const message = describeEagerGraphOverflow([initial!], 100, "/app");
    expect(message).toContain("- initial load: 900 unused bytes across 2 files");
    expect(message).toContain("shared.js: 900 unused, e.g. heavy.js (900)");
  });
});

const heavyBody = Array.from(
  { length: 40 },
  (_, index) => `"lazy-only row ${index} ${"x".repeat(40)}"`,
).join(",");
const fixtureSources: Record<string, string> = {
  "main.js": `import { needed } from "./needed.js";\nglobalThis.out = needed();\nglobalThis.open = () => import("./route.js").then((module) => module.view());\n`,
  "needed.js": `export function needed() { return "needed"; }\n`,
  "route.js": `import { rows } from "./heavy.js";\nimport { needed } from "./needed.js";\nexport const view = () => [needed(), rows.length];\n`,
  "heavy.js": `export const rows = [${heavyBody}];\n`,
};

async function buildFixture(groupNeededWithHeavy: boolean, plugin: Plugin) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eager-graph-"));
  try {
    for (const [name, source] of Object.entries(fixtureSources)) {
      await writeFile(path.join(root, name), source);
    }
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      build: {
        outDir: path.join(root, "dist"),
        emptyOutDir: true,
        write: false,
        modulePreload: false,
        minify: false,
        rolldownOptions: {
          input: path.join(root, "main.js"),
          output: {
            format: "es",
            codeSplitting: {
              // Like a group rule that pins a lazy feature together with a
              // helper an eager page also imports.
              groups: groupNeededWithHeavy
                ? [
                    {
                      name: "feature",
                      test: /(needed|heavy)\.js$/,
                      includeDependenciesRecursively: false,
                    },
                  ]
                : [],
            },
          },
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("eager graph build check", () => {
  test("rejects a bundle whose initial load carries lazy-only code", async () => {
    await expect(
      buildFixture(true, eagerGraphPlugin({ directRoutes: [], allowanceBytes: 256 })),
    ).rejects.toThrow(/initial load: \d+ unused bytes across 2 files[\s\S]*heavy\.js/);
  });

  test("accepts the same code when the lazy module stays behind its route", async () => {
    await buildFixture(false, eagerGraphPlugin({ directRoutes: [], allowanceBytes: 256 }));
  });

  test("does not count code a directly opened route imports itself", async () => {
    // The direct route graph needs heavy.js, but the initial load still does not.
    await expect(
      buildFixture(true, eagerGraphPlugin({ directRoutes: ["route.js"], allowanceBytes: 256 })),
    ).rejects.toThrow(/- initial load: /);
    await expect(
      buildFixture(true, eagerGraphPlugin({ directRoutes: ["route.js"], allowanceBytes: 256 })),
    ).rejects.not.toThrow(/- direct route\.js: /);
  });

  test("fails when a configured direct route does not exist", async () => {
    await expect(
      buildFixture(false, eagerGraphPlugin({ directRoutes: ["missing.js"], allowanceBytes: 256 })),
    ).rejects.toThrow(/no module matches the direct route missing\.js/);
  });
});

describe("web build configuration", () => {
  test("checks the initial load and direct chat loads", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "vite.config.ts")).text();
    expect(source).toContain('eagerGraphPlugin({ directRoutes: ["src/routes/session.tsx"]');
  });
});
