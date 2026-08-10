import { describe, expect, test } from "bun:test";
import { declarationModuleSpecifiers, runtimeModuleSpecifiers } from "./publish-closure-imports";

describe("publish closure import discovery", () => {
  test("finds static, dynamic, and CommonJS runtime imports", async () => {
    const source = `
      import "@opengeni/static";
      const commonjs = require("@opengeni/commonjs");
      const resolved = require.resolve("@opengeni/resolved");
      const dynamic = import("@opengeni/dynamic");
    `;

    expect((await runtimeModuleSpecifiers(source, "ts")).sort()).toEqual([
      "@opengeni/commonjs",
      "@opengeni/dynamic",
      "@opengeni/resolved",
      "@opengeni/static",
    ]);
  });

  test("accepts executable hashbangs without hiding runtime imports", async () => {
    const source = '#!/usr/bin/env node\nimport "@opengeni/cli-runtime";\n';

    expect(await runtimeModuleSpecifiers(source, "ts")).toEqual(["@opengeni/cli-runtime"]);
  });

  test("finds every dependency-bearing declaration form", () => {
    const source = `
      /// <reference types="@opengeni/reference" />
      /// <reference preserve="true" types='@opengeni/reference-extra' />
      import type { A } from "@opengeni/imported";
      export type { B } from "@opengeni/exported";
      import C = require("@opengeni/import-equals");
      export type D = import("@opengeni/import-type").D;
    `;

    expect(declarationModuleSpecifiers(source, "index.d.ts").sort()).toEqual([
      "@opengeni/exported",
      "@opengeni/import-equals",
      "@opengeni/import-type",
      "@opengeni/imported",
      "@opengeni/reference",
      "@opengeni/reference-extra",
    ]);
  });

  test("rejects malformed declarations instead of returning an incomplete closure", () => {
    expect(() =>
      declarationModuleSpecifiers('import type { A } from "unterminated', "bad.d.ts"),
    ).toThrow("Could not parse bad.d.ts");
  });
});
