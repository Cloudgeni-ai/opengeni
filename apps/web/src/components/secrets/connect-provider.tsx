import {
  vaultErrorCode,
  type InstallVaultProviderRequest,
  type InstallVaultProviderResponse,
  type VaultProviderCredentials,
} from "@opengeni/sdk";
import type { VaultSummary } from "@opengeni/react";
import { ArrowUpRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { DetailPage, DetailPageHeader } from "@opengeni/react/ui/detail-page";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FLUSH_DETAIL_PAGE_CLASS, FlushFormPage } from "@opengeni/react/ui/flush-form-page";
import { ListRow, RowList } from "@opengeni/react/ui/list-row";
import { Notice } from "@opengeni/react/ui/notice";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { apiErrorFacts, userErrorText } from "@opengeni/react/ui/api-error";

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
import {
  vaultErrorText,
  type ConnectionOwner,
} from "@opengeni/react/app/components/secrets/vault-model";
import {
  connectionName,
  lockedText,
  PROVIDER_IDS,
  PROVIDERS,
  stillPending,
  type ExternalVaultProviderKind,
  type ProviderAvailability,
  type VaultConnection,
  type VaultProviderId,
} from "./vault-providers";

/* ----------------------------------------------------------------------------
   Connect a password manager.

   The picker (S17) lists every provider as a row: logo, name, what it needs.
   A row opens that provider's own steps. 1Password keeps its own page; the
   others share three steps on one form page:
   1. Who can use it and the provider's access (a token, a one-time token, an
      API key and master password, or a service address and signing secret).
      Secrets never sit in React state.
   2. Pick a mode per vault (or Keeper shared folder).
   3. What was linked, then Done.
   An existing connection renews its access on its own page.
   -------------------------------------------------------------------------- */

/** Why a provider can't be connected here, by provider; absent when it can. */
export type { ProviderAvailability };

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
  bitwarden: "https://bitwarden.com/help/personal-api-key/",
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

