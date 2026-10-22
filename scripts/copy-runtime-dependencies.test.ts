import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { copyRuntimeDependencies } from "./copy-runtime-dependencies";

test("copies only frozen runtime dependencies, preserving aliases, versions and optional peers", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "opengeni-runtime-closure-"));
  const root = join(fixture, "source");
  const output = join(fixture, "runtime");
  async function pkg(name: string, version: string, extra: Record<string, unknown> = {}) {
    const path = join(root, "node_modules/.bun", `${name}@${version}`, "node_modules", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version, ...extra }));
    await writeFile(join(path, "native.node"), version);
    return path;
  }
  async function alias(path: string, target: string) {
    await mkdir(dirname(path), { recursive: true });
    await symlink(relative(dirname(path), target), path);
  }
  try {
    const leaf1 = await pkg("leaf", "1");
    const leaf2 = await pkg("leaf", "2");
    const dev = await pkg("compiler", "1");
    const a = await pkg("a", "1", {
      dependencies: { leaf: "1", b: "1" },
      devDependencies: { compiler: "1" },
      optionalDependencies: { absentPlatform: "1" },
      peerDependencies: { leaf: "1", absentPeer: "1" },
      peerDependenciesMeta: { absentPeer: { optional: true } },
    });
    const b = await pkg("b", "1", { dependencies: { leaf: "2", a: "1" } });
    await alias(join(root, "apps/api/node_modules/a"), a);
    await alias(join(dirname(a), "leaf"), leaf1);
    await alias(join(dirname(a), "b"), b);
    await alias(join(dirname(a), "compiler"), dev);
    await alias(join(dirname(b), "leaf"), leaf2);
    await alias(join(dirname(b), "a"), a);

    const packages = await copyRuntimeDependencies(root, output, "apps/api", ["a"]);
    expect(packages).toHaveLength(4);
    expect(packages.some((path) => path.includes("compiler"))).toBe(false);
    const outA = await realpath(join(output, "apps/api/node_modules/a"));
    const outB = await realpath(join(dirname(outA), "b"));
    expect(await readFile(join(dirname(outA), "leaf/native.node"), "utf8")).toBe("1");
    expect(await readFile(join(dirname(outB), "leaf/native.node"), "utf8")).toBe("2");
    expect(await realpath(join(dirname(outB), "a"))).toBe(outA);
    await rm(root, { recursive: true });
    expect(await readFile(join(outA, "native.node"), "utf8")).toBe("1");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("fails closed for missing required packages or links outside the frozen install", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "opengeni-runtime-closure-invalid-"));
  try {
    const root = join(fixture, "source");
    const outside = join(fixture, "outside");
    await mkdir(join(root, "apps/api/node_modules"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "package.json"), '{"name":"external"}');
    await symlink(outside, join(root, "apps/api/node_modules/external"));
    await expect(
      copyRuntimeDependencies(root, join(fixture, "missing"), "apps/api", ["missing"]),
    ).rejects.toThrow("Missing frozen runtime dependency");
    await expect(
      copyRuntimeDependencies(root, join(fixture, "escaped"), "apps/api", ["external"]),
    ).rejects.toThrow("escaped the frozen install");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Temporal bridge closure retains only the loader-selected native target and runtime files", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "opengeni-native-runtime-closure-"));
  try {
    const root = join(fixture, "source");
    const bridge = join(root, "apps/worker/node_modules/@temporalio/core-bridge");
    for (const directory of ["releases/selected", "releases/foreign", "sdk-core", "lib"]) {
      await mkdir(join(bridge, directory), { recursive: true });
      await writeFile(join(bridge, directory, "index.node"), directory);
    }
    await writeFile(join(bridge, "package.json"), '{"name":"@temporalio/core-bridge"}');
    await writeFile(
      join(bridge, "common.js"),
      "exports.getPrebuiltPath = () => require('node:path').join(__dirname, 'releases/selected/index.node');",
    );
    await writeFile(join(bridge, "Cargo.toml"), "build-only");
    const output = join(fixture, "runtime");
    await copyRuntimeDependencies(root, output, "apps/worker", ["@temporalio/core-bridge"]);
    const copy = join(output, "apps/worker/node_modules/@temporalio/core-bridge");
    expect(await readdir(join(copy, "releases"))).toEqual(["selected"]);
    expect(await readFile(join(copy, "lib/index.node"), "utf8")).toBe("lib");
    expect(await readdir(copy)).not.toContain("sdk-core");
    expect(await readdir(copy)).not.toContain("Cargo.toml");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("workspace runtime closure keeps published source and kernel assets without checkout tests", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "opengeni-workspace-runtime-closure-"));
  try {
    const root = join(fixture, "source");
    const workspace = join(root, "packages/example");
    for (const directory of ["src", "dist", "kernel", "tests"]) {
      await mkdir(join(workspace, directory), { recursive: true });
      await writeFile(join(workspace, directory, "asset"), directory);
    }
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ name: "@opengeni/example", files: ["src", "dist"] }),
    );
    await mkdir(join(root, "node_modules/@opengeni"), { recursive: true });
    await symlink("../../packages/example", join(root, "node_modules/@opengeni/example"));
    const output = join(fixture, "runtime");
    await copyRuntimeDependencies(root, output, ".", ["@opengeni/example"]);
    expect((await readdir(join(output, "packages/example"))).sort()).toEqual([
      "dist",
      "kernel",
      "package.json",
      "src",
    ]);
    expect(
      await readFile(join(output, "node_modules/@opengeni/example/kernel/asset"), "utf8"),
    ).toBe("kernel");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
