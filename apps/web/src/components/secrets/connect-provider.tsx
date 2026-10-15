import {
  vaultErrorCode,
  type InstallVaultProviderRequest,
  type InstallVaultProviderResponse,
  type VaultProviderCredentials,
} from "@opengeni/sdk";
import type { VaultSummary } from "@opengeni/react";
import { ArrowUpRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FLUSH_DETAIL_PAGE_CLASS, FlushFormPage } from "@/components/ui/flush-form-page";
import { ListRow, RowList } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { SelectMenu } from "@/components/ui/select-menu";
import { userErrorText } from "@/lib/api-error";

import { FinishConnectingNotice } from "./provider-connections";
import { ProviderTile } from "./provider-marks";
import {
  causeOf,
  ConnectedPage,
  initialOwner,
  OwnerChoice,
  VaultChooser,
  type LinkVaultActions,
} from "./vault-chooser";
import { vaultErrorText, type ConnectionOwner } from "./vault-model";
import {
  connectionName,
  PROVIDER_IDS,
  PROVIDERS,
  stillPending,
  type ExternalVaultProviderKind,
  type VaultConnection,
  type VaultProviderId,
} from "./vault-providers";

/* ----------------------------------------------------------------------------
   Connect a password manager.

   The picker (S17) lists every provider as a row: logo, name, what it needs.
   A row opens that provider's own steps. 1Password keeps its own page; the
   others share three steps on one form page:
   1. Who can use it and the provider's access (a token, a one-time token, or
      a bridge address and signing secret). Secrets never sit in React state.
   2. Pick a mode per vault (or Keeper shared folder).
   3. What was linked, then Done.
   An existing connection renews its access on its own page.
   -------------------------------------------------------------------------- */

/** Why a provider can't be connected here, by provider; absent when it can. */
export type ProviderAvailability = Partial<Record<VaultProviderId, string>>;

export function ConnectPickerPage({
  unavailable,
  onClose,
  onPick,
}: {
  unavailable: ProviderAvailability;
  onClose: () => void;
  onPick: (provider: VaultProviderId) => void;
}) {
  return (
    <DetailPage back={{ label: "Secrets", onClick: onClose }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        title="Connect a password manager"
        meta={
          <p className="m-0 text-sm text-fg-muted">
            Link vaults from where your team already keeps passwords. Values stay there; agents read
            them when they run.
          </p>
        }
      />
      <div className="mt-6 min-w-0">
        <RowList label="Password managers" flush>
          {PROVIDER_IDS.map((id) => {
            const info = PROVIDERS[id];
            const reason = unavailable[id];
            return reason ? (
              <ListRow
                key={id}
                disabled
                leading={<ProviderTile provider={id} size="lg" labelled={false} />}
                title={info.name}
                meta={[info.summary]}
                indicator={{ kind: "unavailable", label: reason }}
              />
            ) : (
              <ListRow
                key={id}
                leading={<ProviderTile provider={id} size="lg" labelled={false} />}
                title={info.name}
                meta={[info.summary]}
                indicator="open"
                onOpen={() => onPick(id)}
              />
            );
          })}
        </RowList>
      </div>
    </DetailPage>
  );
}

/* ------------------------------------------------------------ credentials */

const DOCS: Partial<Record<ExternalVaultProviderKind, string>> = {
  protonpass: "https://proton.me/support/pass-access-tokens",
  keeper: "https://docs.keeper.io/en/keeperpam/secrets-manager/quick-start-guide",
};

/** Keeper regions, for one-time tokens that don't start with one. */
const KEEPER_REGIONS: { value: string; label: string }[] = [
  { value: "", label: "From the token" },
  { value: "keepersecurity.com", label: "US" },
  { value: "keepersecurity.eu", label: "EU" },
  { value: "keepersecurity.com.au", label: "Australia" },
  { value: "keepersecurity.ca", label: "Canada" },
  { value: "keepersecurity.jp", label: "Japan" },
  { value: "govcloud.keepersecurity.us", label: "US government" },
];

function DocsLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 rounded-sm font-medium og-link outline-none focus-visible:ring-2 focus-visible:ring-brand/55"
    >
      {children}
      <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
    </a>
  );
}

type FieldErrors = { secret?: string; endpoint?: string; label?: string };

const DESCRIPTION: Record<ExternalVaultProviderKind, string> = {
  protonpass:
    "Link vaults from Proton Pass with a personal access token. Values stay in Proton Pass; agents read them when they run.",
  keeper:
    "Link shared folders from Keeper Secrets Manager. Values stay in Keeper; agents read them when they run.",
  bitwarden:
    "Link vaults through a bridge you run next to the Bitwarden CLI. Your master password and unlocked vault stay on your machine.",
  external:
    "Link vaults from a service your product runs. Opengeni signs every request; your service checks who is asking and what they may see.",
};

