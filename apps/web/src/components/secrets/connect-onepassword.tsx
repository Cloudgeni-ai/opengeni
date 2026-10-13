import { isValidSecretName, VAULT_LIMITS } from "@opengeni/contracts";
import {
  vaultErrorCode,
  type InstallOnePasswordRequest,
  type InstallOnePasswordResponse,
  type OnePasswordConnectionSummary,
  type OnePasswordPlanTier,
  type ProviderVaultMeta,
  type ReplaceOnePasswordTokenRequest,
  type VaultMode,
  type VaultSummary,
} from "@opengeni/react";
import { ArrowUpRightIcon, Building2Icon, PlusIcon, UserIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { FormDialog } from "@/components/ui/form-dialog";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { Section } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { userErrorText } from "@/lib/api-error";

import { OnePasswordTile } from "./onepassword-connections";
import {
  connectionName,
  connectionOwnerLabel,
  MODE_LABEL,
  PLAN_LABEL,
  vaultErrorText,
} from "./vault-model";
import { SecretsLoadFailure, VaultTile } from "./vault-parts";

/* ----------------------------------------------------------------------------
   Connect 1Password: three steps on one form page.
   1. Who can use it, the service account token and the 1Password plan.
   2. Pick a mode per 1Password vault, or create a managed vault.
   3. What was linked, then Done.

   An existing connection reuses step 2 (Choose vaults) and has its own
   Replace token page; neither creates a second connection.
   -------------------------------------------------------------------------- */

type Owner = InstallOnePasswordRequest["ownership"];
type Choice = "off" | VaultMode;

const TOKEN_DOCS_URL = "https://developer.1password.com/docs/service-accounts/get-started/";

const PLAN_OPTIONS: { value: OnePasswordPlanTier; label: string }[] = (
  ["family", "teams", "business"] as const
).map((value) => ({ value, label: PLAN_LABEL[value] }));

const MODE_OPTIONS: { value: Choice; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Agents can't use this vault." },
  {
    value: "read_only",
    label: "Read-only",
    description: "Agents use items; nothing is written back.",
  },
  {
    value: "read_write",
    label: "Read & write",
    description: "Agents can also save new items to this vault.",
  },
];

function causeOf(error: unknown): unknown {
  return (error as { cause?: unknown } | null)?.cause ?? error;
}

function itemCountLabel(count: number | null): string | undefined {
  if (count === null) return undefined;
  return count === 1 ? "1 item" : `${count} items`;
}

export interface LinkVaultActions {
  link: (
    vault: ProviderVaultMeta,
    mode: VaultMode,
    owner: Owner,
    connectionId: string,
  ) => Promise<VaultSummary>;
  createManaged: (name: string, owner: Owner, connectionId: string) => Promise<VaultSummary>;
  openVault: (vault: VaultSummary) => void;
}

export interface ConnectOnePasswordActions extends LinkVaultActions {
  install: (request: InstallOnePasswordRequest) => Promise<InstallOnePasswordResponse>;
}

export function ConnectOnePasswordPage({
  owners,
  defaultOwner,
  organizationName,
  onClose,
  onConnected,
  actions,
}: {
  /** The owners this person may connect for, in display order. */
  owners: Owner[];
  /** Preselected owner, for example "user" when opened from "Only me". */
  defaultOwner?: Owner | undefined;
  organizationName: string;
  onClose: () => void;
  /** The connection exists: refresh whatever lists it. */
  onConnected?: () => void;
  actions: ConnectOnePasswordActions;
}) {
  const [connection, setConnection] = useState<InstallOnePasswordResponse | null>(null);
  const [owner, setOwner] = useState<Owner>(() =>
    defaultOwner && owners.includes(defaultOwner)
      ? defaultOwner
      : owners.includes("workspace")
        ? "workspace"
        : (owners[0] ?? "user"),
  );
  const [linked, setLinked] = useState<VaultSummary[] | null>(null);

  if (!connection) {
    return (
      <TokenStep
        owners={owners}
        owner={owner}
        onOwnerChange={setOwner}
        organizationName={organizationName}
        onClose={onClose}
        onConnected={(result) => {
          setConnection(result);
          onConnected?.();
        }}
        install={actions.install}
      />
    );
  }
  if (!linked) {
    const account = connection.accountName ?? "your 1Password account";
    return (
      <VaultChooser
        title="Choose vaults"
        description={`Connected to ${account}. Pick what agents can use; you can change this later.`}
        providerVaults={connection.vaults}
        linkedVaults={[]}
        owner={owner}
        connectionId={connection.connectionId}
        cancelLabel="Skip for now"
        onClose={() => setLinked([])}
        actions={actions}
        onLinked={setLinked}
      />
    );
  }
  return (
    <FlushFormPage
      backLabel="Secrets"
      onClose={onClose}
      title="1Password connected"
      description={
        linked.length === 0
          ? "No vaults are linked yet. Open the connection under 1Password on Secrets to choose them."
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
              onOpen={() => actions.openVault(vault)}
            />
          ))}
        </RowList>
      ) : null}
    </FlushFormPage>
  );
}

