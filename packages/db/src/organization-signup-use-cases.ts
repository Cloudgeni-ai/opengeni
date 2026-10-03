import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/** How a new organization owner said they want to use OpenGeni at signup. */
export const ORGANIZATION_SIGNUP_USE_CASES = ["embed", "cloud"] as const;
export type OrganizationSignupUseCase = (typeof ORGANIZATION_SIGNUP_USE_CASES)[number];

/**
 * Record one person's signup answer for one organization (migration 0595).
 * Call only for the authenticated managed human (`user:` subject) after
 * authorizing their membership in `organizationId`. The first answer wins: a
 * repeated or replayed call returns the stored choice unchanged.
 */
export async function recordOrganizationSignupUseCase(
  db: Database,
  input: { organizationId: string; subjectId: string; useCase: OrganizationSignupUseCase },
): Promise<OrganizationSignupUseCase> {
  const rows = await withRlsContext(db, { accountId: input.organizationId }, async (tx) =>
    rawRows<{ use_case: OrganizationSignupUseCase }>(
      tx,
      sql`select opengeni_private.record_organization_signup_use_case(
        ${input.organizationId}::uuid, ${input.subjectId}::text, ${input.useCase}::text
      ) as use_case`,
    ),
  );
  const stored = rows[0]?.use_case;
  if (!stored) throw new Error("Signup use case was not recorded");
  return stored;
}
