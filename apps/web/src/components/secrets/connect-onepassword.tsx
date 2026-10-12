import { isValidSecretName, VAULT_LIMITS } from "@opengeni/contracts";
import {
  vaultErrorCode,
  type InstallOnePasswordRequest,
  type InstallOnePasswordResponse,
  type OnePasswordPlanTier,
  type ProviderVaultMeta,
  type VaultMode,
  type VaultSummary,
} from "@opengeni/react";
import { PlusIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { FormDialog } from "@/components/ui/form-dialog";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Section } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";

import { MODE_LABEL, vaultErrorText } from "./vault-model";
import { OnePasswordMark, VaultTile } from "./vault-parts";

/* ----------------------------------------------------------------------------
   Connect 1Password (S7): three steps on one form page.
   1. Token, plan and who can use the linked vaults.
   2. Pick a mode per 1Password vault, or create a managed vault.
   3. What was linked, then Done.
   -------------------------------------------------------------------------- */

type Owner = InstallOnePasswordRequest["ownership"];
type Choice = "off" | VaultMode;

const PLAN_OPTIONS: { value: OnePasswordPlanTier; label: string }[] = [
  { value: "family", label: "Family" },
  { value: "teams", label: "Teams" },
  { value: "business", label: "Business" },
];

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

export interface ConnectOnePasswordActions {
  install: (request: InstallOnePasswordRequest) => Promise<InstallOnePasswordResponse>;
  link: (
    vault: ProviderVaultMeta,
    mode: VaultMode,
    owner: Owner,
    connectionId: string,
  ) => Promise<VaultSummary>;
  createManaged: (name: string, owner: Owner, connectionId: string) => Promise<VaultSummary>;
  openVault: (vault: VaultSummary) => void;
}

export function ConnectOnePasswordPage({
  owners,
  organizationName,
  onClose,
  actions,
}: {
  /** The owners this person may link for; the first is the default. */
  owners: Owner[];
  organizationName: string;
  onClose: () => void;
  actions: ConnectOnePasswordActions;
}) {
  const [connection, setConnection] = useState<InstallOnePasswordResponse | null>(null);
  const [owner, setOwner] = useState<Owner>(owners[0] ?? "user");
  const [linked, setLinked] = useState<VaultSummary[] | null>(null);

  if (!connection) {
    return (
      <TokenStep
        owners={owners}
        owner={owner}
        onOwnerChange={setOwner}
        organizationName={organizationName}
        onClose={onClose}
        onConnected={setConnection}
        install={actions.install}
      />
    );
  }
  if (!linked) {
    return (
      <VaultsStep
        connection={connection}
        owner={owner}
        onClose={onClose}
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
          ? "No vaults are linked yet. Link one from Secrets whenever you need it."
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

function ownerLabel(owner: Owner, organizationName: string): string {
  return owner === "user" ? "Only me" : owner === "workspace" ? "This workspace" : organizationName;
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
      leading={<LogoTile icon={<OnePasswordMark />} label="1Password" />}
      title="Connect 1Password"
      description="Agents use items from the 1Password vaults you link. Values stay in 1Password."
      submitLabel="Connect"
      pendingLabel="Checking token…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        // Read the token from the form: it never sits in React state.
        const data = new FormData(event.currentTarget);
        const token = String(data.get("token") ?? "").trim();
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
          const error = causeOf(caught);
          const code = vaultErrorCode(error);
          if (code === "provider_auth_invalid" || code === "provider_auth_expired") {
            setTokenError(vaultErrorText(error));
          } else {
            setFormError(vaultErrorText(error));
          }
          return false;
        }
      }}
    >
      <FieldStack>
        <Field
          label="Service account token"
          hint="In 1Password, open Developer › Service accounts and create one with access to the vaults you want."
          error={tokenError}
        >
          <TextInput
            name="token"
            type="password"
            mono
            autoComplete="off"
            spellCheck={false}
            placeholder="ops_…"
            suppressAutofill
            onChange={() => {
              if (tokenError) setTokenError(undefined);
            }}
          />
        </Field>
        <Field
          label="1Password plan"
          hint="Sets how often OpenGeni asks 1Password for changes. Business allows the most requests."
          group
        >
          <SegmentedControl options={PLAN_OPTIONS} value={plan} onValueChange={setPlan} fullWidth />
        </Field>
        {owners.length > 1 ? (
          <Field
            label="Who can use the linked vaults"
            hint={
              owner === "user"
                ? "Only you, and only work you start."
                : owner === "workspace"
                  ? "Everyone in this workspace."
                  : `Every workspace in ${organizationName}. Change this per vault later.`
            }
            group
          >
            <SegmentedControl
              options={owners.map((value) => ({
                value,
                label:
                  value === "organization" ? "Organization" : ownerLabel(value, organizationName),
              }))}
              value={owner}
              onValueChange={onOwnerChange}
              fullWidth
            />
          </Field>
        ) : null}
      </FieldStack>
    </FlushFormPage>
  );
}

function VaultsStep({
  connection,
  owner,
  onClose,
  actions,
  onLinked,
}: {
  connection: InstallOnePasswordResponse;
  owner: Owner;
  onClose: () => void;
  actions: ConnectOnePasswordActions;
  onLinked: (vaults: VaultSummary[]) => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [managed, setManaged] = useState<VaultSummary[]>([]);
  // Vaults linked by an earlier, partly failed submit: never linked twice.
  const [linkedNow, setLinkedNow] = useState<Record<string, VaultSummary>>({});
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<ReactNode>(null);
  const available = connection.vaults.filter((vault) => !vault.linkedVaultId);
  const chosen = available.filter((vault) => (choices[vault.externalVaultId] ?? "off") !== "off");
  const total = chosen.length + managed.length;
  const account = connection.accountName ?? "your 1Password account";

  return (
    <FlushFormPage
      backLabel="Secrets"
      onClose={onClose}
      title="Choose vaults"
      description={`Connected to ${account}. Pick what agents can use; you can change this later.`}
      submitLabel={total === 0 ? "Finish" : total === 1 ? "Link 1 vault" : `Link ${total} vaults`}
      pendingLabel="Linking…"
      cancelLabel="Skip for now"
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
              connection.connectionId,
            );
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
        {connection.vaults.length === 0 ? (
          <p className="text-sm text-fg-muted">
            This service account can't see any vaults. Give it access in 1Password, or create a
            managed vault below.
          </p>
        ) : (
          <RowList label="1Password vaults">
            {connection.vaults.map((vault) => {
              const already = Boolean(vault.linkedVaultId);
              return (
                <ListRow
                  key={vault.externalVaultId}
                  leading={<LogoTile icon={<OnePasswordMark />} label="1Password" />}
                  title={vault.name}
                  description={
                    already
                      ? "Already linked"
                      : vault.itemCount === null
                        ? undefined
                        : vault.itemCount === 1
                          ? "1 item"
                          : `${vault.itemCount} items`
                  }
                  control={
                    already ? null : (
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
                    )
                  }
                />
              );
            })}
          </RowList>
        )}
        <Section
          title="Managed vault"
          description="OpenGeni creates a new vault in 1Password and saves the items agents create there."
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
          const vault = await actions.createManaged(name, owner, connection.connectionId);
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
  const [name, setName] = useState("OpenGeni");
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
