import { expect, test } from "bun:test";
import { needsSandboxRecoveryCheck } from "./sandbox-failure";

test("only a known no-compute route with a nonstructural failure bypasses checkpoint reads", () => {
  expect(needsSandboxRecoveryCheck({ sandboxBackend: "none", activeSandboxId: null })).toBe(false);
  expect(needsSandboxRecoveryCheck({ sandboxBackend: "none", activeSandboxId: null }, true)).toBe(
    true,
  );
  for (const route of [
    {},
    { sandboxBackend: "none" },
    { activeSandboxId: null },
    { sandboxBackend: "none", activeSandboxId: "connected-machine" },
    { sandboxBackend: "modal", activeSandboxId: null },
    { sandboxBackend: "modal", activeSandboxId: "connected-machine" },
    { sandboxBackend: "docker", activeSandboxId: null },
  ])
    expect(needsSandboxRecoveryCheck(route)).toBe(true);
});

test("eager failure projection does not import the lazy recovery controller", async () => {
  const scanner = new Bun.Transpiler({ loader: "ts" });
  const imports = scanner.scanImports(await Bun.file(`${import.meta.dir}/events.ts`).text());
  expect(imports.map((entry) => entry.path)).toContain("./sandbox-failure");
  expect(imports.map((entry) => entry.path)).not.toContain("./sandbox-recovery");
  expect(
    scanner.scanImports(await Bun.file(`${import.meta.dir}/sandbox-failure.ts`).text()),
  ).toEqual([]);
});
