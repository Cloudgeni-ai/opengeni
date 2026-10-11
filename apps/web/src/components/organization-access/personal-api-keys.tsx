import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { KeyRoundIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ModelsFormPage } from "@/components/models/models-ui";
import {
  OrganizationAccessFields,
  type AccessWorkspace,
} from "@/components/organization-access/organization-access-fields";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretOnce } from "@/components/ui/secret-field";
import { Section } from "@/components/ui/section";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import { apiErrorDetails, userErrorText, userErrorTextWithoutReference } from "@/lib/api-error";
import {
  policyBlockedReason,
  policySummary,
  presetPermissions,
  scopeSummary,
  type OrganizationAccessPolicy,
} from "@/lib/organization-access";

/* ----------------------------------------------------------------------------
   Organization settings > Developer > Personal API keys.

   A key that acts as you: a script or agent using it does what you can do in
   this organization, limited to the access you pick, and shows up as you. It
   follows your role: if your access shrinks, so does the key's, and leaving
   the organization revokes it. Everyone manages their own; owners and admins
   also see everyone's and can revoke them.

     (none)                    the list
     view=new-personal-key     Create personal API key, then the key once
   -------------------------------------------------------------------------- */

export type PersonalApiKey = Awaited<
  ReturnType<OpenGeniBrowserClient["listPersonalApiKeys"]>
>["apiKeys"][number];
type CreatePersonalApiKeyRequest = Parameters<OpenGeniBrowserClient["createPersonalApiKey"]>[1];

export type PersonalApiKeysApi = {
  list: () => Promise<{ apiKeys: PersonalApiKey[]; canManageAll: boolean }>;
  create: (
    request: CreatePersonalApiKeyRequest,
  ) => Promise<{ apiKey: PersonalApiKey; token: string }>;
  revoke: (apiKeyId: string) => Promise<void>;
};

export type PersonalApiKeysLocation = { view?: "new-personal-key" };

export type PersonalApiKeysProps = {
  organizationName: string;
  api: PersonalApiKeysApi;
  /** The signed-in person: their own keys read without a name. */
  currentSubjectId: string;
  workspaces: AccessWorkspace[] | null;
  location: PersonalApiKeysLocation;
  onNavigate: (next: PersonalApiKeysLocation) => void;
};

const COLUMNS: RowListColumn[] = [
  { id: "lastUsed", label: "Last used", width: 116 },
  { id: "expires", label: "Expires", width: 116 },
];

type ExpiryChoice = "30" | "90" | "365" | "never";
const EXPIRY_CHOICES: SelectOption<ExpiryChoice>[] = [
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In a year" },
  { value: "never", label: "Never" },
];

const DEFAULT_NAME = "My automation";

function fullAccess(): OrganizationAccessPolicy {
  return {
    preset: "full",
    permissions: presetPermissions("full"),
    workspaceScope: { kind: "all" },
  };
}

function expired(key: PersonalApiKey): boolean {
  return key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.now();
}

function KeyTile() {
  return <LogoTile icon={<KeyRoundIcon />} />;
}

function usePersonalApiKeys(api: PersonalApiKeysApi) {
  const [state, setState] = useState<{
    keys: PersonalApiKey[] | null;
    canManageAll: boolean;
    error: Error | null;
  }>({ keys: null, canManageAll: false, error: null });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const { apiKeys, canManageAll } = await api.list();
      if (sequence.current === current) setState({ keys: apiKeys, canManageAll, error: null });
    } catch (caught) {
      if (sequence.current === current)
        setState((previous) => ({
          ...previous,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        }));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh]);
  return { ...state, refresh };
}

