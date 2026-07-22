import { describe, expect, test } from "bun:test";
import { declarationModuleSpecifiers, runtimeModuleSpecifiers } from "./publish-closure-imports";

describe("publish closure import discovery", () => {
  test("finds static, dynamic, and CommonJS runtime imports", () => {
    const source = `
      import "@opengeni/static";
      const commonjs = require("@opengeni/commonjs");
      const dynamic = import("@opengeni/dynamic");
    `;

    expect(runtimeModuleSpecifiers(source, "ts").sort()).toEqual([
      "@opengeni/commonjs",
      "@opengeni/dynamic",
      "@opengeni/static",
    ]);
  });

  test("finds every dependency-bearing declaration form", () => {
    const source = `
      /// <reference types="@opengeni/reference" />
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
    ]);
  });
});
