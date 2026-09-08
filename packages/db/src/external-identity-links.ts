import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  BeginExternalIdentityLinkRequest,
  BeginExternalIdentityLinkResponse,
  ConfirmExternalIdentityLinkRequest,
  ExternalIdentityLink,
  ExternalIdentityLinkPage,
  ExternalIdentityReference,
  type ExternalIdentity,
} from "@opengeni/contracts/external-identities";
import { rawRows, withAccountRls, setSubjectRlsContext, type Database } from "./database";
import { lockExternalWorkspaceMembershipLifecycle } from "./external-identities";

type LinkRow = {
  id: string;
  account_id: string;
  external_identity_id: string;
  external_subject_id: string;
  external_authorization_revision: number | string;
  native_subject_id: string | null;
  native_membership_id: string | null;
  native_authorization_revision: number | string | null;
  status: "pending" | "active" | "revoked";
  revision: number | string;
  permissions: string[];
  challenge_digest: string;
  confirm_before: Date | string;
  expires_at: Date | string | null;
};
export class ExternalIdentityLinkConflictError extends Error {
  readonly name = "ExternalIdentityLinkConflictError";
  constructor() {
    super("Identity link changed or is unavailable");
  }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (value: Date | string) => new Date(value).toISOString();
function project(row: LinkRow): ExternalIdentityLink {
  const expiry = row.status === "pending" ? row.confirm_before : row.expires_at;
  return ExternalIdentityLink.parse({
    id: row.id,
    accountId: row.account_id,
    externalIdentityId: row.external_identity_id,
    nativeSubjectId: row.native_subject_id,
    status:
      row.status !== "revoked" && expiry !== null && new Date(expiry).getTime() <= Date.now()
        ? "expired"
        : row.status,
    revision: Number(row.revision),
    permissions: row.permissions,
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
  });
}
async function activeMembership(tx: Database, accountId: string, subjectId: string) {
  const [prior] = await rawRows<{ subject: string }>(
    tx,
    sql`select coalesce(current_setting('opengeni.subject_id', true), '') as subject`,
  );
  // These subjects come from verified admission or the immutable stored link,
  // not caller-selected impersonation. Restore the GUC after each named probe.
  let succeeded = false;
  let row:
    | { membership: { id: string; authorizationRevision: number; personalWorkspaceId: string } }
    | undefined;
  try {
    await setSubjectRlsContext(tx, subjectId);
    [row] = await rawRows<{
      membership: { id: string; authorizationRevision: number; personalWorkspaceId: string };
    }>(
      tx,
      sql`select value as membership from jsonb_array_elements(list_self_organization_memberships(${subjectId}))
        where value ->> 'organizationId' = ${accountId} and value ->> 'status' = 'active'`,
    );
    succeeded = true;
  } finally {
    const restore = tx.execute(
      sql`select set_config('opengeni.subject_id', ${prior?.subject ?? ""}, true)`,
    );
    if (succeeded) await restore;
    else await restore.catch(() => undefined);
  }
  if (!row) throw new ExternalIdentityLinkConflictError();
  return row.membership;
}

/** Internal persistence seam. The API must prove a host external actor and
 * freeze its key permission ceiling before calling. No login is provisioned. */
export async function beginExternalIdentityLink(
  db: Database,
  identity: ExternalIdentity,
  raw: unknown,
) {
  const input = BeginExternalIdentityLinkRequest.parse(raw);
  return withAccountRls(db, identity.accountId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, identity.accountId);
    const membership = await activeMembership(tx, identity.accountId, identity.subjectId);
    if (
      membership.id !== identity.organizationMembershipId ||
      Number(membership.authorizationRevision) !== identity.authorizationRevision ||
      identity.status !== "active"
    )
      throw new ExternalIdentityLinkConflictError();
    const [quota] = await rawRows<{ count: number | string }>(
      tx,
      sql`select count(*) as count
      from external_identity_links where account_id = ${identity.accountId}::uuid
        and external_identity_id = ${identity.id}::uuid and status = 'pending'
        and confirm_before > clock_timestamp()`,
    );
    if (Number(quota?.count ?? 0) >= 32) throw new ExternalIdentityLinkConflictError();
    const challenge = randomBytes(32).toString("base64url");
    const permissions = [...new Set(input.permissions)].sort();
    const [row] = await rawRows<LinkRow>(
      tx,
      sql`insert into external_identity_links
      (id, account_id, external_identity_id, external_subject_id, external_authorization_revision,
        permissions, challenge_digest, confirm_before, expires_at)
      values (${randomUUID()}::uuid, ${identity.accountId}::uuid, ${identity.id}::uuid,
        ${identity.subjectId}, ${identity.authorizationRevision}, ${JSON.stringify(permissions)}::jsonb,
        ${digest(challenge)}, clock_timestamp() + interval '10 minutes', ${input.expiresAt}::timestamptz)
      returning *`,
    );
    if (!row) throw new Error("Identity link insert returned no row");
    return BeginExternalIdentityLinkResponse.parse({
      link: project(row),
      challenge,
      confirmBefore: iso(row.confirm_before),
    });
  });
}

