import { existsSync } from "node:fs";

type Finding = {
  file: string;
  line: number;
  token: string;
  reason: string;
};

const sourceRoots = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs",
  "apps",
  "packages",
  "agent",
  ".agents/skills",
];

const recordMarker = "<!-- docs-refs: record -->";
const ignoreMarker = "<!-- docs-refs: ignore -->";
const architecturePath = "docs/architecture.md";
const architectureMaxWords = 12_000;
const architectureMaxLineLength = 500;
const pathReferencePattern =
  /^(?:apps|packages|scripts|docs|deploy|agent|\.github|\.agents)\/[A-Za-z0-9_./-]+$/;
const packageReferencePattern = /@opengeni\/[a-z0-9-]+/g;
const inlineCodePattern = /`([^`\n]+)`/g;
const skippedPathFragments = ["*", "<", ">", "{", "$", "..."];
const externalPackageAllowlist = new Set<string>();

const [files, workspaceFiles] = await Promise.all([
  listFiles(sourceRoots),
  listFiles(["apps", "packages"]),
]);
const workspacePackages = await listWorkspacePackages(workspaceFiles);
const findings: Finding[] = [];

for (const file of files.filter(isCurrentTierDoc)) {
  const text = await Bun.file(file)
    .text()
    .catch(() => "");
  if (!text || hasRecordMarker(text)) {
    continue;
  }
  checkReferences(file, text, workspacePackages, findings);
}

const architectureText = await Bun.file(architecturePath)
  .text()
  .catch(() => "");
checkArchitectureMap(architectureText, workspaceFiles, findings);

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} — ${finding.token} (${finding.reason})`);
  }
  process.exit(1);
}

console.log("Docs reference freshness and architecture map guards passed.");

async function listWorkspacePackages(packageFiles: string[]): Promise<Set<string>> {
  const names = new Set<string>();
  for (const file of packageFiles) {
    if (!/^(?:apps|packages)\/[^/]+\/package\.json$/.test(file)) {
      continue;
    }
    const manifest = await Bun.file(file)
      .json()
      .catch(() => null);
    if (
      manifest &&
      typeof manifest === "object" &&
      "name" in manifest &&
      typeof manifest.name === "string"
    ) {
      names.add(manifest.name);
    }
  }
  return names;
}

function checkArchitectureMap(text: string, mapFiles: string[], out: Finding[]): void {
  if (!text) {
    out.push({
      file: architecturePath,
      line: 1,
      token: architecturePath,
      reason: "architecture map is missing or unreadable",
    });
    return;
  }

  const wordCount = text.match(/\S+/gu)?.length ?? 0;
  if (wordCount > architectureMaxWords) {
    out.push({
      file: architecturePath,
      line: 1,
      token: `${wordCount} words`,
      reason: `architecture orientation budget exceeds ${architectureMaxWords} words`,
    });
  }

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length <= architectureMaxLineLength) {
      continue;
    }
    out.push({
      file: architecturePath,
      line: index + 1,
      token: `${line.length} characters`,
      reason: `architecture line exceeds ${architectureMaxLineLength} characters`,
    });
  }

  const workspaceMapStart = text.indexOf("### 6.1 Applications");
  const workspaceMapEnd = text.indexOf("### 6.3 Rust agent and relay");
  if (workspaceMapStart < 0 || workspaceMapEnd < 0 || workspaceMapEnd <= workspaceMapStart) {
    out.push({
      file: architecturePath,
      line: 1,
      token: "§6 workspace map",
      reason: "architecture app/package map headings are missing or out of order",
    });
    return;
  }
  const workspaceMap = text.slice(workspaceMapStart, workspaceMapEnd);

  for (const manifest of mapFiles.filter((file) =>
    /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file),
  )) {
    const packagePath = manifest.slice(0, -"/package.json".length);
    if (workspaceMap.includes(`\`${packagePath}\``)) {
      continue;
    }
    out.push({
      file: architecturePath,
      line: 1,
      token: packagePath,
      reason: "workspace app/package is missing from the architecture map",
    });
  }
}

