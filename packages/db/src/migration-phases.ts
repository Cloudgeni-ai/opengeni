/** Shared, side-effect-free migration phase contract for the runner and lint. */
import { splitStatements, stripComments } from "./migration-sql";
export type MigrationPhase = "pre" | "maintenance" | "post";
export type MigrationDeploymentMode = "historical" | "rolling" | "maintenance" | "unclassified";
export type MigrationPhases = Record<MigrationPhase, string[]>;

/** A conservative posture classification, not a general rolling-safety proof.
 * Unknown/dynamic statements stay in the maintenance span rather than guessing.
 * TODO(OPE-834): relax only after forward-compatible readiness is deployed as
 * the OLD production binary; shipping it in the same release is not sufficient.
 */
export function ordinaryMigrationIsPostureInert(sqlText: string): boolean {
  const postureChange =
    /\b(?:CREATE\s+(?:(?:OR\s+REPLACE|UNLOGGED|TEMP(?:ORARY)?)\s+)?(?:TABLE|FUNCTION|PROCEDURE|SCHEMA|VIEW|MATERIALIZED\s+VIEW)|GRANT|REVOKE|ALTER\b[\s\S]*?\bOWNER|ROW\s+LEVEL\s+SECURITY|(?:CREATE|ALTER|DROP)\s+POLICY|ALTER\s+DEFAULT\s+PRIVILEGES|SECURITY\s+DEFINER|DROP\s+(?:FUNCTION|PROCEDURE|TABLE))\b/i;
  return splitStatements(sqlText).every((statement) => {
    const text = stripComments(statement).trim();
    if (!text) return true;
    if (postureChange.test(text)) return false;
    // DO/CALL/EXECUTE and unknown statement forms may hide dynamic DDL. They
    // are intentionally not admitted even if no literal posture keyword occurs.
    return /^(?:ALTER\s+(?:TABLE|INDEX)|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|INSERT|UPDATE|DELETE|SELECT|WITH|SET|RESET)\b/i.test(
      text,
    );
  });
}

export function migrationDeploymentMode(file: string, sqlText: string): MigrationDeploymentMode {
  const firstLine = sqlText.replaceAll("\r\n", "\n").split("\n", 1)[0]?.trim();
  if (firstLine === "-- deployment-mode: rolling") return "rolling";
  if (firstLine === "-- deployment-mode: maintenance") return "maintenance";
  const ordinal = /^(\d{4})_/.exec(file)?.[1];
  return ordinal && Number(ordinal) < 63 ? "historical" : "unclassified";
}

export const RELEASE_DIRECTIVE = /^-- opengeni:(pre-release|post-release)$/;

/** Only real directive lines in the leading comment block, never SQL strings. */
export function migrationReleaseDirectives(sqlText: string): Set<string> {
  const markers = new Set<string>();
  for (const raw of sqlText.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim();
    if (line && !line.startsWith("--")) break;
    const match = RELEASE_DIRECTIVE.exec(line);
    if (match) markers.add(match[1]!);
  }
  return markers;
}

export function parseMigrationPhase(value: string | undefined): MigrationPhase {
  if (value === undefined) return "post";
  if (value === "pre" || value === "maintenance" || value === "post") return value;
  throw new Error(
    `Invalid migration phase ${JSON.stringify(value)}; expected pre, maintenance or post`,
  );
}

/** Both CLI spellings work; an explicit flag takes precedence over the env. */
export function migrationPhaseFromArgs(
  args: readonly string[],
  environmentPhase: string | undefined,
): MigrationPhase {
  const index = args.findIndex((arg) => arg === "--phase" || arg.startsWith("--phase="));
  if (index === -1) return parseMigrationPhase(environmentPhase);
  const arg = args[index]!;
  return parseMigrationPhase(arg === "--phase" ? (args[index + 1] ?? "") : arg.slice(8));
}

/** Input is the database's pending set in file order, not the whole ledger. */
export function partitionMigrationPhases(
  pending: readonly {
    name: string;
    deploymentMode: MigrationDeploymentMode;
    preReleaseEligible: boolean;
    postReleaseEligible: boolean;
  }[],
): MigrationPhases {
  let postStart = pending.length;
  while (
    postStart > 0 &&
    pending[postStart - 1]!.deploymentMode === "rolling" &&
    pending[postStart - 1]!.postReleaseEligible
  )
    postStart--;
  let preEnd = 0;
  while (
    preEnd < postStart &&
    pending[preEnd]!.deploymentMode === "rolling" &&
    pending[preEnd]!.preReleaseEligible
  )
    preEnd++;
  return {
    pre: pending.slice(0, preEnd).map(({ name }) => name),
    maintenance: pending.slice(preEnd, postStart).map(({ name }) => name),
    post: pending.slice(postStart).map(({ name }) => name),
  };
}
