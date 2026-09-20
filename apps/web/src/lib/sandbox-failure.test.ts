import { expect, test } from "bun:test";

test("eager failure projection does not import the lazy recovery controller", async () => {
  const scanner = new Bun.Transpiler({ loader: "ts" });
  const imports = scanner.scanImports(await Bun.file(`${import.meta.dir}/events.ts`).text());
  expect(imports.map((entry) => entry.path)).toContain("./sandbox-failure");
  expect(imports.map((entry) => entry.path)).not.toContain("./sandbox-recovery");
  expect(
    scanner.scanImports(await Bun.file(`${import.meta.dir}/sandbox-failure.ts`).text()),
  ).toEqual([]);
});
