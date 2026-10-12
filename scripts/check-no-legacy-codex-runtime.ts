import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";

/** Decision state retired by M3 PR4. The reset-redemption ledger is NOT here:
 * it remains the live, generation-fenced core claim/adopt/send/recovery ledger.
 * Public Codex types, aliases and historical event decoders are also retained. */
export const LEGACY_CODEX_IDENTIFIERS = [
  "codex_subscription_credentials",
  "codexSubscriptionCredentials",
  "codex_capacity_waiters",
  "codexCapacityWaiters",
  "codex_credential_leases",
  "codexCredentialLeases",
  "codex_rotation_settings",
  "codexRotationSettings",
  "organization_codex_rotation_settings",
  "organizationCodexRotationSettings",
  "codex_apps_settings",
  "codexAppsSettings",
  "workspace_codex_subscription_preferences",
  "workspaceCodexSubscriptionPreferences",
  "codex_turn_source_bindings",
  "codexTurnSourceBindings",
  "resolve_workspace_codex_subscription_source",
  "capture_legacy_codex_turn_sources",
] as const;

/** Exact declaration exceptions, never a directory- or file-wide permission.
 * Schema declarations and posture inventories retain deployed objects: PR4
 * removes runtime decisions, not tables, role contracts or historical SQL.
 * Only the codec-aware 0689 migration may read/decode the retired credentials. */
export const LEGACY_CODEX_EXCEPTIONS: Record<
  string,
  { declarations: readonly string[]; literals?: readonly string[]; reason: string }
> = {
  "packages/db/src/schema.ts": {
    declarations: [
      "codexSubscriptionCredentials",
      "workspaceCodexSubscriptionPreferences",
      "organizationCodexRotationSettings",
      "codexAppsSettings",
      "codexRotationSettings",
      "codexCredentialLeases",
      "codexCapacityWaiters",
      "codexResetRedemptionAttempts",
      "sessions",
    ],
    reason: "Historical schema/FK definitions remain; no table or column drops.",
  },
  "packages/db/src/runtime-posture.ts": {
    declarations: ["FORCE_RLS_TABLES", "RUNTIME_FULL_DML_TABLES", "RUNTIME_READ_ONLY_TABLES"],
    literals: [
      "resolve_workspace_codex_subscription_source(uuid, uuid)",
      "capture_legacy_codex_turn_sources(uuid, uuid)",
    ],
    reason: "Declarative deployed-schema RLS/privilege inventory, not provider decision queries.",
  },
  "packages/db/src/provision-roles.ts": {
    declarations: [],
    literals: [
      "resolve_workspace_codex_subscription_source(uuid,uuid)",
      "capture_legacy_codex_turn_sources(uuid,uuid)",
    ],
    reason:
      "Exact routine-signature inventory for deployed role grants, never an executable decision read.",
  },
  "packages/db/src/codex-subscription-core-cutover.ts": {
    declarations: ["moveCodexCredentials"],
    reason:
      "0689 migration codec stage decodes legacy rows before its atomic scrub/receipt; never a request fallback.",
  },
};

type Node = { type?: string; start?: number; end?: number; [key: string]: unknown };
function walk(node: unknown, visit: (node: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const record = node as Node;
  if (record.type) visit(record);
  for (const [key, value] of Object.entries(record)) if (key !== "parent") walk(value, visit);
}
function declarationName(node: any): string | undefined {
  const value = node.declaration ?? node;
  return value.id?.name ?? value.declarations?.[0]?.id?.name;
}

export type LegacyCodexFinding = { file: string; line: number; message: string };
export function checkLegacyCodexSource(file: string, source: string): LegacyCodexFinding[] {
  const result = parseSync(file, source);
  if (result.errors.length) return [{ file, line: 1, message: "Cannot parse runtime source" }];
  const findings: LegacyCodexFinding[] = [];
  const report = (offset: number, message: string) =>
    findings.push({ file, line: source.slice(0, offset).split("\n").length, message });
  // Ignore comments, but inspect identifiers AND strings/templates (including raw
  // SQL and dynamic table-name constants). Type imports do not bypass the guard.
  let executable = source;
  for (const comment of [...result.comments].sort((a, b) => b.start - a.start)) {
    executable =
      executable.slice(0, comment.start) +
      " ".repeat(comment.end - comment.start) +
      executable.slice(comment.end);
  }
  const inventoryLiterals: Array<{ start: number; end: number }> = [];
  walk(result.program, (node) => {
    if (
      node.type === "Literal" &&
      typeof node.value === "string" &&
      LEGACY_CODEX_EXCEPTIONS[file]?.literals?.includes(node.value)
    ) {
      inventoryLiterals.push({ start: node.start!, end: node.end! });
    }
  });
  for (const identifier of LEGACY_CODEX_IDENTIFIERS) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${identifier}(?![A-Za-z0-9_])`, "g");
    for (const match of executable.matchAll(pattern)) {
      const statement = result.program.body.find(
        (node) => node.start <= match.index && node.end > match.index,
      );
      const name = statement && declarationName(statement);
      if (name && LEGACY_CODEX_EXCEPTIONS[file]?.declarations.includes(name)) continue;
      if (inventoryLiterals.some((range) => range.start <= match.index && range.end > match.index))
        continue;
      report(match.index, `Retired Codex decision state ${identifier}${name ? ` in ${name}` : ""}`);
    }
  }
  walk(result.program, (node) => {
    // Production cannot smuggle the historical test fixtures back into a
    // runtime via import, export-from, require or dynamic import.
    if (node.type !== "Literal" || typeof node.value !== "string") return;
    const value = node.value;
    if (
      /(?:^|\/)(?:legacy-codex(?:-[a-z-]+)?|legacy-subscription-world)(?:\/|$|\.[cm]?[jt]s)/.test(
        value,
      ) &&
      /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/.test(value) &&
      /(?:^\.|^@opengeni\/|^\/workspace\/)/.test(value)
    ) {
      report(node.start ?? 0, "Runtime source references test-only code");
    }
    if (/codex-(?:rotation|fleet-shadow)(?:\.[cm]?[jt]s)?$/.test(value)) {
      report(node.start ?? 0, "Runtime references a deleted Codex producer");
    }
  });
  return findings;
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "build", ".git", "test", "tests"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path)
      : /\.[cm]?[jt]sx?$/.test(path) && !/\.(?:test|e2e|integration)\./.test(path)
        ? [path]
        : [];
  });
}
export function checkNoLegacyCodexRuntime(root: string): LegacyCodexFinding[] {
  return ["apps", "packages", "scripts"]
    .flatMap((dir) => files(join(root, dir)))
    .flatMap((path) => {
      const file = relative(root, path);
      if (file === "scripts/check-no-legacy-codex-runtime.ts") return [];
      return checkLegacyCodexSource(file, readFileSync(path, "utf8"));
    });
}
if (import.meta.main) {
  const findings = checkNoLegacyCodexRuntime(process.cwd());
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  if (findings.length) process.exitCode = 1;
  else
    console.log(
      "No executable legacy Codex decision-state access; exact schema/posture/0689 exceptions only. Reset-redemption ledger remains live.",
    );
}
