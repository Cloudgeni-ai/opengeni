import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { parse } = require("hermes-parser") as {
  parse(source: string, options: { sourceType: "script" }): unknown;
};

const repoRoot = resolve(import.meta.dir, "..");
const entry = join(repoRoot, "scripts/fixtures/react-native-session/entry.ts");
const transformerPath = join(
  repoRoot,
  "scripts/fixtures/react-native-session/metro-transformer.cjs",
);

type BundleMode = "corrected" | "planted-old-import";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function emitBundle(mode: BundleMode, out: string): Promise<void> {
  const { getDefaultConfig, mergeConfig } = require("metro-config") as {
    getDefaultConfig(rootPath: string): Promise<Record<string, unknown>>;
    mergeConfig(...configs: Record<string, unknown>[]): Record<string, unknown>;
  };
  const { runBuild } = require("metro") as {
    runBuild(config: Record<string, unknown>, options: Record<string, unknown>): Promise<void>;
  };

  const defaults = await getDefaultConfig(repoRoot);
  const config = mergeConfig(defaults, {
    projectRoot: repoRoot,
    watchFolders: [repoRoot],
    maxWorkers: 2,
    resetCache: true,
    cacheStores: [],
    resolver: {
      useWatchman: false,
    },
    transformer: {
      babelTransformerPath: transformerPath,
      enableBabelRCLookup: false,
      enableBabelRuntime: false,
      hermesParser: true,
    },
  });

  if (mode === "planted-old-import") {
    process.env.OPENGENI_PLANT_HERMES_TLA = "1";
  } else {
    delete process.env.OPENGENI_PLANT_HERMES_TLA;
  }

  await runBuild(config, {
    entry,
    out,
    platform: "ios",
    dev: false,
    minify: false,
    sourceMap: false,
  });
}

async function runBundleSubprocess(mode: BundleMode, out: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.filename, "--emit", mode, out],
    cwd: repoRoot,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  invariant(exitCode === 0, `Metro ${mode} bundle failed with exit code ${exitCode}`);
}

function parseError(source: string): unknown {
  try {
    parse(source, { sourceType: "script" });
    return null;
  } catch (error) {
    return error;
  }
}

async function verifyBundles(): Promise<void> {
  const workdir = await mkdtemp(join(repoRoot, ".opengeni-session-hermes-"));
  try {
    const correctedPath = join(workdir, "session.corrected.js");
    const plantedPath = join(workdir, "session.planted-old-import.js");

    await runBundleSubprocess("corrected", correctedPath);
    const corrected = await readFile(correctedPath, "utf8");
    invariant(corrected.includes("buildTimeline"), "Metro bundle omitted the public session entry");
    invariant(
      !corrected.includes("await _$$_REQUIRE"),
      "Corrected public session bundle still contains Metro top-level await",
    );
    invariant(
      parseError(corrected) === null,
      "Hermes rejected the corrected public session bundle",
    );

    await runBundleSubprocess("planted-old-import", plantedPath);
    const planted = await readFile(plantedPath, "utf8");
    invariant(
      planted.includes("await _$$_REQUIRE"),
      "Planted historical import did not produce Metro top-level await",
    );

    const error = parseError(planted);
    invariant(
      error instanceof SyntaxError,
      "Hermes did not reject the planted bundle with SyntaxError",
    );
    invariant(
      error.message.includes("';' expected"),
      `Hermes rejected the planted bundle for the wrong reason: ${error.message}`,
    );

    const location = (error as SyntaxError & { loc?: { line?: number; column?: number } }).loc;
    invariant(location?.line !== undefined, "Hermes syntax error omitted its source location");
    const rejectedLine = planted.split("\n")[location.line - 1];
    invariant(
      rejectedLine?.includes("await _$$_REQUIRE"),
      `Hermes syntax error did not point at Metro's top-level await (line ${location.line})`,
    );

    console.log(
      `Hermes accepted the ${corrected.length}-byte public session bundle and rejected the planted historical import at ${location.line}:${(location.column ?? 0) + 1}.`,
    );
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--emit") {
  const mode = process.argv[3] as BundleMode | undefined;
  const out = process.argv[4];
  invariant(mode === "corrected" || mode === "planted-old-import", "Invalid bundle mode");
  invariant(out, "Bundle output path is required");
  await emitBundle(mode, out);
} else {
  await verifyBundles();
}
