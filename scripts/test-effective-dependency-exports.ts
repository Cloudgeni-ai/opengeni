#!/usr/bin/env bun
/** Prepublication proof of the effective, immutable npm release closure. */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publishableWorkspacePackages,
  workspaceVersionMap,
  type WorkspacePackage,
} from "./publishable-workspaces";
import {
  consumerManifest,
  lowestPublishedVersion,
  proveInstalledConsumer,
  registryExportProfiles,
  run,
  stageRegistryCandidate,
  type Profile,
  type SmokeManifest,
} from "./test-registry-dependency-exports";

export type PackedCandidate = { manifest: SmokeManifest; tarball: string };
export type RegistryManifest = SmokeManifest & { dist: { tarball: string; integrity: string } };
export type RegistryMetadata = {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, RegistryManifest>;
};
type RegistrySource = {
  metadata(name: string): Promise<RegistryMetadata>;
  tarball(manifest: RegistryManifest): Promise<Uint8Array>;
};

export function verifyTarballIntegrity(bytes: Uint8Array, integrity: string): void {
  // npm uses SRI. Require at least one supported strong digest to match; never
  // treat a missing integrity value or a weak shasum as immutable-byte proof.
  const supported = integrity
    .split(/\s+/u)
    .filter((part) => /^(sha256|sha384|sha512)-/u.test(part));
  if (
    !supported.some((part) => {
      const dash = part.indexOf("-");
      return (
        createHash(part.slice(0, dash)).update(bytes).digest("base64") === part.slice(dash + 1)
      );
    })
  )
    throw new Error("Registry tarball integrity mismatch or missing strong integrity");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

export async function shippedInventory(
  tarball: string,
  root: string,
): Promise<Map<string, string>> {
  const directory = await mkdtemp(join(root, "inventory-"));
  const names = (await run(["tar", "-tzf", tarball], root)).trim().split("\n");
  if (
    names.some(
      (name) =>
        !name.startsWith("package/") || name.split("/").includes("..") || name.includes("\\"),
    )
  ) {
    throw new Error("Unsafe path in package tarball");
  }
  const entries = (await run(["tar", "-tvzf", tarball], root)).trim().split("\n");
  if (entries.some((line) => !["-", "d"].includes(line[0]!))) {
    throw new Error("Package tarball may contain only regular files and directories");
  }
  await run(
    ["tar", "-xzf", tarball, "--no-same-owner", "--no-same-permissions", "-C", directory],
    root,
  );
  const inventory = new Map<string, string>();
  async function visit(path: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
      else {
        if (!entry.isFile()) throw new Error(`Nonregular packed file ${name}`);
        let bytes = await readFile(join(path, entry.name));
        if (name === "package.json")
          bytes = Buffer.from(JSON.stringify(canonicalJson(JSON.parse(bytes.toString("utf8")))));
        inventory.set(name, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
  await visit(join(directory, "package"));
  await rm(directory, { recursive: true, force: true });
  return inventory;
}

export async function assertUnchangedPublishedBytes(
  name: string,
  candidate: string,
  published: string,
  root: string,
): Promise<void> {
  const [local, registry] = await Promise.all([
    shippedInventory(candidate, root),
    shippedInventory(published, root),
  ]);
  const changed = [...new Set([...local.keys(), ...registry.keys()])]
    .filter((path) => local.get(path) !== registry.get(path))
    .sort();
  if (changed.length)
    throw new Error(
      `${name} changed shipped bytes without a new version: ${changed.slice(0, 12).join(", ")}`,
    );
}

/**
 * Read-only loopback registry overlay, not an install override. Ordinary semver
 * resolution sees real npm versions plus genuinely new versions from this cut.
 * Already-published identities are always served from integrity-verified npm
 * tarballs and must equal the candidate's shipped payload, not local siblings.
 */
export async function effectiveRegistry(
  candidates: ReadonlyMap<string, PackedCandidate>,
  source: RegistrySource,
  root: string,
  intendedNewVersions?: ReadonlySet<string>,
): Promise<{ url: string; metadata: Map<string, RegistryMetadata>; stop(): void }> {
  const metadata = new Map<string, RegistryMetadata>();
  const tarballs = new Map<string, Uint8Array>();
  for (const [name, candidate] of candidates) {
    const packument = structuredClone(await source.metadata(name));
    const existing = packument.versions[candidate.manifest.version];
    let bytes: Uint8Array;
    if (existing) {
      bytes = await source.tarball(existing);
      verifyTarballIntegrity(bytes, existing.dist.integrity ?? "");
      const published = join(root, `${name.replace(/[^a-zA-Z0-9]/gu, "_")}.tgz`);
      await writeFile(published, bytes);
      await assertUnchangedPublishedBytes(
        `${name}@${candidate.manifest.version}`,
        candidate.tarball,
        published,
        root,
      );
      process.stdout.write(
        `[effective-exports] ${name}@${candidate.manifest.version}: immutable registry bytes\n`,
      );
    } else {
      if (
        intendedNewVersions &&
        !intendedNewVersions.has(`${name}@${candidate.manifest.version}`)
      ) {
        throw new Error(
          `${name}@${candidate.manifest.version} is new but not in the intended publication set`,
        );
      }
      bytes = await readFile(candidate.tarball);
      packument.versions[candidate.manifest.version] = {
        ...candidate.manifest,
        dist: {
          tarball: "",
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        },
      };
      process.stdout.write(
        `[effective-exports] ${name}@${candidate.manifest.version}: new release candidate\n`,
      );
    }
    tarballs.set(`${name}@${candidate.manifest.version}`, bytes);
    metadata.set(name, packument);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/tarballs/")) {
        const bytes = tarballs.get(decodeURIComponent(path.slice("/tarballs/".length)));
        return bytes
          ? new Response(Buffer.from(bytes))
          : new Response("Not found", { status: 404 });
      }
      const name = decodeURIComponent(path.slice(1));
      const packument = metadata.get(name);
      if (packument) return Response.json(packument);
      // Reserialize metadata rather than forwarding fetch's decoded body with
      // upstream Content-Encoding/Length headers. Other tarballs keep npm URLs.
      return Response.json(await source.metadata(name));
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  for (const [name, candidate] of candidates) {
    metadata.get(name)!.versions[candidate.manifest.version]!.dist.tarball =
      `${url}tarballs/${encodeURIComponent(`${name}@${candidate.manifest.version}`)}`;
  }
  return { url, metadata, stop: () => server.stop(true) };
}

export async function proveEffectiveConsumers(
  candidates: ReadonlyMap<string, PackedCandidate>,
  profiles: Readonly<Record<string, Profile>>,
  registry: Awaited<ReturnType<typeof effectiveRegistry>>,
  root: string,
): Promise<void> {
  const failures: string[] = [];
  for (const [name, profile] of Object.entries(profiles)) {
    const candidate = candidates.get(name);
    if (!candidate) throw new Error(`Missing effective candidate ${name}`);
    for (const lane of ["resolved", "minimum"] as const) {
      try {
        const consumer = join(root, `${name.replace(/[^a-zA-Z0-9]/gu, "_")}-${lane}`);
        await mkdir(consumer);
        const minimums: Record<string, string> = {};
        if (lane === "minimum") {
          for (const [dep, range] of Object.entries(candidate.manifest.dependencies ?? {})) {
            if (!dep.startsWith("@opengeni/")) continue;
            const metadata = registry.metadata.get(dep);
            if (!metadata) throw new Error(`Missing effective dependency ${dep}`);
            minimums[dep] = lowestPublishedVersion(range, Object.keys(metadata.versions));
          }
        }
        await writeFile(
          join(consumer, "package.json"),
          JSON.stringify(
            consumerManifest(candidate.manifest, candidate.manifest.version, minimums),
          ),
        );
        await run(["bun", "install", "--ignore-scripts", "--registry", registry.url], consumer);
        const installed = join(consumer, "node_modules", name);
        if ((await lstat(installed)).isSymbolicLink())
          throw new Error(`${name} is a workspace link`);
        const manifest = JSON.parse(
          await readFile(join(installed, "package.json"), "utf8"),
        ) as SmokeManifest;
        if (manifest.version !== candidate.manifest.version)
          throw new Error(`${name} installed the wrong version`);
        for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
          if (!dep.startsWith("@opengeni/")) continue;
          const actual = JSON.parse(
            await readFile(Bun.resolveSync(`${dep}/package.json`, installed), "utf8"),
          ) as SmokeManifest;
          if (
            !Bun.semver.satisfies(actual.version, range) ||
            (minimums[dep] && actual.version !== minimums[dep])
          ) {
            throw new Error(`${name} declared ${dep}@${range}, installed ${actual.version}`);
          }
        }
        await proveInstalledConsumer(consumer, manifest, profile);
        process.stdout.write(`[effective-exports] ${name} ${lane} browser/Node consumers passed\n`);
      } catch (error) {
        failures.push(`${name} ${lane}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n\n"));
}

export async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-effective-exports-"));
  const packages = new Map(publishableWorkspacePackages().map((pkg) => [pkg.name, pkg]));
  const candidates = new Map<string, PackedCandidate>();
  const versions = workspaceVersionMap();
  async function stage(pkg: WorkspacePackage): Promise<void> {
    if (candidates.has(pkg.name)) return;
    const staging = join(root, pkg.name.replace(/[^a-zA-Z0-9]/gu, "_"));
    await mkdir(staging);
    const candidate = await stageRegistryCandidate(pkg, staging, versions);
    candidates.set(pkg.name, candidate);
    for (const name of Object.keys(candidate.manifest.dependencies ?? {})) {
      if (!name.startsWith("@opengeni/")) continue;
      const dependency = packages.get(name);
      if (!dependency) throw new Error(`No intended publishable dependency ${name}`);
      await stage(dependency);
    }
  }
  let registry: Awaited<ReturnType<typeof effectiveRegistry>> | undefined;
  let passed = false;
  try {
    for (const name of Object.keys(registryExportProfiles)) {
      const pkg = packages.get(name);
      if (!pkg) throw new Error(`No publishable workspace ${name}`);
      await stage(pkg);
    }
    const expected = process.env.OPENGENI_EXPECTED_PACKAGES?.trim();
    const intendedNewVersions = expected
      ? new Set(expected.split(",").map((item) => item.trim()))
      : undefined;
    registry = await effectiveRegistry(
      candidates,
      {
        async metadata(name) {
          const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
          if (response.status === 404) return { name, "dist-tags": {}, versions: {} };
          if (!response.ok) throw new Error(`Registry ${name}: HTTP ${response.status}`);
          return (await response.json()) as RegistryMetadata;
        },
        async tarball(manifest) {
          const url = new URL(manifest.dist.tarball);
          if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org")
            throw new Error("Unexpected npm tarball origin");
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Registry tarball HTTP ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        },
      },
      root,
      intendedNewVersions,
    );
    await proveEffectiveConsumers(candidates, registryExportProfiles, registry, root);
    passed = true;
  } finally {
    registry?.stop();
    if (passed) await rm(root, { recursive: true, force: true });
    else process.stderr.write(`[effective-exports] failed consumer evidence retained at ${root}\n`);
  }
}

if (import.meta.main) await main();
