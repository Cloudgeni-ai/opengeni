import { describe, expect, test } from "bun:test";
import {
  ArtifactKernelRegistry,
  type ArtifactKernel,
  type ArtifactKernelCapabilities,
  type ArtifactModality,
} from "../src/kernel";

describe("artifact kernel registry", () => {
  test("prefers native and negotiates required capabilities", () => {
    const registry = new ArtifactKernelRegistry();
    registry.register(kernel("reference", false));
    registry.register(kernel("native", true));
    expect(registry.select("spreadsheet", { collaboration: true }).kernel.kind).toBe("native");
    expect(registry.select("spreadsheet").kernel.kind).toBe("native");
  });

  test("never silently selects the TypeScript reference backend", () => {
    const registry = new ArtifactKernelRegistry();
    registry.register(kernel("reference", true));
    expect(() => registry.select("spreadsheet")).toThrow("required kernel capabilities");
    expect(registry.select("spreadsheet", {}, ["reference"]).kernel.kind).toBe("reference");
  });
});

function kernel(kind: ArtifactKernel["kind"], collaboration: boolean): ArtifactKernel {
  return {
    kind,
    version: "test",
    capabilities(modality: ArtifactModality): ArtifactKernelCapabilities {
      return {
        modality,
        modelSchemaVersion: 1,
        operationSchemaVersion: 1,
        inspect: true,
        calculate: modality === "spreadsheet",
        layout: true,
        renderFormats: ["png"],
        importFormats: [],
        exportFormats: [],
        collaboration,
      };
    },
    async open() {
      throw new Error("not needed");
    },
  };
}
