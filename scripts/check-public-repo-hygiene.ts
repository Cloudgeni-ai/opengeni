import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { lstat, readlink } from "node:fs/promises";
import {
  catalogMcpUrlRejection,
  normalizeCatalogSnapshot,
  readSnapshotFile,
} from "./import-integrations-catalog";

type Finding = { file: string; line?: number; reason: string };

const GENERIC_HOME_NAMES = new Set([
  "app",
  "me",
  "node",
  "root",
  "runner",
  "u",
  "ubuntu",
  "user",
  "username",
]);
const RAW_EVIDENCE_EXTENSIONS = new Set([
  ".avi",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".tif",
  ".tiff",
  ".wav",
  ".webm",
  ".zip",
]);
const PERSONAL_MAIL =
  /\b[A-Z0-9._%+-]+@(?:fastmail|gmail|googlemail|hey|hotmail|icloud|live|mac|me|outlook|protonmail|proton|yahoo)\.(?:com|me|net|org|[A-Z]{2})\b/gi;
const HOME_PATH = /\/(?:home|Users)\/([A-Za-z0-9._-]+)(?=\/|[^A-Za-z0-9._-]|$)/g;
const PERSONAL_DEVICE = new RegExp(
  ["\\bjor", "gen?-(?:desktop|laptop|macbook|mbp|workstation)\\b"].join(""),
  "gi",
);
const PERSONAL_NAME = new RegExp(["\\bjor", "ge\\b", "|\\bJ", "\\u00f8", "rgen\\b"].join(""), "gi");
const PRIVATE_AGENT_DOC = /\.agent\/[A-Z0-9_./-]+\.md\b/gi;
const PRIVATE_WORKTREE_PATH = /\.claude\/worktrees\//gi;
const PRIVATE_ISSUE_REFERENCE = /\bcloudgeni\s+#\d+\b/gi;
const INTERNAL_ISSUE_REFERENCE = new RegExp(
  ["(?<![A-Za-z0-9])OPE", "(?:[-_ ]?\\d+)(?=[A-Z_a-z-]|\\b)"].join(""),
  "gi",
);
const INTERNAL_WORK_LABEL = /\b(?:SPIKE|BUG|FORK)[-_ ]?\d+(?=[A-Z_a-z-]|\b)/gi;
const RETIRED_MILESTONE_LABEL = new RegExp(
  ["\\b(?:P4", "a|M", "12|F", "18|I", "8)\\b"].join(""),
  "gi",
);
const PRIVATE_PROJECT_CODENAME = new RegExp(["\\bpelo", "ton\\b"].join(""), "gi");
const RETIRED_DESIGN_RECORD_TERM = new RegExp(["\\bdos", "sier\\b"].join(""), "gi");
const RETIRED_DESIGN_RECORD_PATH = new RegExp(
  [
    "docs/design/sandbox",
    "-surfacing(?:/[a-z0-9._/-]+)?",
    "|modules/(?:0[1-9]|10)-[a-z0-9-]+\\.md",
    "|05-addendum-shared-",
    "sandboxes\\.md",
    "|design/desktop-",
    "hibernation\\.md",
    "|(?:packages/react/)?scripts/m\\d+(?:-[a-z0-9-]+)?\\.mjs",
  ].join(""),
  "gi",
);
const MACHINE_NIX_STORE_PATH = /\/nix\/store\/[a-z0-9]{20,}-/gi;
const LEGACY_MIGRATION_REFERENCE_ALLOWLIST = new Set([
  "packages/db/drizzle/0017_sandbox_leases.sql",
  "packages/db/drizzle/0018_sandbox_os.sql",
  "packages/db/drizzle/0019_session_stream_acknowledgments.sql",
  "packages/db/drizzle/0020_session_recordings.sql",
  "packages/db/drizzle/0021_sandbox_pty_sessions.sql",
  "packages/db/drizzle/0024_sandboxes_enrollments_metrics.sql",
  "packages/db/drizzle/0025_device_enrollment_requests.sql",
  "packages/db/drizzle/0045_workspace_captures.sql",
  "packages/db/drizzle/0053_codex_credential_leases.sql",
  "packages/db/drizzle/0057_durable_queue_control.sql",
  "packages/db/drizzle/0061_session_workflow_wake_outbox.sql",
  "packages/db/drizzle/0062_session_list_snapshot_reaper.sql",
  "packages/db/drizzle/0063_session_control_mega_foundation.sql",
  "packages/db/drizzle/0064_rotation_strategy_sharded_backfill.sql",
  "packages/db/drizzle/0067_session_event_payload_bounds.sql",
  "packages/db/drizzle/0068_workspace_control_event_bounds.sql",
  "packages/db/drizzle/0069_session_event_history_backfill.sql",
  "packages/db/drizzle/0074_session_activity_revisions.sql",
]);
const CATALOG_SNAPSHOT = "data/catalog/integrations-snapshot.json";
const PUBLIC_FITNESS_DOMAIN = ["one", "pelo", "ton", ".com"].join("");
const PUBLIC_FITNESS_NAME = ["Pelo", "ton"].join("");