/** The provider's access fields. Secret values are read from the form on submit. */
function CredentialFields({
  provider,
  errors,
  onEdit,
  renewing,
  region,
  onRegionChange,
}: {
  provider: ExternalVaultProviderKind;
  errors: FieldErrors;
  onEdit: (field: keyof FieldErrors) => void;
  renewing: boolean;
  region: string;
  onRegionChange: (region: string) => void;
}) {
  const secretInput = (placeholder?: string) => (
    <TextInput
      name="secret"
      type="password"
      mono
      autoComplete="off"
      spellCheck={false}
      {...(placeholder ? { placeholder } : {})}
      suppressAutofill
      data-autofocus={provider === "protonpass" || provider === "keeper" ? true : undefined}
      onChange={() => onEdit("secret")}
    />
  );
  switch (provider) {
    case "protonpass":
      return (
        <Field
          label={renewing ? "New personal access token" : "Personal access token"}
          hint={
            <>
              In Proton Pass, create a personal access token with access to the vaults you want.
              Tokens always expire: replace it here before it does.{" "}
              <DocsLink href={DOCS.protonpass!}>How to create one</DocsLink>
            </>
          }
          error={errors.secret}
        >
          {secretInput("pst_…")}
        </Field>
      );
    case "keeper":
      return (
        <>
          <Field
            label="One-time access token"
            hint={
              <>
                In Keeper Secrets Manager, add a device to your application and paste its one-time
                access token. It works once; if connecting fails, add another device.{" "}
                <DocsLink href={DOCS.keeper!}>How to get one</DocsLink>
              </>
            }
            error={errors.secret}
          >
            {secretInput("US:…")}
          </Field>
          <Field
            label="Region"
            optional
            hint="Only needed when the token doesn't start with a region, like US:."
          >
            <SelectMenu
              aria-label="Keeper region"
              options={KEEPER_REGIONS}
              value={region}
              onValueChange={onRegionChange}
              className="w-48"
            />
          </Field>
          <Notice tone="muted">
            Keeper ties a new device to the first IP address that uses it unless IP lock is off.
            Opengeni connects from this server, so keep IP lock off if its address can change.
          </Notice>
        </>
      );
    case "bitwarden":
    case "external": {
      const bridge = provider === "bitwarden";
      return (
        <>
          {provider === "external" && !renewing ? (
            <Field
              label="Name"
              optional
              hint="Shown on Secrets. Without one, the address is used."
              error={errors.label}
            >
              <TextInput
                name="label"
                maxLength={120}
                placeholder="Acme vaults"
                suppressAutofill
                data-autofocus
                onChange={() => onEdit("label")}
              />
            </Field>
          ) : null}
          <Field
            label={bridge ? "Bridge address" : "Service address"}
            hint={
              bridge
                ? "The HTTPS address of the Opengeni bridge you run next to the Bitwarden CLI."
                : "The HTTPS endpoint that answers Opengeni's vault requests."
            }
            error={errors.endpoint}
          >
            <TextInput
              name="endpoint"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                bridge
                  ? "https://bitwarden-bridge.example.com"
                  : "https://vaults.example.com/opengeni"
              }
              suppressAutofill
              data-autofocus={bridge ? true : undefined}
              onChange={() => onEdit("endpoint")}
            />
          </Field>
          <Field
            label="Signing secret"
            hint={`The secret ${bridge ? "the bridge" : "your service"} was set up with, at least 32 characters. Opengeni signs every request with it.`}
            error={errors.secret}
          >
            {secretInput()}
          </Field>
          {bridge ? (
            <Notice tone="muted">
              Opengeni never asks for your master password. Keep Bitwarden unlocked on the bridge;
              while it's locked, agents can't read its items.
            </Notice>
          ) : null}
        </>
      );
    }
  }
}

