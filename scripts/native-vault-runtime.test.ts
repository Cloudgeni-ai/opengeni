import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGE_ASSET_RUNTIME_EXTERNALS } from "./build-runtime-processes";
import { copyRuntimeDependencies } from "./copy-runtime-dependencies";

const root = resolve(import.meta.dir, "..");
const KEEPER_SDK = "@keeper-security/secrets-manager-core";

// The adapter reads and hash-checks the installed SDK build at run time. Bundle
// the API's native factories with the same externals build-runtime-processes
// uses, place the bundle in a frozen runtime closure with no monorepo
// ancestors, and run a Keeper setup there up to its first network request.
test("the bundled native factories load the pinned Keeper SDK from the runtime closure", async () => {
  const work = await mkdtemp(join(tmpdir(), "opengeni-keeper-runtime-"));
  try {
    // Bun.build mutates process-global resolver state; build in a child
    // process (as runtime-process-native-closure.test.ts does).
    const outdir = join(work, "apps/api/dist/process");
    const build = Bun.spawn({
      cmd: [
        process.execPath,
        "build",
        join(root, "apps/api/src/integrations/external-vault-providers.ts"),
        `--outdir=${outdir}`,
        "--target=bun",
        "--format=esm",
        "--splitting",
        ...PACKAGE_ASSET_RUNTIME_EXTERNALS.map((name) => `--external=${name}`),
      ],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildStatus, buildOut, buildErr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(buildStatus, `${buildOut}\n${buildErr}`).toBe(0);
    const outputs = await Promise.all(
      (await readdir(outdir))
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(join(outdir, name), "utf8")),
    );
    expect(outputs.length).toBeGreaterThan(0);
    // Only types come from the SDK at build time; its code must not be inlined.
    for (const text of outputs) expect(text).not.toContain("fetchAndDecryptSecrets");

    await mkdir(join(work, "apps/api"), { recursive: true });
    await copyRuntimeDependencies(root, work, "apps/api", [KEEPER_SDK]);
    // A syntactically valid one-time token; the SDK generates the client key
    // pair, signs the bind request and hands it to the transport, which stops
    // there. Reaching it proves the installed SDK loaded and ran.
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const m = await import("./apps/api/dist/process/external-vault-providers.js");
         let reached = false;
         const factories = m.createNativeExternalVaultFactories({ environment: "production" }, {
           keeper: { queryFunction: async (url, key, payload) => {
             reached = url.startsWith("https://keepersecurity.com/api/rest/sm/v1/") && payload.signature.length > 0;
             throw new Error("probe stops before the network");
           } },
         });
         if (typeof factories.keeper !== "function" || factories.protonpass) throw new Error("factories");
         const error = await factories.keeper({
           credentials: { provider: "keeper", oneTimeToken: "US:" + "A".repeat(43) },
           persistCredentials: async () => {},
         }).then(() => null, (caught) => caught);
         process.stdout.write(JSON.stringify({ reached, code: error?.code }));`,
      ],
      { cwd: work, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ status, stdout, stderr: stderr.slice(0, 2_000) }).toEqual({
      status: 0,
      // A request that may have reached Keeper redeems nothing it can prove.
      stdout: JSON.stringify({ reached: true, code: "provider_outcome_unknown" }),
      stderr: "",
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 120_000);