/** Bitwarden's cloud regions, or any other server (self-hosted Bitwarden, Vaultwarden). */
const BITWARDEN_US = "https://vault.bitwarden.com";
const BITWARDEN_SELF_HOSTED = "self-hosted";
const BITWARDEN_SERVERS: { value: string; label: string }[] = [
  { value: BITWARDEN_US, label: "bitwarden.com" },
  { value: "https://vault.bitwarden.eu", label: "bitwarden.eu" },
  { value: BITWARDEN_SELF_HOSTED, label: "Self-hosted or Vaultwarden" },
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

type FieldErrors = {
  secret?: string;
  endpoint?: string;
  label?: string;
  server?: string;
  clientId?: string;
  masterPassword?: string;
};

const DESCRIPTION: Record<ExternalVaultProviderKind, string> = {
  protonpass:
    "Link vaults from Proton Pass with a personal access token. Values stay in Proton Pass; agents read them when they run.",
  keeper:
    "Link shared folders from Keeper Secrets Manager. Values stay in Keeper; agents read them when they run.",
  bitwarden:
    "Link your vault and organization collections from Bitwarden or Vaultwarden. Values stay in Bitwarden; agents read them when they run.",
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
    case "bitwarden": {
      const server = region || BITWARDEN_US;
      const selfHosted = server === BITWARDEN_SELF_HOSTED;
      return (
        <>
          <Field
            label="Server"
            hint="Where the account lives."
            error={selfHosted ? undefined : errors.server}
          >
            <SelectMenu
              aria-label="Bitwarden server"
              options={BITWARDEN_SERVERS}
              value={server}
              onValueChange={(next) => {
                onRegionChange(next);
                onEdit("server");
              }}
              className="w-64"
            />
          </Field>
          {selfHosted ? (
            <Field
              label="Server address"
              hint="The address you open the web vault at."
              error={errors.server}
            >
              <TextInput
                name="serverUrl"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://vault.example.com"
                suppressAutofill
                data-autofocus
                onChange={() => onEdit("server")}
              />
            </Field>
          ) : null}
          <Field
            label="API key client ID"
            hint={
              <>
                In the Bitwarden web vault, open Settings, Security, Keys and choose View API key.{" "}
                <DocsLink href={DOCS.bitwarden!}>Where to find it</DocsLink>
              </>
            }
            error={errors.clientId}
          >
            <TextInput
              name="clientId"
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder="user.…"
              suppressAutofill
              data-autofocus={selfHosted ? undefined : true}
              onChange={() => onEdit("clientId")}
            />
          </Field>
          <Field label="API key client secret" error={errors.secret}>
            {secretInput()}
          </Field>
          <Field
            label="Master password"
            hint="Used once to unlock the vault. Opengeni keeps the vault's encryption key, encrypted, and never the password."
            error={errors.masterPassword}
          >
            <TextInput
              name="masterPassword"
              type="password"
              autoComplete="off"
              spellCheck={false}
              suppressAutofill
              onChange={() => onEdit("masterPassword")}
            />
          </Field>
          <Notice tone="muted">
            Agents can use everything this account can open. Give them an account of their own and
            share only the collections they need with it.
          </Notice>
        </>
      );
    }
    case "external": {
      return (
        <>
          {!renewing ? (
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
            label="Service address"
            hint="The HTTPS endpoint that answers Opengeni's vault requests."
            error={errors.endpoint}
          >
            <TextInput
              name="endpoint"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://vaults.example.com/opengeni"
              suppressAutofill
              onChange={() => onEdit("endpoint")}
            />
          </Field>
          <Field
            label="Signing secret"
            hint="The secret your service was set up with, at least 32 characters. Opengeni signs every request with it."
            error={errors.secret}
          >
            {secretInput()}
          </Field>
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
    case "bitwarden": {
      const choice = region || BITWARDEN_US;
      const serverUrl =
        choice === BITWARDEN_SELF_HOSTED ? String(data.get("serverUrl") ?? "").trim() : choice;
      const clientId = String(data.get("clientId") ?? "").trim();
      const masterPassword = String(data.get("masterPassword") ?? "");
      const errors: FieldErrors = {};
      if (!serverUrl) errors.server = "Enter the server address.";
      else if (
        !isWebAddress(
          /^[a-z][a-z0-9+.-]*:\/\//i.test(serverUrl) ? serverUrl : `https://${serverUrl}`,
        )
      )
        errors.server = "Enter the address you open the web vault at.";
      if (!clientId) errors.clientId = "Paste the client ID, which looks like user.1a2b3c…";
      else if (/^organization\./i.test(clientId))
        errors.clientId = "That's an organization key. Use the account's personal API key instead.";
      else if (!/^user\./i.test(clientId))
        errors.clientId = "A personal API key's client ID looks like user.1a2b3c…";
      if (!secret) errors.secret = "Paste the client secret.";
      if (!masterPassword) errors.masterPassword = "Enter the master password.";
      if (errors.server || errors.clientId || errors.secret || errors.masterPassword)
        return { errors };
      return {
        credentials: { provider, serverUrl, clientId, clientSecret: secret, masterPassword },
      };
    }
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
  if (provider === "bitwarden") return routeBitwardenError(error, code);
  const remote = provider === "external";
  const machine = "your service";
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
      return { fields: {}, form: lockedText(provider, "connect") };
    default:
      return { fields: {}, form: vaultErrorText(error, undefined, name) };
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Bitwarden names what it refused: the API key, the master password, or the
 * server (unreachable, not a Bitwarden server, or not allowed from here).
 * Refusals share a code and an HTTP status (401 is not "your session ended"
 * here), so the server's own sentence says which field it is about.
 */
function routeBitwardenError(
  error: unknown,
  code: string | null | undefined,
): { fields: FieldErrors; form: string | null } {
  const said = apiErrorFacts(error).serverMessage ?? "";
  switch (code) {
    case "provider_auth_invalid":
    case "provider_auth_expired":
      if (/master password/i.test(said)) {
        return {
          fields: { masterPassword: "This master password doesn't open the account." },
          form: null,
        };
      }
      if (/organization API key/i.test(said)) {
        return {
          fields: {
            clientId: "That's an organization key. Use the account's personal API key instead.",
          },
          form: null,
        };
      }
      if (/server/i.test(said) && /https|address/i.test(said)) {
        return {
          fields: { server: "Enter the server's address, starting with https://." },
          form: null,
        };
      }
      return {
        fields: {
          secret:
            "Bitwarden didn't accept this API key. Check the client ID and secret, then paste them again.",
        },
        form: null,
      };
    case "provider_conflict":
      return { fields: { secret: userErrorText(error) }, form: null };
    case "provider_unavailable":
      // Unreachable, not a Bitwarden server, an API on another site, or an
      // unsupported account format: the server's sentence names which.
      return {
        fields: {
          server: said
            ? /[.!?]$/.test(said)
              ? said
              : `${said}.`
            : "Opengeni couldn't reach a Bitwarden server at this address.",
        },
        form: null,
      };
    default:
      return { fields: {}, form: vaultErrorText(error, undefined, "Bitwarden") };
  }
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
  /**
   * Opens new access for this same connection, when its saved access is
   * refused. Never a second setup: a spent one-time token isn't sent again.
   */
  renew?: (connectionId: string) => void | Promise<void>;
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
  // A Bitwarden account is usually one person's vault: Only me first.
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
        pendingLabel="Checking access…"
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
          onRenew={actions.renew ? () => void actions.renew?.(connection.connectionId) : undefined}
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
    `Enter ${name}'s API key and master password again, for example after rotating the account's encryption key. Linked vaults and collections keep working.`,
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
      pendingLabel="Checking access…"
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