export function auditPublicText(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  collectMatches(file, source, PERSONAL_MAIL, "personal email address", findings);
  collectMatches(file, source, PRIVATE_WORKTREE_PATH, "private worktree path", findings);
  collectMatches(file, source, PRIVATE_ISSUE_REFERENCE, "private issue reference", findings);
  collectMatches(file, source, INTERNAL_WORK_LABEL, "internal work label", findings);
  collectMatches(file, source, RETIRED_MILESTONE_LABEL, "retired milestone label", findings);
  collectMatches(file, source, MACHINE_NIX_STORE_PATH, "machine-specific Nix store path", findings);
  collectMatches(file, source, PERSONAL_NAME, "personal name", findings);
  if (!LEGACY_MIGRATION_REFERENCE_ALLOWLIST.has(file)) {
    collectMatches(
      file,
      source,
      RETIRED_DESIGN_RECORD_PATH,
      "retired internal design-record path",
      findings,
    );
  }

  if (!LEGACY_MIGRATION_REFERENCE_ALLOWLIST.has(file)) {
    collectMatches(file, source, INTERNAL_ISSUE_REFERENCE, "internal issue reference", findings);
    collectMatches(file, source, PRIVATE_AGENT_DOC, "private .agent document reference", findings);
    collectMatches(
      file,
      source,
      RETIRED_DESIGN_RECORD_TERM,
      "retired internal design-record terminology",
      findings,
    );
  }

  PRIVATE_PROJECT_CODENAME.lastIndex = 0;
  for (const match of source.matchAll(PRIVATE_PROJECT_CODENAME)) {
    if (file === CATALOG_SNAPSHOT && isAllowedPublicCatalogReference(source, match.index ?? 0)) {
      continue;
    }
    findings.push({
      file,
      line: lineAt(source, match.index ?? 0),
      reason: "private project codename",
    });
  }

  HOME_PATH.lastIndex = 0;
  for (const match of source.matchAll(HOME_PATH)) {
    const account = match[1]?.toLowerCase();
    if (!account || GENERIC_HOME_NAMES.has(account)) continue;
    findings.push({
      file,
      line: lineAt(source, match.index ?? 0),
      reason: "non-generic home path",
    });
  }
  PERSONAL_DEVICE.lastIndex = 0;
  for (const match of source.matchAll(PERSONAL_DEVICE)) {
    findings.push({
      file,
      line: lineAt(source, match.index ?? 0),
      reason: "personal device label",
    });
  }
  return findings;
}

export function auditSymlinkTarget(file: string, target: string): Finding[] {
  const findings = auditPublicText(file, target);
  if (isAbsolute(target)) {
    findings.push({ file, reason: "absolute symlink target" });
  } else {
    const repositoryRoot = resolve(".");
    const resolvedTarget = resolve(dirname(resolve(repositoryRoot, file)), target);
    const repositoryRelativeTarget = relative(repositoryRoot, resolvedTarget);
    if (
      repositoryRelativeTarget === ".." ||
      repositoryRelativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(repositoryRelativeTarget)
    ) {
      findings.push({ file, reason: "symlink target escapes repository" });
    }
  }
  return findings;
}

export function auditCatalogSnapshot(snapshot: unknown): Finding[] {
  const file = CATALOG_SNAPSHOT;
  const findings: Finding[] = [];
  const root = recordValue(snapshot);
  const skipped = Array.isArray(root?.skipped) ? root.skipped : [];

  for (const entry of skipped) {
    const diagnostic = recordValue(entry);
    if (diagnostic?.mcpUrl !== null) {
      findings.push({ file, reason: "rejected catalog diagnostic retains an MCP URL" });
    }
  }

  visit(snapshot, (key, value) => {
    if (key !== "mcpUrl" || typeof value !== "string") return;
    const rejection = catalogMcpUrlRejection(value);
    if (rejection) {
      findings.push({ file, reason: `persisted catalog MCP URL rejected for ${rejection}` });
    }
  });

  // Hygiene audits URL safety and retained output. Probe evidence is a runtime
  // import-admission concern and older committed snapshots may predate it.
  const normalized = normalizeCatalogSnapshot(
    { importRows: root?.importRows ?? [] },
    { allowUnprobedCandidates: true },
  );
  for (const rejected of normalized.skipped) {
    if (catalogAdmissionOnlyReason(rejected.reason)) continue;
    findings.push({ file, reason: `catalog import row rejected for ${rejected.reason}` });
  }
  for (const quarantined of normalized.quarantined) {
    findings.push({
      file,
      reason: `catalog import row requires quarantine for ${quarantined.row.domain}`,
    });
  }
  return findings;
}

function catalogAdmissionOnlyReason(reason: string): boolean {
  return (
    reason === "auth_unknown" ||
    reason === "api_key_metadata_unactionable" ||
    reason === "duplicate_surface" ||
    reason === "duplicate_domain_name" ||
    reason === "duplicate_endpoint" ||
    reason.startsWith("probe_")
  );
}