function checkReferences(
  file: string,
  text: string,
  knownWorkspacePackages: Set<string>,
  out: Finding[],
): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trimEnd().endsWith(ignoreMarker)) {
      continue;
    }
    const lineNumber = index + 1;
    const seen = new Set<string>();

    for (const rawToken of extractInlineCodeTokens(line)) {
      const token = rawToken.trim();
      const normalizedPath = normalizePathReference(token);
      if (
        normalizedPath &&
        shouldCheckPathReference(normalizedPath) &&
        !existsSync(normalizedPath)
      ) {
        addFinding(out, seen, {
          file,
          line: lineNumber,
          token,
          reason: `missing repo path ${normalizedPath}`,
        });
      }
    }

    for (const token of extractPackageReferences(line)) {
      if (!knownWorkspacePackages.has(token) && !externalPackageAllowlist.has(token)) {
        addFinding(out, seen, {
          file,
          line: lineNumber,
          token,
          reason: "unknown @opengeni workspace package",
        });
      }
    }
  }
}

function extractInlineCodeTokens(line: string): string[] {
  const tokens: string[] = [];
  inlineCodePattern.lastIndex = 0;
  for (const match of line.matchAll(inlineCodePattern)) {
    const token = match[1];
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function extractPackageReferences(line: string): string[] {
  const tokens: string[] = [];
  packageReferencePattern.lastIndex = 0;
  for (const match of line.matchAll(packageReferencePattern)) {
    const token = match[0];
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function normalizePathReference(token: string): string | null {
  if (skippedPathFragments.some((fragment) => token.includes(fragment))) {
    return null;
  }
  const withoutLineRef = token.replace(/:\d+$/, "");
  const normalized = withoutLineRef.replace(/\/+$/, "");
  if (!pathReferencePattern.test(normalized)) {
    return null;
  }
  return normalized;
}

function shouldCheckPathReference(token: string): boolean {
  return !skippedPathFragments.some((fragment) => token.includes(fragment));
}

function addFinding(out: Finding[], seen: Set<string>, finding: Finding): void {
  const key = `${finding.token}\0${finding.reason}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  out.push(finding);
}

function isCurrentTierDoc(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (
    normalized.startsWith(".changeset/") ||
    normalized.startsWith("docs/design/") ||
    /^CHANGELOG/i.test(normalized)
  ) {
    return false;
  }
  return (
    normalized === "README.md" ||
    normalized === "AGENTS.md" ||
    normalized === "CONTRIBUTING.md" ||
    /^docs\/[^/]+\.md$/.test(normalized) ||
    /^apps\/[^/]+\/README\.md$/.test(normalized) ||
    /^packages\/[^/]+\/README\.md$/.test(normalized) ||
    normalized === "agent/README.md" ||
    (normalized.startsWith(".agents/skills/") && normalized.endsWith(".md"))
  );
}

function hasRecordMarker(text: string): boolean {
  return text
    .split("\n")
    .slice(0, 10)
    .some((line) => line.includes(recordMarker));
}

async function listFiles(roots: string[]): Promise<string[]> {
  const existingRoots = roots.filter((root) => existsSync(root));
  if (existingRoots.length === 0) {
    return [];
  }
  const ripgrep = await runFileListCommand(["rg", "--files", ...existingRoots]);
  if (ripgrep !== null) {
    return normalizeFileList(ripgrep);
  }
  const git = await runFileListCommand(["git", "ls-files", "--", ...existingRoots]);
  if (git !== null) {
    return normalizeFileList(git);
  }
  throw new Error("Unable to list source files: neither rg nor git ls-files is available");
}

async function runFileListCommand(command: string[]): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}

function normalizeFileList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("/node_modules/"));
}