export function PersonalApiKeys(props: PersonalApiKeysProps) {
  const { api, location, onNavigate } = props;
  const { keys, canManageAll, error, refresh } = usePersonalApiKeys(api);
  const [revoking, setRevoking] = useState<PersonalApiKey | null>(null);

  if (location.view === "new-personal-key") {
    return (
      <CreatePersonalApiKeyPage
        organizationName={props.organizationName}
        workspaces={props.workspaces}
        onCreate={async (request) => {
          const created = await api.create(request);
          void refresh();
          return created.token;
        }}
        onClose={() => onNavigate({})}
      />
    );
  }

  const create = (
    <Button type="button" onClick={() => onNavigate({ view: "new-personal-key" })}>
      <PlusIcon aria-hidden="true" />
      Create personal key
    </Button>
  );

  let body;
  if (error && keys === null) {
    body = (
      <ErrorMessage
        variant="block"
        title="Couldn't load personal API keys."
        announce
        action={<RowButton onClick={() => void refresh()}>Try again</RowButton>}
        {...apiErrorDetails(error)}
      >
        {userErrorTextWithoutReference(error)}
      </ErrorMessage>
    );
  } else if (keys === null) {
    body = (
      <RowList label="Personal API keys" columns={COLUMNS} busy flush>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  } else if (keys.length === 0) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title="No personal keys yet"
        description={`Give a script or an agent a key that works as you in ${props.organizationName}, with the access you choose.`}
        action={create}
        className="pt-8 pb-6"
      />
    );
  } else {
    body = (
      <RowList label="Personal API keys" columns={COLUMNS} nameLabel="Key" flush>
        {keys.map((key) => {
          const mine = key.owner.subjectId === props.currentSubjectId;
          return (
            <ListRow
              key={key.id}
              leading={<KeyTile />}
              title={key.name}
              status={
                expired(key) ? (
                  <StatusBadge variant="dot" status="expired">
                    Expired
                  </StatusBadge>
                ) : undefined
              }
              description={[
                ...(mine ? [] : [key.owner.name]),
                policySummary(key.access),
                // Every workspace is the usual case; name them only when limited.
                ...(key.access.workspaceScope.kind === "all"
                  ? []
                  : [scopeSummary(key.access.workspaceScope, props.workspaces)]),
              ].join(" · ")}
              cells={{
                lastUsed: key.lastUsedAt ? (
                  <RelativeTime date={key.lastUsedAt} />
                ) : (
                  <span className="text-fg-subtle">Never</span>
                ),
                expires: key.expiresAt ? (
                  <RelativeTime date={key.expiresAt} format="date" />
                ) : (
                  <span className="text-fg-subtle">Never</span>
                ),
              }}
              menu={
                mine || canManageAll ? (
                  <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(key)}>
                    <XIcon />
                    Revoke key…
                  </DropdownMenuItem>
                ) : undefined
              }
              menuLabel={`More actions for ${key.name}`}
            />
          );
        })}
      </RowList>
    );
  }

  const revokingMine = revoking?.owner.subjectId === props.currentSubjectId;
  return (
    <Section
      title="Personal API keys"
      description={
        canManageAll
          ? "Keys that work as the person who created them. Owners and admins see everyone's."
          : "Keys that work as you. Anything done with one shows up as you."
      }
      action={keys && keys.length > 0 ? create : undefined}
    >
      {body}
      <DestructiveConfirm
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        consequences={
          revoking
            ? [
                `Every request using ${revoking.prefix}… is refused right away.`,
                revokingMine
                  ? "Anything using it needs a new key to keep working."
                  : `${revoking.owner.name} will need to create a new key.`,
                "This can't be undone.",
              ]
            : []
        }
        confirmLabel="Revoke key"
        pendingLabel="Revoking…"
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await api.revoke(revoking.id);
          } catch (caught) {
            throw new Error(`Couldn't revoke ${revoking.name}. ${userErrorText(caught)}`, {
              cause: caught,
            });
          }
          toast.success(`Revoked ${revoking.name}`, {
            description: "Requests using it are refused from now on.",
          });
          void refresh();
        }}
      />
    </Section>
  );
}

