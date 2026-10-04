import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
  assertUnchangedPublishedSourceAndAssets,
  effectiveRegistry,
  isGeneratedDistBuildOutput,
  proveEffectiveConsumers,
  shippedInventory,
  verifyTarballIntegrity,
  type PackedCandidate,
  type RegistryManifest,
  type RegistryMetadata,
} from "./test-effective-dependency-exports";
import { repoRoot, type WorkspacePackage } from "./publishable-workspaces";
import {
  candidateManifest,
  run,
  stageRegistryCandidate,
  type SmokeManifest,
} from "./test-registry-dependency-exports";

async function pack(
  root: string,
  id: string,
  packageManifest: SmokeManifest,
  source: string | Record<string, string>,
): Promise<PackedCandidate> {
  const directory = join(root, id);
  const tarballs = join(directory, "tarballs");
  const files = typeof source === "string" ? { "index.js": source } : source;
  await mkdir(tarballs, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ ...packageManifest, files: packageManifest.files ?? Object.keys(files) }),
  );
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), contents);
  }
  const output = await run(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballs],
    directory,
  );
  return {
    manifest: packageManifest,
    tarball: join(tarballs, basename(output.trim().split("\n").at(-1)!)),
  };
}

async function fixture<T>(check: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-effective-export-regression-"));
  try {
    return await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function manifest(
  name: string,
  version: string,
  dependencies?: Record<string, string>,
): SmokeManifest {
  return { name, version, type: "module", exports: { ".": "./index.js" }, dependencies };
}

function builtManifest(
  name: string,
  version: string,
  dependencies?: Record<string, string>,
): SmokeManifest {
  return {
    ...manifest(name, version, dependencies),
    exports: { ".": "./dist/index.js" },
    files: ["src", "dist", "runtime-data.json"],
  };
}

async function sourceFor(
  packed: PackedCandidate,
  tarball = "https://registry.npmjs.org/fixture.tgz",
) {
  const bytes = await readFile(packed.tarball);
  const published: RegistryManifest = {
    ...packed.manifest,
    dist: {
      tarball,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
  };
  const metadata: RegistryMetadata = {
    name: packed.manifest.name,
    "dist-tags": { latest: packed.manifest.version },
    versions: { [packed.manifest.version]: published },
  };
  return {
    metadata: async (name: string) =>
      name === metadata.name ? metadata : { name, "dist-tags": {}, versions: {} },
    tarball: async () => bytes,
  };
}

const closed = "export class ConnectPopupClosedError extends Error {}";
const timeout = "export class ConnectPopupTimeoutError extends Error {}";
const importer =
  'import { ConnectPopupClosedError } from "@opengeni/connect"; export const Closed = ConnectPopupClosedError;';
const profiles = { "@opengeni/react": { browser: ["."], node: ["."] } };

test("generated-dist comparison exclusion is limited to known build formats outside asset subtrees", () => {
  for (const path of [
    "dist/index.js",
    "dist/chunk-HASH.js",
    "dist/nested/index.d.ts",
    "dist/index.js.map",
    "dist/index.d.ts.map",
  ])
    expect(isGeneratedDistBuildOutput(path)).toBe(true);
  for (const path of [
    "src/index.js",
    "index.js",
    "dist/index.ts",
    "dist/runtime.json",
    "dist/styles.css",
    "dist/styles.css.map",
    "dist/kernel.wasm",
    "dist/assets/worker.js",
    "dist/nested/assets/worker.js.map",
  ])
    expect(isGeneratedDistBuildOutput(path)).toBe(false);
});

test("same-source generated dist layout variance is admitted but registry dependency bytes stay immutable", async () => {
  await fixture(async (root) => {
    const pkg = builtManifest("@opengeni/connect", "0.3.0");
    const shared = {
      "src/index.ts": closed,
      "dist/assets/runtime-data.json": '{"value":1}',
    };
    const original = await pack(root, "registry", pkg, {
      ...shared,
      "dist/index.js": 'export { ConnectPopupClosedError } from "./chunk-OLD.js";',
      "dist/chunk-OLD.js": closed,
      "dist/index.d.ts": "export declare class ConnectPopupClosedError extends Error {}",
      "dist/index.js.map": '{"version":3,"sources":["old-layout"]}',
      "dist/index.d.ts.map": '{"version":3,"sources":["old-declaration-layout"]}',
    });
    const candidate = await pack(root, "candidate", pkg, {
      ...shared,
      "dist/index.js": 'export { ConnectPopupClosedError } from "./chunk-NEW.js";',
      "dist/chunk-NEW.js": `${closed}\n`,
      "dist/index.d.ts":
        "// regenerated\nexport declare class ConnectPopupClosedError extends Error {}",
      "dist/index.js.map": '{"version":3,"sources":["new-layout"]}',
      "dist/index.d.ts.map": '{"version":3,"sources":["new-declaration-layout"]}',
    });
    const source = await sourceFor(original);
    const candidates = new Map([[pkg.name, candidate]]);
    const registry = await effectiveRegistry(candidates, source, root);
    try {
      const metadata = registry.metadata.get(pkg.name)!;
      const response = await fetch(metadata.versions[pkg.version]!.dist.tarball);
      const served = Buffer.from(await response.arrayBuffer());
      expect(served).toEqual(await readFile(original.tarball));
      expect(served).not.toEqual(await readFile(candidate.tarball));
    } finally {
      registry.stop();
    }
    await expect(
      effectiveRegistry(
        candidates,
        { ...source, tarball: async () => readFile(candidate.tarball) },
        root,
      ),
    ).rejects.toThrow("integrity mismatch");
  });
});

for (const changed of [
  "src/index.ts",
  "runtime-data.json",
  "dist/runtime-data.json",
  "dist/styles.css",
  "dist/styles.css.map",
  "dist/kernel.wasm",
  "dist/assets/worker.js",
  "dist/assets/worker.js.map",
]) {
  test(`source/asset drift at ${changed} still rejects an existing version`, async () => {
    await fixture(async (root) => {
      const pkg = builtManifest("@opengeni/connect", "0.3.0");
      const files = {
        "src/index.ts": closed,
        "dist/index.js": closed,
        [changed]: "original shipped content",
      };
      const original = await pack(root, "registry", pkg, files);
      const candidate = await pack(root, "candidate", pkg, {
        ...files,
        [changed]: "changed shipped content",
      });
      await expect(
        effectiveRegistry(new Map([[pkg.name, candidate]]), await sourceFor(original), root).then(
          (registry) => registry.stop(),
        ),
      ).rejects.toThrow(changed);
    });
  });
}

for (const target of ["browser", "Node"] as const) {
  test(`${target} tests the local same-version root against registry bytes, not the passing registry root or local dependency build`, async () => {
    await fixture(async (root) => {
      const connectManifest = builtManifest("@opengeni/connect", "0.3.0");
      const reactManifest = builtManifest("@opengeni/react", "7.4.0", {
        "@opengeni/connect": "^0.3.0",
      });
      const publishedConnect = await pack(root, "published-connect", connectManifest, {
        "src/index.ts": closed,
        "dist/index.js": timeout,
        "dist/index.d.ts": "export declare class ConnectPopupClosedError extends Error {}",
      });
      const localConnect = await pack(root, "local-connect", connectManifest, {
        "src/index.ts": closed,
        "dist/index.js": closed,
        "dist/index.d.ts": "export declare class ConnectPopupClosedError extends Error {}",
      });
      const publishedReact = await pack(root, "published-react", reactManifest, {
        "src/index.ts": importer,
        "dist/index.js": "export const Closed = null;",
        "dist/index.d.ts": "export declare const Closed: unknown;",
      });
      const localReact = await pack(root, "local-react", reactManifest, {
        "src/index.ts": importer,
        "dist/index.js": importer,
        "dist/index.d.ts": "export declare const Closed: unknown;",
      });
      const connectSource = await sourceFor(publishedConnect);
      const reactSource = await sourceFor(publishedReact);
      const candidates = new Map([
        [connectManifest.name, localConnect],
        [reactManifest.name, localReact],
      ]);
      const registry = await effectiveRegistry(
        candidates,
        {
          metadata: (name) =>
            name === reactManifest.name ? reactSource.metadata(name) : connectSource.metadata(name),
          tarball: (registryManifest) =>
            registryManifest.name === reactManifest.name
              ? reactSource.tarball()
              : connectSource.tarball(),
        },
        root,
      );
      try {
        const selected = {
          [reactManifest.name]: {
            browser: target === "browser" ? ["."] : [],
            node: target === "Node" ? ["."] : [],
          },
        };
        const control = join(root, "registry-root-control");
        await mkdir(control);
        await proveEffectiveConsumers(
          new Map(candidates).set(reactManifest.name, publishedReact),
          selected,
          registry,
          control,
        );
        const proof = proveEffectiveConsumers(candidates, selected, registry, root);
        await expect(proof).rejects.toThrow(
          /@opengeni\/react resolved:[\s\S]*ConnectPopupClosedError/u,
        );
        await expect(proof).rejects.toThrow(
          /@opengeni\/react minimum:[\s\S]*ConnectPopupClosedError/u,
        );
        for (const lane of ["resolved", "minimum"]) {
          const consumer = join(root, `_opengeni_react-${lane}`);
          const installed = join(consumer, "node_modules", reactManifest.name);
          const consumerPackage = JSON.parse(
            await readFile(join(consumer, "package.json"), "utf8"),
          );
          expect(consumerPackage.dependencies[reactManifest.name]).toBe(
            `file:${localReact.tarball}`,
          );
          expect(consumerPackage.overrides).toBeUndefined();
          expect(consumerPackage.workspaces).toBeUndefined();
          expect((await lstat(installed)).isSymbolicLink()).toBe(false);
          expect(await readFile(join(installed, "dist/index.js"), "utf8")).toBe(importer);
          const dependency = dirname(Bun.resolveSync("@opengeni/connect/package.json", installed));
          expect(await readFile(join(dependency, "dist/index.js"), "utf8")).toBe(timeout);
        }
      } finally {
        registry.stop();
      }
    });
  });
}

for (const field of ["exports", "imports"] as const) {
  for (const nested of [false, true]) {
    test(`same-version ${field} ${nested ? "nested " : ""}condition ordering changes Node's selected branch and must be rejected`, async () => {
      await fixture(async (root) => {
        const name = "@opengeni/connect";
        const conditions = { node: "./node.js", import: "./import.js" };
        const reversed = { import: "./import.js", node: "./node.js" };
        const selector = field === "exports" ? "." : "#selected";
        const originalManifest = {
          ...manifest(name, "0.3.0"),
          [field]: { [selector]: nested ? { node: conditions } : conditions },
        };
        const changedManifest = {
          ...originalManifest,
          [field]: { [selector]: nested ? { node: reversed } : reversed },
        };
        const files = {
          "index.js": 'export { selected } from "#selected";',
          "node.js": 'export const selected = "node";',
          "import.js": 'export const selected = "import";',
        };
        const original = await pack(root, "registry", originalManifest, files);
        const changed = await pack(root, "candidate", changedManifest, files);
        for (const [id, packed, selected] of [
          ["registry", original, "node"],
          ["candidate", changed, "import"],
        ] as const) {
          await run(["tar", "-xzf", packed.tarball, "-C", join(root, id)], root);
          expect(
            (
              await run(
                [
                  "node",
                  "--input-type=module",
                  "--eval",
                  `console.log((await import("${name}")).selected)`,
                ],
                join(root, id, "package"),
              )
            ).trim(),
          ).toBe(selected);
        }
        await expect(
          effectiveRegistry(new Map([[name, changed]]), await sourceFor(original), root).then(
            (registry) => registry.stop(),
          ),
        ).rejects.toThrow(
          "changed shipped source/manifest/assets without a new version: package.json",
        );
      });
    });
  }
}

test("benign top-level and dependency key reordering remains unchanged published payload", async () => {
  await fixture(async (root) => {
    const originalManifest = {
      ...manifest("@opengeni/connect", "0.3.0"),
      dependencies: { "left-fixture": "1.0.0", "right-fixture": "1.0.0" },
    };
    const changedManifest = Object.fromEntries(
      Object.entries(originalManifest).reverse(),
    ) as SmokeManifest;
    changedManifest.dependencies = { "right-fixture": "1.0.0", "left-fixture": "1.0.0" };
    const original = await pack(root, "registry", originalManifest, closed);
    const changed = await pack(root, "candidate", changedManifest, closed);
    const registry = await effectiveRegistry(
      new Map([[changed.manifest.name, changed]]),
      await sourceFor(original),
      root,
    );
    registry.stop();
  });
});

for (const selection of ["files", ".npmignore", ".gitignore"] as const) {
  // Real npm packing/staging can exceed Bun's 5s default on a cold CI runner.
  // Bound only these integration cases; inventory and asset checks stay fail-closed.
  test(`candidate staging matches npm publication inventory with ${selection} selection`, async () => {
    await fixture(async (root) => {
      const source = join(root, "source");
      const reference = join(root, "reference");
      const publishedTarballs = join(root, "published");
      const staging = join(root, "candidate");
      const sourceManifest: SmokeManifest = {
        ...manifest("@opengeni/staging-fixture", "0.3.0"),
        main: "./src/index.ts",
        exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
        ...(selection === "files" ? { files: ["dist", "runtime-data.json"] } : {}),
        scripts: { prepack: 'node -e "process.exit(91)"' },
        dependencies: { "@opengeni/connect": "workspace:*" },
        devDependencies: { "private-fixture": "workspace:*" },
      };
      const ignores = [
        "src/",
        "ignored-root.json",
        "node_modules/",
        ".cache/",
        ".turbo/",
        ".bun-cache/",
        "README.md",
        "LICENSE.txt",
        ...(selection === "files" ? ["runtime-data.json"] : []),
      ].join("\n");
      const files = {
        "package.json": JSON.stringify(sourceManifest),
        "dist/index.js": "export const value = 1;",
        "dist/index.d.ts": "export declare const value: number;",
        "dist/.npmignore": "ignored.txt\n",
        "dist/ignored.txt": "excluded nested file",
        "src/index.ts": "export const value = 1;",
        "runtime-data.json": '{"runtime":"asset"}',
        "ignored-root.json": '{"excluded":true}',
        "README.md": "Default npm inclusion",
        "LICENSE.txt": "Default npm license inclusion",
        "node_modules/private-fixture/index.js": "private dependency",
        ".cache/stale.bin": "build cache",
        ".turbo/stale.bin": "build cache",
        ".bun-cache/stale.bin": "dependency cache",
        [selection === ".gitignore" ? ".gitignore" : ".npmignore"]: ignores,
        ...(selection === ".npmignore" ? { ".gitignore": "runtime-data.json\n" } : {}),
      };
      for (const [path, contents] of Object.entries(files)) {
        await mkdir(dirname(join(source, path)), { recursive: true });
        await writeFile(join(source, path), contents);
      }
      const versions = new Map([["@opengeni/connect", "0.3.0"]]);
      const publishedManifest = candidateManifest(sourceManifest, versions);
      await cp(source, reference, { recursive: true });
      await writeFile(join(reference, "package.json"), JSON.stringify(publishedManifest));
      await mkdir(publishedTarballs);
      const packed = JSON.parse(
        await run(
          [
            "npm",
            "pack",
            "--ignore-scripts",
            "--offline",
            "--json",
            "--pack-destination",
            publishedTarballs,
          ],
          reference,
        ),
      ) as Array<{ filename: string }>;
      const published = join(publishedTarballs, packed[0]!.filename);
      const pkg: WorkspacePackage = {
        dir: relative(repoRoot, source),
        packagePath: join(source, "package.json"),
        name: sourceManifest.name,
        version: sourceManifest.version,
        packageJson: sourceManifest,
      };
      const candidate = await stageRegistryCandidate(pkg, staging, versions);
      const inventory = await shippedInventory(candidate.tarball, root);
      for (const path of ["runtime-data.json", "README.md", "LICENSE.txt"])
        expect(inventory.has(path)).toBe(true);
      for (const path of ["ignored-root.json", "dist/ignored.txt"])
        expect(inventory.has(path)).toBe(false);
      expect(inventory).toEqual(await shippedInventory(published, root));
      await assertUnchangedPublishedSourceAndAssets(pkg.name, candidate.tarball, published, root);
      expect(await readFile(pkg.packagePath, "utf8")).toBe(files["package.json"]);
      for (const directory of ["node_modules", ".cache", ".turbo", ".bun-cache"])
        await expect(lstat(join(staging, "package", directory))).rejects.toThrow("ENOENT");
    });
  }, 30_000);
}

test("effective closure rejects changed unpublished Connect bytes labelled as the existing 0.3.0 version", async () => {
  await fixture(async (root) => {
    const connect = manifest("@opengeni/connect", "0.3.0");
    const old = await pack(root, "registry", connect, timeout);
    const local = await pack(root, "candidate", connect, closed);
    await expect(
      effectiveRegistry(new Map([[connect.name, local]]), await sourceFor(old), root),
    ).rejects.toThrow("changed shipped source/manifest/assets without a new version: index.js");
  });
});

test("effective registry serves existing integrity-checked bytes, so a new React importing a missing export fails", async () => {
  await fixture(async (root) => {
    const connect = await pack(root, "connect", manifest("@opengeni/connect", "0.3.0"), timeout);
    const react = await pack(
      root,
      "react",
      manifest("@opengeni/react", "7.4.0", { "@opengeni/connect": "^0.3.0" }),
      importer,
    );
    const candidates = new Map([
      [connect.manifest.name, connect],
      [react.manifest.name, react],
    ]);
    const registry = await effectiveRegistry(candidates, await sourceFor(connect), root);
    try {
      await expect(proveEffectiveConsumers(candidates, profiles, registry, root)).rejects.toThrow(
        "ConnectPopupClosedError",
      );
    } finally {
      registry.stop();
    }
  });
});

test("legitimate new Connect and React versions install by declared ranges and pass before publication", async () => {
  await fixture(async (root) => {
    const old = await pack(root, "registry", manifest("@opengeni/connect", "0.3.0"), timeout);
    const connect = await pack(root, "connect", manifest("@opengeni/connect", "0.3.1"), closed);
    const react = await pack(
      root,
      "react",
      manifest("@opengeni/react", "7.5.0", { "@opengeni/connect": "^0.3.1" }),
      importer,
    );
    const candidates = new Map([
      [connect.manifest.name, connect],
      [react.manifest.name, react],
    ]);
    const registry = await effectiveRegistry(candidates, await sourceFor(old), root);
    try {
      const forwarded = await fetch(`${registry.url}unscoped-fixture`);
      expect(forwarded.headers.get("content-encoding")).toBeNull();
      expect((await forwarded.json()).name).toBe("unscoped-fixture");
      await proveEffectiveConsumers(candidates, profiles, registry, root);
    } finally {
      registry.stop();
    }
  });
});

for (const hasExport of [false, true]) {
  test(`compatible new Connect ${hasExport ? "retains" : "removes"} the required export while minimum retains the published floor`, async () => {
    await fixture(async (root) => {
      const old = await pack(root, "registry", manifest("@opengeni/connect", "0.3.0"), closed);
      const connect = await pack(
        root,
        "connect",
        manifest("@opengeni/connect", "0.3.1"),
        hasExport ? closed : timeout,
      );
      const react = await pack(
        root,
        "react",
        manifest("@opengeni/react", "7.5.0", { "@opengeni/connect": "^0.3.0" }),
        importer,
      );
      const candidates = new Map([
        [connect.manifest.name, connect],
        [react.manifest.name, react],
      ]);
      const bytes = await readFile(old.tarball);
      const published = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(bytes),
      });
      let registry: Awaited<ReturnType<typeof effectiveRegistry>> | undefined;
      try {
        const source = await sourceFor(old, `${published.url}fixture.tgz`);
        registry = await effectiveRegistry(
          candidates,
          source,
          root,
          new Set(["@opengeni/connect@0.3.1", "@opengeni/react@7.5.0"]),
        );
        const proof = proveEffectiveConsumers(candidates, profiles, registry, root);
        if (hasExport) await proof;
        else {
          await expect(proof).rejects.toThrow(
            /@opengeni\/react resolved:[\s\S]*ConnectPopupClosedError/u,
          );
          await expect(proof).rejects.not.toThrow("@opengeni/react minimum:");
        }
        expect(registry.metadata.get("@opengeni/connect")!["dist-tags"].latest).toBe("0.3.1");
        expect((await source.metadata("@opengeni/connect"))["dist-tags"].latest).toBe("0.3.0");
        for (const [lane, version] of [
          ["resolved", "0.3.1"],
          ["minimum", "0.3.0"],
        ] as const) {
          const installed = join(root, `_opengeni_react-${lane}`, "node_modules/@opengeni/react");
          const dependency = JSON.parse(
            await readFile(Bun.resolveSync("@opengeni/connect/package.json", installed), "utf8"),
          ) as SmokeManifest;
          expect(dependency.version).toBe(version);
        }
      } finally {
        registry?.stop();
        published.stop(true);
      }
    });
  });
}

test("new dependency candidates must belong to the requested publication set when supplied", async () => {
  await fixture(async (root) => {
    const connect = await pack(root, "connect", manifest("@opengeni/connect", "0.3.1"), closed);
    await expect(
      effectiveRegistry(
        new Map([[connect.manifest.name, connect]]),
        {
          metadata: async (name) => ({ name, "dist-tags": {}, versions: {} }),
          tarball: async () => {
            throw new Error("No published version");
          },
        },
        root,
        new Set(["@opengeni/react@7.5.0"]),
      ),
    ).rejects.toThrow("not in the intended publication set");
  });
});

test("ordinary range resolution and minimum lane do not admit a candidate outside React's declared bounds", async () => {
  await fixture(async (root) => {
    const connect = await pack(root, "connect", manifest("@opengeni/connect", "0.4.0"), closed);
    const react = await pack(
      root,
      "react",
      manifest("@opengeni/react", "7.5.0", { "@opengeni/connect": "^0.3.0" }),
      importer,
    );
    const candidates = new Map([
      [connect.manifest.name, connect],
      [react.manifest.name, react],
    ]);
    const registry = await effectiveRegistry(
      candidates,
      {
        metadata: async (name) => ({ name, "dist-tags": {}, versions: {} }),
        tarball: async () => {
          throw new Error("No published tarball");
        },
      },
      root,
    );
    try {
      await expect(proveEffectiveConsumers(candidates, profiles, registry, root)).rejects.toThrow(
        "No published version satisfies declared range ^0.3.0",
      );
    } finally {
      registry.stop();
    }
  });
});

test("registry tarball integrity is mandatory and verified before candidate comparison", () => {
  const bytes = Buffer.from("published fixture");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  verifyTarballIntegrity(bytes, integrity);
  expect(() => verifyTarballIntegrity(Buffer.from("changed"), integrity)).toThrow(
    "integrity mismatch",
  );
  expect(() => verifyTarballIntegrity(bytes, "")).toThrow("missing strong integrity");
});
