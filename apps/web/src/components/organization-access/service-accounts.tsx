import type {
  ApiKey,
  CreateOrganizationServiceAccountRequest,
  OrganizationServiceAccount,
  OrganizationServiceAccountRole,
  UpdateOrganizationServiceAccountRequest,
} from "@opengeni/sdk";
import { CpuIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ModelsFormPage } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { apiErrorDetails, userErrorText } from "@/lib/api-error";
import { policySummary } from "@/lib/organization-access";

/* ----------------------------------------------------------------------------
   Organization settings > Developer > Service accounts.

   An organization identity with no person behind it: what a server, CI job or
   agent that can't sign in as someone uses. Each holds API keys; its role caps
   what those keys can be given.

     (none)                     the list
     view=new-service-account   New service account
     serviceAccount=<id>        a service account's page
   -------------------------------------------------------------------------- */

export type ServiceAccountsLocation = { view?: "new-service-account"; serviceAccount?: string };

export type ServiceAccountsApi = {
  list: () => Promise<OrganizationServiceAccount[]>;
  /** One service account, read fresh when its page opens. */
  get: (id: string) => Promise<OrganizationServiceAccount>;
  create: (request: CreateOrganizationServiceAccountRequest) => Promise<OrganizationServiceAccount>;
  update: (
    id: string,
    request: UpdateOrganizationServiceAccountRequest,
  ) => Promise<OrganizationServiceAccount>;
  remove: (id: string) => Promise<void>;
  /** The organization's keys; the page shows the ones this account holds. */
  listKeys: () => Promise<ApiKey[]>;
};

export type ServiceAccountsProps = {
  api: ServiceAccountsApi;
  /** Only an organization administrator can make one an admin. */
  canMakeAdmin: boolean;
  location: ServiceAccountsLocation;
  onNavigate: (next: ServiceAccountsLocation) => void;
  /** Opens Create API key with this service account chosen. */
  onCreateKey: (serviceAccountId: string) => void;
};

export const ROLE_LABEL: Record<OrganizationServiceAccountRole, string> = {
  admin: "Admin",
  member: "Member",
};

function roleOptions(canMakeAdmin: boolean): SelectOption<OrganizationServiceAccountRole>[] {
  return [
    {
      value: "member",
      label: "Member",
      description: "Works in workspaces. Can't manage people, keys or billing.",
    },
    {
      value: "admin",
      label: "Admin",
      description: "Can also manage people, keys and billing.",
      ...(canMakeAdmin
        ? {}
        : { disabled: true, disabledReason: "Only organization admins can choose this." }),
    },
  ];
}

function keyCount(count: number): string {
  return count === 1 ? "1 key" : `${count} keys`;
}

function ServiceAccountTile() {
  return <LogoTile icon={<CpuIcon />} />;
}

const COLUMNS: RowListColumn[] = [{ id: "created", label: "Created", width: 116 }];

function useServiceAccounts(api: ServiceAccountsApi) {
  const [state, setState] = useState<{
    accounts: OrganizationServiceAccount[] | null;
    error: Error | null;
  }>({ accounts: null, error: null });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const accounts = await api.list();
      if (current === sequence.current) setState({ accounts, error: null });
    } catch (caught) {
      if (current === sequence.current)
        setState((prior) => ({
          accounts: prior.accounts,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        }));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return {
    ...state,
    refresh,
    setAccounts: (accounts: OrganizationServiceAccount[]) => setState({ accounts, error: null }),
  };
}