/** Create personal API key: its own page, then the key shown once on the same page. */
export function CreatePersonalApiKeyPage({
  organizationName,
  workspaces,
  onCreate,
  onClose,
}: {
  organizationName: string;
  workspaces: AccessWorkspace[] | null;
  onCreate: (request: CreatePersonalApiKeyRequest) => Promise<string>;
  onClose: () => void;
}) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [nameError, setNameError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<OrganizationAccessPolicy>(fullAccess);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<ExpiryChoice>("90");
  const [token, setToken] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // On the one-time step focus moves to Copy, so the key isn't skipped unseen.
    if (token) pageRef.current?.querySelector<HTMLElement>("[data-slot=form-body] button")?.focus();
  }, [token]);

  if (token) {
    return (
      <div ref={pageRef} className="min-w-0">
        <ModelsFormPage
          backLabel="Developer"
          onClose={onClose}
          title="Personal key created"
          description={name.trim() || DEFAULT_NAME}
          submitLabel="I've saved it"
          cancelLabel={null}
          onSubmitted={onClose}
        >
          <SecretOnce
            value={token}
            label="key"
            details={
              <>
                Send it as a bearer token, or set it as{" "}
                <code translate="no" className="font-mono text-fg">
                  OPENGENI_API_KEY
                </code>
                . It works as you, so keep it as private as your password.
              </>
            }
          />
        </ModelsFormPage>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="min-w-0">
      <ModelsFormPage
        backLabel="Developer"
        onClose={onClose}
        title="Create personal key"
        description={`A script or agent using this key works as you in ${organizationName}: never more than you can do, and only what you choose below.`}
        submitLabel="Create key"
        pendingLabel="Creating…"
        onSubmit={async () => {
          const trimmed = name.trim();
          if (!trimmed) {
            setNameError("Name the key.");
            return false;
          }
          const blocked = policyBlockedReason(policy);
          if (blocked) {
            setAccessError(blocked);
            return false;
          }
          const expiresAt =
            expiry === "never"
              ? undefined
              : new Date(Date.now() + Number(expiry) * 24 * 60 * 60 * 1000).toISOString();
          try {
            setToken(
              await onCreate({
                name: trimmed,
                access: policy,
                ...(expiresAt ? { expiresAt } : {}),
              }),
            );
            return false;
          } catch (caught) {
            throw new Error(`The key wasn't created. ${userErrorText(caught, "Try again.")}`, {
              cause: caught,
            });
          }
        }}
      >
        <FieldStack>
          <Field label="Name" error={nameError ?? undefined}>
            <TextInput
              value={name}
              suppressAutofill
              maxLength={200}
              placeholder="Deploy script"
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
          </Field>
          <OrganizationAccessFields
            organizationName={organizationName}
            policy={policy}
            onPolicyChange={(next) => {
              setPolicy(next);
              setAccessError(null);
            }}
            workspaces={workspaces}
            includesPersonal
            {...(accessError
              ? {
                  errors: accessError.includes("workspace")
                    ? { workspaces: accessError }
                    : { permissions: accessError },
                }
              : {})}
          />
          <Field label="Expires">
            <SelectMenu
              options={EXPIRY_CHOICES}
              value={expiry}
              onValueChange={setExpiry}
              className="w-full"
            />
          </Field>
        </FieldStack>
      </ModelsFormPage>
    </div>
  );
}

/** Organization settings > Developer > Personal API keys, on the live API. */
export function OrganizationPersonalApiKeys({
  client,
  organizationId,
  organizationName,
  location,
  onNavigate,
}: {
  client: OpenGeniBrowserClient;
  organizationId: string;
  organizationName: string;
  location: PersonalApiKeysLocation;
  onNavigate: (next: PersonalApiKeysLocation) => void;
}) {
  const context = useAppContext();
  const api = useMemo<PersonalApiKeysApi>(
    () => ({
      list: async () => await client.listPersonalApiKeys(organizationId),
      create: async (request) => await client.createPersonalApiKey(organizationId, request),
      revoke: async (apiKeyId) => await client.revokePersonalApiKey(organizationId, apiKeyId),
    }),
    [client, organizationId],
  );
  // The workspaces this person can open here; a key never reaches more.
  const workspaces = useMemo(
    () =>
      context.workspaces
        .filter((workspace) => workspace.accountId === organizationId)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          personal: workspace.kind === "personal",
        }))
        .sort(
          (left, right) =>
            Number(left.personal) - Number(right.personal) || left.name.localeCompare(right.name),
        ),
    [context.workspaces, organizationId],
  );
  return (
    <PersonalApiKeys
      organizationName={organizationName}
      api={api}
      currentSubjectId={context.accessContext.subjectId}
      workspaces={workspaces}
      location={location}
      onNavigate={onNavigate}
    />
  );
}
