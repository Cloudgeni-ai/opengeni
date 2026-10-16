import {
  vaultErrorCode,
  type InstallOnePasswordRequest,
  type InstallOnePasswordResponse,
  type OnePasswordPlanTier,
  type ReplaceOnePasswordTokenRequest,
  type VaultSummary,
} from "@opengeni/react";
import { ArrowUpRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { userErrorText } from "@/lib/api-error";

import {
  causeOf,
  ConnectedPage,
  initialOwner,
  OwnerChoice,
  VaultChooser,
  type LinkVaultActions,
} from "./vault-chooser";
import { PLAN_LABEL, vaultErrorText } from "./vault-model";
import { connectionName, type VaultConnection } from "./vault-providers";

export type { LinkVaultActions } from "./vault-chooser";
export { ChooseVaultsPage } from "./vault-chooser";

/* ----------------------------------------------------------------------------
   Connect 1Password: three steps on one form page.
   1. Who can use it, the service account token and the 1Password plan.
   2. Pick a mode per 1Password vault, or create a managed vault.
   3. What was linked, then Done.

   An existing connection reuses step 2 (Choose vaults) and has its own
   Replace token page; neither creates a second connection.
   -------------------------------------------------------------------------- */

type Owner = InstallOnePasswordRequest["ownership"];

const TOKEN_DOCS_URL = "https://developer.1password.com/docs/service-accounts/get-started/";

const PLAN_OPTIONS: { value: OnePasswordPlanTier; label: string }[] = (
  ["family", "teams", "business"] as const
).map((value) => ({ value, label: PLAN_LABEL[value] }));

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
  const [owner, setOwner] = useState<Owner>(() => initialOwner(owners, defaultOwner));
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
        provider="onepassword"
        title="Choose vaults"
        description={`Connected to ${account}. Pick what agents can use; you can change this later.`}
        providerVaults={connection.vaults}
        linkedVaults={[]}
        owner={owner}
        connectionId={connection.connectionId}
        canCreateManaged
        cancelLabel="Skip for now"
        onClose={() => setLinked([])}
        actions={actions}
        onLinked={setLinked}
      />
    );
  }
  return (
    <ConnectedPage
      provider="onepassword"
      linked={linked}
      onClose={onClose}
      onOpenVault={actions.openVault}
    />
  );
}

/* ------------------------------------------------------------ step 1 */

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
    setTokenError(vaultErrorText(error, undefined, "1Password"));
  } else {
    setFormError(vaultErrorText(error, undefined, "1Password"));
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
        <OwnerChoice
          owners={owners}
          owner={owner}
          onOwnerChange={onOwnerChange}
          organizationName={organizationName}
        />
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
  connection: VaultConnection;
  onClose: () => void;
  onReplace: (request: ReplaceOnePasswordTokenRequest) => Promise<void>;
}) {
  const [plan, setPlan] = useState<OnePasswordPlanTier>(connection.planTier ?? "business");
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
