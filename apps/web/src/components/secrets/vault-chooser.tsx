import { isValidSecretName, VAULT_LIMITS } from "@opengeni/contracts";
import type { ProviderVaultMeta, VaultMode, VaultSummary } from "@opengeni/react";
import { Building2Icon, PlusIcon, UserIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { FormDialog } from "@/components/ui/form-dialog";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { Section } from "@/components/ui/section";
import { SelectMenu } from "@/components/ui/select-menu";

import { ProviderTile } from "./provider-marks";
import {
  connectionOwnerLabel,
  MODE_LABEL,
  vaultErrorText,
  type ConnectionOwner,
} from "./vault-model";
import { SecretsLoadFailure, VaultTile } from "./vault-parts";
import {
  connectionName,
  PROVIDERS,
  type VaultConnection,
  type VaultProviderId,
} from "./vault-providers";

/* ----------------------------------------------------------------------------
   The steps every password manager shares once it is connected: who can use
   it, which of its vaults agents use (and how), and what was linked. Connect
   pages and a connection's Choose vaults page compose these.
   -------------------------------------------------------------------------- */

type Choice = "off" | VaultMode;

export function causeOf(error: unknown): unknown {
  return (error as { cause?: unknown } | null)?.cause ?? error;
}

export interface LinkVaultActions {
  link: (
    vault: ProviderVaultMeta,
    mode: VaultMode,
    owner: ConnectionOwner,
    connectionId: string,
    provider: VaultProviderId,
  ) => Promise<VaultSummary>;
  createManaged: (
    name: string,
    owner: ConnectionOwner,
    connectionId: string,
  ) => Promise<VaultSummary>;
  openVault: (vault: VaultSummary) => void;
}

/* ------------------------------------------------------------ who can use it */

const OWNER_ICON: Record<ConnectionOwner, ReactNode> = {
  user: <UserIcon />,
  workspace: <UsersIcon />,
  organization: <Building2Icon />,
};

export function ownerConsequence(owner: ConnectionOwner, organizationName: string): string {
  return owner === "user"
    ? "Only you, and only work you start, can use its vaults. Nobody else sees them."
    : owner === "workspace"
      ? "Everyone in this workspace and their agents can use its vaults."
      : `Workspaces in ${organizationName} can use its vaults. Choose which per vault later.`;
}

/** The owner this person starts on: the one asked for, else This workspace, else the first. */
export function initialOwner(
  owners: ConnectionOwner[],
  requested: ConnectionOwner | undefined,
): ConnectionOwner {
  if (requested && owners.includes(requested)) return requested;
  return owners.includes("workspace") ? "workspace" : (owners[0] ?? "user");
}

/** "Who can use it": choice cards when there is a choice, else the one consequence. */
export function OwnerChoice({
  owners,
  owner,
  onOwnerChange,
  organizationName,
}: {
  owners: ConnectionOwner[];
  owner: ConnectionOwner;
  onOwnerChange: (owner: ConnectionOwner) => void;
  organizationName: string;
}) {
  if (owners.length <= 1) {
    return (
      <p className="m-0 text-sm leading-5 text-fg-muted">
        {ownerConsequence(owner, organizationName)}
      </p>
    );
  }
  return (
    <ChoiceCards
      label="Who can use it"
      value={owner}
      onValueChange={(value) => onOwnerChange(value as ConnectionOwner)}
      layout={owners.length === 2 ? "grid" : "stack"}
    >
      {owners.map((value) => (
        <ChoiceCard
          key={value}
          value={value}
          icon={OWNER_ICON[value]}
          title={connectionOwnerLabel(value)}
          description={ownerConsequence(value, organizationName)}
        />
      ))}
    </ChoiceCards>
  );
}

/* ------------------------------------------------------------ choose vaults */

/** Who the provider granted access to, as the subject of a sentence. */
const GRANTEE: Record<VaultProviderId, string> = {
  onepassword: "This service account",
  protonpass: "This token",
  keeper: "This application",
  bitwarden: "The bridge",
  external: "Your service",
};

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function itemCountLabel(count: number | null): string | undefined {
  if (count === null) return undefined;
  return count === 1 ? "1 item" : `${count} items`;
}

/** Whether agents could save to this vault through the connection, as far as it says. */
export function providerVaultAccess(
  vault: ProviderVaultMeta,
): "read_only" | "read_write" | "unknown" {
  const operations = vault.operations;
  if (
    vault.writeAccess === "read_only" ||
    (operations && operations.createItemTypes.length === 0 && !operations.updateItem)
  )
    return "read_only";
  return vault.writeAccess ?? "read_write";
}

function modeOptions(
  provider: VaultProviderId,
  access: "read_only" | "read_write" | "unknown",
): { value: Choice; label: string; description: string }[] {
  const options: { value: Choice; label: string; description: string }[] = [
    { value: "off", label: "Off", description: "Agents can't use this vault." },
    {
      value: "read_only",
      label: "Read-only",
      description: "Agents use items; nothing is written back.",
    },
  ];
  if (access === "read_only") return options;
  options.push({
    value: "read_write",
    label: "Read & write",
    description:
      access === "unknown"
        ? `Agents can also save new items. ${PROVIDERS[provider].name} checks edit rights when they do.`
        : "Agents can also save new items to this vault.",
  });
  return options;
}

/** Choose vaults for a connection that already exists. */
export function ChooseVaultsPage({
  connection,
  vaults,
  loadProviderVaults,
  onClose,
  onLinked,
  actions,
}: {
  connection: VaultConnection;
  /** Opengeni vaults, to open the ones already linked. */
  vaults: VaultSummary[];
  loadProviderVaults: (signal: AbortSignal) => Promise<ProviderVaultMeta[]>;
  onClose: () => void;
  onLinked: (linked: VaultSummary[]) => void;
  actions: LinkVaultActions;
}) {
  const [state, setState] = useState<{ vaults: ProviderVaultMeta[] | null; error: unknown }>({
    vaults: null,
    error: null,
  });
  const [attemptCount, setAttemptCount] = useState(0);
  const retry = useCallback(() => setAttemptCount((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ vaults: null, error: null });
    loadProviderVaults(controller.signal)
      .then((loaded) => setState({ vaults: loaded, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ vaults: null, error });
      });
    return () => controller.abort();
  }, [loadProviderVaults, attemptCount]);

  const provider = connection.provider;
  const info = PROVIDERS[provider];
  const name = connectionName(connection);
  const description = `Pick what agents can use from ${name}. Linked ${info.vaultNoun.many} open from here.`;

  if (!state.vaults) {
    return (
      <FlushFormPage
        backLabel={name}
        onClose={onClose}
        title="Choose vaults"
        description={description}
        submitLabel="Link vaults"
        submitDisabled
      >
        {state.error ? (
          <SecretsLoadFailure
            title={
              provider === "onepassword"
                ? "Couldn't load this account's vaults"
                : `Couldn't load ${info.name} ${info.vaultNoun.many}`
            }
            error={state.error}
            onRetry={retry}
            home={info.home}
          />
        ) : (
          <div role="status" aria-label={`Loading ${info.name} ${info.vaultNoun.many}`}>
            <RowList label={`${info.name} ${info.vaultNoun.many}`} busy>
              <ListRowSkeleton count={3} />
            </RowList>
          </div>
        )}
      </FlushFormPage>
    );
  }

  return (
    <VaultChooser
      provider={provider}
      title="Choose vaults"
      description={description}
      backLabel={name}
      providerVaults={state.vaults}
      linkedVaults={vaults}
      owner={connection.ownership}
      connectionId={connection.id}
      canCreateManaged={provider === "onepassword" || connection.operations.createVault}
      cancelLabel="Cancel"
      onClose={onClose}
      actions={actions}
      onLinked={onLinked}
    />
  );
}

