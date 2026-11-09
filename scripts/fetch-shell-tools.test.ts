import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import {
  MANAGED_SHELL_TOOLS_TARGETS,
  SHELL_TOOLS_TARGETS,
  SHELL_TOOLS_VERSIONS,
  type ShellToolDownload,
} from "../packages/runtime/src/sandbox/shell-tools-manifest";
import { buildManagedShellToolsBundle } from "../packages/runtime/src/sandbox/shell-tools";
import {
  extractShellTool,
  fetchShellTools,
  tarMember,
  vendoredShellTool,
  zipMember,
} from "./fetch-shell-tools";

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
    for (const [target, assets] of Object.entries(SHELL_TOOLS_TARGETS)) {
      expect("url" in assets.rg && assets.rg.url).toStartWith(
        "https://github.com/BurntSushi/ripgrep/releases/download/",
      );
      // jq's Linux release executables statically link glibc; Linux gets the
      // static musl builds committed by scripts/build-static-jq.sh instead.
      if (target.endsWith("-linux-musl")) {
        expect("path" in assets.jq && assets.jq.path).toStartWith("agent/vendor/jq/");
      } else {
        expect("url" in assets.jq && assets.jq.url).toStartWith(
          "https://github.com/jqlang/jq/releases/download/",
        );
      }
      for (const asset of [assets.rg, assets.jq]) {
        if ("sha256" in asset) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(asset.binarySha256).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
  });

  test("the committed Linux jq is the pinned static musl build of the pinned release", async () => {
    const script = await readFile(join(root, "scripts/build-static-jq.sh"), "utf8");
    expect(script).toContain(`JQ_VERSION=${SHELL_TOOLS_VERSIONS.jq.version}\n`);
    // The source jq publishes, pinned as in jq's sha256sum.txt.
    expect(script).toContain(
      "JQ_SOURCE_SHA256=71b8d6e8f5fe81f6c6d0d110e3892251f6ce76ed095abd315e26e6e1193af3af",
    );
    const machines = { x86_64: 62, aarch64: 183 } as const;
    for (const [arch, target] of Object.entries(MANAGED_SHELL_TOOLS_TARGETS)) {
      const asset = SHELL_TOOLS_TARGETS[target].jq;
      if (!("path" in asset)) throw new Error(`${target} jq is not the committed build`);
      // The file name scripts/build-static-jq.sh writes.
      expect(asset.path).toBe(
        `agent/vendor/jq/jq-${SHELL_TOOLS_VERSIONS.jq.version}-${arch}-linux-musl`,
      );
      const bytes = await vendoredShellTool(asset);
      const elf = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(elf.getUint32(0, false)).toBe(0x7f454c46);
      expect(elf.getUint16(16, true)).toBe(2); // ET_EXEC: not position-independent, not a library
      expect(elf.getUint16(18, true)).toBe(machines[arch as keyof typeof machines]);
      // Static: no program interpreter and no dynamic section.
      const programHeaders = Number(elf.getBigUint64(32, true));
      const entrySize = elf.getUint16(54, true);
      const types = Array.from({ length: elf.getUint16(56, true) }, (_, index) =>
        elf.getUint32(programHeaders + index * entrySize, true),
      );
      expect(types.length).toBeGreaterThan(0);
      expect(types).not.toContain(2); // PT_DYNAMIC
      expect(types).not.toContain(3); // PT_INTERP
      const text = new TextDecoder("latin1").decode(bytes);
      expect(text).not.toContain("GLIBC");
      expect(text).toContain("--with-oniguruma=builtin");
    }
  });

  test("image builds pin exactly the manifest's Linux assets", async () => {
    const linux = Object.values(MANAGED_SHELL_TOOLS_TARGETS).flatMap((target) => [
      SHELL_TOOLS_TARGETS[target].rg,
      SHELL_TOOLS_TARGETS[target].jq,
    ]);
    const expected = linux
      .flatMap((asset) => ("url" in asset ? [`${asset.sha256} ${asset.url}`] : []))
      .sort();
    const vendored = [
      ...new Set(
        linux.flatMap((asset) => ("path" in asset ? [`${dirname(asset.path)}/`] : [])),
      ),
    ];
    expect(vendored).toEqual(["agent/vendor/jq/"]);
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
      // The committed executables reach the fetch: a minimal fetch stage
      // copies them beside the script, the worker build has the whole tree.
      for (const directory of vendored) {
        expect(
          source.includes(`COPY ${directory} ${directory}`) ||
            source.includes("COPY --chown=bun:bun . ."),
        ).toBe(true);
      }
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
    const tarGz: ShellToolDownload = {
      url: "https://example.invalid/x.tar.gz",
      sha256: bundle.sha256,
      member: "rg",
      binarySha256: sha256(rg),
    };
    expect(extractShellTool(tarGz, bundle.bytes)).toEqual(rg);

    const zip = storedZip("ripgrep/rg.exe", rg);
    const zipAsset: ShellToolDownload = {
      url: "https://example.invalid/x.zip",
      sha256: sha256(zip),
      member: "ripgrep/rg.exe",
      binarySha256: sha256(rg),
    };
    expect(extractShellTool(zipAsset, zip)).toEqual(rg);
    expect(zipMember(zip, "other")).toBeNull();

    const bare: ShellToolDownload = {
      url: "https://example.invalid/jq",
      sha256: sha256(jq),
      binarySha256: sha256(jq),
    };
    expect(extractShellTool(bare, jq)).toEqual(jq);
  });

  test("rejects a changed download and a changed executable", () => {
    const bare: ShellToolDownload = {
      url: "https://example.invalid/jq",
      sha256: sha256(jq),
      binarySha256: sha256(jq),
    };
    expect(() => extractShellTool(bare, rg)).toThrow("does not match its pinned SHA-256");
    const bundle = buildManagedShellToolsBundle({ rg, jq, notices: new Uint8Array() });
    const wrongMember: ShellToolDownload = {
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

  test("rejects a changed committed executable", async () => {
    const repository = join(scratch, "repository");
    await mkdir(join(repository, "vendor"), { recursive: true });
    await writeFile(join(repository, "vendor/jq"), jq);
    const asset = { path: "vendor/jq", binarySha256: sha256(jq) };
    expect(await vendoredShellTool(asset, repository)).toEqual(jq);
    await writeFile(join(repository, "vendor/jq"), rg);
    await expect(vendoredShellTool(asset, repository)).rejects.toThrow(
      "vendor/jq does not match its pinned SHA-256",
    );
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
    if (!("sha256" in asset)) throw new Error("rg is an official download");
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
