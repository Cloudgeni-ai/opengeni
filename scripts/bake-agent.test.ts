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
const targets = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];
const components = [
  "opengeni-agent",
  "opengeni-browserd",
  "opengeni-agent-browser",
  "opengeni-computer-native",
];
const files = targets.flatMap((target) =>
  components.flatMap((component) =>
    ["", ".sha256", ".minisig"].map((suffix) => component + "-" + target + suffix),
  ),
);

type BuildCall = {
  tool: string;
  args: string[];
  buildId?: string;
  embedded: Record<string, string | undefined>;
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-bake-fixture-"));
  for (const path of ["scripts", "agent", "tools", "packages/browserd/dist"]) {
    await mkdir(join(directory, path), { recursive: true });
  }
  await copyFile(join(root, "scripts/bake-agent.sh"), join(directory, "scripts/bake-agent.sh"));
  const program = String.raw`
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const embedded = Object.fromEntries(["OPENGENI_EMBEDDED_BROWSERD", "OPENGENI_EMBEDDED_AGENT_BROWSER", "OPENGENI_EMBEDDED_COMPUTER_NATIVE"].map(name => [name, process.env[name]]));
await appendFile(process.env.BAKE_FIXTURE_LOG, JSON.stringify({tool, args, buildId:process.env.OPENGENI_RUNTIME_BUILD_ID, embedded}) + "\n");
async function output(path, bytes) {
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, bytes);
}
if (tool === "git") {
  console.log(process.env.BAKE_FIXTURE_SOURCE_ID);
} else if (tool === "cargo") {
  if (args[0] !== "zigbuild") throw Error("unexpected Cargo command");
  const target = args[args.indexOf("--target") + 1];
  const name = args[args.indexOf("-p") + 1];
  const bundle = {};
  for (const [key, path] of Object.entries(embedded)) if (path) bundle[key] = await readFile(path, "utf8");
  await output(join(process.cwd(), "target", target, "release", name), JSON.stringify({name, buildId:process.env.OPENGENI_RUNTIME_BUILD_ID, bundle}));
} else if (tool === "bun") {
  if (args[0] === "build") {
    if (process.env.BAKE_FIXTURE_SKIP !== "browserd") await output(args[args.indexOf("--outfile") + 1], "browserd " + process.env.OPENGENI_RUNTIME_BUILD_ID);
  } else if (args[0] === "packages/browserd/scripts/stage-agent-browser.ts") {
    await output(join(process.cwd(), "packages/browserd/dist", process.env.OPENGENI_BROWSERD_AGENT_BROWSER_OUTPUT), "pinned-driver");
  } else throw Error("unexpected Bun command");
} else if (tool === "rsign") {
  await output(args[args.indexOf("-x") + 1], "untrusted comment: synthetic fixture\nSIG\n");
} else if (tool === "readelf" && args[0] === "-l") {
  console.log("      [Requesting program interpreter: " + (process.env.BAKE_FIXTURE_INTERPRETER ?? (args[1].includes("aarch64") ? "/lib/ld-linux-aarch64.so.1" : "/lib64/ld-linux-x86-64.so.2")) + "]");
} else if (!["cargo-zigbuild", "rustup", "zig", "readelf"].includes(tool)) throw Error("unexpected tool");
`;
  for (const tool of [
    "bun",
    "cargo",
    "cargo-zigbuild",
    "rustup",
    "zig",
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
  await writeFile(log, "");
  return {
    directory,
    async run(overrides: Record<string, string | undefined> = {}) {
      const child = Bun.spawn(["bash", join(directory, "scripts/bake-agent.sh")], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: join(directory, "tools") + ":" + process.env.PATH,
          OGE_BAKE_TARGETS: targets.join(" "),
          OPENGENI_AGENT_MINISIGN_KEY: "synthetic-signing-key",
          OPENGENI_RUNTIME_BUILD_ID: sourceId,
          BAKE_FIXTURE_SOURCE_ID: sourceId,
          BAKE_FIXTURE_LOG: log,
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const calls = (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as BuildCall);
      return { exit, stdout, stderr, calls };
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("exact-source canary interaction bundle", () => {
  test("builds and signs the complete embedded runtime with one explicit source identity", async () => {
    const value = await fixture();
    try {
      const result = await value.run();
      expect(result.exit).toBe(0);
      const baked = join(value.directory, "agent/install/baked");
      expect((await readdir(baked)).filter((name) => name.startsWith("opengeni-")).sort()).toEqual(
        [...files].sort(),
      );
      for (const target of targets) {
        const agent = JSON.parse(await readFile(join(baked, "opengeni-agent-" + target), "utf8"));
        expect(agent.buildId).toBe(sourceId);
        expect(agent.bundle.OPENGENI_EMBEDDED_BROWSERD).toBe("browserd " + sourceId);
        expect(agent.bundle.OPENGENI_EMBEDDED_AGENT_BROWSER).toBe("pinned-driver");
        expect(JSON.parse(agent.bundle.OPENGENI_EMBEDDED_COMPUTER_NATIVE).buildId).toBe(sourceId);
        for (const component of components) {
          const asset = component + "-" + target;
          const bytes = await readFile(join(baked, asset));
          expect(await readFile(join(baked, asset + ".sha256"), "utf8")).toStartWith(
            new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          );
          expect(await readFile(join(baked, asset + ".minisig"), "utf8")).toContain(
            "synthetic fixture",
          );
        }
      }
      const compiles = result.calls.filter(
        (call) => call.tool === "cargo" || (call.tool === "bun" && call.args[0] === "build"),
      );
      expect(compiles).toHaveLength(6);
      expect(compiles.every((call) => call.buildId === sourceId)).toBe(true);
      for (const compile of compiles.filter((call) => call.tool === "bun")) {
        expect(compile.args).toContain('process.env.OPENGENI_RUNTIME_BUILD_ID="' + sourceId + '"');
        expect(compile.args.some((argument) => argument.startsWith("--target=bun-linux-"))).toBe(
          true,
        );
        const outfile = compile.args[compile.args.indexOf("--outfile") + 1]!;
        expect(compile.args).toContain(
          outfile.endsWith("aarch64-unknown-linux-musl")
            ? "--target=bun-linux-arm64"
            : "--target=bun-linux-x64",
        );
      }
    } finally {
      await value.close();
    }
  });

  test.each([undefined, "development", "2222222222222222222222222222222222222222"])(
    "refuses missing or non-source build identity %s before building",
    async (buildId) => {
      const value = await fixture();
      try {
        const result = await value.run({ OPENGENI_RUNTIME_BUILD_ID: buildId });
        expect(result.exit).not.toBe(0);
        expect(result.calls.some((call) => call.tool === "cargo" || call.tool === "bun")).toBe(
          false,
        );
      } finally {
        await value.close();
      }
    },
  );

  test("a missing helper cannot publish a thin or partial agent cohort", async () => {
    const value = await fixture();
    try {
      const result = await value.run({ BAKE_FIXTURE_SKIP: "browserd" });
      expect(result.exit).not.toBe(0);
      const baked = join(value.directory, "agent/install/baked");
      expect((await readdir(baked)).filter((name) => name.startsWith("opengeni-"))).toEqual([]);
    } finally {
      await value.close();
    }
  });

  test("a helper from the wrong architecture cannot publish a cohort", async () => {
    const value = await fixture();
    try {
      const result = await value.run({ BAKE_FIXTURE_INTERPRETER: "/lib64/ld-linux-x86-64.so.2" });
      expect(result.exit).not.toBe(0);
      expect(
        (await readdir(join(value.directory, "agent/install/baked"))).filter((name) =>
          name.startsWith("opengeni-"),
        ),
      ).toEqual([]);
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
