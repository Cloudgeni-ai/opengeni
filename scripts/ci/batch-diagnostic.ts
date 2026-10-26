import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * Structured evidence for a failed Batch CI check: which check failed, the
 * tracked repository files its output names, and the first error line. The
 * merge batcher uses it only to attribute a failure to the one batch member
 * whose diff touches those files; it never makes a result green.
 */
export type BatchDiagnostic = { check: string; paths: string[]; excerpt: string };

const MAX_PATHS = 50;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const CHECK = /^[a-z0-9][a-z0-9:_.-]{0,63}$/;

export function safeRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !isAbsolute(path) &&
    !/[\u0000-\u001f]/.test(path) &&
    !path.split("/").some((part) => part === ".." || part === "." || part === "") &&
    !path.startsWith("node_modules/")
  );
}

/** Extract the named tracked files from one failed check's output. */
export function extractDiagnostic(
  check: string,
  output: string,
  root: string,
  isFile: (path: string) => boolean = (path) => {
    const absolute = join(root, path);
    return existsSync(absolute) && statSync(absolute).isFile();
  },
): BatchDiagnostic {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    // Command echoes and passing-project lines name tools, not failures.
    .filter((line) => !/^\s*\$ /.test(line) && !/^\[typecheck\] ok\b/.test(line));
  const paths = new Set<string>();
  let named: string | null = null;
  const add = (candidate: string): boolean => {
    let path = candidate;
    if (isAbsolute(path)) {
      const inside = relative(root, path);
      if (inside.startsWith("..") || isAbsolute(inside)) return false;
      path = inside;
    }
    path = normalize(path).replace(/^\.\//, "");
    if (!safeRepositoryPath(path) || !isFile(path)) return false;
    if (paths.size < MAX_PATHS) paths.add(path);
    return true;
  };
  for (const line of lines) {
    let found = false;
    // Changesets names the changeset, not its file.
    for (const match of line.matchAll(/\bFound (?:mixed )?changeset ([\w.-]+)/g))
      found = add(`.changeset/${match[1]}.md`) || found;
    for (const match of line.matchAll(
      /(?:^|[\s"'`([,=<])((?:\/|\.\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.[\w-]+)(?=$|[\s"'`(),\]:;>])/g,
    ))
      found = add(match[1]!) || found;
    if (found) named ??= line;
  }
  const excerpt =
    named ??
    lines.find((text) => /\berror\b|\bfail(ed|ure)?\b/i.test(text)) ??
    lines.find((text) => text.trim()) ??
    "";
  return { check, paths: [...paths].sort(), excerpt: excerpt.trim().slice(0, 300) };
}

/**
 * Diagnose a failed batch-source step from its output tail. The guard runner
 * runs several guards in one step; only the section of the last one counts.
 */
export function diagnoseStep(
  step: string,
  tail: string,
  root: string,
  isFile?: (path: string) => boolean,
): BatchDiagnostic {
  const guard = step === "guards" ? [...tail.matchAll(/^\[guard\] (\S+)$/gm)].at(-1) : null;
  if (!guard) return extractDiagnostic(step, tail, root, isFile);
  return extractDiagnostic(
    `guard:${guard[1]}`,
    tail.slice(guard.index! + guard[0].length),
    root,
    isFile,
  );
}

/** Validate untrusted diagnostic JSON; malformed evidence is simply absent. */
export function parseDiagnostic(raw: unknown): BatchDiagnostic | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.check !== "string" ||
    !CHECK.test(value.check) ||
    !Array.isArray(value.paths) ||
    value.paths.length > MAX_PATHS ||
    value.paths.some((path) => typeof path !== "string" || !safeRepositoryPath(path)) ||
    typeof value.excerpt !== "string"
  )
    return null;
  return {
    check: value.check,
    paths: [...new Set(value.paths as string[])].sort(),
    excerpt: value.excerpt.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300),
  };
}

/** Record a failed check for the enclosing batch task receipt, if requested. */
export function writeDiagnostic(
  diagnostic: BatchDiagnostic,
  file = process.env.BATCH_DIAGNOSTIC_FILE,
): void {
  if (!file) return;
  let merged = diagnostic;
  try {
    const previous = parseDiagnostic(JSON.parse(readFileSync(file, "utf8")));
    if (previous?.check === diagnostic.check)
      merged = {
        ...previous,
        paths: [...new Set([...previous.paths, ...diagnostic.paths])].sort().slice(0, MAX_PATHS),
      };
  } catch {
    // No previous diagnostic for this task.
  }
  writeFileSync(file, JSON.stringify(merged) + "\n");
}