export function VaultChooser({
  provider,
  title,
  description,
  backLabel = "Secrets",
  providerVaults,
  linkedVaults,
  owner,
  connectionId,
  canCreateManaged,
  cancelLabel,
  onClose,
  actions,
  onLinked,
}: {
  provider: VaultProviderId;
  title: string;
  description: string;
  backLabel?: string;
  providerVaults: ProviderVaultMeta[];
  /** Opengeni vaults; a provider vault with `linkedVaultId` opens the matching one. */
  linkedVaults: VaultSummary[];
  owner: ConnectionOwner;
  connectionId: string;
  /** The provider can create a vault for Opengeni (1Password managed vaults). */
  canCreateManaged: boolean;
  cancelLabel: string;
  onClose: () => void;
  actions: LinkVaultActions;
  onLinked: (vaults: VaultSummary[]) => void;
}) {
  const info = PROVIDERS[provider];
  const grantee = GRANTEE[provider];
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [managed, setManaged] = useState<VaultSummary[]>([]);
  // Vaults linked by an earlier, partly failed submit: never linked twice.
  const [linkedNow, setLinkedNow] = useState<Record<string, VaultSummary>>({});
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<ReactNode>(null);
  const available = providerVaults.filter((vault) => !vault.linkedVaultId);
  const chosen = available.filter((vault) => (choices[vault.externalVaultId] ?? "off") !== "off");
  const allLinked = providerVaults.length > 0 && available.length === 0;
  const submitLabel =
    chosen.length === 0
      ? "Done"
      : chosen.length === 1
        ? "Link 1 vault"
        : `Link ${chosen.length} vaults`;

  return (
    <FlushFormPage
      backLabel={backLabel}
      onClose={onClose}
      title={title}
      description={description}
      submitLabel={submitLabel}
      pendingLabel="Linking…"
      cancelLabel={cancelLabel}
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const done: Record<string, VaultSummary> = { ...linkedNow };
        for (const vault of chosen) {
          if (done[vault.externalVaultId]) continue;
          try {
            const mode = choices[vault.externalVaultId] as VaultMode;
            done[vault.externalVaultId] = await actions.link(
              vault,
              mode,
              owner,
              connectionId,
              provider,
            );
          } catch (caught) {
            setFormError(`${vault.name}: ${vaultErrorText(causeOf(caught), undefined, info.home)}`);
            setLinkedNow(done);
            return false;
          }
        }
        onLinked([...managed, ...Object.values(done)]);
        return true;
      }}
    >
      <FieldStack>
        {providerVaults.length === 0 ? (
          <p className="m-0 text-sm leading-5 text-fg-muted">
            {grantee} can't see any {info.vaultNoun.many}. Give it access in {info.home}
            {canCreateManaged ? ", or create a managed vault below." : "."}
          </p>
        ) : (
          <RowList label={`${info.name} ${info.vaultNoun.many}`}>
            {providerVaults.map((vault) => {
              const linked = vault.linkedVaultId
                ? linkedVaults.find((each) => each.id === vault.linkedVaultId)
                : undefined;
              if (vault.linkedVaultId) {
                return (
                  <ListRow
                    key={vault.externalVaultId}
                    leading={<ProviderTile provider={provider} />}
                    title={vault.name}
                    description={linked ? `Linked · ${MODE_LABEL[linked.mode]}` : "Already linked"}
                    indicator={linked ? "open" : undefined}
                    onOpen={linked ? () => actions.openVault(linked) : undefined}
                  />
                );
              }
              const access = providerVaultAccess(vault);
              const count = itemCountLabel(vault.itemCount);
              const facts = [
                count,
                access === "read_only" ? `${grantee} can only read it` : undefined,
              ].filter(Boolean);
              return (
                <ListRow
                  key={vault.externalVaultId}
                  leading={<ProviderTile provider={provider} />}
                  title={vault.name}
                  description={facts.length ? facts.join(" · ") : undefined}
                  control={
                    <SelectMenu
                      aria-label={`Access to ${vault.name}`}
                      size="sm"
                      options={modeOptions(provider, access)}
                      value={choices[vault.externalVaultId] ?? "off"}
                      onValueChange={(value) =>
                        setChoices((current) => ({ ...current, [vault.externalVaultId]: value }))
                      }
                      showMetaInTrigger={false}
                    />
                  }
                />
              );
            })}
          </RowList>
        )}
        {allLinked ? (
          <p className="m-0 text-sm leading-5 text-fg-muted">
            Every {info.vaultNoun.one} {lowerFirst(grantee)} can see is linked. Give it access to
            more in {info.home} to link them here.
          </p>
        ) : null}
        {canCreateManaged ? (
          <Section
            title="Managed vault"
            description={`Opengeni creates a new vault in ${info.home} and saves the items agents create there.`}
            action={
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                <PlusIcon aria-hidden="true" />
                Create managed vault
              </Button>
            }
          >
            {managed.length > 0 ? (
              <RowList label="Managed vaults">
                {managed.map((vault) => (
                  <ListRow
                    key={vault.id}
                    leading={<VaultTile vault={vault} />}
                    title={vault.name}
                    description="Created · Read & write"
                    indicator="open"
                    onOpen={() => actions.openVault(vault)}
                  />
                ))}
              </RowList>
            ) : null}
          </Section>
        ) : null}
      </FieldStack>
      {canCreateManaged ? (
        <ManagedVaultDialog
          home={info.home}
          open={creating}
          onOpenChange={setCreating}
          onCreate={async (name) => {
            const vault = await actions.createManaged(name, owner, connectionId);
            setManaged((current) => [...current, vault]);
          }}
        />
      ) : null}
    </FlushFormPage>
  );
}

