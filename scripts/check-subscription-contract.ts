import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Keeps docs/subscription-accounts.md honest: every requirement ID has a
 * verification line, verified requirements are named by the tests that claim
 * them, and no test claims a requirement the contract does not define.
 */

export const CONTRACT_PATH = "docs/subscription-accounts.md";
const ID_PATTERN = /SUB-[A-Z]+-\d{2}/g;
const DEFINITION_PATTERN = /^- \*\*(SUB-[A-Z]+-\d{2})\*\*/;
const PENDING_PATTERN = /^pending \(([a-z][a-z0-9-]*)\)\.?$/;
const WORK_ITEM_ROW = /^\| `([a-z][a-z0-9-]*)` \|/;
const TEST_ROOTS = ["apps", "packages", "scripts", "examples"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);
const SELF_TEST = "scripts/check-subscription-contract.test.ts";

export type ContractRequirement = {
  id: string;
  line: number;
  verification: { kind: "pending"; workItem: string } | { kind: "tests"; paths: string[] } | null;
};

export type ContractFinding = { file: string; line: number; message: string };

export function parseContract(markdown: string): ContractRequirement[] {
  const lines = markdown.split("\n");
  const requirements: ContractRequirement[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = DEFINITION_PATTERN.exec(lines[index]!);
    if (!match) continue;
    // A list item continues on indented lines until a blank line or the next item.
    const itemLines = [lines[index]!];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]!;
      if (!line.trim() || line.startsWith("- ") || line.startsWith("#")) break;
      itemLines.push(line.trim());
    }
    const text = itemLines.join(" ");
    const marker = text.lastIndexOf("Verification:");
    let verification: ContractRequirement["verification"] = null;
    if (marker >= 0) {
      const value = text.slice(marker + "Verification:".length).trim();
      const pending = PENDING_PATTERN.exec(value);
      if (pending) {
        verification = { kind: "pending", workItem: pending[1]! };
      } else {
        const paths = [...value.matchAll(/`([^`]+)`/g)].map((path) => path[1]!);
        if (paths.length > 0) verification = { kind: "tests", paths };
      }
    }
    requirements.push({ id: match[1]!, line: index + 1, verification });
  }
  return requirements;
}

function listTestFiles(root: string, directory: string, files: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) listTestFiles(root, path, files);
    else if (/\.test\.tsx?$/.test(entry)) files.push(relative(root, path));
  }
}

/** Work item names declared in the contract's "Work items" table. */
export function parseWorkItems(markdown: string): Set<string> {
  const items = new Set<string>();
  let inSection = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) inSection = line.trim() === "## Work items";
    else if (inSection) {
      const match = WORK_ITEM_ROW.exec(line);
      if (match) items.add(match[1]!);
    }
  }
  return items;
}

export function checkSubscriptionContract(root: string): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const contractFile = join(root, CONTRACT_PATH);
  if (!existsSync(contractFile)) {
    return [{ file: CONTRACT_PATH, line: 1, message: "contract document is missing" }];
  }
  const markdown = readFileSync(contractFile, "utf8");
  const requirements = parseContract(markdown);
  const workItems = parseWorkItems(markdown);
  if (requirements.length === 0) {
    findings.push({ file: CONTRACT_PATH, line: 1, message: "no requirement IDs found" });
  }
  const defined = new Map<string, ContractRequirement>();
  for (const requirement of requirements) {
    if (defined.has(requirement.id)) {
      findings.push({
        file: CONTRACT_PATH,
        line: requirement.line,
        message: requirement.id + " is defined more than once",
      });
    }
    defined.set(requirement.id, requirement);
    if (!requirement.verification) {
      findings.push({
        file: CONTRACT_PATH,
        line: requirement.line,
        message:
          requirement.id +
          " needs 'Verification: pending (<work item>).' or a list of backticked test files",
      });
      continue;
    }
    if (requirement.verification.kind === "pending") {
      if (!workItems.has(requirement.verification.workItem)) {
        findings.push({
          file: CONTRACT_PATH,
          line: requirement.line,
          message:
            requirement.id + " names an unknown work item: " + requirement.verification.workItem,
        });
      }
      continue;
    }
    for (const path of requirement.verification.paths) {
      const testFile = join(root, path);
      if (!/\.test\.tsx?$/.test(path) || !existsSync(testFile)) {
        findings.push({
          file: CONTRACT_PATH,
          line: requirement.line,
          message: requirement.id + " names a test file that does not exist: " + path,
        });
      } else if (!readFileSync(testFile, "utf8").includes(requirement.id)) {
        findings.push({
          file: path,
          line: 1,
          message: "does not name " + requirement.id + " in any test title",
        });
      }
    }
  }
  const testFiles: string[] = [];
  for (const testRoot of TEST_ROOTS) listTestFiles(root, join(root, testRoot), testFiles);
  for (const path of testFiles) {
    if (path === SELF_TEST) continue;
    const lines = readFileSync(join(root, path), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(ID_PATTERN)) {
        if (!defined.has(match[0])) {
          findings.push({
            file: path,
            line: index + 1,
            message: match[0] + " is not defined in " + CONTRACT_PATH,
          });
        }
      }
    });
  }
  return findings;
}

if (import.meta.main) {
  const findings = checkSubscriptionContract(process.cwd());
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(finding.file + ":" + finding.line + " " + finding.message);
    }
    process.exit(1);
  }
  console.log("Subscription contract requirements and test references are consistent.");
}
