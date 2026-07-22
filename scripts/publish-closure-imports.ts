import ts from "typescript";

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
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers = new Set<string>();

  for (const directive of sourceFile.typeReferenceDirectives) {
    specifiers.add(directive.fileName);
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.add(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...specifiers];
}
