import postgres from "postgres";
import { VAULT_RUNTIME_ROUTINES, VAULT_TABLES } from "../src/runtime-posture";

/**
 * Fixtures stopped before 0739 still write sessions and schedules through the
 * current adapters, which name `vault_policy`. Stage the column exactly as
 * 0739 declares it (0739 adds it with IF NOT EXISTS, so a later forward
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
 * Fixtures that stay before 0755 for good (they never migrate forward through
 * it) still write sessions and turns through the current adapters, which name
 * the connection-account intent columns. Stage them as 0755 declares them.
 * A fixture that later applies 0755 must first drop them again with
 * dropConnectionAccountIntentColumns: 0755 adds them without IF NOT EXISTS.
 */
export async function stageConnectionAccountIntentColumns(ownerUrl: string): Promise<void> {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS initial_connection_account_intent jsonb DEFAULT NULL`;
    await owner`ALTER TABLE session_turns
      ADD COLUMN IF NOT EXISTS connection_account_intent jsonb DEFAULT NULL`;
    await owner`ALTER TABLE session_realtime_modes
      ADD COLUMN IF NOT EXISTS connection_account_intent jsonb DEFAULT NULL`;
  } finally {
    await owner.end({ timeout: 5 });
  }
}

/** Removes the staged 0755 columns so a forward migrate can add them itself. */
export async function dropConnectionAccountIntentColumns(ownerUrl: string): Promise<void> {
  const owner = postgres(ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`ALTER TABLE sessions DROP COLUMN IF EXISTS initial_connection_account_intent`;
    await owner`ALTER TABLE session_turns DROP COLUMN IF EXISTS connection_account_intent`;
    await owner`ALTER TABLE session_realtime_modes DROP COLUMN IF EXISTS connection_account_intent`;
  } finally {
    await owner.end({ timeout: 5 });
  }
}

/**
 * A fixture stopped before 0739 has no vault objects, so current readiness
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

const laterCapabilities = new Set([
  "target-schema runtime capability scheduled_task_is_exhausted(uuid) is missing or ambiguous",
  "target-schema runtime capability session_visibility_change_blocker(uuid, uuid, uuid) is missing or ambiguous",
]);

/**
 * A fixture stopped before 0761 and 0768 has no exhausted-schedule outbox,
 * predicate or visibility preview, so current readiness reports them missing.
 * Drop exactly those messages (and only that table from a combined
 * "... tables are missing" line).
 */
export function withoutAbsentLaterPosture(violations: readonly string[]): string[] {
  const table = "scheduled_task_schedule_outbox";
  const kept: string[] = [];
  for (const violation of violations) {
    if (laterCapabilities.has(violation)) continue;
    const prefix = [
      "protected tables are missing: ",
      "runtime privilege tables are missing: ",
    ].find((candidate) => violation.startsWith(candidate));
    if (prefix) {
      const others = violation
        .slice(prefix.length)
        .split(", ")
        .filter((name) => name !== table);
      if (others.length > 0) kept.push(`${prefix}${others.join(", ")}`);
      continue;
    }
    kept.push(violation);
  }
  return kept;
}