/** Caller proves either exact host identity or native login, never a caller's
 * claimed subject. The challenge is intentionally absent from every read. */
export async function getExternalIdentityLink(
  db: Database,
  input: {
    accountId: string;
    linkId: string;
    subjectId: string;
  },
): Promise<ExternalIdentityLink | null> {
  return withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<LinkRow>(
      tx,
      sql`select * from external_identity_links
      where account_id = ${input.accountId}::uuid and id = ${input.linkId}::uuid
      and (external_subject_id = ${input.subjectId} or native_subject_id = ${input.subjectId})`,
    );
    return row ? project(row) : null;
  });
}

/** Bounded inventory of the verified participant's links. Neither account-wide
 * access nor a supplied cursor reveals another participant's pending requests. */
export async function listExternalIdentityLinks(
  db: Database,
  input: { accountId: string; subjectId: string; cursor?: string },
): Promise<ExternalIdentityLinkPage> {
  return withAccountRls(db, input.accountId, async (tx) => {
    const rows = await rawRows<LinkRow>(
      tx,
      sql`
      select * from external_identity_links
      where account_id = ${input.accountId}::uuid
        and (external_subject_id = ${input.subjectId} or native_subject_id = ${input.subjectId})
        ${input.cursor ? sql`and id > ${input.cursor}::uuid` : sql``}
      order by id limit 51`,
    );
    const links = rows.slice(0, 50).map(project);
    await setSubjectRlsContext(tx, input.subjectId);
    const [labels] = links.length
      ? await rawRows<{ references: Record<string, unknown> }>(
          tx,
          sql`select get_external_identity_link_inventory_references(${input.accountId}::uuid, ARRAY[${sql.join(
            links.map((link) => sql`${link.id}::uuid`),
            sql`, `,
          )}]) as references`,
        )
      : [];
    return ExternalIdentityLinkPage.parse({
      links: links.map((link) => ({
        ...link,
        ...(labels?.references[link.id]
          ? { externalIdentity: ExternalIdentityReference.parse(labels.references[link.id]) }
          : {}),
      })),
      nextCursor: rows.length > 50 ? links.at(-1)!.id : null,
    });
  });
}

/** Consent-screen projection, only after canonical native login admission.
 * The short-lived challenge proves which host request the human is approving. */
export async function previewExternalIdentityLink(
  db: Database,
  input: {
    accountId: string;
    linkId: string;
    challenge: string;
  },
): Promise<{ link: ExternalIdentityLink; externalIdentity: ExternalIdentityReference } | null> {
  return withAccountRls(db, input.accountId, async (tx) => {
    const [row] = await rawRows<LinkRow>(
      tx,
      sql`select * from external_identity_links
      where account_id = ${input.accountId}::uuid and id = ${input.linkId}::uuid
        and challenge_digest = ${digest(input.challenge)} and status = 'pending'
        and confirm_before > clock_timestamp()
        and (expires_at is null or expires_at > clock_timestamp())`,
    );
    if (!row) return null;
    const [identity] = await rawRows<{ reference: unknown }>(
      tx,
      sql`select get_external_identity_link_reference(${input.accountId}::uuid, ${input.linkId}::uuid, ${digest(input.challenge)}) as reference`,
    );
    return identity?.reference
      ? {
          link: project(row),
          externalIdentity: ExternalIdentityReference.parse(identity.reference),
        }
      : null;
  });
}

/** Must only receive the canonical native-session subject after explicit UI
 * consent. Possession of the challenge alone is not native authentication. */
