import { describe, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const sourceId = "1111111111111111111111111111111111111111";
const signingKey = "synthetic-signing-key";
const targets = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];
const components = ["opengeni-agent", "opengeni-browserd", "opengeni-computer-native"];
const assets = targets.flatMap((target) => components.map((component) => component + "-" + target));
const files = assets.flatMap((asset) =>
  ["", ".sha256", ".minisig"].map((suffix) => asset + suffix),
);
const installer = await readFile(join(root, "scripts/install-agent-build-tools.sh"), "utf8");
const pin = (name: string) => new RegExp(`^${name}=(\\S+)$`, "m").exec(installer)![1]!;
const pins = {
  zigbuild: pin("CARGO_ZIGBUILD_VERSION"),
  rsign: pin("RSIGN2_VERSION"),
  zig: pin("ZIGLANG_VERSION"),
};

type ToolCall = {
  tool: string;
  args: string[];
  buildId?: string;
  embedded: Record<string, string | undefined>;
  /** The signing key was in the tool's environment. */
  keyInEnv: boolean;
  /** A file under the bake's temporary directory held the signing key. */
  keyOnDisk: boolean;
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-bake-fixture-"));
  for (const path of ["scripts", "agent", "tools", "tmp", "packages/browserd/dist"]) {
    await mkdir(join(directory, path), { recursive: true });
  }
  for (const script of ["bake-agent.sh", "install-agent-build-tools.sh"]) {
    await copyFile(join(root, "scripts", script), join(directory, "scripts", script));
  }
  const program = String.raw`
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const embedded = Object.fromEntries(["OPENGENI_EMBEDDED_BROWSERD", "OPENGENI_EMBEDDED_COMPUTER_NATIVE"].map(name => [name, process.env[name]]));
async function holdsKey(path) {
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory() ? await holdsKey(child) : (await readFile(child, "utf8").catch(() => "")).includes(process.env.BAKE_FIXTURE_KEY)) return true;
  }
  return false;
}
await appendFile(process.env.BAKE_FIXTURE_LOG, JSON.stringify({tool, args, buildId:process.env.OPENGENI_RUNTIME_BUILD_ID, embedded, keyInEnv: Object.entries(process.env).some(([name, value]) => name !== "BAKE_FIXTURE_KEY" && value?.includes(process.env.BAKE_FIXTURE_KEY)), keyOnDisk: await holdsKey(process.env.TMPDIR)}) + "\n");
async function output(path, bytes) {
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, bytes);
}
const installed = join(process.env.BAKE_FIXTURE_STATE, "crates");
const zig = join(process.env.BAKE_FIXTURE_STATE, "zig");
if (tool === "git") {
  console.log(process.env.BAKE_FIXTURE_SOURCE_ID);
} else if (tool === "cargo" && args[0] === "install") {
  if (args[1] === "--list") {
    process.stdout.write(await readFile(installed, "utf8").catch(() => ""));
  } else {
    if (args[1] !== "--locked" || args[2] !== "--version" || args.length !== 5) throw Error("unpinned cargo install");
    await appendFile(installed, args[4] + " v" + args[3] + ":\n    " + (args[4] === "rsign2" ? "rsign" : args[4]) + "\n");
  }
} else if (tool === "cargo") {
  if (args[0] !== "zigbuild") throw Error("unexpected Cargo command");
  // cargo-zigbuild accepts a glibc version suffix (x86_64-unknown-linux-gnu.2.28)
  // but writes to the plain target directory.
  const target = args[args.indexOf("--target") + 1].replace(/\.\d+\.\d+$/, "");
  const name = args[args.indexOf("-p") + 1];
  const bundle = {};
  for (const [key, path] of Object.entries(embedded)) if (path) bundle[key] = await readFile(path, "utf8");
  await output(join(process.cwd(), "target", target, "release", name), JSON.stringify({name, buildId:process.env.OPENGENI_RUNTIME_BUILD_ID, bundle}));
} else if (tool === "python3") {
  if (args.join(" ") === "-m ziglang version") {
    const version = await readFile(zig, "utf8").catch(() => "");
    if (!version) process.exit(1);
    console.log(version);
  } else if (args[0] === "-m" && args[1] === "pip" && args[2] === "install") {
    if (!args.includes("--require-hashes") || !args.includes("--only-binary=:all:")) throw Error("unverified pip install");
    const requirements = await readFile(args[args.indexOf("-r") + 1], "utf8");
    const version = /^ziglang==(\S+)/.exec(requirements)[1];
    if (!/--hash=sha256:[0-9a-f]{64}/.test(requirements)) throw Error("no wheel hash");
    await writeFile(zig, version);
  } else throw Error("unexpected Python command");
} else if (tool === "bun") {
  if (args[0] === "build") {
    if (process.env.BAKE_FIXTURE_SKIP !== "browserd") await output(args[args.indexOf("--outfile") + 1], "browserd " + process.env.OPENGENI_RUNTIME_BUILD_ID);
  } else if (args[0] === "docker/distrust-embedded-roots.ts") {
    // The fixture binaries carry no root list; the call itself is asserted.
  } else throw Error("unexpected Bun command");
} else if (tool === "rsign") {
  await output(args[args.indexOf("-x") + 1], "untrusted comment: synthetic fixture\nSIG\n");
} else if (tool === "readelf" && args[0] === "-l") {
  console.log("      [Requesting program interpreter: " + (process.env.BAKE_FIXTURE_INTERPRETER ?? (args[1].includes("aarch64") ? "/lib/ld-linux-aarch64.so.1" : "/lib64/ld-linux-x86-64.so.2")) + "]");
} else if (!["cargo-zigbuild", "rustup", "readelf"].includes(tool)) throw Error("unexpected tool");
`;
  for (const tool of [
    "bun",
    "cargo",
    "cargo-zigbuild",
    "python3",
    "rustup",
    "rsign",
    "readelf",
    "git",
  ]) {
    const path = join(directory, "tools", tool);
    await writeFile(
      path,
      "#!" + process.execPath + "\nconst tool = " + JSON.stringify(tool) + ";\n" + program,
    );
    await chmod(path, 0o755);
  }
  const log = join(directory, "calls.jsonl");
  const baked = join(directory, "agent/install/baked");
  return {
    directory,
    baked,
    async run(command: string[], overrides: Record<string, string | undefined> = {}) {
      await writeFile(log, "");
      const child = Bun.spawn(
        ["bash", ...command.map((part, index) => (index === 0 ? join(directory, part) : part))],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: join(directory, "tools") + ":" + process.env.PATH,
            TMPDIR: join(directory, "tmp"),
            OGE_BAKE_TARGETS: targets.join(" "),
            OPENGENI_RUNTIME_BUILD_ID: sourceId,
            BAKE_FIXTURE_SOURCE_ID: sourceId,
            BAKE_FIXTURE_LOG: log,
            BAKE_FIXTURE_STATE: directory,
            BAKE_FIXTURE_KEY: signingKey,
            ...overrides,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const calls = (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ToolCall);
      return { exit, stdout, stderr, calls };
    },
    /** The release steps in order: install the pinned tools, build, sign. */
    async release(overrides: Record<string, string | undefined> = {}) {
      const install = await this.run(["scripts/install-agent-build-tools.sh", "zigbuild", "rsign"]);
      const build = await this.run(["scripts/bake-agent.sh", "build"]);
      const sign = await this.run(["scripts/bake-agent.sh", "sign"], {
        OPENGENI_AGENT_MINISIGN_KEY: signingKey,
        ...overrides,
      });
      return { install, build, sign };
    },
    async bakedAssets() {
      return (await readdir(baked).catch(() => [] as string[]))
        .filter((name) => name.startsWith("opengeni-"))
        .sort();
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("exact-source canary interaction bundle", () => {
  test("builds the complete embedded runtime with one explicit source identity, then signs it", async () => {
    const value = await fixture();
    try {
      const { install, build, sign } = await value.release();
      expect(install.exit).toBe(0);
      expect(build.exit).toBe(0);
      expect(sign.exit).toBe(0);
      expect(await value.bakedAssets()).toEqual([...files].sort());
      for (const target of targets) {
        const agent = JSON.parse(
          await readFile(join(value.baked, "opengeni-agent-" + target), "utf8"),
        );
        expect(agent.buildId).toBe(sourceId);
        expect(agent.bundle.OPENGENI_EMBEDDED_BROWSERD).toBe("browserd " + sourceId);
        expect(JSON.parse(agent.bundle.OPENGENI_EMBEDDED_COMPUTER_NATIVE).buildId).toBe(sourceId);
      }
      for (const asset of assets) {
        const bytes = await readFile(join(value.baked, asset));
        expect(await readFile(join(value.baked, asset + ".sha256"), "utf8")).toStartWith(
          new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        );
        expect(await readFile(join(value.baked, asset + ".minisig"), "utf8")).toContain(
          "synthetic fixture",
        );
      }
      const compiles = build.calls.filter(
        (call) =>
          (call.tool === "cargo" && call.args[0] === "zigbuild") ||
          (call.tool === "bun" && call.args[0] === "build"),
      );
      expect(compiles).toHaveLength(6);
      expect(compiles.every((call) => call.buildId === sourceId)).toBe(true);
      for (const compile of compiles.filter((call) => call.tool === "bun")) {
        expect(compile.args).toContain('process.env.OPENGENI_RUNTIME_BUILD_ID="' + sourceId + '"');
        const outfile = compile.args[compile.args.indexOf("--outfile") + 1]!;
        expect(compile.args).toContain(
          outfile.endsWith("aarch64-unknown-linux-musl")
            ? "--target=bun-linux-arm64"
            : "--target=bun-linux-x64",
        );
        const distrust = build.calls
          .filter(
            (call) => call.tool === "bun" && call.args[0] === "docker/distrust-embedded-roots.ts",
          )
          .filter((call) => call.args.at(-1) === outfile)
          .map((call) => call.args.slice(1, -1));
        expect(distrust).toEqual([
          ["docker/distrusted-roots.pem"],
          ["--check", "docker/distrusted-roots.pem"],
        ]);
      }
    } finally {
      await value.close();
    }
  });

  test("no install or build tool ever sees the signing key; signing runs only the pinned signer", async () => {
    const value = await fixture();
    try {
      const { install, build, sign } = await value.release();
      expect(sign.exit).toBe(0);
      for (const call of [...install.calls, ...build.calls]) {
        expect(call.keyInEnv || call.keyOnDisk).toBe(false);
      }
      // Signing installs and compiles nothing: it confirms the pinned signer
      // and runs it, with the key in a file and never in the environment.
      expect(sign.calls.map((call) => [call.tool, ...call.args.slice(0, 2)])).toEqual([
        ["cargo", "install", "--list"],
        ...assets.map(() => ["rsign", "sign", "-W"]),
      ]);
      expect(sign.calls.every((call) => !call.keyInEnv)).toBe(true);
      expect(
        sign.calls.filter((call) => call.tool === "rsign").every((call) => call.keyOnDisk),
      ).toBe(true);
      expect(sign.calls[0]!.keyOnDisk).toBe(false);
      // The key file is gone afterwards.
      expect(await readdir(join(value.directory, "tmp"))).toEqual([]);
    } finally {
      await value.close();
    }
  });

  test("the build refuses to run with the signing key present", async () => {
    const value = await fixture();
    try {
      await value.run(["scripts/install-agent-build-tools.sh", "zigbuild", "rsign"]);
      for (const command of [["scripts/bake-agent.sh"], ["scripts/bake-agent.sh", "build"]]) {
        const result = await value.run(command, { OPENGENI_AGENT_MINISIGN_KEY: signingKey });
        expect(result.exit).not.toBe(0);
        expect(result.calls).toEqual([]);
      }
      expect(await value.bakedAssets()).toEqual([]);
    } finally {
      await value.close();
    }
  });

  test("tools install only at their exact pinned versions, verified, and once", async () => {
    const value = await fixture();
    try {
      // A different version already present is replaced by the pinned one.
      await writeFile(
        join(value.directory, "crates"),
        "cargo-zigbuild v0.0.1:\n    cargo-zigbuild\n",
      );
      const first = await value.run(["scripts/install-agent-build-tools.sh", "zigbuild", "rsign"]);
      expect(first.exit).toBe(0);
      const installs = first.calls.filter(
        (call) =>
          (call.tool === "cargo" && call.args[1] !== "--list") ||
          (call.tool === "python3" && call.args[1] === "pip"),
      );
      expect(installs.map((call) => [call.tool, ...call.args.slice(0, 5)])).toEqual([
        ["cargo", "install", "--locked", "--version", pins.zigbuild, "cargo-zigbuild"],
        ["python3", "-m", "pip", "install", "--disable-pip-version-check", "--no-deps"],
        ["cargo", "install", "--locked", "--version", pins.rsign, "rsign2"],
      ]);
      expect(await readFile(join(value.directory, "zig"), "utf8")).toBe(pins.zig);
      const again = await value.run(["scripts/install-agent-build-tools.sh", "zigbuild", "rsign"]);
      expect(again.exit).toBe(0);
      expect(
        again.calls.filter((call) => call.args.includes("--locked") || call.args[1] === "pip"),
      ).toEqual([]);
    } finally {
      await value.close();
    }
  });

  test("signing never installs a missing signer", async () => {
    const value = await fixture();
    try {
      await value.run(["scripts/install-agent-build-tools.sh", "zigbuild"]);
      expect((await value.run(["scripts/bake-agent.sh", "build"])).exit).toBe(0);
      const sign = await value.run(["scripts/bake-agent.sh", "sign"], {
        OPENGENI_AGENT_MINISIGN_KEY: signingKey,
      });
      expect(sign.exit).not.toBe(0);
      expect(sign.calls.map((call) => [call.tool, ...call.args.slice(0, 2)])).toEqual([
        ["cargo", "install", "--list"],
      ]);
      expect(sign.calls.every((call) => !call.keyInEnv && !call.keyOnDisk)).toBe(true);
      expect((await value.bakedAssets()).some((name) => name.endsWith(".minisig"))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("signing refuses a cohort that is incomplete or no longer matches its checksums", async () => {
    const value = await fixture();
    try {
      await value.run(["scripts/install-agent-build-tools.sh", "zigbuild", "rsign"]);
      expect((await value.run(["scripts/bake-agent.sh", "build"])).exit).toBe(0);
      await writeFile(join(value.baked, assets[1]!), "replaced after the build");
      const altered = await value.run(["scripts/bake-agent.sh", "sign"], {
        OPENGENI_AGENT_MINISIGN_KEY: signingKey,
      });
      expect(altered.exit).not.toBe(0);
      await rm(join(value.baked, assets[1]!));
      const missing = await value.run(["scripts/bake-agent.sh", "sign"], {
        OPENGENI_AGENT_MINISIGN_KEY: signingKey,
      });
      expect(missing.exit).not.toBe(0);
      for (const result of [altered, missing]) {
        expect(result.calls.some((call) => call.tool === "rsign")).toBe(false);
      }
      expect((await value.bakedAssets()).some((name) => name.endsWith(".minisig"))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test("signing without the key fails loudly unless an unsigned bake is allowed", async () => {
    const value = await fixture();
    try {
      const refused = await value.release({ OPENGENI_AGENT_MINISIGN_KEY: undefined });
      expect(refused.sign.exit).not.toBe(0);
      const allowed = await value.run(["scripts/bake-agent.sh", "sign"], {
        OGE_BAKE_ALLOW_UNSIGNED: "1",
      });
      expect(allowed.exit).toBe(0);
      expect(await value.bakedAssets()).toEqual(
        files.filter((name) => !name.endsWith(".minisig")).sort(),
      );
    } finally {
      await value.close();
    }
  });

  test("a new build drops the signatures of the previous one", async () => {
    const value = await fixture();
    try {
      expect((await value.release()).sign.exit).toBe(0);
      expect((await value.run(["scripts/bake-agent.sh", "build"])).exit).toBe(0);
      expect((await value.bakedAssets()).some((name) => name.endsWith(".minisig"))).toBe(false);
    } finally {
      await value.close();
    }
  });

  test.each([undefined, "development", "2222222222222222222222222222222222222222"])(
    "refuses missing or non-source build identity %s before building",
    async (buildId) => {
      const value = await fixture();
      try {
        const result = await value.run(["scripts/bake-agent.sh", "build"], {
          OPENGENI_RUNTIME_BUILD_ID: buildId,
        });
        expect(result.exit).not.toBe(0);
        expect(result.calls.every((call) => call.tool === "git")).toBe(true);
      } finally {
        await value.close();
      }
    },
  );

  test("a missing helper cannot publish a thin or partial agent cohort", async () => {
    const value = await fixture();
    try {
      const result = await value.run(["scripts/bake-agent.sh", "build"], {
        BAKE_FIXTURE_SKIP: "browserd",
      });
      expect(result.exit).not.toBe(0);
      expect(await value.bakedAssets()).toEqual([]);
    } finally {
      await value.close();
    }
  });

  test("a helper from the wrong architecture cannot publish a cohort", async () => {
    const value = await fixture();
    try {
      const result = await value.run(["scripts/bake-agent.sh", "build"], {
        BAKE_FIXTURE_INTERPRETER: "/lib64/ld-linux-x86-64.so.2",
      });
      expect(result.exit).not.toBe(0);
      expect(await value.bakedAssets()).toEqual([]);
    } finally {
      await value.close();
    }
  });

  test("the image completeness gate rejects every missing cohort asset or sidecar", async () => {
    const workflow = parse(await readFile(join(root, ".github/workflows/ci.yml"), "utf8"));
    const step = workflow.jobs["api-image"].steps.find(
      (entry: { name?: string }) => entry.name === "Require complete exact-SHA canary agent bake",
    );
    const directory = await mkdtemp(join(tmpdir(), "agent-cohort-gate-"));
    const baked = join(directory, "agent/install/baked");
    try {
      await mkdir(baked, { recursive: true });
      for (const file of files) await writeFile(join(baked, file), "synthetic artifact");
      async function gate() {
        const child = Bun.spawn(["bash", "-c", step.run], {
          cwd: directory,
          stdout: "pipe",
          stderr: "pipe",
        });
        await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return child.exited;
      }
      expect(await gate()).toBe(0);
      for (const file of files) {
        await rm(join(baked, file));
        expect(await gate()).not.toBe(0);
        await writeFile(join(baked, file), "synthetic artifact");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
