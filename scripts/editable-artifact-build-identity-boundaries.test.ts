import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";

type AllowedComparison = Readonly<{
  expression: string;
  category: "distribution" | "materialization" | "in-flight consistency" | "exact immutable record";
}>;

const allowed = new Map<string, readonly AllowedComparison[]>([
  [
    "apps/api/src/editable-artifact-native-kernel.ts",
    [
      {
        expression: "runtime.buildIdentity !== location.kernel.buildIdentity",
        category: "distribution",
      },
    ],
  ],
  [
    "apps/worker/src/editable-artifact-materializer-subprocess.ts",
    [{ expression: "record.kernelVersion !== job.kernelVersion", category: "materialization" }],
  ],
  [
    "apps/worker/src/editable-artifact-materializer.ts",
    [
      { expression: "identity.kernelVersion === job.kernelVersion", category: "materialization" },
      { expression: "result.kernelVersion !== job.kernelVersion", category: "materialization" },
    ],
  ],
  [
    "packages/artifact-tool/src/materializer-cli.ts",
    [
      {
        expression: "manifest.kernelVersion !== capabilities.kernelVersion",
        category: "materialization",
      },
    ],
  ],
  [
    "packages/artifact-tool/src/office-import.ts",
    [
      {
        expression: "snapshot.kernelVersion !== expectedKernelVersion",
        category: "in-flight consistency",
      },
    ],
  ],
  [
    "packages/artifact-tool/src/runtime-cli.ts",
    [
      {
        expression: "proof.runtimeBuildIdentity !== location.kernel.buildIdentity",
        category: "distribution",
      },
      {
        expression: "record.buildIdentity !== location.kernel.buildIdentity",
        category: "distribution",
      },
      {
        expression: "runtime.buildIdentity !== before.kernel.buildIdentity",
        category: "distribution",
      },
    ],
  ],
  [
    "packages/artifact-tool/src/runtime-development.ts",
    [
      {
        expression: "receipt.buildIdentity !== kernel.buildIdentity",
        category: "distribution",
      },
      {
        expression: "runtime.buildIdentity !== after.kernel.buildIdentity",
        category: "distribution",
      },
    ],
  ],
  [
    "packages/artifact-tool/src/runtime-receipt.ts",
    [{ expression: "record.buildIdentity.length === 0", category: "distribution" }],
  ],
  [
    "packages/artifact-tool/src/runtime.ts",
    [
      {
        expression:
          "JSON.stringify(actual) !== JSON.stringify({ schemaVersion: expected.schemaVersion, target: expected.target, kind: expected.kind, packageName: expected.packageName, packageVersion: expected.packageVersion, artifactToolVersion: expected.artifactToolVersion, buildIdentity: expected.buildIdentity, })",
        category: "distribution",
      },
      {
        expression: "this.buildIdentity !== manifest.buildIdentity",
        category: "distribution",
      },
    ],
  ],
  [
    "packages/core/src/domain/editable-artifacts/service.ts",
    [
      {
        expression: "existing.kernelVersion === candidate.kernelVersion",
        category: "exact immutable record",
      },
    ],
  ],
  [
    "packages/db/src/editable-artifacts.ts",
    [
      {
        expression: "transaction.kernelVersion !== receipt.kernelVersion",
        category: "exact immutable record",
      },
    ],
  ],
  [
    "packages/sdk/src/editable-artifacts/http-live-transport.ts",
    [
      {
        expression: "frame.kernelVersion !== assembly.metadata.kernelVersion",
        category: "in-flight consistency",
      },
    ],
  ],
  [
    "packages/sdk/src/editable-artifacts/worker/kernel-adapter.ts",
    [
      { expression: "buildIdentity.length === 0", category: "distribution" },
      { expression: 'normalized.buildIdentityFormat !== "utf8"', category: "distribution" },
    ],
  ],
  [
    "packages/sdk/src/editable-artifacts/worker/runtime.ts",
    [
      {
        expression: "adapter.kernelVersion !== initialization.kernelVersion",
        category: "distribution",
      },
      {
        expression: "input.kernelVersion !== adapter.kernelVersion",
        category: "in-flight consistency",
      },
    ],
  ],
  [
    "scripts/assemble-artifact-runtime-installation.ts",
    [
      {
        expression: "receipt.buildIdentity !== packageManifest.buildIdentity",
        category: "distribution",
      },
    ],
  ],
  [
    "scripts/materialize-artifact-kernel-packages.ts",
    [
      {
        expression: "new Set(receipts.map(({ buildIdentity }) => buildIdentity)).size !== 1",
        category: "distribution",
      },
    ],
  ],
  [
    "scripts/publish-closure-guard.ts",
    [
      { expression: "identity.buildIdentity.length === 0", category: "distribution" },
      {
        expression: "identity.kernelVersion !== identity.buildIdentity",
        category: "distribution",
      },
    ],
  ],
  [
    "scripts/test-artifact-kernel-package-consumers.ts",
    [
      {
        expression: "wasmReceipt.buildIdentity !== buildIdentity",
        category: "distribution",
      },
    ],
  ],
]);

const comparisonOperators = new Set(["==", "===", "!=", "!=="]);
const sourceRoots = ["apps", "packages", "scripts"] as const;
const sourceGlob = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");

describe("editable artifact build identity boundaries", () => {
  test("allows build equality only at documented non-reader boundaries", async () => {
    const found = new Map<string, string[]>();
    for (const root of sourceRoots) {
      for await (const path of sourceGlob.scan({ cwd: root })) {
        if (
          /(^|\/)(?:demo-dist|dist|target|test|tests)\//u.test(path) ||
          /\.test\.[^.]+$/u.test(path) ||
          /\.d\.ts$/u.test(path)
        ) {
          continue;
        }
        const file = `${root}/${path}`;
        const source = await Bun.file(file).text();
        if (!/(?:kernelVersion|buildIdentity)/u.test(source)) continue;
        const parsed = parseSync(file, source, { sourceType: "module" });
        expect(parsed.errors, file).toEqual([]);
        visit(parsed.program, (node) => {
          if (node.type !== "BinaryExpression" || !comparisonOperators.has(String(node.operator))) {
            return;
          }
          const expression = source.slice(node.start, node.end).replace(/\s+/gu, " ");
          if (
            !/(?:kernelVersion|buildIdentity)/u.test(expression) ||
            /typeof\s/u.test(expression)
          ) {
            return;
          }
          found.set(file, [...(found.get(file) ?? []), expression]);
        });
      }
    }

    const actual = [...found].flatMap(([file, expressions]) =>
      expressions.map((expression) => `${file}: ${expression}`),
    );
    const expected = [...allowed].flatMap(([file, entries]) =>
      entries.map(({ expression }) => `${file}: ${expression}`),
    );
    expect(actual.sort()).toEqual(expected.sort());
    expect([...allowed.values()].flat().every(({ category }) => category.length > 0)).toBe(true);
  });
});

function visit(node: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, onNode);
    return;
  }
  const record = node as Record<string, unknown>;
  onNode(record);
  for (const [key, child] of Object.entries(record)) {
    if (key !== "start" && key !== "end") visit(child, onNode);
  }
}
