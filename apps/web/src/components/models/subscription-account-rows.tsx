import type { ReactNode } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { ListRowSkeleton } from "@opengeni/react/ui/list-row";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { accountReachLabel } from "@opengeni/react/app/components/models/models-ui";
import { ModelSettingsPlaceholder } from "@opengeni/react/app/components/models/model-settings-placeholder";
import type { SubscriptionAccountPlaces } from "./subscription-account-detail";
import {
  splitSubscriptionPool,
  type SubscriptionPoolAccount,
} from "./use-subscription-account-pool";
import { AccountGroupRows, groupEntry } from "./account-fold";

type Account = SubscriptionPoolAccount & { status: string; allocatorEnabled?: boolean };
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
  /** A workspace's name in the organization, for an account's tag. */
  workspaceName: (workspaceId: string) => string | undefined;
  openAccount: (id: string) => void;
};
export function subscriptionListedCount<T extends Account>(pool: SubscriptionRowsPool<T>) {
  if (pool.unavailable || pool.loading) return 0;
  if (pool.loadError || pool.pending) return 1;
  const { shared, own } = splitSubscriptionPool(pool);
  return own.length + shared.length;
}

/** The same own and organization account rows at workspace and organization scope. */
export function SubscriptionAccountPoolRows<T extends Account>({
  pool,
  organization = null,
  places,
  providerName,
  renderRow,
  pendingRow,
}: {
  pool: SubscriptionRowsPool<T>;
  organization?: OrganizationSubscriptionRows<T> | null;
  places: SubscriptionAccountPlaces;
  providerName: string;
  renderRow: (account: T, onOpen: () => void, scopeLabel?: ReactNode) => ReactNode;
  pendingRow?: ReactNode;
}) {
  if (pool.unavailable) return null;
  if (pool.loading) return <ListRowSkeleton count={1} />;
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
  // The organization's accounts serving here are listed once, as the
  // organization's (in use), never again as this workspace's own.
  const { shared, own } = splitSubscriptionPool(pool);
  // Every account that reaches this workspace, each once. For people who
  // manage the organization's accounts, an organization account's tag says who
  // else it reaches (once the organization's list is read; until then it waits
  // in place), and the row opens its organization page.
  const listed =
    organization && !organization.pool.loading && !organization.pool.loadError
      ? new Map(organization.pool.accounts.map((account) => [account.id, account]))
      : null;
  const entries = [
    ...shared.map((account) => {
      const organizationAccount = listed?.get(account.id);
      const scopeLabel = !organization ? undefined : organizationAccount?.reach ? (
        accountReachLabel(places.scope, organizationAccount.reach, organization.workspaceName)
      ) : organization.pool.loading ? (
        <ModelSettingsPlaceholder />
      ) : undefined;
      return groupEntry(
        account.id,
        account,
        renderRow(
          account,
          () =>
            organization && organizationAccount
              ? organization.openAccount(account.id)
              : places.openAccount(account.id),
          scopeLabel,
        ),
      );
    }),
    ...own.map((account) =>
      groupEntry(
        account.id,
        account,
        renderRow(account, () => places.openAccount(account.id)),
      ),
    ),
  ];
  // In use first; ones turned off fold away once there are several, as on the
  // organization's list.
  return (
    <>
      <AccountGroupRows title={providerName} entries={entries} />
      {pendingRow}
    </>
  );
}
