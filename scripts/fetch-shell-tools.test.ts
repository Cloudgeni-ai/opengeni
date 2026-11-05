import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import {
  MANAGED_SHELL_TOOLS_TARGETS,
  SHELL_TOOLS_TARGETS,
  SHELL_TOOLS_VERSIONS,
  type ShellToolAsset,
} from "../packages/runtime/src/sandbox/shell-tools-manifest";
import { buildManagedShellToolsBundle } from "../packages/runtime/src/sandbox/shell-tools";
import { extractShellTool, fetchShellTools, tarMember, zipMember } from "./fetch-shell-tools";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "opengeni-fetch-shell-tools-"));
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A minimal stored (uncompressed) zip with one member. */
function storedZip(name: string, body: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + nameBytes.byteLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint32(18, body.byteLength, true);
  localView.setUint32(22, body.byteLength, true);
  localView.setUint16(26, nameBytes.byteLength, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.byteLength);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint32(20, body.byteLength, true);
  centralView.setUint32(24, body.byteLength, true);
  centralView.setUint16(28, nameBytes.byteLength, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, local.byteLength + body.byteLength, true);
  return Buffer.concat([local, body, central, end]);
}

describe("pinned shell tools manifest", () => {
  test("pins official ripgrep >= 15.2.0 and jq >= 1.7 for every agent target", () => {
    const [major, minor] = SHELL_TOOLS_VERSIONS.rg.version.split(".").map(Number);
    expect(major! > 15 || (major === 15 && minor! >= 2)).toBe(true);
    const [jqMajor, jqMinor] = SHELL_TOOLS_VERSIONS.jq.version.split(".").map(Number);
    expect(jqMajor! > 1 || (jqMajor === 1 && jqMinor! >= 7)).toBe(true);
    expect(Object.keys(SHELL_TOOLS_TARGETS).sort()).toEqual(
      [
        "aarch64-apple-darwin",
        "aarch64-pc-windows-msvc",
        "aarch64-unknown-linux-musl",
        "x86_64-apple-darwin",
        "x86_64-pc-windows-msvc",
        "x86_64-unknown-linux-musl",
      ].sort(),
    );
    for (const assets of Object.values(SHELL_TOOLS_TARGETS)) {
      expect(assets.rg.url).toStartWith("https://github.com/BurntSushi/ripgrep/releases/download/");
      expect(assets.jq.url).toStartWith("https://github.com/jqlang/jq/releases/download/");
      for (const asset of [assets.rg, assets.jq]) {
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(asset.binarySha256).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
  });

  test("image builds pin exactly the manifest's Linux assets", async () => {
    const linux = Object.values(MANAGED_SHELL_TOOLS_TARGETS).flatMap((target) => [
      SHELL_TOOLS_TARGETS[target].rg,
      SHELL_TOOLS_TARGETS[target].jq,
    ]);
    const expected = linux.map((asset) => `${asset.sha256} ${asset.url}`).sort();
    for (const path of [
      "docker/opengeni.Dockerfile",
      "docker/sandbox.Dockerfile",
      "docker/desktop.Dockerfile",
    ]) {
      const source = await readFile(join(root, path), "utf8");
      const pins = [
        ...source.matchAll(
          /^ADD --checksum=sha256:([0-9a-f]{64}) (\S+) \/cache\/([0-9a-f]{64})$/gmu,
        ),
      ]
        .map((match) => {
          expect(match[3]).toBe(match[1]!);
          return `${match[1]} ${match[2]}`;
        })
        .sort();
      expect({ path, pins }).toEqual({ path, pins: expected });
      expect(source).toContain("bun scripts/fetch-shell-tools.ts --offline");
    }
  });

  test("every agent build embeds the fetched tools", async () => {
    for (const path of ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"]) {
      const source = await readFile(join(root, path), "utf8");
      const builds = source
        .split("\n")
        .filter((line) => /cargo build .*-p opengeni-agent\b/u.test(line));
      expect(builds.length).toBeGreaterThan(0);
      for (const line of builds)
        expect(line).toContain("OPENGENI_EMBEDDED_SHELL_TOOLS=/shell-tools");
      expect(source).toContain("COPY --from=shell-tools-fetch /out/ /shell-tools/");
    }
    const worker = await readFile(join(root, "docker/opengeni.Dockerfile"), "utf8");
    expect(worker).toContain(
      "OPENGENI_SHELL_TOOLS_DIR=/tmp/shell-tools bun scripts/build-runtime-processes.ts worker",
    );

    // Release agents fetch the tools from build.rs: each agent build there
    // names its source in OPENGENI_RUNTIME_BUILD_ID and runs after Bun is set up.
    const workflow = parse(
      await readFile(join(root, ".github/workflows/agent-release.yml"), "utf8"),
    ) as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            uses?: string;
            run?: string;
            env?: Record<string, string>;
          }>;
        }
      >;
    };
    let agentBuilds = 0;
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      // Each job is its own runner: Bun must be set up in the same job.
      const bun = steps.findIndex((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
      steps.forEach((step, index) => {
        if (!/cargo (zig)?build [^\n]*-p opengeni-agent\b/u.test(step.run ?? "")) return;
        agentBuilds++;
        expect({ job: name, bunBeforeBuild: bun >= 0 && index > bun }).toEqual({
          job: name,
          bunBeforeBuild: true,
        });
        expect(
          step.env?.OPENGENI_RUNTIME_BUILD_ID !== undefined ||
            (step.run ?? "").includes("OPENGENI_RUNTIME_BUILD_ID="),
        ).toBe(true);
      });
    }
    expect(agentBuilds).toBeGreaterThanOrEqual(3);
    const buildScript = await readFile(join(root, "agent/crates/opengeni-agent/build.rs"), "utf8");
    expect(buildScript).toContain('env::var_os("OPENGENI_RUNTIME_BUILD_ID")?');
    expect(buildScript).toContain("scripts/fetch-shell-tools.ts");
    // Without Bun a release build fails instead of shipping without the tools.
    expect(buildScript).toContain("a release build needs bun to fetch the pinned rg and jq");
  });
});

