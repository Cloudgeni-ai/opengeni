import * as t from "oxc-parser";

export type RuntimeLoader = "js" | "jsx" | "ts" | "tsx";

export async function runtimeModuleSpecifiers(
  source: string,
  loader: RuntimeLoader,
): Promise<string[]> {
  // Bun.Transpiler rejects executable hashbangs even though Node/Bun accept
  // them at the start of shipped CLI modules. Preserve line numbering while
  // scanning the JavaScript body for its dependency closure.
  const scannableSource = source.startsWith("#!") ? source.replace(/^#![^\r\n]*/u, "") : source;
  const transpiler = new Bun.Transpiler({ loader });
  const imports = transpiler.scanImports(scannableSource);
  const scan = await transpiler.scan(scannableSource);
  return [...new Set([...scan.imports, ...imports].map((entry) => entry.path))];
}

export function declarationModuleSpecifiers(source: string, fileName: string): string[] {
  const parsed = t.parseSync(fileName, source, { sourceType: "unambiguous" });
  if (parsed.errors.length > 0) {
    throw new Error(
      `Could not parse ${fileName}: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const specifiers = new Set<string>();

  for (const comment of parsed.comments) {
    if (comment.type !== "Line" || !/^\/\s*<reference\b/u.test(comment.value)) continue;
    const directive = /\btypes\s*=\s*(["'])([^"']+)\1/u.exec(comment.value);
    if (directive?.[2]) specifiers.add(directive[2]);
  }

  function visit(node: t.Node): void {
    const record = node as unknown as Record<string, unknown>;
    if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration") {
      addStringLiteral(record.source);
    } else if (node.type === "ExportAllDeclaration" || node.type === "TSImportType") {
      addStringLiteral(record.source);
    } else if (node.type === "TSImportEqualsDeclaration") {
      const reference = record.moduleReference;
      if (isNode(reference) && reference.type === "TSExternalModuleReference") {
        addStringLiteral((reference as unknown as Record<string, unknown>).expression);
      }
    }

    for (const key of t.visitorKeys[node.type] ?? []) {
      const value = record[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) visit(child);
      }
    }
  }

  function addStringLiteral(value: unknown): void {
    if (isNode(value) && value.type === "Literal" && typeof value.value === "string") {
      specifiers.add(value.value);
    }
  }

  visit(parsed.program);
  return [...specifiers];
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}
