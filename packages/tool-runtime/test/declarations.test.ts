import { describe, expect, test } from "bun:test";
import { generateCanonicalToolDeclarations } from "../src";

describe("canonical tool declaration rendering", () => {
  test("renders deterministic module augmentation for any programmatic surface", () => {
    const declaration = generateCanonicalToolDeclarations({
      moduleSpecifier: "@opengeni/app-sdk",
      interfaceName: "AppGeneratedTools",
      entries: [
        {
          programmaticPath: ["docs", "search"],
          description: "Search docs",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, limit: { type: "integer" } },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { hits: { type: "array", items: { type: "string" } } },
            required: ["hits"],
            additionalProperties: false,
          },
        },
        {
          programmaticPath: ["docs", "refresh"],
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      callOptionsType: "AppCallOptions",
      defaultResultType: "AppToolResult",
      importTypes: ["AppCallOptions", "AppToolResult"],
      headerLines: ["// Generated App declarations.", "// Catalog digest: abc"],
      pathLabel: "App",
    });
    expect(declaration).toContain('declare module "@opengeni/app-sdk"');
    expect(declaration).toContain("interface AppGeneratedTools");
    expect(declaration).toContain(
      "argumentsValue: { readonly limit?: number; readonly query: string }",
    );
    expect(declaration).toContain("Promise<{ readonly hits: readonly (string)[] }>;");
    expect(declaration).toContain("argumentsValue?: Record<string, never>");
    expect(declaration).toContain("Promise<AppToolResult>;");
  });

  test("rejects namespace/tool prefix collisions", () => {
    expect(() =>
      generateCanonicalToolDeclarations({
        moduleSpecifier: "example",
        interfaceName: "Tools",
        entries: [
          { programmaticPath: ["docs", "search"], inputSchema: { type: "object" } },
          {
            programmaticPath: ["docs", "search", "advanced"],
            inputSchema: { type: "object" },
          },
        ],
        callOptionsType: "CallOptions",
        defaultResultType: "ToolResult",
        importTypes: [],
        pathLabel: "App",
      }),
    ).toThrow("App declaration path docs.search.advanced extends a tool leaf");
  });
});
