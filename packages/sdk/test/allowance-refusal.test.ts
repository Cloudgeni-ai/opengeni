import { expect, test } from "bun:test";
import {
  allowanceExhaustedMessage,
  parseAllowanceExhaustedRefusal,
} from "../src/allowance-refusal";

test("SDK allowance subpath preserves canonical safe presentation", () => {
  const refusal = parseAllowanceExhaustedRefusal({
    code: "allowance_exhausted",
    scope: "member",
    resetsAt: null,
    message: "Private wrapper",
  });
  expect(refusal).not.toBeNull();
  const text = allowanceExhaustedMessage(refusal!);
  expect(text).toContain("workspace administrator");
  expect(text).toContain("no automatic reset");
  expect(text).not.toContain("Private wrapper");
});

test("published SDK allowance leaf is self-contained without a schema runtime", async () => {
  if (process.env.OPENGENI_VERIFY_BUILT_EMBEDDING_PACKAGES !== "1") return;
  const emitted = await Bun.file(`${import.meta.dir}/../dist/allowance-refusal.js`).text();
  expect(emitted).toContain("usage allowance is exhausted");
  expect(emitted).not.toContain("@opengeni/contracts");
  expect(emitted).not.toMatch(/\bzod\b|\$ZodType|ZodError/u);
});

test("React allowance projection's browser closure stays client-only", async () => {
  const loaded = new Set<string>();
  const result = await Bun.build({
    entrypoints: [`${import.meta.dir}/../../react/src/timeline/projection.ts`],
    target: "browser",
    format: "esm",
    minify: true,
    plugins: [
      {
        name: "observe-browser-closure",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
            loaded.add(args.path);
            return undefined;
          });
        },
      },
    ],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Allowance projection failed to bundle");
  expect([...loaded].some((path) => path.includes("/sdk/src/allowance-refusal.ts"))).toBe(true);
  expect([...loaded].some((path) => path.includes("/contracts/src/allowance-refusal.ts"))).toBe(
    true,
  );
  expect(
    [...loaded].filter((path) =>
      /\/packages\/(?:core|db|runtime|config|events|storage|network)\//u.test(path),
    ),
  ).toEqual([]);
  expect([...loaded].filter((path) => /\/node_modules\/.*\/zod\//u.test(path))).toEqual([]);
  const text = await result.outputs[0]!.text();
  expect(text).toContain("usage allowance is exhausted");
  expect(text).not.toMatch(/require\(["'](?:node:)?(?:fs|child_process|net)["']\)/u);
});
