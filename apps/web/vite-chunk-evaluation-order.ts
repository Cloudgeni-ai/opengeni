import path from "node:path";

import { parseAst, type Plugin } from "vite";

/**
 * Chunk graphs may contain cycles: Rolldown's code-splitting groups place
 * modules by size and by which routes share them, not by import direction.
 * Inside a cycle the order in which chunks run depends on which route the
 * browser reached first. A chunk that reads a binding from a cycle peer while
 * it is still loading (a module-level icon table, alias, call or `extends`)
 * can therefore capture `undefined` and fail far away, typically as React
 * error #130 when that value is rendered as a component. Function bodies and
 * other deferred code are safe because the whole cycle has run before they
 * execute.
 *
 * This check reports every load-time read of a cycle peer's binding so the
 * build fails instead of shipping a bundle that crashes for some navigation
 * orders only.
 */

export type BundleChunk = Readonly<{
  fileName: string;
  code: string;
  /** Static chunk imports, as bundle file names. */
  imports: readonly string[];
}>;

export type ChunkEvaluationOrderHazard = Readonly<{
  /** The chunk whose load-time code reads the binding. */
  chunk: string;
  /** The chunk that owns the binding and may not have run yet. */
  from: string;
  /** The exported name read from `from`. */
  importedName: string;
  /** The load-time code that reads it, shortened. */
  excerpt: string;
  /** Every chunk in the same import cycle, sorted. */
  cycle: readonly string[];
}>;

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type ImportedBinding = { from: string; importedName: string };
type Scope = { names: Set<string>; parent: Scope | null };

/** Strongly connected chunk groups with more than one chunk. */
export function chunkImportCycles(chunks: readonly BundleChunk[]): string[][] {
  const graph = new Map(chunks.map((chunk) => [chunk.fileName, chunk.imports]));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let counter = 0;
  // Iterative Tarjan: bundle graphs are large enough to make recursion fragile.
  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const edges = (graph.get(frame.node) ?? []).filter((target) => graph.has(target));
      if (frame.next < edges.length) {
        const target = edges[frame.next++]!;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter++);
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      if (component.length > 1) cycles.push(component.sort());
    }
  }
  return cycles;
}

export function findChunkEvaluationOrderHazards(
  chunks: readonly BundleChunk[],
): ChunkEvaluationOrderHazard[] {
  const cycleOf = new Map<string, readonly string[]>();
  for (const cycle of chunkImportCycles(chunks)) {
    for (const member of cycle) cycleOf.set(member, cycle);
  }
  const hazards: ChunkEvaluationOrderHazard[] = [];
  for (const chunk of chunks) {
    const cycle = cycleOf.get(chunk.fileName);
    if (!cycle) continue;
    const program = parseAst(chunk.code) as unknown as AstNode;
    const peers = new Map<string, ImportedBinding>();
    for (const statement of children(program, "body")) {
      if (statement.type !== "ImportDeclaration") continue;
      const from = resolveChunkImport(
        chunk.fileName,
        (statement.source as { value: string }).value,
      );
      if (from === chunk.fileName || !cycle.includes(from)) continue;
      for (const specifier of children(statement, "specifiers")) {
        const local = (specifier.local as { name: string }).name;
        const importedName =
          specifier.type === "ImportSpecifier"
            ? exportName(specifier.imported as AstNode)
            : specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        peers.set(local, { from, importedName });
      }
    }
    if (peers.size === 0) continue;
    const reported = new Set<string>();
    for (const read of loadTimeReads(program, peers)) {
      const binding = peers.get(read.name)!;
      const excerpt = shorten(chunk.code, read.node);
      const key = `${binding.from}\0${binding.importedName}\0${read.statement.start}`;
      if (reported.has(key)) continue;
      reported.add(key);
      hazards.push({
        chunk: chunk.fileName,
        from: binding.from,
        importedName: binding.importedName,
        excerpt,
        cycle,
      });
    }
  }
  return hazards;
}

export function describeChunkEvaluationOrderHazards(
  hazards: readonly ChunkEvaluationOrderHazard[],
): string {
  const lines = hazards.map(
    (hazard) =>
      `- ${hazard.chunk} reads "${hazard.importedName}" from ${hazard.from} while loading: ${hazard.excerpt}`,
  );
  return [
    "Chunks that import each other read each other's bindings while loading.",
    "Which one runs first depends on the route a visitor opens first, so these reads can see undefined.",
    "Move the read into a function, or adjust the code-splitting groups so the owner is in a chunk outside the cycle.",
    "Build with --minify false to see the source code behind each excerpt.",
    ...lines,
  ].join("\n");
}

/** Fails the build when a chunk can observe an uninitialized cycle peer. */
export function chunkEvaluationOrderPlugin(): Plugin {
  return {
    name: "opengeni-chunk-evaluation-order",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks: BundleChunk[] = [];
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        chunks.push({ fileName: output.fileName, code: output.code, imports: output.imports });
      }
      const hazards = findChunkEvaluationOrderHazards(chunks);
      if (hazards.length > 0) this.error(describeChunkEvaluationOrderHazards(hazards));
    },
  };
}