describe("fetch-shell-tools", () => {
  const rg = new TextEncoder().encode("#!/bin/sh\necho rg\n");
  const jq = new TextEncoder().encode("#!/bin/sh\necho jq\n");

  test("extracts and verifies a tar.gz member, a zip member and a bare executable", () => {
    const bundle = buildManagedShellToolsBundle({ rg, jq, notices: new Uint8Array() });
    const tarGz: ShellToolAsset = {
      url: "https://example.invalid/x.tar.gz",
      sha256: bundle.sha256,
      member: "rg",
      binarySha256: sha256(rg),
    };
    expect(extractShellTool(tarGz, bundle.bytes)).toEqual(rg);

    const zip = storedZip("ripgrep/rg.exe", rg);
    const zipAsset: ShellToolAsset = {
      url: "https://example.invalid/x.zip",
      sha256: sha256(zip),
      member: "ripgrep/rg.exe",
      binarySha256: sha256(rg),
    };
    expect(extractShellTool(zipAsset, zip)).toEqual(rg);
    expect(zipMember(zip, "other")).toBeNull();

    const bare: ShellToolAsset = {
      url: "https://example.invalid/jq",
      sha256: sha256(jq),
      binarySha256: sha256(jq),
    };
    expect(extractShellTool(bare, jq)).toEqual(jq);
  });

  test("rejects a changed download and a changed executable", () => {
    const bare: ShellToolAsset = {
      url: "https://example.invalid/jq",
      sha256: sha256(jq),
      binarySha256: sha256(jq),
    };
    expect(() => extractShellTool(bare, rg)).toThrow("does not match its pinned SHA-256");
    const bundle = buildManagedShellToolsBundle({ rg, jq, notices: new Uint8Array() });
    const wrongMember: ShellToolAsset = {
      url: "https://example.invalid/x.tar.gz",
      sha256: bundle.sha256,
      member: "jq",
      binarySha256: sha256(rg),
    };
    expect(() => extractShellTool(wrongMember, bundle.bytes)).toThrow(
      "does not match its pinned SHA-256",
    );
    expect(tarMember(new Uint8Array(Bun.gunzipSync(bundle.bytes)), "missing")).toBeNull();
  });

  test("offline mode never downloads", async () => {
    const previous = process.env.OPENGENI_SHELL_TOOLS_CACHE;
    process.env.OPENGENI_SHELL_TOOLS_CACHE = join(scratch, "empty-cache");
    try {
      await expect(
        fetchShellTools({
          out: join(scratch, "out"),
          targets: ["x86_64-unknown-linux-musl"],
          offline: true,
        }),
      ).rejects.toThrow("--offline");
    } finally {
      if (previous === undefined) delete process.env.OPENGENI_SHELL_TOOLS_CACHE;
      else process.env.OPENGENI_SHELL_TOOLS_CACHE = previous;
    }
  });

  test("a corrupted cache entry is not used offline", async () => {
    const cache = join(scratch, "bad-cache");
    const asset = SHELL_TOOLS_TARGETS["x86_64-unknown-linux-musl"].rg;
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, asset.sha256), gzipSync(new Uint8Array(16)));
    const previous = process.env.OPENGENI_SHELL_TOOLS_CACHE;
    process.env.OPENGENI_SHELL_TOOLS_CACHE = cache;
    try {
      await expect(
        fetchShellTools({
          out: join(scratch, "out2"),
          targets: ["x86_64-unknown-linux-musl"],
          offline: true,
        }),
      ).rejects.toThrow("not in the cache");
    } finally {
      if (previous === undefined) delete process.env.OPENGENI_SHELL_TOOLS_CACHE;
      else process.env.OPENGENI_SHELL_TOOLS_CACHE = previous;
    }
  });
});
