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
  })
  .strict();
export type SdkCompatibilityMatrix = z.infer<typeof matrixSchema>;

export function sdkCompatibilityFailures(candidate: unknown, previous?: unknown): string[] {
  const parsed = matrixSchema.safeParse(candidate);
  if (!parsed.success) return [`SDK compatibility matrix is invalid: ${parsed.error.message}`];
  const current = parsed.data;
  const failures: string[] = [];
  if (new Set(current.versions.map((entry) => entry.version)).size !== current.versions.length)
    failures.push("SDK compatibility matrix contains duplicate versions");
  if (previous === undefined) return failures;
  const base = matrixSchema.parse(previous);
  for (const entry of base.versions) {
    if (current.versions.some((item) => item.version === entry.version)) continue;
    failures.push(
      `SDK ${entry.version}: cannot remove compatibility coverage; a major release or deprecation period does not retire existing integrations`,
    );
  }
  return failures;
}
