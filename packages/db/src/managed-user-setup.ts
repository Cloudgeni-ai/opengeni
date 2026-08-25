import {
  CompleteSelfServiceOrganizationSetupResponse,
  type CompleteSelfServiceOrganizationSetupResponse as CompleteSelfServiceOrganizationSetupResponseType,
  CompleteOrganizationUserSetupResponse,
  type CompleteOrganizationUserSetupResponse as CompleteOrganizationUserSetupResponseType,
  OrganizationUserSetupDelivery,
  type OrganizationUserSetupDelivery as OrganizationUserSetupDeliveryType,
  OrganizationUserSetupPreview,
  type OrganizationUserSetupPreview as OrganizationUserSetupPreviewType,
  OrganizationUserSetupPreviewWorkspace,
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

export type OrganizationUserSetupDeliveryClaim =
  | {
      claimed: false;
      delivery: OrganizationUserSetupDeliveryType;
    }
  | {
      claimed: true;
      delivery: OrganizationUserSetupDeliveryType;
      attemptId: string;
      claimHolderId: string;
      invitationId: string;
      providerKey: string;
      recipientEmail: string;
      recipientName: string | null;
      organizationName: string;
      organizationRole: "owner" | "admin" | "member";
      sharedWorkspaceAccess: Array<{
        workspaceId: string;
        workspaceName: string;
        role: "viewer" | "member" | "admin";
      }>;
      expiresAt: string;
    };

export async function claimOrganizationUserSetupDelivery(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    invitationId: string;
    invitationOperationId?: string;
    operationId: string;
  },
): Promise<OrganizationUserSetupDeliveryClaim> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select claim_organization_user_setup_delivery(
          ${JSON.stringify(input)}::jsonb
        ) as result`,
      );
      return parseOrganizationUserSetupDeliveryClaim(row?.result);
    },
  );
}

export async function prepareOrganizationUserSetupDelivery(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    deliveryId: string;
    attemptId: string;
    claimHolderId: string;
    tokenDigest: string;
    payloadDigest: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      await rawRows(
        scopedDb,
        sql`select prepare_organization_user_setup_delivery(
          ${JSON.stringify(input)}::jsonb
        )`,
      );
    },
  );
}

export async function settleOrganizationUserSetupDelivery(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    deliveryId: string;
    attemptId: string;
    claimHolderId: string;
    outcome: "sent" | "failed" | "outcome_unknown";
    errorClass?: string;
    providerMessageId?: string | null;
  },
): Promise<OrganizationUserSetupDeliveryType> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      const [row] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`select settle_organization_user_setup_delivery(
          ${JSON.stringify(input)}::jsonb
        ) as result`,
      );
      return OrganizationUserSetupDelivery.parse(row?.result);
    },
  );
}

export async function previewOrganizationUserSetup(
  db: Database,
  tokenDigest: string,
): Promise<OrganizationUserSetupPreviewType> {
  const [row] = await rawRows<{ result: unknown }>(
    db,
    sql`select preview_organization_user_setup(${tokenDigest}::text) as result`,
  );
  return OrganizationUserSetupPreview.parse(row?.result);
}

function parseOrganizationUserSetupDeliveryClaim(
  value: unknown,
): OrganizationUserSetupDeliveryClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Organization user setup delivery claim returned an invalid result");
  }
  const candidate = value as Record<string, unknown>;
  const delivery = OrganizationUserSetupDelivery.parse(candidate.delivery);
  if (candidate.claimed !== true) return { claimed: false, delivery };
  const workspaceAccess = OrganizationUserSetupPreviewWorkspace.array()
    .max(100)
    .safeParse(candidate.sharedWorkspaceAccess);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof candidate.attemptId !== "string" ||
    !uuid.test(candidate.attemptId) ||
    typeof candidate.claimHolderId !== "string" ||
    !uuid.test(candidate.claimHolderId) ||
    typeof candidate.invitationId !== "string" ||
    !uuid.test(candidate.invitationId) ||
    typeof candidate.providerKey !== "string" ||
    typeof candidate.recipientEmail !== "string" ||
    (typeof candidate.recipientName !== "string" && candidate.recipientName !== null) ||
    typeof candidate.organizationName !== "string" ||
    !["owner", "admin", "member"].includes(String(candidate.organizationRole)) ||
    !workspaceAccess.success ||
    typeof candidate.expiresAt !== "string"
  ) {
    throw new Error("Organization user setup delivery claim returned an invalid result");
  }
  return {
    claimed: true,
    delivery,
    attemptId: candidate.attemptId,
    claimHolderId: candidate.claimHolderId,
    invitationId: candidate.invitationId,
    providerKey: candidate.providerKey,
    recipientEmail: candidate.recipientEmail,
    recipientName: candidate.recipientName,
    organizationName: candidate.organizationName,
    organizationRole: candidate.organizationRole as "owner" | "admin" | "member",
    sharedWorkspaceAccess: workspaceAccess.data,
    expiresAt: candidate.expiresAt,
  };
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
