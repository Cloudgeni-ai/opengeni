/** Shared, side-effect-free migration phase contract for the runner and lint. */
export type MigrationPhase = "pre" | "maintenance" | "post";
export type MigrationDeploymentMode = "historical" | "rolling" | "maintenance" | "unclassified";
export type MigrationPhases = Record<MigrationPhase, string[]>;

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
  while (preEnd < postStart && ["rolling", "historical"].includes(pending[preEnd]!.deploymentMode))
    preEnd++;
  return {
    pre: pending.slice(0, preEnd).map(({ name }) => name),
    maintenance: pending.slice(preEnd, postStart).map(({ name }) => name),
    post: pending.slice(postStart).map(({ name }) => name),
  };
}
