import { parse } from "@babel/parser";
import { VISITOR_KEYS, type Node } from "@babel/types";

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
    plugins: ["typescript"],
  });
  const specifiers = new Set<string>();

  for (const match of source.matchAll(
    /^\s*\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["'][^>]*\/>/gm,
  )) {
    if (match[1]) specifiers.add(match[1]);
  }

  function visit(node: Node): void {
    if (node.type === "ImportDeclaration" && node.source.type === "StringLiteral") {
      specifiers.add(node.source.value);
    } else if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.source?.type === "StringLiteral"
    ) {
      specifiers.add(node.source.value);
    } else if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference.type === "TSExternalModuleReference" &&
      node.moduleReference.expression.type === "StringLiteral"
    ) {
      specifiers.add(node.moduleReference.expression.value);
    } else if (node.type === "TSImportType" && node.argument.type === "StringLiteral") {
      specifiers.add(node.argument.value);
    }
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const entry of child) {
          if (entry && typeof entry === "object" && "type" in entry) visit(entry as Node);
        }
      } else if (child && typeof child === "object" && "type" in child) {
        visit(child as Node);
      }
    }
  }

  visit(sourceFile);
  return [...specifiers];
}
