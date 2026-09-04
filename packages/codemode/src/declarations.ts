import type { AttemptToolCatalog } from "@opengeni/contracts";
import { generateToolDeclarations, jsonSchemaToTypeScript } from "@opengeni/tool-gateway";
import { parseVerifiedAttemptToolCatalog } from "./index";

export type GenerateCodemodeDeclarationsOptions = {
  /** Package whose augmentable CodemodeGeneratedTools interface owns the namespace. */
  moduleSpecifier?: string;
};

/**
 * Generate declaration merging for one exact, digest-pinned attempt catalog.
 * Types improve authoring only; runtime catalog validation remains authoritative.
 */
export function generateCodemodeDeclarations(
  catalog: AttemptToolCatalog,
  options: GenerateCodemodeDeclarationsOptions = {},
): string {
  const verified = parseVerifiedAttemptToolCatalog(catalog);
  return generateToolDeclarations(
    { digest: verified.digest, entries: verified.entries },
    {
      moduleSpecifier: options.moduleSpecifier ?? "@opengeni/codemode",
      interfaceName: "CodemodeGeneratedTools",
      callOptionsType: "CodemodeCallOptions",
      fallbackResultType: "CodemodeToolResult",
      generatedBy: "@opengeni/codemode via @opengeni/tool-gateway",
      catalogDigestLabel: "Attempt catalog digest",
    },
  );
}

export { jsonSchemaToTypeScript };
