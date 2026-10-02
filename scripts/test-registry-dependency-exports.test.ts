import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import {
  candidateManifest,
  consumerManifest,
  lowestPublishedVersion,
  proveInstalledConsumer,
  type SmokeManifest,
} from "./test-registry-dependency-exports";

const react: SmokeManifest = {
  name: "@opengeni/react",
  version: "7.4.0",
  type: "module",
  exports: { ".": "./index.js" },
  dependencies: { "@opengeni/connect": "^0.3.0" },
};

async function fixture<T>(hasExport: boolean, check: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-registry-export-regression-"));
  try {
    const consumer = consumerManifest(react, "7.4.0");
    await writeFile(join(root, "package.json"), JSON.stringify(consumer));
    for (const [manifest, source] of [
      [
        react,
        'import { ConnectPopupClosedError } from "@opengeni/connect";\nexport function isClosed(error) { return error instanceof ConnectPopupClosedError; }',
      ],
      [
        {
          name: "@opengeni/connect",
          version: "0.3.0",
          type: "module",
          exports: { ".": "./index.js" },
        },
        hasExport
          ? "export class ConnectPopupClosedError extends Error {}"
          : "export class ConnectPopupTimeoutError extends Error {}",
      ],
    ] as const) {
      const dir = join(root, "node_modules", manifest.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
      await writeFile(join(dir, "index.js"), source);
    }
    return await check(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("registry dependency export smoke", () => {
  test("browser linking rejects a missing ConnectPopupClosedError even when unused", async () => {
    await fixture(false, async (root) => {
      await expect(
        proveInstalledConsumer(root, react, { browser: ["."], node: [] }),
      ).rejects.toThrow("ConnectPopupClosedError");
    });
  });

  test("real Node ESM linking rejects the same missing export", async () => {
    await fixture(false, async (root) => {
      await expect(
        proveInstalledConsumer(root, react, { browser: [], node: ["."] }),
      ).rejects.toThrow("does not provide an export named 'ConnectPopupClosedError'");
    });
  });

  test("browser and Node succeed when the installed registry dependency provides the export", async () => {
    await fixture(true, (root) =>
      proveInstalledConsumer(root, react, { browser: ["."], node: ["."] }),
    );
  });

  test("consumer keeps declared dependency resolution, with no sibling candidates or overrides", () => {
    const consumer = consumerManifest(react, "file:/isolated/react.tgz");
    expect(consumer.dependencies).toEqual({ "@opengeni/react": "file:/isolated/react.tgz" });
    expect(consumer.overrides).toBeUndefined();
    expect(consumer.workspaces).toBeUndefined();
    expect(react.dependencies).toEqual({ "@opengeni/connect": "^0.3.0" });
  });

  test("candidate uses publication transforms without mutating source or substituting siblings", () => {
    const source = {
      ...react,
      main: "./src/index.ts",
      exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } },
      dependencies: { "@opengeni/connect": "workspace:*" },
      devDependencies: { "private-dev-fixture": "workspace:*" },
    };
    const candidate = candidateManifest(source, new Map([["@opengeni/connect", "0.3.0"]]));
    expect(candidate.dependencies).toEqual({ "@opengeni/connect": "^0.3.0" });
    expect(candidate.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    });
    expect(candidate.devDependencies).toBeUndefined();
    expect(source.dependencies).toEqual({ "@opengeni/connect": "workspace:*" });
    expect(source.exports["."].default).toBe("./src/index.ts");
  });

  test("minimum lane pins only published versions allowed by the declared range", () => {
    const version = lowestPublishedVersion("^0.3.0", ["0.4.0", "0.3.2", "0.3.1", "0.3.0"]);
    expect(version).toBe("0.3.0");
    expect(consumerManifest(react, "7.4.0", { "@opengeni/connect": version }).dependencies).toEqual(
      {
        "@opengeni/react": "7.4.0",
        "@opengeni/connect": "0.3.0",
      },
    );
    expect(lowestPublishedVersion("^0.3.1", ["0.3.0", "0.3.2"])).toBe("0.3.2");
    expect(() => lowestPublishedVersion("^0.3.1", ["0.3.0", "0.4.0"])).toThrow(
      "No published version satisfies declared range ^0.3.1",
    );
  });

  test("rejects workspace/file dependency leakage in a supposedly published manifest", () => {
    for (const range of ["workspace:*", "file:../connect", "link:../connect"]) {
      expect(() =>
        consumerManifest({ ...react, dependencies: { "@opengeni/connect": range } }, "7.4.0"),
      ).toThrow("is not a registry dependency");
    }
  });

  test("missing selected entrypoints cannot silently reduce the smoke coverage", async () => {
    await fixture(true, async (root) => {
      await expect(
        proveInstalledConsumer(root, react, { browser: ["./connect"], node: [] }),
      ).rejects.toThrow("is missing smoke entrypoint ./connect");
    });
  });

  test("CI exercises regression; release checks registry closure only after publication reconciliation", () => {
    type Workflow = { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
    const workflows = join(import.meta.dir, "../.github/workflows");
    const ci = parse(readFileSync(join(workflows, "ci.yml"), "utf8")) as Workflow;
    expect(
      ci.jobs["package-contracts"]!.steps.some(
        (step) =>
          step.name === "Registry dependency export guard regression" &&
          step.run?.includes("scripts/test-registry-dependency-exports.test.ts"),
      ),
    ).toBe(true);
    const publication = parse(
      readFileSync(join(workflows, "publish-packages.yml"), "utf8"),
    ) as Workflow;
    const steps = publication.jobs.publish!.steps;
    const reconcile = steps.findIndex(
      (step) => step.name === "Reconcile exact registry package identity",
    );
    const smoke = steps.findIndex((step) =>
      step.run?.includes("test:registry-dependency-exports --candidate"),
    );
    expect(reconcile).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(reconcile);
    expect(steps[smoke]!.run).toContain("test:registry-dependency-exports --published-source");
    const publish = steps.findIndex((step) => step.name === "Publish unpublished package versions");
    const effective = steps.findIndex((step) =>
      step.run?.includes("test:effective-dependency-exports"),
    );
    expect(effective).toBeGreaterThan(-1);
    expect(effective).toBeLessThan(publish);
  });
});
