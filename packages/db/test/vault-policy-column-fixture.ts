import postgres from "postgres";
import { VAULT_RUNTIME_ROUTINES, VAULT_TABLES } from "../src/runtime-posture";

/**
 * Fixtures stopped before 0738 still write sessions and schedules through the
 * current adapters, which name `vault_policy`. Stage the column exactly as
 * 0738 declares it (0738 adds it with IF NOT EXISTS, so a later forward
 * migrate keeps working).
 */
export async function stageVaultPolicyColumns(ownerUrl: string): Promise<void> {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS vault_policy jsonb NOT NULL DEFAULT '{"mode":"all"}'::jsonb`;
    await owner`ALTER TABLE scheduled_tasks
      ADD COLUMN IF NOT EXISTS vault_policy jsonb NOT NULL DEFAULT '{"mode":"all"}'::jsonb`;
  } finally {
    await owner.end({ timeout: 5 });
  }
}

/**
 * A fixture stopped before 0738 has no vault objects, so current readiness
 * reports them missing. Drop exactly those messages (and only the vault names
 * from a combined "protected tables are missing" line) so the fixture still
 * pins every other posture failure.
 */
export function withoutAbsentVaultPosture(violations: readonly string[]): string[] {
  const vaultTables = new Set<string>(VAULT_TABLES);
  const absentVaultMessages = new Set<string>([
    ...VAULT_RUNTIME_ROUTINES.map(
      (routine) => `target-schema runtime capability ${routine} is missing or ambiguous`,
    ),
    "vault capability table vault_authority_capabilities is missing or ambiguous",
    "vault capability predicate vault_authority_capability_active(text) is missing or ambiguous",
  ]);
  const prefix = "protected tables are missing: ";
  const kept: string[] = [];
  for (const violation of violations) {
    if (absentVaultMessages.has(violation)) continue;
    if (violation.startsWith(prefix)) {
      const others = violation
        .slice(prefix.length)
        .split(", ")
        .filter((table) => !vaultTables.has(table));
      if (others.length > 0) kept.push(`${prefix}${others.join(", ")}`);
      continue;
    }
    kept.push(violation);
  }
  return kept;
}