export function ServiceAccounts(props: ServiceAccountsProps) {
  const { api, location, onNavigate } = props;
  const { accounts, error, refresh, setAccounts } = useServiceAccounts(api);
  // Its page reads the account fresh: keys created elsewhere change its count.
  const [opened, setOpened] = useState<OrganizationServiceAccount | null>(null);
  const openedId = location.serviceAccount;
  useEffect(() => {
    setOpened(null);
    if (!openedId) return;
    let live = true;
    api
      .get(openedId)
      .then((account) => {
        if (live) setOpened(account);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, openedId]);

  if (location.view === "new-service-account") {
    return (
      <NewServiceAccountPage
        canMakeAdmin={props.canMakeAdmin}
        onClose={() => onNavigate({})}
        onCreate={async (request) => {
          const created = await api.create(request);
          setAccounts([created, ...(accounts ?? [])]);
          toast.success(`${created.name} created`);
          onNavigate({ serviceAccount: created.id });
        }}
      />
    );
  }
  if (location.serviceAccount) {
    const listed = accounts?.find((each) => each.id === location.serviceAccount) ?? null;
    const account = opened?.id === location.serviceAccount ? opened : listed;
    return (
      <ServiceAccountPage
        {...props}
        account={account}
        loading={accounts === null && !error}
        onClose={() => onNavigate({})}
        onSaved={(next) => {
          setOpened(next);
          setAccounts((accounts ?? []).map((each) => (each.id === next.id ? next : each)));
        }}
        onDeleted={() => {
          setAccounts((accounts ?? []).filter((each) => each.id !== location.serviceAccount));
          onNavigate({});
        }}
      />
    );
  }

  const create = (
    <Button type="button" onClick={() => onNavigate({ view: "new-service-account" })}>
      <PlusIcon aria-hidden="true" />
      New service account
    </Button>
  );
  let body;
  if (error && !accounts) {
    body = (
      <ErrorMessage
        variant="block"
        title="Couldn't load service accounts."
        announce
        action={<RowButton onClick={() => void refresh()}>Try again</RowButton>}
        {...apiErrorDetails(error)}
      />
    );
  } else if (!accounts) {
    body = (
      <RowList label="Service accounts" columns={COLUMNS} busy flush>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  } else if (accounts.length === 0) {
    body = (
      <EmptyState
        icon={<CpuIcon />}
        title="No service accounts yet"
        description="One for each server, CI job or agent that works without a person, holding its API keys."
        action={create}
      />
    );
  } else {
    body = (
      <RowList label="Service accounts" columns={COLUMNS} nameLabel="Service account" flush>
        {accounts.map((account) => (
          <ListRow
            key={account.id}
            leading={<ServiceAccountTile />}
            title={account.name}
            onOpen={() => onNavigate({ serviceAccount: account.id })}
            indicator="open"
            description={`${ROLE_LABEL[account.role]} · ${keyCount(account.activeKeyCount)}`}
            cells={{ created: <RelativeTime date={account.createdAt} format="date" /> }}
          />
        ))}
      </RowList>
    );
  }
  return (
    <Section
      title="Service accounts"
      description="Identities for work without a person. Each holds API keys."
      action={accounts && accounts.length > 0 ? create : undefined}
    >
      {body}
    </Section>
  );
}

function NewServiceAccountPage({
  canMakeAdmin,
  onClose,
  onCreate,
}: {
  canMakeAdmin: boolean;
  onClose: () => void;
  onCreate: (request: CreateOrganizationServiceAccountRequest) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<OrganizationServiceAccountRole>("member");
  const [nameError, setNameError] = useState<string | null>(null);
  return (
    <ModelsFormPage
      backLabel="Developer"
      onClose={onClose}
      title="New service account"
      description="For a server, CI job or agent that works without a person. Give it API keys next."
      submitLabel="Create service account"
      pendingLabel="Creating…"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setNameError("Name the service account.");
          return false;
        }
        try {
          await onCreate({
            name: trimmed,
            role,
            ...(description.trim() ? { description: description.trim() } : {}),
          });
          return false;
        } catch (error) {
          throw new Error(
            `The service account wasn't created. ${userErrorText(error, "Try again.")}`,
            { cause: error },
          );
        }
      }}
    >
      <FieldStack>
        <Field label="Name" error={nameError ?? undefined}>
          <TextInput
            value={name}
            suppressAutofill
            maxLength={200}
            placeholder="Release pipeline"
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
        </Field>
        <Field label="Description" optional>
          <TextArea
            value={description}
            rows={3}
            maxLength={500}
            placeholder="What does it do?"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field
          label="Role"
          hint={roleOptions(canMakeAdmin).find((each) => each.value === role)?.description}
        >
          <SelectMenu
            options={roleOptions(canMakeAdmin)}
            value={role}
            onValueChange={setRole}
            showMetaInTrigger={false}
            className="w-full"
          />
        </Field>
      </FieldStack>
    </ModelsFormPage>
  );
}

function ServiceAccountPage({
  api,
  canMakeAdmin,
  account,
  loading,
  onClose,
  onSaved,
  onDeleted,
  onCreateKey,
}: ServiceAccountsProps & {
  account: OrganizationServiceAccount | null;
  loading: boolean;
  onClose: () => void;
  onSaved: (next: OrganizationServiceAccount) => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState({
    name: "",
    description: "",
    role: "member" as OrganizationServiceAccountRole,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  useEffect(() => {
    if (account)
      setDraft({ name: account.name, description: account.description ?? "", role: account.role });
  }, [account]);
  useEffect(() => {
    let live = true;
    api
      .listKeys()
      .then((all) => {
        if (live) setKeys(all);
      })
      .catch(() => {
        if (live) setKeys([]);
      });
    return () => {
      live = false;
    };
  }, [api, account?.id, account?.role]);
  const held = useMemo(
    () =>
      (keys ?? []).filter(
        (key) => key.serviceAccount?.id === account?.id && key.revokedAt === null,
      ),
    [keys, account?.id],
  );
  const changed = Boolean(
    account &&
    (draft.name.trim() !== account.name ||
      (draft.description.trim() || null) !== account.description ||
      draft.role !== account.role),
  );
  const back = { label: "Developer", onClick: onClose };

  if (!account) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {loading ? (
          <RowList label="Service account" busy flush>
            <ListRowSkeleton count={1} />
          </RowList>
        ) : (
          <EmptyState
            variant="page"
            icon={<CpuIcon />}
            title="This service account doesn't exist"
            description="It was deleted, or it belongs to another organization."
          />
        )}
      </DetailPage>
    );
  }

  const narrowing = account.role === "admin" && draft.role === "member" && held.length > 0;
  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<ServiceAccountTile />}
        title={account.name}
        meta={[`${ROLE_LABEL[account.role]} · ${keyCount(account.activeKeyCount)}`]}
        actions={
          <MoreMenu label={`More for ${account.name}`}>
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
              Delete
            </DropdownMenuItem>
          </MoreMenu>
        }
      />
      <DetailPageBody
        aside={
          <DetailAside>
            <DetailAsideItem label="Created">
              <RelativeTime date={account.createdAt} />
            </DetailAsideItem>
          </DetailAside>
        }
      >
        <DetailSection title="Details">
          <div className="flex min-w-0 flex-col gap-6">
            <FieldStack>
              <Field label="Name">
                <TextInput
                  value={draft.name}
                  suppressAutofill
                  maxLength={200}
                  disabled={saving}
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.target.value });
                    setSaveError(null);
                  }}
                />
              </Field>
              <Field label="Description" optional>
                <TextArea
                  value={draft.description}
                  rows={2}
                  maxLength={500}
                  disabled={saving}
                  onChange={(event) => {
                    setDraft({ ...draft, description: event.target.value });
                    setSaveError(null);
                  }}
                />
              </Field>
              <Field
                label="Role"
                hint={
                  narrowing
                    ? "Its keys lose administrator permissions when you save."
                    : roleOptions(canMakeAdmin).find((each) => each.value === draft.role)
                        ?.description
                }
              >
                <SelectMenu
                  options={roleOptions(canMakeAdmin || account.role === "admin")}
                  value={draft.role}
                  onValueChange={(role) => {
                    setDraft({ ...draft, role });
                    setSaveError(null);
                  }}
                  disabled={saving}
                  showMetaInTrigger={false}
                  className="w-full"
                />
              </Field>
            </FieldStack>
            {saveError ? (
              <p role="alert" className="m-0 text-sm leading-5 text-danger">
                {saveError}
              </p>
            ) : null}
            {changed ? (
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setDraft({
                      name: account.name,
                      description: account.description ?? "",
                      role: account.role,
                    });
                    setSaveError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={saving || !draft.name.trim()}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      const next = await api.update(account.id, {
                        ...(draft.name.trim() !== account.name ? { name: draft.name.trim() } : {}),
                        ...((draft.description.trim() || null) !== account.description
                          ? { description: draft.description.trim() || null }
                          : {}),
                        ...(draft.role !== account.role ? { role: draft.role } : {}),
                      });
                      onSaved(next);
                      toast.success(`${next.name} updated`);
                    } catch (caught) {
                      setSaveError(
                        `The change wasn't saved. ${userErrorText(caught, "Try again.")}`,
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : null}
          </div>
        </DetailSection>
        <DetailSection
          title="API keys"
          action={
            <RowButton onClick={() => onCreateKey(account.id)}>
              <PlusIcon aria-hidden="true" />
              Create key
            </RowButton>
          }
        >
          {keys === null ? (
            <RowList label="API keys" busy flush>
              <ListRowSkeleton count={1} />
            </RowList>
          ) : held.length === 0 ? (
            <p className="m-0 text-sm leading-5 text-fg-muted">No keys yet.</p>
          ) : (
            <RowList label="API keys" flush>
              {held.map((key) => (
                <ListRow
                  key={key.id}
                  leading={<LogoTile icon={<KeyRoundIcon />} />}
                  title={key.name}
                  description={[
                    key.prefix,
                    key.policy
                      ? policySummary(key.policy)
                      : key.access === "read"
                        ? "Read only"
                        : key.access === "developer_setup"
                          ? "Developer setup"
                          : "Full access",
                  ].join(" · ")}
                />
              ))}
            </RowList>
          )}
        </DetailSection>
      </DetailPageBody>
      <DestructiveConfirm
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${account.name}?`}
        consequences={[
          account.activeKeyCount > 0
            ? `Its ${keyCount(account.activeKeyCount)} stop working now.`
            : "It has no keys.",
          "This can't be undone.",
        ]}
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          await api.remove(account.id);
          toast.success(`${account.name} deleted`);
          onDeleted();
        }}
      />
    </DetailPage>
  );
}