export async function confirmExternalIdentityLink(
  db: Database,
  input: {
    accountId: string;
    linkId: string;
    nativeSubjectId: string;
    request: ConfirmExternalIdentityLinkRequest;
  },
): Promise<ExternalIdentityLink> {
  const request = ConfirmExternalIdentityLinkRequest.parse(input.request);
  if (!/^user:[^\r\n]+$/.test(input.nativeSubjectId)) throw new ExternalIdentityLinkConflictError();
  return withAccountRls(db, input.accountId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
    const [row] = await rawRows<LinkRow>(
      tx,
      sql`select * from external_identity_links
      where account_id = ${input.accountId}::uuid and id = ${input.linkId}::uuid
        and challenge_digest = ${digest(request.challenge)} for update`,
    );
    if (!row) throw new ExternalIdentityLinkConflictError();
    const external = await activeMembership(tx, input.accountId, row.external_subject_id);
    const native = await activeMembership(tx, input.accountId, input.nativeSubjectId);
    if (Number(external.authorizationRevision) !== Number(row.external_authorization_revision))
      throw new ExternalIdentityLinkConflictError();
    const permissions = [...new Set(request.permissions)].sort();
    if (
      row.status === "active" &&
      Number(row.revision) === request.expectedRevision + 1 &&
      row.native_subject_id === input.nativeSubjectId &&
      row.native_membership_id === native.id &&
      Number(row.native_authorization_revision) === Number(native.authorizationRevision) &&
      JSON.stringify(row.permissions) === JSON.stringify(permissions) &&
      project(row).status === "active"
    )
      return project(row);
    if (
      row.status !== "pending" ||
      Number(row.revision) !== request.expectedRevision ||
      project(row).status !== "pending" ||
      permissions.some((permission) => !row.permissions.includes(permission))
    )
      throw new ExternalIdentityLinkConflictError();
    const [confirmed] = await rawRows<LinkRow>(
      tx,
      sql`update external_identity_links set
      status = 'active', revision = revision + 1, native_subject_id = ${input.nativeSubjectId},
      native_membership_id = ${native.id}::uuid, native_authorization_revision = ${Number(native.authorizationRevision)},
      permissions = ${JSON.stringify(permissions)}::jsonb, confirmed_at = clock_timestamp()
      where id = ${row.id}::uuid returning *`,
    );
    if (!confirmed) throw new ExternalIdentityLinkConflictError();
    return project(confirmed);
  });
}

export async function revokeExternalIdentityLink(
  db: Database,
  input: {
    accountId: string;
    linkId: string;
    subjectId: string;
    expectedRevision: number;
  },
): Promise<ExternalIdentityLink> {
  return withAccountRls(db, input.accountId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, input.accountId);
    const [row] = await rawRows<LinkRow>(
      tx,
      sql`select * from external_identity_links
      where account_id = ${input.accountId}::uuid and id = ${input.linkId}::uuid
      and (external_subject_id = ${input.subjectId} or native_subject_id = ${input.subjectId}) for update`,
    );
    if (!row) throw new ExternalIdentityLinkConflictError();
    if (row.status === "revoked" && Number(row.revision) === input.expectedRevision + 1)
      return project(row);
    if (row.status === "revoked" || Number(row.revision) !== input.expectedRevision)
      throw new ExternalIdentityLinkConflictError();
    const [revoked] = await rawRows<LinkRow>(
      tx,
      sql`update external_identity_links
      set status = 'revoked', revision = revision + 1, revoked_at = clock_timestamp()
      where id = ${row.id}::uuid returning *`,
    );
    if (!revoked) throw new ExternalIdentityLinkConflictError();
    return project(revoked);
  });
}

/** Live linked admission primitive. It retains membership/link locks when
 * called in an open transaction. Never uses old creator audit as authority. */
export async function resolveExternalIdentityLink(
  db: Database,
  input: {
    identity: ExternalIdentity;
    linkId: string;
    expectedRevision: number;
  },
): Promise<{ link: ExternalIdentityLink; personalWorkspaceId: string } | null> {
  return withAccountRls(db, input.identity.accountId, async (tx) => {
    await lockExternalWorkspaceMembershipLifecycle(tx, input.identity.accountId);
    const [row] = await rawRows<LinkRow>(
      tx,
      sql`select * from external_identity_links
      where id = ${input.linkId}::uuid and account_id = ${input.identity.accountId}::uuid
        and external_identity_id = ${input.identity.id}::uuid for share`,
    );
    if (
      !row ||
      row.status !== "active" ||
      !row.native_subject_id ||
      Number(row.revision) !== input.expectedRevision ||
      Number(row.external_authorization_revision) !== input.identity.authorizationRevision ||
      input.identity.status !== "active" ||
      project(row).status !== "active"
    )
      return null;
    try {
      const external = await activeMembership(
        tx,
        input.identity.accountId,
        input.identity.subjectId,
      );
      const native = await activeMembership(tx, input.identity.accountId, row.native_subject_id);
      if (
        external.id !== input.identity.organizationMembershipId ||
        Number(external.authorizationRevision) !== input.identity.authorizationRevision ||
        native.id !== row.native_membership_id ||
        Number(native.authorizationRevision) !== Number(row.native_authorization_revision)
      )
        return null;
      return { link: project(row), personalWorkspaceId: native.personalWorkspaceId };
    } catch (error) {
      if (error instanceof ExternalIdentityLinkConflictError) return null;
      throw error;
    }
  });
}
