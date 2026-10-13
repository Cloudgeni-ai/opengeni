import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("a backend contract leaf does not construct unrelated request validators", async () => {
  const contracts = fileURLToPath(new URL("../packages/contracts/src/index.ts", import.meta.url));
  const result = await Bun.build({
    entrypoints: ["contract-leaf-probe"],
    target: "bun",
    format: "esm",
    minify: { syntax: true, whitespace: true, identifiers: false },
    plugins: [
      {
        name: "contract-leaf-probe",
        setup(build) {
          build.onResolve({ filter: /^contract-leaf-probe$/ }, () => ({
            path: "contract-leaf-probe",
            namespace: "contract-leaf-probe",
          }));
          build.onLoad({ filter: /.*/, namespace: "contract-leaf-probe" }, () => ({
            loader: "ts",
            contents: `import { SandboxBackend } from ${JSON.stringify(contracts)}; console.log(JSON.stringify(SandboxBackend.options));`,
          }));
        },
      },
    ],
  });
  expect(result.success).toBe(true);
  const output = await result.outputs[0]!.text();
  // Names are deliberately preserved in deployed bundles. A pure annotation
  // on only the outer Zod call still retains nested builders and their graph.
  expect(output).not.toContain("HumanInputQuestion");
  expect(output).toContain("SandboxBackend");
  const probe = Bun.spawn([process.execPath, "run", "-"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  probe.stdin.write(output);
  probe.stdin.end();
  const text = await new Response(probe.stdout).text();
  const stderr = await new Response(probe.stderr).text();
  expect(await probe.exited, stderr).toBe(0);
  const { SandboxBackend } = await import("../packages/contracts/src/index");
  expect(JSON.parse(text)).toEqual(SandboxBackend.options);
});
