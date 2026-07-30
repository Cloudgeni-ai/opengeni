import { parse } from "@babel/parser";
import * as babel from "@babel/types";

export type RuntimeLoader = "js" | "jsx" | "ts" | "tsx";

export async function runtimeModuleSpecifiers(
  source: string,
  loader: RuntimeLoader,
): Promise<string[]> {
  const transpiler = new Bun.Transpiler({ loader });
  const imports = transpiler.scanImports(source);
  const scan = await transpiler.scan(source);
  return [...new Set([...scan.imports, ...imports].map((entry) => entry.path))];
}

export function declarationModuleSpecifiers(source: string, fileName: string): string[] {
  const sourceFile = parse(source, {
    sourceFilename: fileName,
    sourceType: "unambiguous",
    plugins: [["typescript", { dts: true }]],
  });
  const specifiers = new Set<string>();

  for (const match of source.matchAll(
    /^\s*\/\/\/\s*<reference\s+types=(?:"([^"]+)"|'([^']+)')\s*\/?\s*>/gm,
  )) {
    specifiers.add(match[1] ?? match[2]!);
  }

  function visit(node: babel.Node): void {
    if (
      (babel.isImportDeclaration(node) ||
        babel.isExportNamedDeclaration(node) ||
        babel.isExportAllDeclaration(node)) &&
      babel.isStringLiteral(node.source)
    ) {
      specifiers.add(node.source.value);
    } else if (
      babel.isTSImportEqualsDeclaration(node) &&
      babel.isTSExternalModuleReference(node.moduleReference) &&
      babel.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.value);
    } else if (babel.isTSImportType(node) && babel.isStringLiteral(node.argument)) {
      specifiers.add(node.argument.value);
    }
    for (const key of babel.VISITOR_KEYS[node.type] ?? []) {
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && "type" in child) {
            visit(child as babel.Node);
          }
        }
      } else if (value && typeof value === "object" && "type" in value) {
        visit(value as babel.Node);
      }
    }
  }

  visit(sourceFile);
  return [...specifiers];
}
