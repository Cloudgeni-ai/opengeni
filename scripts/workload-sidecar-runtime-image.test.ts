import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stage(source: string, name: string): string {
  const match = new RegExp(`^FROM .+ AS ${name}$`, "m").exec(source);
  if (!match) throw new Error(`missing Docker stage ${name}`);
  const rest = source.slice(match.index + match[0].length);
  const next = rest.search(/^FROM /m);
  return match[0] + (next < 0 ? rest : rest.slice(0, next));
}

test("sidecar images ship only self-contained bundles and their runtime assets", async () => {
  const dockerfile = await readFile(join(root, "docker/opengeni.Dockerfile"), "utf8");
  for (const name of ["artifact-outbox-dispatcher", "artifact-materializer"]) {
    const runtime = stage(dockerfile, name);
    expect(runtime).toStartWith(`FROM oven/bun:\${BUN_VERSION}-slim AS ${name}`);
    expect(runtime).toContain("USER bun");
    expect(runtime).toContain("NODE_ENV=production");
    expect(runtime).toContain("OPENGENI_SERVER_VERSION=$OPENGENI_SERVER_VERSION");
    expect(runtime).not.toContain("node_modules");
    expect(runtime).not.toContain("bun install");
    expect(runtime).not.toContain("COPY .");
    expect(runtime).not.toContain("/app/packages/");
    expect(runtime).not.toContain("build-runtime-processes.ts");
  }
  const outbox = stage(dockerfile, "artifact-outbox-dispatcher");
  expect(outbox).not.toContain("apt-get");
  expect(outbox).toContain("COPY --from=artifact-outbox-build");
  expect(outbox).not.toContain("artifact-runtime/");

  const materializer = stage(dockerfile, "artifact-materializer");
  expect(materializer).not.toContain("git openssh-client");
  expect(materializer).toContain(
    "COPY --from=artifact-materializer-build --chown=root:root /app/artifact-runtime/",
  );
  expect(materializer).toContain(
    "COPY --from=artifact-materializer-build --chown=root:root /opt/opengeni/bin/opengeni-artifact-materializer",
  );
  expect(materializer).toContain(
    "RUN /opt/opengeni/bin/opengeni-artifact-materializer --opengeni-materializer-identity-v1",
  );
  expect(materializer).toContain(
    "OPENGENI_ARTIFACT_RUNTIME_MANIFEST=/app/artifact-runtime/installation.json",
  );
  expect(materializer).toContain("OPENGENI_ARTIFACT_MATERIALIZER_BWRAP=/usr/bin/bwrap");
  expect(materializer).toContain("OPENGENI_ARTIFACT_MATERIALIZER_PRLIMIT=/usr/bin/prlimit");
  expect(stage(dockerfile, "artifact-runtime-base")).toContain(
    "runtime-cli-entry.ts doctor --json",
  );
});

for (const [target, exportedFunction] of [
  ["artifact-outbox", "runEditableArtifactOutboxSidecar"],
  ["artifact-materializer", "runEditableArtifactMaterializerSidecar"],
] as const) {
  test(`${target} bundle loads without the source tree or node_modules`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "opengeni-sidecar-runtime-"));
    try {
      const output = join(fixture, "entry.js");
      // Build in a fresh process, just like the production builder. Bun's test
      // resolver must not participate in the bundle's dependency resolution.
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          join(root, `apps/worker/src/${target}-entry.ts`),
          "--target=bun",
          "--minify-syntax",
          "--minify-whitespace",
          `--outfile=${output}`,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const buildError = await new Response(build.stderr).text();
      if ((await build.exited) !== 0) throw new Error(buildError);
      const bundle = pathToFileURL(output).href;
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `const module = await import(${JSON.stringify(bundle)}); if (typeof module[${JSON.stringify(exportedFunction)}] !== "function") process.exit(1);`,
        ],
        { cwd: fixture, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(child.stderr).text();
      expect(stderr).toBe("");
      expect(await child.exited).toBe(0);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 30_000);
}
