import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, type Database } from "../database";

/**
 * The request-local account:admin proof the API's access resolver mints for an
 * authenticated account administrator (the core access layer's
 * `AccountAdminAuthorizationStamp`). The database checks it against the
 * transaction's own account and subject before it records anything (0956).
 */
export type SubscriptionAccountAdministratorStamp = Readonly<{
  authorizationId: string;
  accountId: string;
  actorSubjectId: string;
  permission: "account:admin";
}>;

/**
 * Resolves the current request's account:admin proof for one account and
 * subject, or null when the request holds none. Installed per request by the
 * API; background work runs without one.
 */
export type SubscriptionAccountAdministratorResolver = (input: {
  accountId: string;
  subjectId: string;
}) => Promise<SubscriptionAccountAdministratorStamp | null>;

const accountAdministratorResolver =
  new AsyncLocalStorage<SubscriptionAccountAdministratorResolver>();

/** Run `fn` with this request's account-administrator resolver. */
export function withSubscriptionAccountAdministrators<T>(
  resolver: SubscriptionAccountAdministratorResolver,
  fn: () => Promise<T>,
): Promise<T> {
  return accountAdministratorResolver.run(resolver, fn);
}

/**
 * Set the acting subject of a subscription administration transaction and,
 * when the request proves account:admin for exactly this account and subject,
 * record that authority for the transaction so subscription_organization_admin()
 * and the subscription write policies recognise it. Organization membership
 * administrators need no record. Returns whether this transaction now holds
 * account administration from the request's proof (not from a membership).
 */
export async function setSubscriptionAdministrationSubject(
  tx: Database,
  input: { accountId: string; subjectId: string },
): Promise<boolean> {
  await setSubjectRlsContext(tx, input.subjectId);
  return await recordSubscriptionAccountAdministrator(tx, input);
}

/**
 * `setSubscriptionAdministrationSubject` for a transaction whose subject is
 * already set (for example by `withWorkspaceSubjectRls`).
 */
export async function recordSubscriptionAccountAdministrator(
  tx: Database,
  input: { accountId: string; subjectId: string },
): Promise<boolean> {
  const resolver = accountAdministratorResolver.getStore();
  if (!resolver) return false;
  const stamp = await resolver({ accountId: input.accountId, subjectId: input.subjectId });
  if (
    !stamp ||
    stamp.permission !== "account:admin" ||
    stamp.accountId !== input.accountId ||
    stamp.actorSubjectId !== input.subjectId
  ) {
    return false;
  }
  const [row] = await rawRows<{ granted: boolean }>(
    tx,
    sql`select opengeni_private.grant_subscription_account_administrator(${JSON.stringify(stamp)}::jsonb) as granted`,
  );
  return row?.granted === true;
}