/* ------------------------------------------------------------ step 1 */

const OWNER_ICON: Record<Owner, ReactNode> = {
  user: <UserIcon />,
  workspace: <UsersIcon />,
  organization: <Building2Icon />,
};

function ownerConsequence(owner: Owner, organizationName: string): string {
  return owner === "user"
    ? "Only you, and only work you start, can use its vaults. Nobody else sees them."
    : owner === "workspace"
      ? "Everyone in this workspace and their agents can use its vaults."
      : `Workspaces in ${organizationName} can use its vaults. Choose which per vault later.`;
}

function TokenHint() {
  return (
    <>
      In 1Password, create a service account with access to the vaults you want, then paste its
      token.{" "}
      <a
        href={TOKEN_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 rounded-sm font-medium og-link outline-none focus-visible:ring-2 focus-visible:ring-brand/55"
      >
        How to create one
        <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
      </a>
    </>
  );
}

function TokenField({
  error,
  onEdit,
  label = "Service account token",
}: {
  error: string | undefined;
  onEdit: () => void;
  label?: string;
}) {
  return (
    <Field label={label} hint={<TokenHint />} error={error}>
      <TextInput
        name="token"
        type="password"
        mono
        autoComplete="off"
        spellCheck={false}
        placeholder="ops_…"
        suppressAutofill
        data-autofocus
        onChange={onEdit}
      />
    </Field>
  );
}

function PlanField({
  value,
  onValueChange,
}: {
  value: OnePasswordPlanTier;
  onValueChange: (value: OnePasswordPlanTier) => void;
}) {
  return (
    <Field
      label="1Password plan"
      hint="Opengeni checks for changes as often as your plan allows. If unsure, pick Business."
      group
    >
      <SegmentedControl
        options={PLAN_OPTIONS}
        value={value}
        onValueChange={onValueChange}
        fullWidth
      />
    </Field>
  );
}

/** Reads the token field; the token never sits in React state. */
function readToken(form: HTMLFormElement): string {
  return String(new FormData(form).get("token") ?? "").trim();
}

/** Puts a rejected token's message on the field and anything else on the form. */
function routeTokenError(
  caught: unknown,
  setTokenError: (message: string) => void,
  setFormError: (message: string) => void,
) {
  const error = causeOf(caught);
  const code = vaultErrorCode(error);
  if (code === "provider_conflict") {
    // The token is for a different 1Password account; the server names both.
    setTokenError(userErrorText(error));
  } else if (code === "provider_auth_invalid" || code === "provider_auth_expired") {
    setTokenError(vaultErrorText(error));
  } else {
    setFormError(vaultErrorText(error));
  }
}

function TokenStep({
  owners,
  owner,
  onOwnerChange,
  organizationName,
  onClose,
  onConnected,
  install,
}: {
  owners: Owner[];
  owner: Owner;
  onOwnerChange: (owner: Owner) => void;
  organizationName: string;
  onClose: () => void;
  onConnected: (connection: InstallOnePasswordResponse) => void;
  install: ConnectOnePasswordActions["install"];
}) {
  const [plan, setPlan] = useState<OnePasswordPlanTier>("business");
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);

  return (
    <FlushFormPage
      backLabel="Secrets"
      onClose={onClose}
      title="Connect 1Password"
      description="Link vaults from a 1Password service account. Values stay in 1Password; agents read them when they run."
      submitLabel="Connect"
      pendingLabel="Checking token…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const token = readToken(event.currentTarget);
        if (!token) {
          setTokenError("Paste a service account token.");
          return false;
        }
        setTokenError(undefined);
        try {
          const result = await install({ token, ownership: owner, planTier: plan });
          onConnected(result);
          return true;
        } catch (caught) {
          routeTokenError(caught, setTokenError, setFormError);
          return false;
        }
      }}
    >
      <FieldStack>
        {owners.length > 1 ? (
          <ChoiceCards
            label="Who can use it"
            value={owner}
            onValueChange={(value) => onOwnerChange(value as Owner)}
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
        ) : (
          <p className="m-0 text-sm leading-5 text-fg-muted">
            {ownerConsequence(owner, organizationName)}
          </p>
        )}
        <TokenField
          error={tokenError}
          onEdit={() => {
            if (tokenError) setTokenError(undefined);
          }}
        />
        <PlanField value={plan} onValueChange={setPlan} />
      </FieldStack>
    </FlushFormPage>
  );
}

/* ------------------------------------------------------------ replace token */