type LoadTimeRead = { name: string; statement: AstNode; node: AstNode };

/**
 * Identifier reads that happen while the module body runs: top-level
 * statements, immediately invoked functions, functions the top level calls,
 * callbacks passed to method calls (array helpers run them at once), class
 * heritage and static members. Ordinary function bodies are deferred.
 */
function loadTimeReads(program: AstNode, peers: ReadonlyMap<string, ImportedBinding>) {
  const reads: LoadTimeRead[] = [];
  const moduleFunctions = new Map<string, AstNode>();
  const moduleClasses = new Map<string, AstNode>();
  const body = children(program, "body").map((statement) =>
    statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? ((statement.declaration as AstNode | null) ?? statement)
      : statement,
  );
  for (const statement of body) {
    if (statement.type === "FunctionDeclaration" && statement.id) {
      moduleFunctions.set((statement.id as { name: string }).name, statement);
    }
    if (statement.type === "ClassDeclaration" && statement.id) {
      moduleClasses.set((statement.id as { name: string }).name, statement);
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declarator of children(statement, "declarations")) {
      const id = declarator.id as AstNode;
      const init = declarator.init as AstNode | null;
      if (id.type !== "Identifier" || !init) continue;
      const name = (id as unknown as { name: string }).name;
      if (isFunction(init)) moduleFunctions.set(name, init);
      if (init.type === "ClassExpression") moduleClasses.set(name, init);
    }
  }
  const moduleScope: Scope = { names: new Set(), parent: null };
  const enteredFunctions = new Set<AstNode>();
  let statement: AstNode = program;

  const resolves = (name: string, scope: Scope | null): boolean => {
    for (let current = scope; current; current = current.parent) {
      if (current.names.has(name)) return false;
    }
    return peers.has(name);
  };

  const runFunction = (fn: AstNode, scope: Scope) => {
    if (enteredFunctions.has(fn)) return;
    enteredFunctions.add(fn);
    const names = new Set<string>();
    for (const param of children(fn, "params")) collectPatternNames(param, names);
    if (fn.type !== "ArrowFunctionExpression" && fn.id) {
      names.add((fn.id as { name: string }).name);
    }
    const fnBody = fn.body as AstNode;
    collectDeclaredNames(fnBody, names);
    const inner: Scope = { names, parent: scope };
    for (const param of children(fn, "params")) visitPattern(param, inner);
    visit(fnBody, inner);
  };

  const runClass = (cls: AstNode, scope: Scope, instance: boolean) => {
    if (cls.superClass) visit(cls.superClass as AstNode, scope);
    for (const member of children(cls.body as AstNode, "body")) {
      if (member.computed) visit(member.key as AstNode, scope);
      const isStatic = member.static === true;
      if (member.type === "StaticBlock") {
        const names = new Set<string>();
        collectDeclaredNames(member, names);
        visit({ ...member, type: "BlockStatement" }, { names, parent: scope });
      } else if (member.type === "PropertyDefinition" && member.value && isStatic !== instance) {
        visit(member.value as AstNode, scope);
      } else if (
        instance &&
        member.type === "MethodDefinition" &&
        member.kind === "constructor" &&
        member.value
      ) {
        runFunction(member.value as AstNode, scope);
      }
    }
  };

  const visitPattern = (pattern: AstNode, scope: Scope) => {
    // Defaults and computed keys in patterns run when the binding is created.
    if (pattern.type === "AssignmentPattern") visit(pattern.right as AstNode, scope);
    if (pattern.type === "Property" && pattern.computed) visit(pattern.key as AstNode, scope);
    for (const child of childNodes(pattern)) {
      if (child.type !== "Identifier") visitPattern(child, scope);
    }
  };

  const visit = (node: AstNode, scope: Scope): void => {
    switch (node.type) {
      case "Identifier":
        if (resolves((node as unknown as { name: string }).name, scope)) {
          reads.push({ name: (node as unknown as { name: string }).name, statement, node });
        }
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        runClass(node, scope, false);
        return;
      case "MemberExpression":
        visit(node.object as AstNode, scope);
        if (node.computed) visit(node.property as AstNode, scope);
        return;
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
        if (node.computed) visit(node.key as AstNode, scope);
        if (node.value && !(node.type === "Property" && (node.method || node.kind !== "init"))) {
          visit(node.value as AstNode, scope);
        }
        return;
      case "VariableDeclarator":
        visitPattern(node.id as AstNode, scope);
        if (node.init) visit(node.init as AstNode, scope);
        return;
      case "LabeledStatement":
      case "BreakStatement":
      case "ContinueStatement":
        if (node.type === "LabeledStatement") visit(node.body as AstNode, scope);
        return;
      case "BlockStatement":
      case "StaticBlock": {
        const names = new Set<string>();
        collectBlockNames(node, names);
        const inner: Scope = { names, parent: scope };
        for (const child of children(node, "body")) visit(child, inner);
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "CatchClause": {
        const names = new Set<string>();
        const head = (node.type === "CatchClause" ? node.param : (node.init ?? node.left)) as
          | AstNode
          | null
          | undefined;
        if (head?.type === "VariableDeclaration" && head.kind !== "var") {
          for (const declarator of children(head, "declarations")) {
            collectPatternNames(declarator.id as AstNode, names);
          }
        } else if (node.type === "CatchClause" && head) {
          collectPatternNames(head, names);
        }
        const inner: Scope = { names, parent: scope };
        for (const child of childNodes(node)) visit(child, inner);
        return;
      }
      case "CallExpression":
      case "NewExpression": {
        const callee = unwrap(node.callee as AstNode);
        if (isFunction(callee)) {
          runFunction(callee, scope);
        } else {
          visit(callee, scope);
          if (callee.type === "Identifier") {
            const name = (callee as unknown as { name: string }).name;
            const local = resolvesToModule(name, scope);
            const fn = local ? moduleFunctions.get(name) : undefined;
            const cls = local ? moduleClasses.get(name) : undefined;
            if (fn) runFunction(fn, moduleScope);
            if (cls && node.type === "NewExpression") runClass(cls, moduleScope, true);
          }
        }
        for (const argument of children(node, "arguments")) {
          const value = unwrap(argument);
          // Array helpers and similar method calls run their callbacks at once.
          if (isFunction(value) && callee.type === "MemberExpression") runFunction(value, scope);
          else visit(argument, scope);
        }
        return;
      }
      case "TaggedTemplateExpression":
        visit(node.tag as AstNode, scope);
        visit(node.quasi as AstNode, scope);
        return;
      default:
        for (const child of childNodes(node)) visit(child, scope);
    }
  };

  const resolvesToModule = (name: string, scope: Scope | null): boolean => {
    for (let current = scope; current && current !== moduleScope; current = current.parent) {
      if (current.names.has(name)) return false;
    }
    return true;
  };

  for (const top of body) {
    if (
      top.type === "ImportDeclaration" ||
      top.type === "ExportAllDeclaration" ||
      top.type === "ExportNamedDeclaration" ||
      top.type === "FunctionDeclaration"
    ) {
      continue;
    }
    statement = top;
    visit(top, moduleScope);
  }
  return reads;
}

function resolveChunkImport(importer: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
}

function exportName(node: AstNode): string {
  return node.type === "Identifier"
    ? (node as unknown as { name: string }).name
    : String((node as unknown as { value: unknown }).value);
}

function isFunction(node: AstNode): boolean {
  return node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
}

function unwrap(node: AstNode): AstNode {
  let current = node;
  while (current.type === "ParenthesizedExpression" || current.type === "ChainExpression") {
    current = current.expression as AstNode;
  }
  return current;
}

function children(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value) ? (value.filter(isNode) as AstNode[]) : [];
}

