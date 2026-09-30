// Settings > API keys: the list of a workspace's keys, one page per key and a
// Create API key page whose second step shows the token once.
//   ?section=api-keys             the list
//   ?section=api-keys&key=new     Create API key
//   ?section=api-keys&key=<id>    a key's page
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  HashIcon,
  KeyRoundIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { SettingsHeaderActions } from "@/components/settings/settings-header-actions";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import {
  CheckboxField,
  Field,
  FieldStack,
  TextArea,
  TextInput,
  useField,
} from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretOnce } from "@/components/ui/secret-field";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import {
  API_KEY_EXPIRY_CHOICES,
  DEFAULT_API_KEY_EXPIRY,
  WORKSPACE_KEY_PERMISSION_GROUPS,
  accessLabel,
  apiKeyPresets,
  apiKeyStatus,
  countLabel,
  expiryDate,
  isWorkspaceKeyPermission,
  keyDateLabel,
  permissionLabel,
  presetById,
  presetFor,
  type ApiKeyExpiryId,
  type ApiKeyPresetId,
  type ApiKeyStatus,
} from "@/lib/api-key-presets";
import { apiErrorDetails, userErrorText } from "@/lib/api-error";
import { NEW_API_KEY } from "@/lib/api-keys-route";
import { delegableApiKeyPermissions, hasWorkspacePermission } from "@/lib/permissions";
import type { ApiKey } from "@/types";
import { FLUSH_DETAIL_PAGE_CLASS, FLUSH_FORM_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { useFocusOnNavigation } from "@/lib/use-focus-on-navigation";

const DOCS_URL = "https://docs.opengeni.ai/reference/authentication";

const COLUMNS: RowListColumn[] = [
  { id: "lastUsed", label: "Last used", width: 116 },
  { id: "expires", label: "Expires", width: 116 },
];

/** What happened, then what to do. Never the raw API error string. */
function failureText(what: string, error: unknown): string {
  return `${what} ${userErrorText(error, "Try again.")}`;
}

/* ----------------------------------------------------------------------------
   Data.
   -------------------------------------------------------------------------- */

/** Nobody administers a Personal workspace, so none of its pages offer keys. */
const PERSONAL_UNAVAILABLE = {
  title: "API keys aren't available in Personal workspaces",
  description: "Create a key in a shared workspace, where workspace admins manage them.",
} as const;

interface Keys {
  keys: ApiKey[];
  loaded: boolean;
  error: Error | null;
  canManage: boolean;
  /** A Personal workspace has no admins, so it has no API keys at all. */
  personal: boolean;
  delegable: Set<string>;
  refresh: () => Promise<void>;
  /** Adds or replaces one key in the list. */
  upsert: (key: ApiKey) => void;
  create: (request: {
    name: string;
    description?: string;
    permissions: string[];
    expiresAt?: string;
  }) => Promise<{ apiKey: ApiKey; token: string } | null>;
  /** Throws a user-facing error. Returns false when the workspace changed meanwhile. */
  revoke: (key: ApiKey) => Promise<boolean>;
}

function useWorkspaceApiKeys(workspaceId: string): Keys {
  const context = useAppContext();
  const client = context.client;
  const { captureWorkspaceInvocation, ownsWorkspaceInvocation } = context;
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "api_keys:manage");
  const personal =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.kind === "personal";
  const workspaceGrant =
    context.accessContext.workspaceGrants.find((grant) => grant.workspaceId === workspaceId) ??
    null;
  const accountGrant = context.accessContext.accountGrants.find(
    (grant) => grant.accountId === workspaceGrant?.accountId,
  );
  const delegable = delegableApiKeyPermissions(
    workspaceGrant?.permissions ?? [],
    accountGrant?.permissions ?? [],
  );

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!canManage) {
      setKeys([]);
      setError(null);
      setLoaded(true);
      return;
    }
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return;
    setLoaded(false);
    try {
      const nextApiKeys = await client.listApiKeys(workspaceId);
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return;
      setKeys(nextApiKeys);
      setError(null);
    } catch (caught) {
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return;
      setKeys([]);
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (ownsWorkspaceInvocation(workspaceId, acceptedTransition)) setLoaded(true);
    }
  }, [canManage, captureWorkspaceInvocation, client, ownsWorkspaceInvocation, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    void refresh();
  }, [refresh, workspaceId]);

  const upsert = useCallback((key: ApiKey) => {
    setKeys((current) =>
      current.some((each) => each.id === key.id)
        ? current.map((each) => (each.id === key.id ? key : each))
        : [key, ...current],
    );
  }, []);

  const create: Keys["create"] = async (request) => {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return null;
    const result = await client.createApiKey(workspaceId, {
      name: request.name,
      ...(request.description ? { description: request.description } : {}),
      permissions: request.permissions as never,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
    if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return null;
    upsert(result.apiKey);
    return result;
  };

  const revoke: Keys["revoke"] = async (key) => {
    const acceptedTransition = captureWorkspaceInvocation(workspaceId);
    if (!acceptedTransition) return false;
    let revoked: ApiKey;
    try {
      revoked = await client.deleteApiKey(workspaceId, key.id);
    } catch (caught) {
      if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return false;
      throw new Error(failureText(`Couldn't revoke ${key.name}.`, caught), {
        cause: caught,
      });
    }
    if (!ownsWorkspaceInvocation(workspaceId, acceptedTransition)) return false;
    upsert(revoked);
    return true;
  };

  return { keys, loaded, error, canManage, personal, delegable, refresh, upsert, create, revoke };
}

/* ----------------------------------------------------------------------------
   Small pieces.
   -------------------------------------------------------------------------- */

function KeyTile() {
  return <LogoTile icon={<KeyRoundIcon />} />;
}

function statusLabel(key: ApiKey, status: ApiKeyStatus): string {
  if (status === "revoked" && key.revokedAt) return `Revoked ${keyDateLabel(key.revokedAt)}`;
  if (status === "expired" && key.expiresAt) return `Expired ${keyDateLabel(key.expiresAt)}`;
  return "Active";
}

/** A fact that starts a column ("Never") but sits mid-line once the row folds ("last used never"). */
function FactWord({ children }: { children: string }) {
  return (
    <>
      <span className="@[640px]/list:hidden">{children.toLowerCase()}</span>
      <span className="hidden @[640px]/list:inline">{children}</span>
    </>
  );
}

/** What a script needs next to its key: the workspace ID, and the docs. */
function WorkspaceIdLine({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-xs leading-4.5 text-fg-muted">
      <span className="inline-flex max-w-full min-w-0 items-center gap-2">
        <span className="shrink-0">Workspace ID</span>
        <CopyField value={workspaceId} label="workspace ID" truncate="middle" />
      </span>
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/55"
      >
        API docs
        <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
      </a>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The list.
   -------------------------------------------------------------------------- */

function KeyRows({
  keys,
  label,
  now,
  onOpen,
}: {
  keys: ApiKey[];
  label: string;
  now: Date;
  onOpen: (key: ApiKey) => void;
}) {
  return (
    <RowList label={label} columns={COLUMNS} nameLabel="Key" flush>
      {keys.map((key) => {
        const status = apiKeyStatus(key, now);
        const live = status === "active";
        return (
          <ListRow
            key={key.id}
            leading={<KeyTile />}
            title={key.name}
            status={
              live ? undefined : (
                <StatusBadge status={status} variant="dot">
                  {statusLabel(key, status)}
                </StatusBadge>
              )
            }
            description={
              <>
                <span className="font-mono">{key.prefix}…</span> · {accessLabel(key.permissions)}
              </>
            }
            cells={{
              lastUsed: key.lastUsedAt ? (
                <RelativeTime date={key.lastUsedAt} />
              ) : (
                <FactWord>Never</FactWord>
              ),
              // Revoked and expired keys say when in their status instead.
              expires: live ? (
                key.expiresAt ? (
                  keyDateLabel(key.expiresAt)
                ) : (
                  <FactWord>Never</FactWord>
                )
              ) : null,
            }}
            indicator="open"
            onOpen={() => onOpen(key)}
          />
        );
      })}
    </RowList>
  );
}

function KeyList({
  workspaceId,
  data,
  onOpen,
  onCreate,
}: {
  workspaceId: string;
  data: Keys;
  onOpen: (key: ApiKey) => void;
  onCreate: () => void;
}) {
  const now = new Date();
  const live = data.keys.filter((key) => apiKeyStatus(key, now) === "active");
  const old = data.keys.filter((key) => apiKeyStatus(key, now) !== "active");
  const empty = data.loaded && !data.error && data.keys.length === 0;

  const createButton = (
    <Button type="button" onClick={onCreate} className="pointer-coarse:h-11">
      <PlusIcon aria-hidden="true" />
      Create API key
    </Button>
  );

  let body: ReactNode;
  if (!data.canManage) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        {...(data.personal
          ? PERSONAL_UNAVAILABLE
          : {
              title: "API keys are managed by workspace admins",
              description: "Ask a workspace admin to create a key for your script or app.",
            })}
      />
    );
  } else if (!data.loaded) {
    body = (
      <RowList label="API keys" columns={COLUMNS} busy flush>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  } else if (data.error) {
    body = (
      <ErrorMessage
        variant="block"
        align="center"
        title="Couldn't load API keys."
        announce
        {...apiErrorDetails(data.error)}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void data.refresh()}>
            Try again
          </Button>
        }
      >
        {userErrorText(data.error)} Your keys keep working.
      </ErrorMessage>
    );
  } else if (empty) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title="No API keys yet"
        description="Create a key to start sessions from CI, scripts or your own app."
        action={createButton}
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-6">
        {live.length > 0 ? (
          <KeyRows keys={live} label="API keys" now={now} onOpen={onOpen} />
        ) : (
          <p className="text-sm leading-5 text-fg-muted">
            No active keys. Create one, or open an old key below to replace it.
          </p>
        )}
        {old.length > 0 ? (
          <Disclosure
            title={`Revoked and expired (${old.length})`}
            summary={old.map((key) => key.name).join(", ")}
          >
            <KeyRows keys={old} label="Revoked and expired API keys" now={now} onOpen={onOpen} />
          </Disclosure>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* One primary per region: the empty state carries its own. */}
      {data.canManage && !empty ? (
        <SettingsHeaderActions>{createButton}</SettingsHeaderActions>
      ) : null}
      {data.canManage && !empty ? <WorkspaceIdLine workspaceId={workspaceId} /> : null}
      {body}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   A key's page.
   -------------------------------------------------------------------------- */

function PermissionList({ permissions }: { permissions: readonly string[] }) {
  return (
    <ul className="m-0 grid min-w-0 list-none gap-2 p-0 @[440px]/detail:grid-cols-2">
      {permissions.map((permission) => (
        <li
          key={permission}
          title={permission}
          className="flex min-w-0 items-center gap-2 text-sm leading-5 text-fg"
        >
          <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-status-idle" />
          <span className="min-w-0 truncate">{permissionLabel(permission)}</span>
        </li>
      ))}
    </ul>
  );
}

function KeyPageSkeleton() {
  return (
    <div role="status" aria-label="Loading API key" className="flex min-w-0 flex-col gap-8">
      <div className="flex items-start gap-4">
        <Skeleton className="size-10 rounded-[10px]" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-24 w-full rounded-[14px]" />
    </div>
  );
}

function KeyPage({
  workspaceId,
  data,
  keyId,
  onBack,
  onReplace,
}: {
  workspaceId: string;
  data: Keys;
  keyId: string;
  onBack: () => void;
  onReplace: (key: ApiKey) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const back = { label: "API keys", onClick: onBack };
  const apiKey = data.keys.find((key) => key.id === keyId) ?? null;

  if (data.canManage && !data.loaded) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <KeyPageSkeleton />
      </DetailPage>
    );
  }
  if (!apiKey) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<KeyRoundIcon />}
          title={
            data.canManage
              ? "This key isn't here"
              : data.personal
                ? PERSONAL_UNAVAILABLE.title
                : "API keys are managed by workspace admins"
          }
          description={
            data.error
              ? "Couldn't load API keys. Go back and try again."
              : data.canManage
                ? "It may belong to another workspace, or the link is wrong."
                : data.personal
                  ? PERSONAL_UNAVAILABLE.description
                  : "Ask a workspace admin about this key."
          }
          action={
            <Button type="button" variant="outline" onClick={onBack}>
              Back to API keys
            </Button>
          }
        />
      </DetailPage>
    );
  }

  const status = apiKeyStatus(apiKey);
  const live = status === "active";
  const permissions = apiKey.permissions;
  const preset = presetFor(permissions);

  const actions = !data.canManage ? null : live ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => setConfirmOpen(true)}
      className="rounded-[10px] text-danger hover:text-danger pointer-coarse:h-11"
    >
      Revoke key
    </Button>
  ) : (
    <Button
      type="button"
      size="sm"
      onClick={() => onReplace(apiKey)}
      className="rounded-[10px] pointer-coarse:h-11"
    >
      <RotateCcwIcon aria-hidden="true" />
      Create a replacement
    </Button>
  );

  const endLabel = status === "revoked" ? "Revoked" : status === "expired" ? "Expired" : "Expires";
  const endValue =
    status === "revoked" && apiKey.revokedAt
      ? keyDateLabel(apiKey.revokedAt)
      : apiKey.expiresAt
        ? keyDateLabel(apiKey.expiresAt)
        : "Never";

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<KeyTile />}
        title={apiKey.name}
        chips={
          <StatusBadge status={status} variant="outline">
            {statusLabel(apiKey, status)}
          </StatusBadge>
        }
        meta={[
          <span key="prefix" className="font-mono text-xs">
            {apiKey.prefix}…
          </span>,
          <span key="access" className="whitespace-nowrap">
            {accessLabel(permissions)}
          </span>,
          <span key="created" className="whitespace-nowrap">
            created {keyDateLabel(apiKey.createdAt)}
          </span>,
        ]}
        actions={actions}
      />
      <DetailPageBody
        aside={
          <DetailAside label={`${apiKey.name} details`}>
            <DetailAsideItem label="Created" icon={<CalendarIcon />}>
              {keyDateLabel(apiKey.createdAt)}
            </DetailAsideItem>
            <DetailAsideItem label="Last used" icon={<ClockIcon />}>
              {apiKey.lastUsedAt ? <RelativeTime date={apiKey.lastUsedAt} /> : "Never"}
            </DetailAsideItem>
            <DetailAsideItem label={endLabel} icon={<CalendarIcon />}>
              {endValue}
            </DetailAsideItem>
            <DetailAsideItem label="Key prefix" icon={<HashIcon />}>
              <CopyField value={apiKey.prefix} display={`${apiKey.prefix}…`} label="key prefix" />
            </DetailAsideItem>
            <DetailAsideItem label="Key ID">
              <CopyField value={apiKey.id} label="key ID" truncate="middle" />
            </DetailAsideItem>
          </DetailAside>
        }
      >
        {status === "expired" && apiKey.expiresAt ? (
          <DetailSection>
            <Notice tone="muted">
              Expired on {keyDateLabel(apiKey.expiresAt)}. Requests using it are refused. Create a
              replacement to keep {apiKey.name} running.
            </Notice>
          </DetailSection>
        ) : null}
        {status === "revoked" ? (
          <DetailSection>
            <Notice tone="muted">
              Revoked. Requests using this key are refused. Create a replacement if a script still
              needs access.
            </Notice>
          </DetailSection>
        ) : null}
        {apiKey.description ? (
          <DetailSection title="Used for">
            <p className="m-0 text-sm leading-5 break-words text-fg">{apiKey.description}</p>
          </DetailSection>
        ) : null}
        <DetailSection
          title="Access"
          description={
            preset === "custom"
              ? `Custom · ${countLabel(permissions.length)}`
              : `${presetById(preset).label} · ${countLabel(permissions.length)}`
          }
        >
          <PermissionList permissions={permissions} />
        </DetailSection>
        <DetailSection
          title="Use it"
          description="Send the key as a bearer token. Scripts also need the workspace ID."
        >
          <WorkspaceIdLine workspaceId={workspaceId} />
        </DetailSection>
      </DetailPageBody>
      <DestructiveConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="consequences"
        title={`Revoke ${apiKey.name}?`}
        consequences={[
          "Scripts and CI using this key stop working right away.",
          apiKey.lastUsedAt
            ? `Last used ${keyDateLabel(apiKey.lastUsedAt)}.`
            : "It has never been used.",
          "This can't be undone.",
        ]}
        confirmLabel="Revoke key"
        pendingLabel="Revoking…"
        onConfirm={async () => {
          const done = await data.revoke(apiKey);
          if (done) {
            toast(`Revoked ${apiKey.name}`, {
              description: "Requests using it are refused from now on.",
            });
          }
          return done;
        }}
      />
    </DetailPage>
  );
}

