import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type PackageManifest = {
  name: string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/** Copy the frozen install's runtime graph, not a freshly resolved install.
 * Retain real package locations and rebuild relative aliases so native loaders,
 * package-local assets and distinct versions resolve exactly as in the builder.
 * Development dependencies never extend the graph. */
export async function copyRuntimeDependencies(
  root: string,
  destination: string,
  importer: string,
  packages: readonly string[],
): Promise<string[]> {
  root = resolve(root);
  destination = resolve(destination);
  const copied = new Set<string>();
  const aliases = new Set<string>();
  const outputPath = (source: string) => {
    const path = relative(root, source);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
      throw new Error(`Runtime dependency escaped the frozen install: ${source}`);
    }
    return join(destination, path);
  };

  function locate(name: string, from: string): string | undefined {
    let directory = from;
    while (true) {
      // Node skips a node_modules directory when searching its parents.
      if (!directory.endsWith(`${sep}node_modules`)) {
        const candidate = join(directory, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) return candidate;
      }
      if (directory === root) return undefined;
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      outputPath(parent);
      directory = parent;
    }
  }

  async function visit(name: string, from: string, optional = false): Promise<void> {
    const alias = locate(name, from);
    if (!alias) {
      if (optional) return;
      throw new Error(`Missing frozen runtime dependency ${name} from ${from}`);
    }
    const physical = await realpath(alias);
    const target = outputPath(physical);
    if (!copied.has(physical)) {
      copied.add(physical);
      const manifest = JSON.parse(
        await readFile(join(physical, "package.json"), "utf8"),
      ) as PackageManifest;
      // The bridge archive contains every supported platform plus its Rust
      // build tree. Use its own loader's target selection, not a second ABI
      // mapping, and retain all other package assets without guessing at them.
      const nativeRelease =
        manifest.name === "@temporalio/core-bridge"
          ? relative(
              physical,
              createRequire(join(physical, "package.json"))("./common.js").getPrebuiltPath(),
            ).split(sep)[1]
          : undefined;
      if (manifest.name === "@temporalio/core-bridge" && !nativeRelease) {
        throw new Error("Temporal native loader did not select a prebuilt runtime target");
      }
      await mkdir(dirname(target), { recursive: true });
      await cp(physical, target, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (source) => {
          const parts = relative(physical, source).split(sep);
          if (parts.some((part) => part.startsWith(".bun-tag-"))) return false;
          if (manifest.name.startsWith("@opengeni/") && parts.length > 0 && parts[0]) {
            // Workspace links point at checkouts rather than packed packages.
            // Preserve the published runtime files, not tests or build inputs.
            const allowed = new Set([
              "package.json",
              "LICENSE",
              "README.md",
              ...(manifest.files ?? []),
              "kernel",
            ]);
            if (!allowed.has(parts[0])) return false;
          }
          if (!nativeRelease) return true;
          if (parts[0] === "releases") return parts.length === 1 || parts[1] === nativeRelease;
          return ![
            "bridge-macros",
            "Cargo.lock",
            "Cargo.toml",
            "sdk-core",
            "scripts",
            "src",
            "ts",
          ].includes(parts[0]!);
        },
      });
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        await visit(dependency, physical, dependency in (manifest.optionalDependencies ?? {}));
      }
      for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
        await visit(dependency, physical, true);
      }
      for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
        await visit(dependency, physical, manifest.peerDependenciesMeta?.[dependency]?.optional);
      }
    }
    if (alias !== physical && !aliases.has(alias)) {
      aliases.add(alias);
      const outputAlias = outputPath(alias);
      await mkdir(dirname(outputAlias), { recursive: true });
      if (!existsSync(outputAlias)) {
        await symlink(relative(dirname(outputAlias), target), outputAlias, "dir");
      }
    }
  }

  for (const name of packages) await visit(name, resolve(root, importer));
  return [...copied].map((path) => relative(root, path)).sort();
}
