import type { VaultSummary } from "@opengeni/react";
import { KeyRoundIcon, PlusIcon, ShieldOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { MoreMenu } from "@/components/ui/page-actions";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section, SectionStack } from "@/components/ui/section";

import { OnePasswordMark, SecretsLoadFailure, SyncStatus, VaultChips, VaultTile } from "./vault-parts";
import { groupVaults, isMissingKeyError, itemsLabel, VAULT_GROUP_TITLE } from "./vault-model";

/* ----------------------------------------------------------------------------
   Settings › Secrets (S1): the vaults this person can use, grouped by who
   owns them. The whole row opens the vault's page.
   -------------------------------------------------------------------------- */

export const SECRETS_DESCRIPTION = "Logins, keys and files your agents can use without seeing them.";

const COLUMNS: RowListColumn[] = [
  { id: "items", label: "Items", width: 96, hideLabel: true },
  { id: "updated", label: "Updated", width: 104, hideLabel: true },
];

export type SecretsListState = "loading" | "error" | "ready";

export function SecretsListPage({
  state,
  error,
  vaults,
  canList,
  canCreate,
  canConnect,
  capabilityOff,
  agentSettingsHref,
  onRetry,
  onOpenVault,
  onNewVault,
  onConnectOnePassword,
  onOpenAgentSettings,
}: {
  state: SecretsListState;
  error: unknown;
  vaults: VaultSummary[];
  canList: boolean;
  canCreate: boolean;
  canConnect: boolean;
  /** Agents in this workspace have the Secrets capability off. */
  capabilityOff: boolean;
  agentSettingsHref: string | null;
  onRetry: () => void;
  onOpenVault: (vault: VaultSummary) => void;
  onNewVault: () => void;
  onConnectOnePassword: () => void;
  onOpenAgentSettings: () => void;
}) {
  const missingKey = state === "error" && isMissingKeyError(error);
  const empty = state === "ready" && vaults.length === 0;
  const newVaultButton = (
    <Button type="button" onClick={onNewVault} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />
      New vault
    </Button>
  );
  const headerActions =
    canList && !empty && state === "ready" && (canCreate || canConnect) ? (
      <div className="flex items-center gap-2">
        {canCreate ? newVaultButton : null}
        {canConnect ? (
          <MoreMenu label="More ways to add secrets">
            <DropdownMenuItem onSelect={onConnectOnePassword}>
              <span aria-hidden="true" className="inline-flex size-4">
                <OnePasswordMark />
              </span>
              Connect 1Password
            </DropdownMenuItem>
          </MoreMenu>
        ) : null}
      </div>
    ) : null;

  const renderRow = (vault: VaultSummary) => (
    <ListRow
      key={vault.id}
      leading={<VaultTile vault={vault} />}
      title={vault.name}
      titleAddon={<VaultChips vault={vault} />}
      description={vault.description || undefined}
      status={<SyncStatus vault={vault} />}
      cells={{
        items: itemsLabel(vault.itemCount),
        updated: <RelativeTime date={vault.updatedAt} />,
      }}
      indicator="open"
      onOpen={() => onOpenVault(vault)}
    />
  );

  let body;
  if (!canList) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title="You can't see secrets here"
        description="Ask a workspace admin for access to secrets."
      />
    );
  } else if (missingKey) {
    body = (
      <EmptyState
        variant="page"
        tone="danger"
        icon={<ShieldOffIcon />}
        title="Secrets aren't set up on this server"
        description="The server's encryption key is missing, so secrets can't be stored or read. Ask whoever runs this OpenGeni server to set it."
        action={
          <Button type="button" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  } else if (state === "loading") {
    body = (
      <RowList label="Vaults" columns={COLUMNS} flush busy>
        <ListRowSkeleton count={4} />
      </RowList>
    );
  } else if (state === "error") {
    body = <SecretsLoadFailure title="Couldn't load secrets" error={error} onRetry={onRetry} />;
  } else if (empty) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title="No vaults yet"
        description={
          canCreate
            ? "Save logins and keys once, and your agents can sign in and call APIs for you."
            : "Someone who can manage secrets can add a vault here."
        }
        action={canCreate ? newVaultButton : undefined}
      />
    );
  } else {
    body = (
      <SectionStack>
        {groupVaults(vaults).map((group) => (
          <Section
            key={group.id}
            title={
              <>
                {VAULT_GROUP_TITLE[group.id]}
                <span className="ml-2 font-normal text-fg-subtle tabular-nums">
                  {group.vaults.length}
                </span>
              </>
            }
          >
            <RowList label={`Vaults: ${VAULT_GROUP_TITLE[group.id]}`} columns={COLUMNS} flush>
              {group.vaults.map(renderRow)}
            </RowList>
          </Section>
        ))}
      </SectionStack>
    );
  }

  return (
    <div className="min-w-0">
      <PageHeader title="Secrets" description={SECRETS_DESCRIPTION} actions={headerActions} />
      {capabilityOff && canList && !missingKey ? (
        <Notice
          tone="muted"
          className="mt-6"
          actionLayout="responsive"
          action={
            agentSettingsHref ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenAgentSettings}>
                Agent settings
              </Button>
            ) : undefined
          }
        >
          Agents in this workspace can't use secrets. Turn on Secrets in agent settings.
        </Notice>
      ) : null}
      <div className="min-w-0 pt-6">{body}</div>
    </div>
  );
}