/* ----------------------------------------------------------------------------
   Create API key.
   -------------------------------------------------------------------------- */

export interface CreatePrefill {
  name: string;
  permissions: string[];
}

function FieldSelect<V extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<SelectOption<V>>;
  value: V;
  onChange: (value: V) => void;
  className?: string;
}) {
  const field = useField();
  return (
    <SelectMenu
      id={field?.controlId}
      options={options}
      value={value}
      onValueChange={onChange}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      showMetaInTrigger={false}
      className={className}
    />
  );
}

function fullyDelegable(permissions: readonly string[], delegable: Set<string>): boolean {
  return permissions.every((permission) => delegable.has(permission));
}

function initialAccess(prefill: CreatePrefill | null, delegable: Set<string>): ApiKeyPresetId {
  if (prefill) {
    const preset = presetFor(prefill.permissions);
    if (preset !== "custom" && fullyDelegable(presetById(preset).permissions, delegable)) {
      return preset;
    }
    return "custom";
  }
  return fullyDelegable(presetById("run_sessions").permissions, delegable)
    ? "run_sessions"
    : "custom";
}

function initialCustom(prefill: CreatePrefill | null, delegable: Set<string>): string[] {
  const source = prefill?.permissions ?? presetById("run_sessions").permissions;
  return source.filter(
    (permission) => delegable.has(permission) && isWorkspaceKeyPermission(permission),
  );
}

