import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  effectiveRegistry,
  proveEffectiveConsumers,
  verifyTarballIntegrity,
  type PackedCandidate,
  type RegistryManifest,
  type RegistryMetadata,
} from "./test-effective-dependency-exports";
import { run, type SmokeManifest } from "./test-registry-dependency-exports";

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
    JSON.stringify({ ...packageManifest, files: Object.keys(files) }),
  );
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(directory, name), contents);
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
        ).rejects.toThrow("changed shipped bytes without a new version: package.json");
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

test("effective closure rejects changed unpublished Connect bytes labelled as the existing 0.3.0 version", async () => {
  await fixture(async (root) => {
    const connect = manifest("@opengeni/connect", "0.3.0");
    const old = await pack(root, "registry", connect, timeout);
    const local = await pack(root, "candidate", connect, closed);
    await expect(
      effectiveRegistry(new Map([[connect.name, local]]), await sourceFor(old), root),
    ).rejects.toThrow("changed shipped bytes without a new version: index.js");
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