/** A new token for an existing connection. Its linked vaults keep their links. */
export function ReplaceTokenPage({
  connection,
  onClose,
  onReplace,
}: {
  connection: OnePasswordConnectionSummary;
  onClose: () => void;
  onReplace: (request: ReplaceOnePasswordTokenRequest) => Promise<void>;
}) {
  const [plan, setPlan] = useState<OnePasswordPlanTier>(connection.planTier);
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);
  const name = connectionName(connection);

  return (
    <FlushFormPage
      backLabel={name}
      onClose={onClose}
      title="Replace token"
      description={`Paste a new service account token for ${name}. Linked vaults keep working and sync again right away.`}
      submitLabel="Replace token"
      pendingLabel="Checking token…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const token = readToken(event.currentTarget);
        if (!token) {
          setTokenError("Paste a service account token.");
          return false;
        }
        setTokenError(undefined);
        try {
          await onReplace({ token, planTier: plan });
          return true;
        } catch (caught) {
          routeTokenError(caught, setTokenError, setFormError);
          return false;
        }
      }}
    >
      <FieldStack>
        <TokenField
          label="New service account token"
          error={tokenError}
          onEdit={() => {
            if (tokenError) setTokenError(undefined);
          }}
        />
        <PlanField value={plan} onValueChange={setPlan} />
      </FieldStack>
    </FlushFormPage>
  );
}

/* ------------------------------------------------------------ choose vaults */

/** Choose vaults for a connection that already exists. */
export function ChooseVaultsPage({
  connection,
  vaults,
  loadProviderVaults,
  onClose,
  onLinked,
  actions,
}: {
  connection: OnePasswordConnectionSummary;
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

  const name = connectionName(connection);
  const description = `Pick what agents can use from ${name}. Linked vaults open from here.`;

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
            title="Couldn't load this account's vaults"
            error={state.error}
            onRetry={retry}
          />
        ) : (
          <div role="status" aria-label="Loading 1Password vaults">
            <RowList label="1Password vaults" busy>
              <ListRowSkeleton count={3} />
            </RowList>
          </div>
        )}
      </FlushFormPage>
    );
  }

  return (
    <VaultChooser
      title="Choose vaults"
      description={description}
      backLabel={name}
      providerVaults={state.vaults}
      linkedVaults={vaults}
      owner={connection.ownership}
      connectionId={connection.id}
      cancelLabel="Cancel"
      onClose={onClose}
      actions={actions}
      onLinked={onLinked}
    />
  );
}

function VaultChooser({
  title,
  description,
  backLabel = "Secrets",
  providerVaults,
  linkedVaults,
  owner,
  connectionId,
  cancelLabel,
  onClose,
  actions,
  onLinked,
}: {
  title: string;
  description: string;
  backLabel?: string;
  providerVaults: ProviderVaultMeta[];
  /** Opengeni vaults; a provider vault with `linkedVaultId` opens the matching one. */
  linkedVaults: VaultSummary[];
  owner: Owner;
  connectionId: string;
  cancelLabel: string;
  onClose: () => void;
  actions: LinkVaultActions;
  onLinked: (vaults: VaultSummary[]) => void;
}) {
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
            done[vault.externalVaultId] = await actions.link(vault, mode, owner, connectionId);
          } catch (caught) {
            setFormError(`${vault.name}: ${vaultErrorText(causeOf(caught))}`);
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
            This service account can't see any vaults. Give it access in 1Password, or create a
            managed vault below.
          </p>
        ) : (
          <RowList label="1Password vaults">
            {providerVaults.map((vault) => {
              const linked = vault.linkedVaultId
                ? linkedVaults.find((each) => each.id === vault.linkedVaultId)
                : undefined;
              if (vault.linkedVaultId) {
                return (
                  <ListRow
                    key={vault.externalVaultId}
                    leading={<OnePasswordTile />}
                    title={vault.name}
                    description={linked ? `Linked · ${MODE_LABEL[linked.mode]}` : "Already linked"}
                    indicator={linked ? "open" : undefined}
                    onOpen={linked ? () => actions.openVault(linked) : undefined}
                  />
                );
              }
              return (
                <ListRow
                  key={vault.externalVaultId}
                  leading={<OnePasswordTile />}
                  title={vault.name}
                  description={itemCountLabel(vault.itemCount)}
                  control={
                    <SelectMenu
                      aria-label={`Access to ${vault.name}`}
                      size="sm"
                      options={MODE_OPTIONS}
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
            Every vault this service account can see is linked. Give it access to more in 1Password
            to link them here.
          </p>
        ) : null}
        <Section
          title="Managed vault"
          description="Opengeni creates a new vault in 1Password and saves the items agents create there."
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
      </FieldStack>
      <ManagedVaultDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (name) => {
          const vault = await actions.createManaged(name, owner, connectionId);
          setManaged((current) => [...current, vault]);
        }}
      />
    </FlushFormPage>
  );
}

function ManagedVaultDialog({
  open,
  onOpenChange,
  onCreate,
}: {
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
      description="The vault is created in 1Password and linked as Read & write."
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
          setError(vaultErrorText(causeOf(caught)));
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
