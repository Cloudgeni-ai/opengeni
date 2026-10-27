import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

/** How a new organization owner said they want to use Opengeni at signup. */
export const ORGANIZATION_SIGNUP_USE_CASES = ["everyday", "embed", "cloud"] as const;
export type OrganizationSignupUseCase = (typeof ORGANIZATION_SIGNUP_USE_CASES)[number];

/**
 * Record one person's signup answer for one organization (migration 0595;
 * `everyday` since 1002).
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

/**
 * Keep one person's current signup answer for one organization (migration
 * 1003): at organization setup, and again when they go Back and choose
 * another answer. The new-chat page follows it on every device; the first
 * answer stays in `organization_signup_use_cases` for analytics. Call only for
 * the authenticated managed human after proving their active membership in
 * `organizationId`.
 */
export async function setOrganizationSignupUseCase(
  db: Database,
  input: { organizationId: string; subjectId: string; useCase: OrganizationSignupUseCase },
): Promise<OrganizationSignupUseCase> {
  const rows = await withRlsContext(db, { accountId: input.organizationId }, async (tx) =>
    rawRows<{ use_case: OrganizationSignupUseCase }>(
      tx,
      sql`insert into opengeni_private.organization_signup_current_use_cases
          (account_id, subject_id, use_case, updated_at)
        values (${input.organizationId}::uuid, ${input.subjectId}, ${input.useCase}, now())
        on conflict (account_id, subject_id) do update
          set use_case = excluded.use_case, updated_at = excluded.updated_at
        returning use_case`,
    ),
  );
  const stored = rows[0]?.use_case;
  if (!stored) throw new Error("Signup use case was not kept");
  return stored;
}

/**
 * The person's current signup answer for this organization, or null when the
 * server has none (an organization set up before 1003, or without an answer).
 */
export async function readOrganizationSignupUseCase(
  db: Database,
  input: { organizationId: string; subjectId: string },
): Promise<OrganizationSignupUseCase | null> {
  const rows = await withRlsContext(db, { accountId: input.organizationId }, async (tx) =>
    rawRows<{ use_case: OrganizationSignupUseCase }>(
      tx,
      sql`select use_case from opengeni_private.organization_signup_current_use_cases
        where account_id = ${input.organizationId}::uuid and subject_id = ${input.subjectId}`,
    ),
  );
  return rows[0]?.use_case ?? null;
}
