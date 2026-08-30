import type { CanonicalToolJsonSchema } from "@opengeni/contracts";
import { jsonSchemaToTypeScript, rootObjectArgumentsAreOptional } from "./schema";

export type CanonicalToolDeclarationEntry = Readonly<{
  programmaticPath: readonly string[];
  title?: string;
  description?: string;
  inputSchema: CanonicalToolJsonSchema;
  outputSchema?: CanonicalToolJsonSchema;
}>;

export type RenderCanonicalToolDeclarationTreeOptions = Readonly<{
  callOptionsType: string;
  defaultResultType: string;
  argumentName?: string;
  pathLabel?: string;
  indent?: number;
}>;

export type GenerateCanonicalToolDeclarationsOptions = Readonly<{
  moduleSpecifier: string;
  interfaceName: string;
  entries: readonly CanonicalToolDeclarationEntry[];
  callOptionsType: string;
  defaultResultType: string;
  importTypes: readonly string[];
  headerLines?: readonly string[];
  argumentName?: string;
  pathLabel?: string;
}>;

type NamespaceNode = {
  children: Map<string, NamespaceNode>;
  entry: CanonicalToolDeclarationEntry | null;
};

/** Generic module augmentation over one exact caller-owned tool catalog. */
export function generateCanonicalToolDeclarations(
  options: GenerateCanonicalToolDeclarationsOptions,
): string {
  const imports = [...new Set(options.importTypes)];
  return [
    ...(options.headerLines ?? []),
    ...(imports.length > 0
      ? [`import type { ${imports.join(", ")} } from ${JSON.stringify(options.moduleSpecifier)};`]
      : []),
    "",
    `declare module ${JSON.stringify(options.moduleSpecifier)} {`,
    `  interface ${options.interfaceName} {`,
    ...renderCanonicalToolDeclarationTree(options.entries, {
      callOptionsType: options.callOptionsType,
      defaultResultType: options.defaultResultType,
      ...(options.argumentName ? { argumentName: options.argumentName } : {}),
      ...(options.pathLabel ? { pathLabel: options.pathLabel } : {}),
      indent: 4,
    }),
    "  }",
    "}",
    "",
    "export {};",
    "",
  ].join("\n");
}

/** Render a deterministic nested namespace tree for any programmatic tool surface. */
export function renderCanonicalToolDeclarationTree(
  entries: readonly CanonicalToolDeclarationEntry[],
  options: RenderCanonicalToolDeclarationTreeOptions,
): string[] {
  const root = namespaceNode();
  for (const entry of entries) insertEntry(root, entry, options.pathLabel ?? "Tool");
  return renderChildren(root, options.indent ?? 0, options);
}

function namespaceNode(): NamespaceNode {
  return { children: new Map(), entry: null };
}

function insertEntry(
  root: NamespaceNode,
  entry: CanonicalToolDeclarationEntry,
  pathLabel: string,
): void {
  let node = root;
  for (const [index, segment] of entry.programmaticPath.entries()) {
    if (node.entry) {
      throw new Error(
        `${pathLabel} declaration path ${entry.programmaticPath.join(".")} extends a tool leaf`,
      );
    }
    let child = node.children.get(segment);
    if (!child) {
      child = namespaceNode();
      node.children.set(segment, child);
    }
    node = child;
    if (index === entry.programmaticPath.length - 1) {
      if (node.entry || node.children.size > 0) {
        throw new Error(
          `${pathLabel} declaration path ${entry.programmaticPath.join(".")} collides`,
        );
      }
      node.entry = entry;
    }
  }
}

function renderChildren(
  node: NamespaceNode,
  indent: number,
  options: RenderCanonicalToolDeclarationTreeOptions,
): string[] {
  const lines: string[] = [];
  for (const [name, child] of [...node.children].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (child.entry) {
      lines.push(...renderTool(name, child.entry, indent, options));
      continue;
    }
    lines.push(`${spaces(indent)}readonly ${name}: {`);
    lines.push(...renderChildren(child, indent + 2, options));
    lines.push(`${spaces(indent)}};`);
  }
  return lines;
}

function renderTool(
  name: string,
  entry: CanonicalToolDeclarationEntry,
  indent: number,
  options: RenderCanonicalToolDeclarationTreeOptions,
): string[] {
  const input = jsonSchemaToTypeScript(entry.inputSchema);
  const output = entry.outputSchema
    ? jsonSchemaToTypeScript(entry.outputSchema)
    : options.defaultResultType;
  const optionalArguments = rootObjectArgumentsAreOptional(entry.inputSchema);
  const description = boundedDoc(entry.description ?? entry.title);
  const argumentName = options.argumentName ?? "argumentsValue";
  return [
    ...(description ? renderDoc(description, indent) : []),
    `${spaces(indent)}readonly ${name}: (`,
    `${spaces(indent + 2)}${argumentName}${optionalArguments ? "?" : ""}: ${input},`,
    `${spaces(indent + 2)}options?: ${options.callOptionsType},`,
    `${spaces(indent)}) => Promise<${output}>;`,
  ];
}

function boundedDoc(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/gu, " ").trim().replace(/\*\//gu, "*\\/");
  if (!normalized) return null;
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 509)}...`;
}

function renderDoc(value: string, indent: number): string[] {
  return [`${spaces(indent)}/** ${value} */`];
}

function spaces(count: number): string {
  return " ".repeat(count);
}
