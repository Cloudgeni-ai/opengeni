import {
  CompleteSelfServiceOrganizationSetupResponse,
  type CompleteSelfServiceOrganizationSetupResponse as CompleteSelfServiceOrganizationSetupResponseType,
  CompleteOrganizationUserSetupResponse,
  type CompleteOrganizationUserSetupResponse as CompleteOrganizationUserSetupResponseType,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";

export async function getSelfServiceOrganizationOnboardingState(
  db: Database,
  input: { authUserId: string; email: string; emailVerified: boolean },
): Promise<"required" | "invitation_pending" | "unavailable" | "complete"> {
  const actorSubjectId = `user:${input.authUserId}`;
  return await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await setSubjectRlsContext(txDb, actorSubjectId);
    if (input.emailVerified) {
      await rawRows(
        txDb,
        sql`select bind_pending_organization_invitations_for_verified_email(
          ${actorSubjectId}::text, ${input.email}::text
        )`,
      );
    }
    const [membershipRow] = await rawRows<{ active: boolean }>(
      txDb,
      sql`select exists(
        select 1
        from pg_catalog.jsonb_array_elements(
          list_self_organization_memberships(${actorSubjectId}::text)
        ) membership(value)
        where membership.value ->> 'status' = 'active'
      ) as active`,
    );
    if (membershipRow?.active === true) return "complete";
    const [invitationRow] = await rawRows<{ pending: boolean }>(
      txDb,
      sql`select has_pending_organization_invitation_for_subject(
        ${actorSubjectId}::text
      ) as pending`,
    );
    if (invitationRow?.pending === true) return "invitation_pending";
    const [membershipPresenceRow] = await rawRows<{ exists: boolean }>(
      txDb,
      sql`select exists(
        select 1
        from pg_catalog.jsonb_array_elements(
          list_self_organization_memberships(${actorSubjectId}::text)
        ) membership(value)
      ) as exists`,
    );
    return membershipPresenceRow?.exists === true ? "unavailable" : "required";
  });
}

export async function preflightOrganizationUserSetup(
  db: Database,
  tokenDigest: string,
): Promise<"pending" | "completed" | "unavailable"> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select preflight_organization_user_setup(${tokenDigest}::text) as result`,
  );
  if (row?.result !== "pending" && row?.result !== "completed" && row?.result !== "unavailable") {
    throw new Error("Organization user setup preflight returned an invalid result");
  }
  return row.result;
}

export async function completeSelfServiceOrganizationSetup(
  db: Database,
  input: {
    authUserId: string;
    actorSubjectId: string;
    organizationName: string;
    operationId: string;
    requestFingerprint: string;
  },
): Promise<CompleteSelfServiceOrganizationSetupResponseType> {
  return await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await setSubjectRlsContext(txDb, input.actorSubjectId);
    const [row] = await rawRows<{ result: unknown }>(
      txDb,
      sql`select complete_self_service_organization_setup(
        ${JSON.stringify(input)}::jsonb
      ) as result`,
    );
    return CompleteSelfServiceOrganizationSetupResponse.parse(row?.result);
  });
}

export async function ensureOrganizationUserSetupIntent(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    invitationId: string;
    tokenDigest: string;
    expiresAt: string;
  },
): Promise<{ status: "pending" | "completed" }> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select ensure_organization_user_setup_intent(
          ${JSON.stringify(input)}::jsonb
        ) as result`,
      );
      const result = row?.result as { status?: unknown } | undefined;
      if (result?.status !== "pending" && result?.status !== "completed") {
        throw new Error("Organization user setup intent returned an invalid result");
      }
      return { status: result.status };
    },
  );
}

export async function completeOrganizationUserSetup(
  db: Database,
  input: {
    tokenDigest: string;
    operationId: string;
    requestFingerprint: string;
    authUserId: string;
    name: string;
    passwordHash: string;
  },
): Promise<CompleteOrganizationUserSetupResponseType> {
  return await db.transaction(async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`select complete_organization_user_setup(
        ${JSON.stringify(input)}::jsonb
      ) as result`,
    );
    return CompleteOrganizationUserSetupResponse.parse(row?.result);
  });
}
