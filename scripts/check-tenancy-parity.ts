// Read-only organization tenancy PARITY check (phase E). Verifies the
// structural tenancy invariants, reports the compatibility lanes, and names the
// properties that are currently unverifiable, as one machine-readable report an
// operator can gate a cutover on.
//
// It never writes, repairs, or widens anything, and no reported mismatch is
// ever resolved toward user authority - ambiguity is reported and fails closed.
//
// Usage:
//   bun run db:check-tenancy-parity --organization-id <uuid>
//     [--evidence-limit <0-50>] [--observation-window-days <1-365>] [--quiet]
//
// Point it at a WRITABLE PRIMARY: it cannot run against a read replica. The
// seam claims and releases its own transaction-local capability row, so a
// read-only standby fails with `25006: cannot execute DELETE in a read-only
// transaction`. It is still read-only with respect to every inspected table.
//
// Exit codes: 0 = every gate passed; 1 = at least one gate failed; 2 = the
// command could not run (bad input or database error).
import { dbSearchPath, getSettings } from "@opengeni/config";
import { checkOrganizationTenancyParity, createDb, type DbClient } from "@opengeni/db";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function integerArgument(name: string): number | undefined {
  const raw = argument(name);
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

async function main(): Promise<number> {
  const organizationId = argument("--organization-id");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  const quiet = process.argv.includes("--quiet");
  const evidenceLimit = integerArgument("--evidence-limit");
  const observationWindowDays = integerArgument("--observation-window-days");
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const report = await checkOrganizationTenancyParity(client.db, {
      organizationId,
      ...(evidenceLimit === undefined ? {} : { evidenceLimit }),
      ...(observationWindowDays === undefined ? {} : { observationWindowDays }),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!quiet) {
      for (const gate of report.gates) {
        if (gate.status === "fail") {
          console.error(
            `FAIL ${gate.id}: ${gate.violations} violation(s)` +
              (gate.evidence.length > 0
                ? ` [${gate.evidence.join(", ")}${gate.evidenceTruncated ? ", …" : ""}]`
                : ""),
          );
        }
      }
      for (const lane of report.lanes) {
        if (!lane.drained) {
          console.error(
            `LANE ${lane.id}: ${lane.count} remaining` +
              (lane.owner ? ` (owned by ${lane.owner})` : ""),
          );
        }
      }
    }
    return report.status === "pass" ? 0 : 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  });
}