function CustomPermissions({
  selected,
  delegable,
  onToggle,
}: {
  selected: string[];
  delegable: Set<string>;
  onToggle: (permission: string, checked: boolean) => void;
}) {
  return (
    <div className="@container/permissions min-w-0">
      <div className="grid min-w-0 gap-x-6 gap-y-6 @[34rem]/permissions:grid-cols-2">
        {WORKSPACE_KEY_PERMISSION_GROUPS.map((group) => (
          <fieldset key={group.label} className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-2 p-0 text-xs leading-4.5 font-medium text-fg">
              {group.label}
            </legend>
            <div className="flex min-w-0 flex-col gap-3">
              {group.permissions.map((permission) => {
                const allowed = delegable.has(permission);
                return (
                  <CheckboxField
                    key={permission}
                    label={permissionLabel(permission)}
                    description={
                      <span className="font-mono">
                        {permission}
                        {allowed ? null : (
                          <span className="font-sans"> · beyond your own access</span>
                        )}
                      </span>
                    }
                    checked={allowed && selected.includes(permission)}
                    disabled={!allowed}
                    onCheckedChange={(checked) => onToggle(permission, checked)}
                  />
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

function CreateKeyPage({
  workspaceName,
  data,
  prefill,
  onClose,
  onFinished,
}: {
  workspaceName: string;
  data: Keys;
  prefill: CreatePrefill | null;
  onClose: () => void;
  onFinished: (key: ApiKey) => void;
}) {
  const [name, setName] = useState(prefill?.name ?? "");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<ApiKeyPresetId>(() =>
    initialAccess(prefill, data.delegable),
  );
  const [custom, setCustom] = useState<string[]>(() => initialCustom(prefill, data.delegable));
  const [expiry, setExpiry] = useState<ApiKeyExpiryId>(DEFAULT_API_KEY_EXPIRY);
  const [errors, setErrors] = useState<{ name?: string; permissions?: string }>({});
  const [created, setCreated] = useState<{ apiKey: ApiKey; token: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // On the one-time step focus moves to Copy, so a second Enter can't leave it unseen.
    if (created) {
      rootRef.current?.querySelector<HTMLElement>("[data-slot=form-body] button")?.focus();
    }
  }, [created]);

  if (!data.canManage) {
    return (
      <DetailPage
        back={{ label: "API keys", onClick: onClose }}
        className={FLUSH_DETAIL_PAGE_CLASS}
      >
        <EmptyState
          variant="page"
          icon={<KeyRoundIcon />}
          {...(data.personal
            ? PERSONAL_UNAVAILABLE
            : {
                title: "Only workspace admins can create API keys",
                description: "Ask a workspace admin to create a key for your script or app.",
              })}
        />
      </DetailPage>
    );
  }

  const permissions =
    access === "custom"
      ? custom
      : presetById(access).permissions.filter((permission) => data.delegable.has(permission));
  const expiresOn = expiryDate(expiry);

  const presetOptions: SelectOption<ApiKeyPresetId>[] = apiKeyPresets().map((preset) => {
    const allowed = preset.id === "custom" || fullyDelegable(preset.permissions, data.delegable);
    return {
      value: preset.id,
      label: preset.id === "custom" ? "Custom…" : preset.label,
      description: preset.description,
      ...(allowed
        ? {}
        : {
            disabled: true,
            disabledReason:
              "Needs permissions your own access doesn't include. A workspace admin can create it.",
          }),
    };
  });

  if (created) {
    const { apiKey, token } = created;
    return (
      <div ref={rootRef} className="min-w-0">
        <FormPage
          className={FLUSH_FORM_PAGE_CLASS}
          title="API key created"
          description={[
            apiKey.name,
            accessLabel(apiKey.permissions),
            apiKey.expiresAt ? `Expires ${keyDateLabel(apiKey.expiresAt)}` : "Never expires",
          ].join(" · ")}
          submitLabel="I've saved it"
          cancelLabel={null}
          onSubmit={() => true}
          onSubmitted={() => onFinished(apiKey)}
        >
          <SecretOnce value={token} />
        </FormPage>
      </div>
    );
  }

  const submit = async () => {
    const trimmed = name.trim();
    const nextErrors: typeof errors = {};
    if (!trimmed) nextErrors.name = "Give the key a name.";
    else if (
      data.keys.some(
        (key) => apiKeyStatus(key) === "active" && key.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      nextErrors.name = `There's already an active key called ${trimmed}.`;
    }
    if (permissions.length === 0) nextErrors.permissions = "Pick at least one permission.";
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.permissions) return false;
    const trimmedDescription = description.trim();
    const result = await data.create({
      name: trimmed,
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
      permissions,
      ...(expiresOn ? { expiresAt: expiresOn.toISOString() } : {}),
    });
    if (!result) return false;
    setCreated(result);
    return true;
  };

  return (
    <div ref={rootRef} className="min-w-0">
      <FormPage
        className={FLUSH_FORM_PAGE_CLASS}
        back={{ label: "API keys", onClick: onClose }}
        title="Create API key"
        description={`For scripts, CI and your own apps that work in ${workspaceName}.`}
        submitLabel="Create API key"
        pendingLabel="Creating…"
        onSubmit={async () => {
          try {
            return await submit();
          } catch (caught) {
            throw new Error(failureText("Couldn't create the key.", caught), {
              cause: caught,
            });
          }
        }}
        onCancel={onClose}
      >
        <FieldStack>
          <Field
            label="Name"
            error={errors.name}
            hint="Where the key is used, so you know what breaks when you revoke it."
          >
            <TextInput
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((current) => ({ ...current, name: undefined }));
              }}
              placeholder="e.g. CI pipeline"
              suppressAutofill
            />
          </Field>
          <Field label="Description" optional>
            <TextArea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What will this key be used for?"
              maxLength={500}
              rows={2}
            />
          </Field>
          <Field
            label="Access"
            error={access === "custom" ? undefined : errors.permissions}
            hint={
              access === "custom"
                ? "Pick exactly what this key can do. It can't do more than you can."
                : presetById(access).description
            }
          >
            <FieldSelect
              options={presetOptions}
              value={access}
              onChange={(next) => {
                setAccess(next);
                setErrors((current) => ({ ...current, permissions: undefined }));
              }}
              className="w-full"
            />
          </Field>
          {access === "custom" ? (
            <Field label="Permissions" group error={errors.permissions}>
              <CustomPermissions
                selected={custom}
                delegable={data.delegable}
                onToggle={(permission, checked) => {
                  setErrors((current) => ({ ...current, permissions: undefined }));
                  setCustom((current) =>
                    checked
                      ? [...current, permission]
                      : current.filter((each) => each !== permission),
                  );
                }}
              />
            </Field>
          ) : null}
          <Field
            label="Expires"
            hint={
              expiresOn
                ? `On ${keyDateLabel(expiresOn)}. You can create a replacement before then.`
                : "The key works until someone revokes it."
            }
          >
            <FieldSelect
              options={API_KEY_EXPIRY_CHOICES.map((choice) => {
                const date = expiryDate(choice.id);
                return {
                  value: choice.id,
                  label: choice.label,
                  ...(date ? { meta: keyDateLabel(date) } : {}),
                };
              })}
              value={expiry}
              onChange={setExpiry}
              className="w-48 max-w-full"
            />
          </Field>
        </FieldStack>
      </FormPage>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The page.
   -------------------------------------------------------------------------- */

export function WorkspaceApiKeysPage({
  workspaceId,
  keyParam,
}: {
  workspaceId: string;
  /** `new` for Create API key, a key id for its page, or the list. */
  keyParam: string | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const data = useWorkspaceApiKeys(workspaceId);
  const [prefill, setPrefill] = useState<CreatePrefill | null>(null);
  const root = useFocusOnNavigation(keyParam ?? "", {
    onList: !keyParam,
    rememberTitle: Boolean(keyParam) && keyParam !== NEW_API_KEY,
  });
  const workspaceName =
    context.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "this workspace";

  const go = (key: string | undefined) => {
    void navigate({
      to: "/workspaces/$workspaceId/settings",
      params: { workspaceId },
      search: { section: "api-keys", ...(key ? { key } : {}) },
    });
  };

  let page: ReactNode;
  if (keyParam === NEW_API_KEY) {
    page = (
      <CreateKeyPage
        // A new prefill (Create a replacement) starts a fresh form.
        key={prefill ? `replace:${prefill.name}` : "new"}
        workspaceName={workspaceName}
        data={data}
        prefill={prefill}
        onClose={() => {
          setPrefill(null);
          go(undefined);
        }}
        onFinished={(key) => {
          setPrefill(null);
          go(key.id);
        }}
      />
    );
  } else if (keyParam) {
    page = (
      <KeyPage
        workspaceId={workspaceId}
        data={data}
        keyId={keyParam}
        onBack={() => go(undefined)}
        onReplace={(key) => {
          setPrefill({ name: key.name, permissions: key.permissions });
          go(NEW_API_KEY);
        }}
      />
    );
  } else {
    page = (
      <KeyList
        workspaceId={workspaceId}
        data={data}
        onOpen={(key) => go(key.id)}
        onCreate={() => {
          setPrefill(null);
          go(NEW_API_KEY);
        }}
      />
    );
  }

  return (
    <div ref={root} className="min-w-0">
      {page}
    </div>
  );
}
