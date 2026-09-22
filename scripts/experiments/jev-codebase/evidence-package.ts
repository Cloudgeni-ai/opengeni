import ts from "typescript";
import type { Chunk } from "./core";

/** Merge overlapping exact ranges only; never fill an unread gap or merge adjacent definitions. */
export function mergeEvidence(spans: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  for (const span of spans) {
    const overlapping = out.filter(
      (s) => s.path === span.path && s.startLine <= span.endLine && s.endLine >= span.startLine,
    );
    const members = [...overlapping, span],
      lines = new Map<number, string>();
    for (const s of members) {
      const text = s.text.split("\n");
      if (text.length !== s.endLine - s.startLine + 1) throw new Error("invalid_evidence_lines");
      text.forEach((line, i) => {
        const n = s.startLine + i;
        if (lines.has(n) && lines.get(n) !== line) throw new Error("conflicting_evidence_lines");
        lines.set(n, line);
      });
    }
    const startLine = Math.min(...members.map((s) => s.startLine)),
      endLine = Math.max(...members.map((s) => s.endLine));
    const merged = {
      ...span,
      id: overlapping[0]?.id ?? span.id,
      startLine,
      endLine,
      text: Array.from({ length: endLine - startLine + 1 }, (_, i) => {
        const line = lines.get(startLine + i);
        if (line === undefined) throw new Error("evidence_gap");
        return line;
      }).join("\n"),
    };
    const insert = overlapping.length ? out.indexOf(overlapping[0]) : out.length;
    for (let i = out.length - 1; i >= 0; i--) if (overlapping.includes(out[i])) out.splice(i, 1);
    out.splice(insert, 0, merged);
  }
  return out;
}

function referencedContext(files: Chunk[], selected: Chunk[]): Chunk[] {
  const result: Chunk[] = [];
  for (const file of files) {
    const own = selected.filter((s) => s.path === file.path);
    if (!own.length) continue;
    const identifiers = new Set<string>();
    for (const span of own) {
      const selectedTree = ts.createSourceFile(span.path, span.text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) identifiers.add(node.text);
        ts.forEachChild(node, visit);
      };
      visit(selectedTree);
    }
    const tree = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true),
      lines = file.text.split("\n");
    for (const statement of tree.statements) {
      // Keep small same-file guards/helpers referenced syntactically by selected evidence. This is
      // conservative syntactic context, not complete dependency resolution.
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        identifiers.has(statement.name.text)
      ) {
        const start = tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line;
        const end = tree.getLineAndCharacterOfPosition(statement.getEnd()).line;
        const text = lines.slice(start, end + 1).join("\n");
        if (text.length <= 1500)
          result.push({
            id: `helper:${file.path}:${file.startLine + start}`,
            path: file.path,
            startLine: file.startLine + start,
            endLine: file.startLine + end,
            text,
          });
      }
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      const clause = statement.importClause,
        bindings = clause.namedBindings;
      const names = [
        ...(clause.name ? [clause.name.text] : []),
        ...(bindings
          ? ts.isNamespaceImport(bindings)
            ? [bindings.name.text]
            : bindings.elements.map((e) => e.name.text)
          : []),
      ];
      if (!names.some((n) => identifiers.has(n))) continue;
      const start = tree.getLineAndCharacterOfPosition(statement.getStart(tree)).line,
        end = tree.getLineAndCharacterOfPosition(statement.getEnd()).line;
      result.push({
        id: `import:${file.path}:${file.startLine + start}`,
        path: file.path,
        startLine: file.startLine + start,
        endLine: file.startLine + end,
        text: lines.slice(start, end + 1).join("\n"),
      });
    }
  }
  return result;
}

export function packEvidence(candidates: Chunk[], files: Chunk[], limit: number) {
  let evidence: Chunk[] = [],
    omittedEssentialSpans = false,
    omittedContextSpans = false,
    contextImportsAdded = 0,
    contextHelpersAdded = 0;
  const add = (span: Chunk) => {
    const merged = mergeEvidence([...evidence, span]);
    if (merged.reduce((n, s) => n + s.text.length, 0) > limit) return false;
    evidence = merged;
    return true;
  };
  for (const span of candidates) if (!add(span)) omittedEssentialSpans = true;
  for (const span of referencedContext(files, evidence)) {
    if (
      evidence.some(
        (e) => e.path === span.path && e.startLine <= span.startLine && e.endLine >= span.endLine,
      )
    )
      continue;
    if (add(span)) {
      if (span.id.startsWith("import:")) contextImportsAdded++;
      else contextHelpersAdded++;
    } else omittedContextSpans = true;
  }
  return {
    evidence,
    omittedEssentialSpans,
    omittedContextSpans,
    contextImportsAdded,
    contextHelpersAdded,
  };
}