/** Reads and checks the access fields. Returns the credentials or the field errors. */
function readCredentials(
  provider: ExternalVaultProviderKind,
  form: HTMLFormElement,
  region: string,
): { credentials: VaultProviderCredentials; label?: string } | { errors: FieldErrors } {
  const data = new FormData(form);
  const secret = String(data.get("secret") ?? "").trim();
  switch (provider) {
    case "protonpass":
      if (!secret) return { errors: { secret: "Paste a personal access token." } };
      return { credentials: { provider, token: secret } };
    case "keeper":
      if (!secret) return { errors: { secret: "Paste a one-time access token." } };
      return {
        credentials: { provider, oneTimeToken: secret, ...(region ? { hostname: region } : {}) },
      };
    case "bitwarden":
    case "external": {
      const endpoint = String(data.get("endpoint") ?? "").trim();
      const label = String(data.get("label") ?? "").trim();
      const errors: FieldErrors = {};
      if (!endpoint) errors.endpoint = "Enter the address.";
      else if (!isWebAddress(endpoint))
        errors.endpoint = "Enter the full address, starting with https://.";
      if (!secret) errors.secret = "Paste the signing secret.";
      else if (secret.length < 32)
        errors.secret = "Use the full signing secret. It's at least 32 characters.";
      if (errors.endpoint || errors.secret) return { errors };
      return {
        credentials: { provider, endpoint, signingSecret: secret },
        ...(label ? { label } : {}),
      };
    }
  }
}

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Puts a provider's refusal on the field it is about and anything else on the form. */
function routeCredentialError(
  provider: ExternalVaultProviderKind,
  caught: unknown,
): { fields: FieldErrors; form: string | null } {
  const error = causeOf(caught);
  const code = vaultErrorCode(error);
  const name = PROVIDERS[provider].name;
  const remote = provider === "bitwarden" || provider === "external";
  const machine = provider === "bitwarden" ? "the bridge" : "your service";
  switch (code) {
    case "provider_auth_invalid":
    case "provider_auth_expired":
      return {
        fields: {
          secret:
            provider === "protonpass"
              ? code === "provider_auth_expired"
                ? "This token has expired. Create a new one in Proton Pass, then paste it."
                : "Proton Pass didn't accept this token. Check you copied all of it, then paste it again."
              : provider === "keeper"
                ? "Keeper didn't accept this token. One-time tokens work once: add another device in Keeper, then paste its token."
                : `${remote ? capitalized(machine) : name} didn't accept this signing secret. Check it matches the one ${machine} uses.`,
        },
        form: null,
      };
    case "provider_conflict":
      // A different account than the one this connection was made with; the server names both.
      return { fields: { secret: userErrorText(error) }, form: null };
    case "provider_unavailable":
      return remote
        ? {
            fields: {
              endpoint: `Opengeni couldn't reach ${machine} at this address. Check that it's running and reachable from this server.`,
            },
            form: null,
          }
        : { fields: {}, form: vaultErrorText(error, undefined, name) };
    case "provider_locked":
      return {
        fields: {},
        form: "Bitwarden is locked on the bridge. Unlock it there, then connect again.",
      };
    default:
      return { fields: {}, form: vaultErrorText(error, undefined, name) };
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function useCredentialForm(provider: ExternalVaultProviderKind) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<ReactNode>(null);
  const [region, setRegion] = useState("");
  const fields = (renewing: boolean) => (
    <CredentialFields
      provider={provider}
      errors={errors}
      renewing={renewing}
      region={region}
      onRegionChange={setRegion}
      onEdit={(field) => {
        if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
      }}
    />
  );
  /** Runs `send` with the form's credentials; false keeps the page open with errors. */
  const submit = async (
    form: HTMLFormElement,
    send: (read: { credentials: VaultProviderCredentials; label?: string }) => Promise<void>,
  ): Promise<boolean> => {
    setFormError(null);
    const read = readCredentials(provider, form, region);
    if ("errors" in read) {
      setErrors(read.errors);
      return false;
    }
    setErrors({});
    try {
      await send(read);
      return true;
    } catch (caught) {
      const routed = routeCredentialError(provider, caught);
      setErrors(routed.fields);
      setFormError(routed.form);
      return false;
    }
  };
  return { fields, submit, formError };
}

/* ------------------------------------------------------------ connect */

export interface ConnectProviderActions extends LinkVaultActions {
  install: (request: InstallVaultProviderRequest) => Promise<InstallVaultProviderResponse>;
  /** Checks a saved-but-pending connection again, with its saved access. */
  verify: (connectionId: string) => Promise<InstallVaultProviderResponse>;
}

export function ConnectProviderPage({
  provider,
  owners,
  defaultOwner,
  organizationName,
  onClose,
  onConnected,
  actions,
}: {
  provider: ExternalVaultProviderKind;
  /** The owners this person may connect for, in display order. */
  owners: ConnectionOwner[];
  defaultOwner?: ConnectionOwner | undefined;
  organizationName: string;
  onClose: () => void;
  /** The connection exists: refresh whatever lists it. */
  onConnected?: () => void;
  actions: ConnectProviderActions;
}) {
  const info = PROVIDERS[provider];
  const [connection, setConnection] = useState<InstallVaultProviderResponse | null>(null);
  // A Bitwarden account is one person's vault, unlocked on their machine: Only me first.
  const [owner, setOwner] = useState<ConnectionOwner>(() =>
    initialOwner(owners, defaultOwner ?? (provider === "bitwarden" ? "user" : undefined)),
  );
  const [linked, setLinked] = useState<VaultSummary[] | null>(null);
  const form = useCredentialForm(provider);

  if (!connection) {
    return (
      <FlushFormPage
        backLabel="Secrets"
        onClose={onClose}
        title={provider === "external" ? "Connect your vault service" : `Connect ${info.name}`}
        description={DESCRIPTION[provider]}
        submitLabel="Connect"
        pendingLabel={provider === "bitwarden" ? "Checking bridge…" : "Checking access…"}
        error={form.formError}
        onSubmit={async (event) => {
          event.preventDefault();
          return await form.submit(event.currentTarget, async ({ credentials, label }) => {
            const result = await actions.install({
              credentials,
              ownership: owner,
              ...(label ? { label } : {}),
            });
            setConnection(result);
            onConnected?.();
          });
        }}
      >
        <FieldStack>
          <OwnerChoice
            owners={owners}
            owner={owner}
            onOwnerChange={setOwner}
            organizationName={organizationName}
          />
          {form.fields(false)}
        </FieldStack>
      </FlushFormPage>
    );
  }
  if (connection.discoveryPending) {
    // The access is saved (a Keeper token is already spent): never ask for it again here.
    return (
      <FlushFormPage
        backLabel="Secrets"
        onClose={onClose}
        title={provider === "external" ? "Connect your vault service" : `Connect ${info.name}`}
        description={DESCRIPTION[provider]}
        submitLabel="Done"
        cancelLabel={null}
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
          return true;
        }}
      >
        <FinishConnectingNotice
          provider={provider}
          canManage
          onFinish={async () => {
            const result = stillPending(await actions.verify(connection.connectionId));
            onConnected?.();
            setConnection(result);
          }}
        />
      </FlushFormPage>
    );
  }
  if (!linked) {
    const account = connection.accountName ?? info.home;
    return (
      <VaultChooser
        provider={provider}
        title={`Choose ${info.vaultNoun.many}`}
        description={`Connected to ${account}. Pick what agents can use; you can change this later.`}
        providerVaults={connection.vaults}
        linkedVaults={[]}
        owner={owner}
        connectionId={connection.connectionId}
        canCreateManaged={connection.operations.createVault}
        cancelLabel="Skip for now"
        onClose={() => setLinked([])}
        actions={actions}
        onLinked={setLinked}
      />
    );
  }
  return (
    <ConnectedPage
      provider={provider}
      linked={linked}
      onClose={onClose}
      onOpenVault={actions.openVault}
    />
  );
}

