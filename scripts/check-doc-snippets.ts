import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// Typecheck the TypeScript code samples in the integration docs, the bundled
// opengeni-client Skill and the package READMEs against the SDK and React
// sources in this repository, so a renamed option, removed export or changed
// method shape fails CI instead of reaching a coding agent that copies the
// sample.
//
// Samples are often fragments: they use variables declared in an earlier
// sample or in the reader's product (`client`, `db`, `app`). Unknown names,
// syntax placeholders (`...`) and third-party modules that are not installed
// here are therefore ignored. What is reported is drift against Opengeni's own
// API: unknown exports, unknown properties and options, wrong argument counts
// and type mismatches involving Opengeni types.
//
// Skip one sample by putting `doc-snippets: skip` in a comment on the line
// right before its fence (`<!-- doc-snippets: skip -->` or
// `{/* doc-snippets: skip */}`), for example when it deliberately shows code
// that does not compile.
//
// Option and prop tables are checked too when a comment right before the
// table names the type they document:
//
//   {/* doc-snippets: keys SessionProxyHandlerOptions from "@opengeni/sdk" complete */}
//
// Every backticked name in the table's first column must be a property of that
// type. With `complete`, every property of the type must also be listed, so a
// new option cannot ship undocumented and a removed one cannot linger.

export type DocSnippet = {
  file: string;
  /** 1-based line of the first code line in the source file. */
  line: number;
  lang: "ts" | "tsx";
  code: string;
  /** Source line for each code line, when the code is generated rather than copied. */
  lineMap?: number[];
};

export type SnippetFinding = {
  file: string;
  line: number;
  code: number;
  message: string;
};

export const DOC_SNIPPET_SOURCES = [
  "docs-site",
  ".agents/skills/opengeni-client",
  ".agents/skills/opengeni/references/client-integration.md",
  "packages/sdk/README.md",
  "packages/react/README.md",
  "docs/embedding.md",
  "docs/product-integration.md",
  "examples",
] as const;

// Generated from .agents/skills/opengeni-client, which is checked directly.
const GENERATED_MIRRORS = new Set(["docs-site/reference/opengeni-client-skill.mdx"]);

const SKIP_MARKER = "doc-snippets: skip";
const KEYS_MARKER =
  /doc-snippets:\s*keys\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'](\s+complete)?/;
const LANGS = new Map<string, "ts" | "tsx">([
  ["ts", "ts"],
  ["typescript", "ts"],
  ["tsx", "tsx"],
]);

/**
 * Diagnostics that show a sample disagrees with an API it can actually see.
 * Names the sample never declares become error types and do not cascade.
 */
const REPORTED_CODES = new Set([
  2305, // Module has no exported member.
  2307, // Cannot find module (reported only for @opengeni/* modules).
  2322, // Type is not assignable.
  2339, // Property does not exist on type.
  2345, // Argument is not assignable to parameter.
  2353, // Object literal may only specify known properties.
  2551, // Property does not exist; did you mean.
  2554, // Expected N arguments.
  2555, // Expected at least N arguments.
  2561, // Object literal may only specify known properties; did you mean.
  2614, // Module has no exported member; did you mean to use import x from.
  2724, // Module has no exported member; did you mean.
  2741, // Property is missing in type.
  2739, // Type is missing properties.
  2740, // Type is missing properties (and more).
  2769, // No overload matches this call.
]);

function walk(root: string, path: string, files: string[]): void {
  if (!existsSync(join(root, path))) return;
  if (/\.(md|mdx)$/.test(path)) {
    files.push(path);
    return;
  }
  let entries;
  try {
    entries = readdirSync(join(root, path), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      if (entry.name !== ".agents") continue;
    }
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory() || /\.(md|mdx)$/.test(entry.name)) walk(root, child, files);
  }
}

export function docSnippetFiles(root = process.cwd()): string[] {
  const files: string[] = [];
  for (const source of DOC_SNIPPET_SOURCES) walk(root, source, files);
  return [...new Set(files)].filter((file) => !GENERATED_MIRRORS.has(file));
}

