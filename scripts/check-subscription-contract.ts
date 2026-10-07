import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSync } from "oxc-parser";

import {
  discoverTestFiles,
  E2E_TEST_PATTERN,
  INTEGRATION_TEST_PATTERN,
  OPT_IN_TESTS,
  UNIT_TEST_PATTERN,
} from "./ci/workspace";

/**
 * Keeps docs/subscription-accounts.md honest: every requirement ID has a
 * verification line, verified requirements are named by the tests that claim
 * them, and no test claims a requirement the contract does not define.
 */

export const CONTRACT_PATH = "docs/subscription-accounts.md";
// Bounded on both sides: SUB-SEL-012 and XSUB-SEL-01 are not SUB-SEL-01.
const ID_PATTERN = /(?<![A-Z0-9-])SUB-[A-Z]+-\d{2}(?!\d)/g;
const DEFINITION_PATTERN = /^- \*\*(SUB-[A-Z]+-\d{2})\*\*/;
const PENDING_PATTERN = /^pending \(([a-z][a-z0-9-]*)\)\.?$/;
const WORK_ITEM_ROW = /^\| `([a-z][a-z0-9-]*)` \|/;
const SELF_TEST = "scripts/check-subscription-contract.test.ts";
/** Test-defining calls whose first string argument is a title. */
const TITLE_CALLS = new Set(["test", "it", "describe"]);
/** Modifiers that never run the test body, so their titles verify nothing. */
const NOT_RUN_MODIFIERS = new Set(["skip", "todo"]);

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

function isTestFile(path: string): boolean {
  return (
    UNIT_TEST_PATTERN.test(path) ||
    INTEGRATION_TEST_PATTERN.test(path) ||
    E2E_TEST_PATTERN.test(path)
  );
}

/**
 * Every unit, integration and end-to-end test file, discovered the same way CI
 * discovers them (apps, packages, scripts, examples and the root `test/`
 * tree), plus the opt-in tests CI runs only in dedicated gates.
 */
export function listTestFiles(root: string): string[] {
  const discovered = discoverTestFiles(root);
  const optIn = Object.keys(OPT_IN_TESTS).filter((path) => existsSync(join(root, path)));
  return [
    ...new Set([...discovered.unit, ...discovered.integration, ...discovered.e2e, ...optIn]),
  ].sort();
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

type AstNode = Record<string, unknown> & { type?: string };

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const record = node as AstNode;
  if (typeof record.type === "string") visit(record);
  for (const key of Object.keys(record)) {
    if (key !== "parent") walk(record[key], visit);
  }
}

/**
 * Whether a callee is `test`, `it` or `describe`, optionally with modifiers
 * (`test.only`, `test.each([...])`, `describe.if(...)`), but not one that is
 * skipped or a placeholder (`test.skip`, `test.todo`).
 */
function isTitledTestCall(callee: unknown): boolean {
  let current = callee as AstNode | undefined;
  while (current && (current.type === "MemberExpression" || current.type === "CallExpression")) {
    if (current.type === "MemberExpression") {
      const property = current.property as AstNode | undefined;
      if (property?.type === "Identifier" && NOT_RUN_MODIFIERS.has(property.name as string)) {
        return false;
      }
      current = current.object as AstNode;
    } else {
      current = current.callee as AstNode;
    }
  }
  return current?.type === "Identifier" && TITLE_CALLS.has(current.name as string);
}

/**
 * The titles of a test file: the first argument of every `test(`, `it(` and
 * `describe(` call when it is a string or template literal. Comments, fixture
 * strings and other code never count as a title.
 */
export function testTitles(path: string, source: string): string[] {
  const titles: string[] = [];
  walk(parseSync(path, source).program, (node) => {
    if (node.type !== "CallExpression" || !isTitledTestCall(node.callee)) return;
    const title = (node.arguments as AstNode[] | undefined)?.[0];
    if (title?.type === "Literal" && typeof title.value === "string") titles.push(title.value);
    else if (title?.type === "TemplateLiteral") {
      // Interpolations are unknown at check time; never let an ID span one.
      const quasis = title.quasis as { value: { cooked?: string | null; raw: string } }[];
      titles.push(quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("\n"));
    }
  });
  return titles;
}

function titlesName(titles: readonly string[], id: string): boolean {
  return titles.some((title) => [...title.matchAll(ID_PATTERN)].some((match) => match[0] === id));
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
  const titleCache = new Map<string, string[]>();
  const titlesOf = (path: string) => {
    let titles = titleCache.get(path);
    if (!titles) {
      titles = testTitles(path, readFileSync(join(root, path), "utf8"));
      titleCache.set(path, titles);
    }
    return titles;
  };
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
      if (!isTestFile(path) || !existsSync(testFile)) {
        findings.push({
          file: CONTRACT_PATH,
          line: requirement.line,
          message: requirement.id + " names a test file that does not exist: " + path,
        });
      } else if (!titlesName(titlesOf(path), requirement.id)) {
        findings.push({
          file: path,
          line: 1,
          message: "does not name " + requirement.id + " in any test title",
        });
      }
    }
  }
  for (const path of listTestFiles(root)) {
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
