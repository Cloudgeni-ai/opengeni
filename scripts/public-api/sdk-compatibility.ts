import { z } from "zod";

export const SDK_COMPATIBILITY_MATRIX_PATH = "test/integration/sdk-compatibility/versions.json";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
  });
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const matrixSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewedOn: date,
    registry: z.literal("https://registry.npmjs.org"),
    versions: z.array(z.object({ version, reason: z.string().min(1) }).strict()).min(1),
    retirementNotices: z
      .array(
        z
          .object({ version, announcedOn: date, sunset: date, migration: z.string().min(1) })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type SdkCompatibilityMatrix = z.infer<typeof matrixSchema>;

export function sdkCompatibilityFailures(
  candidate: unknown,
  previous?: unknown,
  now = new Date(),
): string[] {
  const parsed = matrixSchema.safeParse(candidate);
  if (!parsed.success) return [`SDK compatibility matrix is invalid: ${parsed.error.message}`];
  const current = parsed.data;
  const failures: string[] = [];
  if (new Set(current.versions.map((entry) => entry.version)).size !== current.versions.length)
    failures.push("SDK compatibility matrix contains duplicate versions");
  for (const notice of current.retirementNotices) {
    if (Date.parse(notice.sunset) - Date.parse(notice.announcedOn) < 90 * 86_400_000)
      failures.push(`SDK ${notice.version}: retirement requires at least 90 days' notice`);
  }
  if (previous === undefined) return failures;
  const base = matrixSchema.parse(previous);
  for (const entry of base.versions) {
    if (current.versions.some((item) => item.version === entry.version)) continue;
    // The notice must already be on main: a PR cannot backdate its own notice
    // and simultaneously stop exercising a customer's installed SDK.
    const notice = base.retirementNotices.find((item) => item.version === entry.version);
    if (
      !notice ||
      Date.parse(notice.sunset) > now.getTime() ||
      Date.parse(notice.sunset) - Date.parse(notice.announcedOn) < 90 * 86_400_000
    ) {
      failures.push(
        `SDK ${entry.version}: cannot remove compatibility coverage without a previously committed 90-day retirement notice whose sunset has passed`,
      );
    }
  }
  return failures;
}