/** Extract ts/tsx fenced code blocks, including fences indented inside MDX components. */
export function extractDocSnippets(file: string, text: string): DocSnippet[] {
  const lines = text.split("\n");
  const snippets: DocSnippet[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const keys = KEYS_MARKER.exec(lines[index]!);
    if (keys) {
      const table = optionTableSnippet(file, lines, index, keys[1]!, keys[2]!, Boolean(keys[3]));
      snippets.push(table);
      continue;
    }
    const open = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z]+)?(.*)$/.exec(lines[index]!);
    if (!open) continue;
    const [, indent = "", fence = "", lang = ""] = open;
    const close = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    let end = index + 1;
    while (end < lines.length && !close.test(lines[end]!)) end += 1;
    const kind = LANGS.get(lang.toLowerCase());
    const previous = lines[index - 1] ?? "";
    if (kind && !previous.includes(SKIP_MARKER)) {
      const body = lines
        .slice(index + 1, end)
        .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()));
      snippets.push({
        file,
        line: index + 2,
        lang: kind,
        code: body.join("\n"),
      });
    }
    index = end;
  }
  return snippets;
}

/** Turn a marked option table into a type assertion over its first-column names. */
function optionTableSnippet(
  file: string,
  lines: readonly string[],
  markerIndex: number,
  typeName: string,
  module: string,
  complete: boolean,
): DocSnippet {
  const code = [
    `import type { ${typeName} as Documented } from ${JSON.stringify(module)};`,
    "const key = <Name extends keyof Documented>(name: Name): Name => name;",
    "const listed = [",
  ];
  const lineMap = [markerIndex + 1, markerIndex + 1, markerIndex + 1];
  let index = markerIndex + 1;
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  let rows = 0;
  for (; index < lines.length && lines[index]!.trimStart().startsWith("|"); index += 1) {
    const firstCell = lines[index]!.trim().slice(1).split("|")[0] ?? "";
    for (const match of firstCell.matchAll(/`([A-Za-z_$][\w$]*)`/g)) {
      code.push(`  key(${JSON.stringify(match[1])}),`);
      lineMap.push(index + 1);
      rows += 1;
    }
  }
  code.push("] as const;");
  lineMap.push(markerIndex + 1);
  if (rows === 0) {
    // No table follows the marker: fail loudly instead of checking nothing.
    code.push("const noTableAfterMarker: never = true;");
    lineMap.push(markerIndex + 1);
  }
  if (complete) {
    code.push(
      "const everyOptionIsListed: [Exclude<keyof Documented, (typeof listed)[number]>] extends [never]",
      "  ? true",
      "  : `undocumented: ${Exclude<keyof Documented, (typeof listed)[number]> & string}` = true;",
    );
    lineMap.push(markerIndex + 1, markerIndex + 1, markerIndex + 1);
  }
  code.push("void listed;");
  lineMap.push(markerIndex + 1);
  return {
    file,
    line: markerIndex + 1,
    lang: "ts",
    code: code.join("\n"),
    lineMap,
  };
}

type RawDiagnostic = {
  path: string;
  line: number;
  code: number;
  message: string;
};

export function parseDiagnostics(output: string): RawDiagnostic[] {
  const diagnostics: RawDiagnostic[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),\d+\): error TS(\d+): (.*)$/.exec(line.trim());
    if (!match) continue;
    diagnostics.push({
      path: match[1]!,
      line: Number(match[2]),
      code: Number(match[3]),
      message: match[4]!,
    });
  }
  return diagnostics;
}

export function isReportedDiagnostic(code: number, message: string): boolean {
  if (!REPORTED_CODES.has(code)) return false;
  if (code === 2307) return /'@opengeni\//.test(message);
  return true;
}

const PRELUDE_LINES = 1;

type ExportTarget = string | { types?: string; default?: string; import?: string } | null;

/**
 * Resolve every `@opengeni/*` import the way a reader's project would see the
 * published package: through each package's `exports` map (types first). The
 * base config's `paths` cover only the packages the workspace imports itself.
 */
export function packagePaths(root: string): Record<string, string[]> {
  const base = JSON.parse(readFileSync(join(root, "tsconfig.base.json"), "utf8")) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(base.compilerOptions?.paths ?? {})) {
    paths[key] = targets.map((target) => resolve(root, target));
  }
  const packagesDir = join(root, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      types?: string;
      exports?: Record<string, ExportTarget>;
    };
    if (!manifest.name?.startsWith("@opengeni/")) continue;
    const exportsMap = manifest.exports ?? (manifest.types ? { ".": manifest.types } : {});
    for (const [subpath, target] of Object.entries(exportsMap)) {
      const file =
        typeof target === "string" ? target : (target?.types ?? target?.import ?? target?.default);
      if (!file || !/\.(d\.)?tsx?$/.test(file)) continue;
      const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      paths[specifier] ??= [resolve(packagesDir, entry.name, file)];
    }
  }
  return paths;
}