function ManagedVaultDialog({
  home,
  open,
  onOpenChange,
  onCreate,
}: {
  home: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("Opengeni");
  const [error, setError] = useState<string | undefined>();
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) setError(undefined);
        onOpenChange(next);
      }}
      size="sm"
      title="Create managed vault"
      description={`The vault is created in ${home} and linked as Read & write.`}
      submitLabel="Create vault"
      pendingLabel="Creating…"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = name.trim();
        const issue = !trimmed
          ? "Give the vault a name."
          : isValidSecretName(trimmed)
            ? undefined
            : "Names can't contain /, {, }, # or \\, or start with id:.";
        setError(issue);
        if (issue) return false;
        try {
          await onCreate(trimmed);
          return true;
        } catch (caught) {
          setError(vaultErrorText(causeOf(caught), undefined, home));
          return false;
        }
      }}
    >
      <Field label="Name" error={error}>
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={VAULT_LIMITS.nameMaxChars}
          suppressAutofill
        />
      </Field>
    </FormDialog>
  );
}

/* ------------------------------------------------------------ connected */

/** The last step: what was linked, then Done. */
export function ConnectedPage({
  provider,
  linked,
  onClose,
  onOpenVault,
}: {
  provider: VaultProviderId;
  linked: VaultSummary[];
  onClose: () => void;
  onOpenVault: (vault: VaultSummary) => void;
}) {
  const name = PROVIDERS[provider].name;
  return (
    <FlushFormPage
      backLabel="Secrets"
      onClose={onClose}
      title={`${name} connected`}
      description={
        linked.length === 0
          ? `No ${PROVIDERS[provider].vaultNoun.many} are linked yet. Open the connection under Connections on Secrets to choose them.`
          : `Agents can use ${linked.length === 1 ? "this vault" : "these vaults"} now.`
      }
      submitLabel="Done"
      cancelLabel={null}
      onSubmit={(event) => {
        event.preventDefault();
        onClose();
        return true;
      }}
    >
      {linked.length > 0 ? (
        <RowList label="Linked vaults">
          {linked.map((vault) => (
            <ListRow
              key={vault.id}
              leading={<VaultTile vault={vault} />}
              title={vault.name}
              description={MODE_LABEL[vault.mode]}
              indicator="open"
              onOpen={() => onOpenVault(vault)}
            />
          ))}
        </RowList>
      ) : null}
    </FlushFormPage>
  );
}
