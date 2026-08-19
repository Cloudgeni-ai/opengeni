import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, setRlsContext } from "./database";
import * as schema from "./schema";

export type ManagedHumanPersonalWorkspaceProvisioning = {
  organizationMembershipId: string;
  personalWorkspaceId: string;
};

/**
 * Converge the deterministic managed-human personal workspace, its inference
 * control row, and the organization-membership anchor through the exact 0219
 * `ensure_managed_human_personal_workspace` lifecycle seam.
 *
 * This is the single implementation of that preparation. The Better Auth
 * managed-access hook and the operator membership backfill driver both call it,
 * so neither owns a second copy of the deterministic personal-workspace
 * identity. All authority - account binding, owner-membership proof, workspace
 * identity, control-row validation, membership status - stays inside the
 * SECURITY DEFINER seam, which fails closed; nothing here writes an
 * organization-tenancy table directly.
 *
 * Must be called inside a transaction whose RLS context is already the exact
 * account with no workspace. It restores that context before returning.
 */
export async function ensureManagedHumanPersonalWorkspace(
  tx: Database,
  input: { accountId: string; subjectId: string },
): Promise<ManagedHumanPersonalWorkspaceProvisioning> {
  const personalWorkspaceExternalSource = "opengeni:organization-membership";
  const personalWorkspaceExternalId = `${input.accountId}:${input.subjectId}`;
  let [personalWorkspace] = await tx
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.externalSource, personalWorkspaceExternalSource),
        eq(schema.workspaces.externalId, personalWorkspaceExternalId),
      ),
    )
    .limit(1);
  if (!personalWorkspace) {
    [personalWorkspace] = await tx
      .insert(schema.workspaces)
      .values({
        accountId: input.accountId,
        name: "Personal workspace",
        slug: null,
        externalSource: personalWorkspaceExternalSource,
        externalId: personalWorkspaceExternalId,
      })
      .onConflictDoUpdate({
        target: [schema.workspaces.externalSource, schema.workspaces.externalId],
        set: { updatedAt: new Date() },
      })
      .returning();
  }
  if (!personalWorkspace) {
    throw new Error("Failed to ensure personal workspace");
  }
  if (
    personalWorkspace.accountId !== input.accountId ||
    personalWorkspace.externalSource !== personalWorkspaceExternalSource ||
    personalWorkspace.externalId !== personalWorkspaceExternalId
  ) {
    throw new Error("Managed personal workspace identity conflict");
  }

  await setRlsContext(tx, {
    accountId: input.accountId,
    workspaceId: personalWorkspace.id,
  });
  const [personalWorkspaceControl] = await tx
    .select({ workspaceId: schema.workspaceInferenceControls.workspaceId })
    .from(schema.workspaceInferenceControls)
    .where(eq(schema.workspaceInferenceControls.workspaceId, personalWorkspace.id))
    .limit(1);
  if (!personalWorkspaceControl) {
    await tx
      .insert(schema.workspaceInferenceControls)
      .values({
        workspaceId: personalWorkspace.id,
        accountId: input.accountId,
      })
      .onConflictDoNothing();
  }
  await setRlsContext(tx, {
    accountId: input.accountId,
    workspaceId: null,
  });

  const [provisionedMembership] = await rawRows<{
    organization_membership_id: string;
    personal_workspace_id: string;
  }>(
    tx,
    sql`
      select * from ensure_managed_human_personal_workspace(
        ${input.accountId},
        ${input.subjectId},
        ${personalWorkspace.id}
      )
    `,
  );
  if (
    !provisionedMembership ||
    provisionedMembership.personal_workspace_id !== personalWorkspace.id
  ) {
    throw new Error("Managed organization membership provisioning did not converge");
  }
  return {
    organizationMembershipId: provisionedMembership.organization_membership_id,
    personalWorkspaceId: provisionedMembership.personal_workspace_id,
  };
}