function childNodes(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) result.push(item);
    } else if (isNode(value)) {
      result.push(value);
    }
  }
  return result;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function collectPatternNames(pattern: AstNode, names: Set<string>): void {
  switch (pattern.type) {
    case "Identifier":
      names.add((pattern as unknown as { name: string }).name);
      return;
    case "AssignmentPattern":
      collectPatternNames(pattern.left as AstNode, names);
      return;
    case "RestElement":
      collectPatternNames(pattern.argument as AstNode, names);
      return;
    case "ArrayPattern":
      for (const element of children(pattern, "elements")) collectPatternNames(element, names);
      return;
    case "ObjectPattern":
      for (const property of children(pattern, "properties")) {
        collectPatternNames(
          (property.type === "RestElement" ? property : property.value) as AstNode,
          names,
        );
      }
      return;
  }
}

/** Function-scoped names: `var` anywhere outside nested functions, plus top-level lexical names. */
function collectDeclaredNames(body: AstNode, names: Set<string>): void {
  collectBlockNames(body, names);
  const walk = (node: AstNode) => {
    if (isFunction(node) || node.type === "FunctionDeclaration") return;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of children(node, "declarations")) {
        collectPatternNames(declarator.id as AstNode, names);
      }
    }
    for (const child of childNodes(node)) walk(child);
  };
  walk(body);
}

/** Lexical names declared directly in a block. */
function collectBlockNames(block: AstNode, names: Set<string>): void {
  for (const statement of children(block, "body")) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration as AstNode | null)
        : statement;
    if (!declaration) continue;
    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.id
    ) {
      names.add((declaration.id as { name: string }).name);
    }
    if (declaration.type === "VariableDeclaration") {
      for (const declarator of children(declaration, "declarations")) {
        collectPatternNames(declarator.id as AstNode, names);
      }
    }
  }
}

function shorten(source: string, node: AstNode): string {
  const from = Math.max(0, node.start - 80);
  const to = Math.min(source.length, node.end + 80);
  const excerpt = source.slice(from, to).replace(/\s+/gu, " ");
  return `${from > 0 ? "…" : ""}${excerpt}${to < source.length ? "…" : ""}`;
}