// Bundler asset imports the docs show for Vite-style hosts.
const AMBIENT_DECLARATIONS = `declare module "*?url" { const url: string; export default url; }
declare module "*?worker&url" { const url: string; export default url; }
declare module "*?worker" { const Worker: new () => globalThis.Worker; export default Worker; }
declare module "*.css";
`;

/** Typecheck snippets in a scratch project under `tmp/` and map findings back to their sources. */
export function checkDocSnippets(
  snippets: readonly DocSnippet[],
  root = process.cwd(),
): SnippetFinding[] {
  if (snippets.length === 0) return [];
  mkdirSync(join(root, "tmp"), { recursive: true });
  const dir = mkdtempSync(join(root, "tmp", "doc-snippets-"));
  try {
    const byFile = new Map<string, DocSnippet>();
    snippets.forEach((snippet, index) => {
      const name = `snippet-${index}.${snippet.lang}`;
      byFile.set(name, snippet);
      // `export {}` keeps every sample in its own module scope.
      writeFileSync(join(dir, name), `export {};\n${snippet.code}\n`);
    });
    writeFileSync(join(dir, "ambient.d.ts"), AMBIENT_DECLARATIONS);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          extends: join(root, "tsconfig.base.json"),
          compilerOptions: {
            noEmit: true,
            jsx: "react-jsx",
            types: ["bun"],
            paths: packagePaths(root),
            noUnusedLocals: false,
            noUnusedParameters: false,
            allowUnreachableCode: true,
          },
          include: ["*.ts", "*.tsx"],
        },
        null,
        2,
      ),
    );
    const compiler = join(root, "node_modules", "tsrs", "bin", "tsrs");
    const run = () => {
      const result = spawnSync(compiler, ["--noEmit", "--pretty", "false", "-p", dir], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      return result;
    };
    // The compiler reports only syntax errors while any file has one. Samples
    // that are not complete statements (an options excerpt such as
    // `capabilities: "none"`) cannot be typechecked; set them aside and check
    // the rest.
    let result = run();
    for (let pass = 0; pass < 5; pass += 1) {
      const syntactic = parseDiagnostics(result.stdout).filter((d) => isSyntaxDiagnostic(d.code));
      if (syntactic.length === 0) break;
      for (const diagnostic of syntactic) {
        const name = diagnostic.path.replaceAll("\\", "/").split("/").pop() ?? "";
        if (byFile.delete(name)) rmSync(join(dir, name), { force: true });
      }
      result = run();
    }
    const findings: SnippetFinding[] = [];
    for (const diagnostic of parseDiagnostics(`${result.stdout}\n${result.stderr}`)) {
      const name = diagnostic.path.replaceAll("\\", "/").split("/").pop() ?? "";
      const snippet = byFile.get(name);
      if (!snippet || !isReportedDiagnostic(diagnostic.code, diagnostic.message)) continue;
      findings.push({
        file: snippet.file,
        line:
          snippet.lineMap?.[diagnostic.line - 1 - PRELUDE_LINES] ??
          snippet.line + diagnostic.line - 1 - PRELUDE_LINES,
        code: diagnostic.code,
        message: diagnostic.message,
      });
    }
    if (result.status !== 0 && !/error TS\d+/.test(result.stdout)) {
      throw new Error(`snippet typecheck failed to run:\n${result.stdout}\n${result.stderr}`);
    }
    checkedSnippetCount = byFile.size;
    return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  } finally {
    if (!process.env.DOC_SNIPPETS_KEEP) rmSync(dir, { recursive: true, force: true });
  }
}

/** Number of samples the last `checkDocSnippets` call could typecheck. */
export let checkedSnippetCount = 0;

export function isSyntaxDiagnostic(code: number): boolean {
  // Parser diagnostics; 12xx and 13xx are grammar checks reported with types.
  return (code >= 1000 && code < 1200) || code === 2657 || (code >= 17000 && code < 18000);
}

if (import.meta.main) {
  const root = process.cwd();
  const snippets = docSnippetFiles(root).flatMap((file) =>
    extractDocSnippets(file, readFileSync(join(root, file), "utf8")),
  );
  const findings = checkDocSnippets(snippets, root);
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: TS${finding.code} ${finding.message}`);
  }
  if (findings.length > 0) {
    console.error(
      `\n${findings.length} doc sample problem(s). Update the sample to the current SDK, or mark a deliberate non-compiling sample with "${SKIP_MARKER}" on the line before its fence.`,
    );
    process.exit(1);
  }
  console.log(
    `doc snippets: ${checkedSnippetCount} of ${snippets.length} TypeScript samples typecheck (the rest are excerpts that are not complete statements)`,
  );
}
