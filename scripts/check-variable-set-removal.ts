// Variable Sets became vaults (SDK 2.0.0). This guard keeps the removed client
// surface from coming back in product code: SDK methods, React hooks, the old
// `/variable-sets` routes as client calls, and the deleted picker modules.
// Tests may still name them (to assert they are gone); the API keeps its own
// 410 handlers and legacy-field 422s, which live outside the scanned roots.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SCANNED_ROOTS = [
  "apps/web/src",
  "apps/mobile/src",
  "apps/mobile/app",
  "packages/sdk/src",
  "packages/react/src",
  "packages/react-native/src",
  "examples",
];
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage"]);
const EXTENSIONS = new Set([".ts", ".tsx"]);

export type RemovalRule = { name: string; pattern: RegExp };

export const REMOVAL_RULES: readonly RemovalRule[] = [
  {
    name: "removed Variable Set SDK method or React hook",
    pattern:
      /\b(listVariableSets|getVariableSet|createVariableSet|updateVariableSet|deleteVariableSet|setVariableSetVariable|deleteVariableSetVariable|updateSessionVariableSets|useVariableSets|useVariableSet|useEnvironments)\b/,
  },
  {
    name: "client call to a removed /variable-sets or /environments route",
    pattern: /["'`]\/v1\/workspaces\/[^"'`\n]*\/(variable-sets|environments)\b/,
  },
  {
    name: "import of a deleted Variable Set picker module",
    pattern:
      /from\s+["'][^"']*(variable-set-shortlist|session-variable-set-picker|new-session-variable-set-picker|selected-variable-set-list|components\/variable-sets\/|hooks\/use-environments)["']/,
  },
];

function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.tsx?$/.test(path);
}

async function walk(dir: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await walk(path, files);
    } else if (EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) {
      files.push(path);
    }
  }
}

/** Every `file: rule` violation under the scanned roots of `root`. */
export async function findVariableSetRemovalViolations(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const scanned of SCANNED_ROOTS) await walk(join(root, scanned), files);
  const failures: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (isTestFile(rel)) continue;
    const text = await readFile(file, "utf8");
    for (const rule of REMOVAL_RULES) {
      if (rule.pattern.test(text)) failures.push(`${rel}: ${rule.name}`);
    }
  }
  return failures.sort();
}

if (import.meta.main) {
  const failures = await findVariableSetRemovalViolations(process.cwd());
  if (failures.length > 0) {
    console.error("Variable Set removal guard failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("Variable Set removal guard passed.");
}