export async function auditPublicRepository(): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const file of await gitFiles(["ls-files", "-ci", "--exclude-standard", "-z"])) {
    findings.push({ file, reason: "tracked file is ignored by .gitignore" });
  }

  const indexModes = await gitIndexModes();
  for (const file of await gitFiles(["diff", "--cached", "--name-only", "-z"])) {
    const mode = indexModes.get(file);
    if (!mode) continue;
    findings.push(...auditPublicText(file, file));
    const bytes = await gitIndexBlob(file);
    const source = new TextDecoder().decode(bytes);
    if (mode === "120000") {
      findings.push(...auditSymlinkTarget(file, source));
      continue;
    }
    if (bytes.includes(0)) continue;
    findings.push(...auditPublicText(file, source));
    if (file === CATALOG_SNAPSHOT) {
      try {
        findings.push(...auditCatalogSnapshot(JSON.parse(source)));
      } catch {
        findings.push({ file, reason: "staged catalog snapshot is not valid JSON" });
      }
    }
  }

  const files = await gitFiles(["ls-files", "-co", "--exclude-standard", "-z"]);
  for (const file of files) {
    findings.push(...auditPublicText(file, file));
    const stats = await lstat(file).catch(() => null);
    const extension = extname(file).toLowerCase();
    if (file.startsWith("docs/design/") && RAW_EVIDENCE_EXTENSIONS.has(extension)) {
      findings.push({ file, reason: "raw evidence media belongs in private artifact storage" });
      continue;
    }
    if (!stats) continue;
    if (stats.isSymbolicLink()) {
      findings.push(...auditSymlinkTarget(file, await readlink(file)));
      continue;
    }
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    if (bytes.includes(0)) continue;
    findings.push(...auditPublicText(file, new TextDecoder().decode(bytes)));
  }

  const snapshotPath = "data/catalog/integrations-snapshot.json";
  findings.push(...auditCatalogSnapshot(await readSnapshotFile(snapshotPath)));
  return findings;
}

function isAllowedPublicCatalogReference(source: string, index: number): boolean {
  const objectSource = enclosingJsonObject(source, index);
  if (!objectSource) return false;
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(objectSource) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (row.domain !== PUBLIC_FITNESS_DOMAIN) return false;

  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  const line = source.slice(start, end < 0 ? source.length : end);
  const field = /^\s*"([^"]+)"\s*:\s*("(?:\\.|[^"])*")\s*,?\s*$/.exec(line);
  if (!field) return false;
  const key = field[1];
  const value = JSON.parse(field[2]!) as string;
  if (key === "domain") return value === PUBLIC_FITNESS_DOMAIN;
  if (key === "name") return value === PUBLIC_FITNESS_NAME;
  if (key === "mcpUrl") return value === `https://${PUBLIC_FITNESS_DOMAIN}/mcp`;
  if (key !== "logoSourceUrl") return false;
  try {
    const logo = new URL(value);
    return logo.protocol === "https:" && logo.pathname.split("/").includes(PUBLIC_FITNESS_DOMAIN);
  } catch {
    return false;
  }
}

function enclosingJsonObject(source: string, index: number): string | null {
  const stack: number[] = [];
  let inString = false;
  let escaped = false;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    const character = source[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") stack.push(cursor);
    else if (character === "}") stack.pop();
  }
  const start = stack.at(-1);
  if (start === undefined) return null;

  let depth = 0;
  inString = false;
  escaped = false;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, cursor + 1);
    }
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function visit(value: unknown, inspect: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, inspect);
    return;
  }
  const record = recordValue(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    inspect(key, entry);
    visit(entry, inspect);
  }
}

async function gitFiles(args: string[]): Promise<string[]> {
  const process = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.split("\0").filter(Boolean);
}

async function gitIndexModes(): Promise<Map<string, string>> {
  const process = Bun.spawn(["git", "ls-files", "-s", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ls-files -s failed: ${stderr.trim()}`);
  const modes = new Map<string, string>();
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const match = /^(\d+) [0-9a-f]+ \d+\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error(`unexpected git ls-files entry for public hygiene`);
    modes.set(match[2]!, match[1]!);
  }
  return modes;
}

async function gitIndexBlob(file: string): Promise<Uint8Array> {
  const process = Bun.spawn(["git", "show", `:${file}`], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git show :${file} failed: ${stderr.trim()}`);
  return new Uint8Array(stdout);
}

function collectMatches(
  file: string,
  source: string,
  pattern: RegExp,
  reason: string,
  findings: Finding[],
): void {
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    findings.push({ file, line: lineAt(source, match.index ?? 0), reason });
  }
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

if (import.meta.main) {
  const findings = await auditPublicRepository();
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}${finding.line ? `:${finding.line}` : ""} — ${finding.reason}`);
    }
    process.exit(1);
  }
  console.log("Public repository hygiene guard passed.");
}