/* ------------------------------------------------------------ renew */

const RENEW_DESCRIPTION: Record<ExternalVaultProviderKind, (name: string) => string> = {
  protonpass: (name) =>
    `Paste a new personal access token for ${name}. Linked vaults keep working and sync again right away.`,
  keeper: (name) =>
    `Add a new device to the same Keeper application and paste its one-time access token. ${name}'s linked folders keep working.`,
  bitwarden: (name) =>
    `Change where ${name}'s bridge runs or the secret it signs with. Linked vaults keep working.`,
  external: (name) =>
    `Change where ${name} runs or the secret it signs with. Linked vaults keep working.`,
};

/** New access for an existing connection. Its linked vaults keep their links. */
export function RenewCredentialsPage({
  connection,
  onClose,
  onRenew,
}: {
  connection: VaultConnection & { provider: ExternalVaultProviderKind };
  onClose: () => void;
  onRenew: (credentials: VaultProviderCredentials) => Promise<void>;
}) {
  const provider = connection.provider;
  const info = PROVIDERS[provider];
  const name = connectionName(connection);
  const form = useCredentialForm(provider);
  return (
    <FlushFormPage
      backLabel={name}
      onClose={onClose}
      title={info.renewLabel}
      description={RENEW_DESCRIPTION[provider](name)}
      submitLabel={info.renewLabel}
      pendingLabel={provider === "bitwarden" ? "Checking bridge…" : "Checking access…"}
      error={form.formError}
      onSubmit={async (event) => {
        event.preventDefault();
        return await form.submit(event.currentTarget, ({ credentials }) => onRenew(credentials));
      }}
    >
      <FieldStack>{form.fields(true)}</FieldStack>
    </FlushFormPage>
  );
}
