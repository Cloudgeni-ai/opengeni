/**
 * "Ask me each time" for vault items and fields (docs/secrets.md, "Approval
 * for each use"): reading and changing an item's rules, and the grants in
 * force for it. Reach comes from the vault routines: a person sees and marks
 * only items they can open. Anyone who may write the item can add marks and
 * revoke grants, because both only make use stricter. Removing a mark is for
 * the person signed in themselves (not API keys or agents), so an agent can
 * never lift its own approval.
 */
import {
  secretNameKey,
  type SecretUseGrant,
  type SetVaultItemApprovalRequest,
  type VaultItemApproval,
} from "@opengeni/contracts";
import {
  getVaultItem,
  listSecretApprovalRules,
  listSecretUseGrantsForItem,
  revokeSecretUseGrant,
  setSecretApprovalRules,
  VaultError,
  type SecretUseApprovalRow,
  type VaultItemRow,
} from "@opengeni/db";
import { hasPermission } from "../../access";
import type { VaultRequestActor, VaultServiceDeps } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contextFor(actor: VaultRequestActor, workspaceId: string) {
  return {
    kind: "subject" as const,
    accountId: actor.grant.accountId,
    workspaceId,
    subjectId: actor.grant.subjectId,
  };
}

function isPerson(actor: VaultRequestActor): boolean {
  return (
    actor.personSignedIn === true &&
    actor.grant.principalKind === "human_session" &&
    !actor.grant.serviceInitiator
  );
}

function requirePerson(actor: VaultRequestActor): void {
  if (!isPerson(actor)) {
    throw new VaultError(
      "human_auth_required",
      "only a person signed in can remove an approval requirement; agents and API keys can only add them",
    );
  }
}

function fieldNameFor(item: VaultItemRow, fieldKey: string): string {
  return item.fields.find((field) => secretNameKey(field.name) === fieldKey)?.name ?? fieldKey;
}

function grantView(row: SecretUseApprovalRow, item: VaultItemRow): SecretUseGrant {
  return {
    id: row.id,
    scope: row.scope!,
    sessionId: row.sessionId,
    fields: row.targets
      .filter((target) => target.itemId === item.id)
      .map((target) => target.fieldName || fieldNameFor(item, target.fieldKey)),
    surface: row.surface,
    toolName: row.toolName,
    destination: row.destination,
    decidedAt: (row.decidedAt ?? row.createdAt).toISOString(),
    decidedBySubjectId: row.decidedBySubjectId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

async function approvalOf(
  deps: VaultServiceDeps,
  actor: VaultRequestActor,
  workspaceId: string,
  item: VaultItemRow,
): Promise<VaultItemApproval> {
  const scope = { accountId: actor.grant.accountId, workspaceId };
  const [rules, grants] = await Promise.all([
    listSecretApprovalRules(deps.db, scope, [item.id]),
    listSecretUseGrantsForItem(deps.db, scope, { itemId: item.id }),
  ]);
  const canWrite = hasPermission(
    actor.grant.permissions,
    "secrets:write",
    actor.grant.permissionMode,
  );
  return {
    item: rules.some((rule) => rule.fieldKey === ""),
    fields: rules
      .filter((rule) => rule.fieldKey !== "")
      .map((rule) => fieldNameFor(item, rule.fieldKey))
      .sort((left, right) => left.localeCompare(right)),
    grants: grants.map((row) => grantView(row, item)),
    canChange: isPerson(actor) && canWrite,
    canAddMarks: canWrite,
  };
}

/** The marks as one comparable value: the item mark plus sorted field keys. */
function markKey(rules: ReadonlyArray<{ fieldKey: string }>): string {
  return JSON.stringify([...new Set(rules.map((rule) => rule.fieldKey))].sort());
}

export async function getVaultItemApproval(
  deps: VaultServiceDeps,
  actor: VaultRequestActor,
  workspaceId: string,
  itemId: string,
): Promise<VaultItemApproval> {
  const item = await getVaultItem(deps.db, contextFor(actor, workspaceId), { itemId });
  return await approvalOf(deps, actor, workspaceId, item);
}

export async function setVaultItemApproval(
  deps: VaultServiceDeps,
  actor: VaultRequestActor,
  workspaceId: string,
  itemId: string,
  request: SetVaultItemApprovalRequest,
): Promise<VaultItemApproval> {
  const item = await getVaultItem(deps.db, contextFor(actor, workspaceId), { itemId });
  const known = new Set(item.fields.map((field) => secretNameKey(field.name)));
  const fieldKeys = [...new Set(request.fields.map(secretNameKey))];
  const unknown = fieldKeys.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new VaultError("vault_field_not_found", "the item has no field with that name", {
      fields: unknown,
    });
  }
  const scope = { accountId: actor.grant.accountId, workspaceId };
  const current = await listSecretApprovalRules(deps.db, scope, [item.id]);
  if (!isPerson(actor)) {
    // Adding marks only makes use stricter; lifting one needs the person.
    const requested = new Set(fieldKeys);
    const lifts = current.some((rule) =>
      rule.fieldKey === "" ? !request.item : !requested.has(rule.fieldKey),
    );
    if (lifts) requirePerson(actor);
  }
  await setSecretApprovalRules(
    deps.db,
    { accountId: actor.grant.accountId, workspaceId },
    {
      itemId: item.id,
      vaultId: item.vaultId,
      item: request.item,
      fieldKeys,
      subjectId: actor.grant.subjectId,
    },
  );
  const approval = await approvalOf(deps, actor, workspaceId, item);
  const after = [...(approval.item ? [""] : []), ...fieldKeys];
  return {
    ...approval,
    changed: markKey(current) !== markKey(after.map((fieldKey) => ({ fieldKey }))),
  };
}

export async function revokeVaultItemGrant(
  deps: VaultServiceDeps,
  actor: VaultRequestActor,
  workspaceId: string,
  itemId: string,
  grantId: string,
): Promise<VaultItemApproval> {
  const item = await getVaultItem(deps.db, contextFor(actor, workspaceId), { itemId });
  const revoked =
    UUID.test(grantId) &&
    (await revokeSecretUseGrant(
      deps.db,
      { accountId: actor.grant.accountId, workspaceId },
      { grantId, itemId: item.id, subjectId: actor.grant.subjectId },
    ));
  if (!revoked) {
    throw new VaultError("vault_item_not_found", "no approval in force with that id", {
      grantId,
    });
  }
  return await approvalOf(deps, actor, workspaceId, item);
}
