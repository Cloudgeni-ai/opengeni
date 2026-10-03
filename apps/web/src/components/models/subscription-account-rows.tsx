import { Fragment, type ReactNode } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useConnectionAccess } from "@/components/connection-access-settings";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRowSkeleton } from "@/components/ui/list-row";
import { RowButton } from "@/components/ui/page-actions";
import { NOT_IN_USE, organizationReachLabel } from "./models-ui";
import { reachesWorkspace } from "./organization-codex-models";
import { SubscriptionAccountRow } from "./subscription-account-ui";
import type { SubscriptionAccountPlaces } from "./subscription-account-detail";
import {
  subscriptionAccountName,
  type SubscriptionPoolAccount,
} from "./use-subscription-account-pool";

type Account = SubscriptionPoolAccount & { status: string };
export type SubscriptionRowsPool<T extends Account> = {
  accounts: T[];
  loading: boolean;
  loadError: string | null;
  unavailable: boolean;
  inherited: boolean;
  client: OpenGeniBrowserClient;
  organizationId?: string | undefined;
  refresh: () => Promise<void>;
  pending?: unknown;
};
export type OrganizationSubscriptionRows<T extends Account> = {
  pool: SubscriptionRowsPool<T>;
  workspace: { id: string; personal: boolean };
  openAccount: (id: string) => void;
};
export function subscriptionListedCount<T extends Account>(
  pool: SubscriptionRowsPool<T>,
  organization: OrganizationSubscriptionRows<T> | null = null,
) {
  if (pool.unavailable || pool.loading) return 0;
  if (pool.loadError || pool.pending) return 1;
  return (
    (pool.inherited ? 0 : pool.accounts.length) +
    (organization
      ? organization.pool.loadError
        ? 1
        : organization.pool.accounts.length
      : pool.inherited
        ? pool.accounts.length
        : 0)
  );
}

/** The same own/inherited/set-aside account rows at workspace and organization scope. */
export function SubscriptionAccountPoolRows<T extends Account>({
  pool,
  organization = null,
  places,
  provider,
  kind,
  providerName,
  plan,
  renderRow,
  pendingRow,
}: {
  pool: SubscriptionRowsPool<T>;
  organization?: OrganizationSubscriptionRows<T> | null;
  places: SubscriptionAccountPlaces;
  provider: "supergrok" | "claude_subscription";
  kind: "supergrok" | "claude_subscription";
  providerName: string;
  plan: (account: T) => string;
  renderRow: (account: T, onOpen: () => void, scopeLabel?: string) => ReactNode;
  pendingRow?: ReactNode;
}) {
  if (pool.unavailable) return null;
  if (pool.loading || organization?.pool.loading) return <ListRowSkeleton count={1} />;
  if (pool.loadError)
    return (
      <li className="col-span-full list-none px-3 py-3">
        <ErrorMessage
          variant="inline"
          title={`Couldn't load ${providerName} accounts.`}
          action={<RowButton onClick={() => void pool.refresh()}>Try again</RowButton>}
        >
          {pool.loadError}
        </ErrorMessage>
      </li>
    );
  const own = pool.inherited ? [] : pool.accounts;
  return (
    <>
      {organization?.pool.loadError ? (
        <li className="col-span-full list-none px-3 py-3">
          <ErrorMessage
            variant="inline"
            title={`Couldn't load shared ${providerName} accounts.`}
            action={
              <RowButton onClick={() => void organization.pool.refresh()}>Try again</RowButton>
            }
          >
            {organization.pool.loadError}
          </ErrorMessage>
        </li>
      ) : organization ? (
        organization.pool.accounts.map((account) => {
          const live = pool.inherited
            ? pool.accounts.find((candidate) => candidate.id === account.id)
            : undefined;
          return (
            <SharedRow
              key={account.id}
              account={live ?? account}
              inUse={!!live}
              ownInUse={own.length > 0}
              organization={organization}
              places={places}
              provider={provider}
              kind={kind}
              plan={plan}
              renderRow={renderRow}
            />
          );
        })
      ) : pool.inherited ? (
        pool.accounts.map((account) => (
          <Fragment key={account.id}>
            {renderRow(account, () => places.openAccount(account.id))}
          </Fragment>
        ))
      ) : null}
      {own.map((account) => (
        <Fragment key={account.id}>
          {renderRow(account, () => places.openAccount(account.id))}
        </Fragment>
      ))}
      {pendingRow}
    </>
  );
}
function SharedRow<T extends Account>({
  account,
  inUse,
  ownInUse,
  organization,
  places,
  provider,
  kind,
  plan,
  renderRow,
}: {
  account: T;
  inUse: boolean;
  ownInUse: boolean;
  organization: OrganizationSubscriptionRows<T>;
  places: SubscriptionAccountPlaces;
  provider: "supergrok" | "claude_subscription";
  kind: "supergrok" | "claude_subscription";
  plan: (account: T) => string;
  renderRow: (account: T, onOpen: () => void, scopeLabel?: string) => ReactNode;
}) {
  const access = useConnectionAccess({
    client: organization.pool.client,
    organizationId: organization.pool.organizationId,
    kind,
    connectionId: account.id,
  });
  const scopeLabel = organizationReachLabel(places.scope, access.data);
  if (inUse) return renderRow(account, () => organization.openAccount(account.id), scopeLabel);
  const reaches = reachesWorkspace(access.data, organization.workspace);
  return (
    <SubscriptionAccountRow
      provider={provider}
      title={subscriptionAccountName(account)}
      email={account.email}
      meta={[
        scopeLabel,
        plan(account),
        access.error
          ? "Couldn't check availability"
          : reaches === false
            ? `Not available in ${places.scopeName}`
            : ownInUse
              ? "Set aside while this workspace has its own"
              : null,
      ]}
      cells={{ usage: NOT_IN_USE }}
      indicator={
        account.status !== "active" ? { kind: "attention", label: "Needs reconnect" } : "open"
      }
      onOpen={() => organization.openAccount(account.id)}
    />
  );
}
