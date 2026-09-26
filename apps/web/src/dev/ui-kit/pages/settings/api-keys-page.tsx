import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRightIcon, CheckIcon, KeyRoundIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import {
  DetailBody,
  DetailFact,
  DetailFacts,
  DetailFooter,
  DetailFooterConfirm,
  DetailHeader,
  DetailInline,
  DetailPage,
  DetailSection,
  DetailSheet,
  DetailSheetContent,
} from "@/components/ui/detail-sheet";
import { DestructiveConfirm, showUndoToast } from "@/components/ui/destructive-confirm";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState, EmptyStateTemplate, EmptyStateTemplates } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { CheckboxField, Field, FieldStack, TextInput, useField } from "@/components/ui/field";
import { FormDialog, FormInline, FormPage, type FormFrameProps } from "@/components/ui/form-dialog";
import { HelpLink } from "@/components/ui/inline-help";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretOnce } from "@/components/ui/secret-field";
import { SelectMenu } from "@/components/ui/select-menu";
import { StatusBadge } from "@/components/ui/status-badge";

import {
  KIT_NOW,
  apiKeyPresets,
  currentWorkspace,
  defaultApiKeyExpiry,
  type ApiKeyAccess,
} from "../../fixtures";
import {
  DEFAULT_RAW_SCOPES,
  EXPIRY_CHOICES,
  PERMISSION_GROUPS,
  RAW_SCOPE_GROUPS,
  accessLabelFor,
  fakeToken,
  isLiveKey,
  presetPermissions,
  wait,
  type PreviewApiKey,
} from "./data";
import { useSettingsPicks } from "./picks";
import { SettingsFrame } from "./settings-frame";
import { AdminOnly, FORM_PAGE_IN_SETTINGS, absoluteTime, useFrameBase } from "./shared";
import { useSettingsPreview } from "./state";

/* ----------------------------------------------------------------------------
   Words.
   -------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "31 Mar 2027": keys show dates, not times (Oslo calendar day). */
function dateLabel(iso: string): string {
  const oslo = new Date(new Date(iso).getTime() + 2 * 60 * 60_000);
  return `${oslo.getUTCDate()} ${MONTHS[oslo.getUTCMonth()]} ${oslo.getUTCFullYear()}`;
}

function expiresText(key: PreviewApiKey): string {
  if (key.status === "revoked") return "-";
  if (key.status === "expired" && key.expiresAt) return dateLabel(key.expiresAt);
  if (!key.expiresAt) return "Never";
  return dateLabel(key.expiresAt);
}

/**
 * A fact value that starts a column ("Never") but sits mid-line once the list
 * folds its columns into the meta line on narrow widths ("Last used never").
 */
function FactWord({ children }: { children: string }) {
  const picks = useSettingsPicks();
  // Catalog rows never show columns: the fact always sits in the meta line.
  if (picks.list === "catalog") return <>{children.toLowerCase()}</>;
  return (
    <>
      <span className="@[640px]/list:hidden">{children.toLowerCase()}</span>
      <span className="hidden @[640px]/list:inline">{children}</span>
    </>
  );
}

function LastUsed({ apiKey }: { apiKey: PreviewApiKey }) {
  if (!apiKey.lastUsedAt) return <FactWord>Never</FactWord>;
  return <RelativeTime date={apiKey.lastUsedAt} now={KIT_NOW} />;
}

/** The row's access, short: the preset's name, or how many permissions a custom key has. */
function accessShort(key: PreviewApiKey): string {
  if (key.access === "custom") {
    return `${key.permissions.length} ${key.permissions.length === 1 ? "permission" : "permissions"}`;
  }
  return apiKeyPresets.find((preset) => preset.id === key.access)?.label ?? key.accessLabel;
}

function KeyStatus({ apiKey, look }: { apiKey: PreviewApiKey; look: "row" | "header" }) {
  const picks = useSettingsPicks();
  const variant = look === "row" ? picks.statusRow : picks.statusHeader;
  return (
    <StatusBadge variant={variant} status={apiKey.status}>
      {apiKey.statusLabel}
    </StatusBadge>
  );
}

/* ----------------------------------------------------------------------------
   Create API key (question 9).
   -------------------------------------------------------------------------- */

interface CreatedKey {
  key: PreviewApiKey;
  token: string;
}

const ACCESS_OPTIONS = apiKeyPresets.map((preset) => ({
  value: preset.id,
  label: preset.id === "custom" ? "Custom…" : preset.label,
  description: preset.description,
}));

function FieldSelect<V extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<{ value: V; label: string; description?: string; meta?: string }>;
  value: V;
  onChange: (value: V) => void;
  className?: string;
}) {
  const field = useField();
  const picks = useSettingsPicks();
  return (
    <SelectMenu
      variant={picks.select === "combobox" ? "menu" : picks.select}
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

/** ["Read sessions", "Start sessions"] -> "Read sessions and start sessions." */
function permissionSentence(permissions: string[]): string {
  const lower = permissions.map((permission, index) =>
    index === 0 ? permission : permission.charAt(0).toLowerCase() + permission.slice(1),
  );
  const joined =
    lower.length > 1 ? `${lower.slice(0, -1).join(", ")} and ${lower.at(-1)}` : (lower[0] ?? "");
  return `${joined}.`;
}

function CheckboxGroups({
  groups,
  selected,
  onToggle,
  mono = false,
}: {
  groups: Array<{ label: string; items: string[] }>;
  selected: string[];
  onToggle: (item: string, checked: boolean) => void;
  mono?: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-5 @[34rem]/form:grid-cols-2">
      {groups.map((group) => (
        <fieldset key={group.label} className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-2 p-0 text-xs leading-4.5 font-medium text-fg-muted">
            {group.label}
          </legend>
          <div className="flex min-w-0 flex-col gap-2.5">
            {group.items.map((item) => (
              <CheckboxField
                key={item}
                label={mono ? <span className="font-mono text-xs font-normal">{item}</span> : item}
                checked={selected.includes(item)}
                onCheckedChange={(checked) => onToggle(item, checked)}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function useCreateKeyForm({
  onClose,
  prefill,
}: {
  onClose: () => void;
  prefill?: { name: string; access: ApiKeyAccess; permissions: string[] } | null;
}) {
  const { keys, setKeys, questions, workspaceName, viewerPerson } = useSettingsPreview();
  const presets = questions.q9 === "yes";
  const [step, setStep] = useState<"form" | "secret">("form");
  const [name, setName] = useState(prefill?.name ?? "");
  const [access, setAccess] = useState<ApiKeyAccess>(prefill?.access ?? "run_sessions");
  const [custom, setCustom] = useState<string[]>(prefill?.permissions ?? []);
  const [scopes, setScopes] = useState<string[]>(DEFAULT_RAW_SCOPES);
  const [expiry, setExpiry] = useState(defaultApiKeyExpiry);
  const [errors, setErrors] = useState<{ name?: string; permissions?: string }>({});
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const reset = (next = prefill) => {
    setStep("form");
    setName(next?.name ?? "");
    setAccess(next?.access ?? "run_sessions");
    setCustom(next?.permissions ?? []);
    setScopes(DEFAULT_RAW_SCOPES);
    setExpiry(defaultApiKeyExpiry);
    setErrors({});
    setCreated(null);
  };

  const permissions = presets ? (access === "custom" ? custom : presetPermissions(access)) : scopes;
  const expiryChoice = EXPIRY_CHOICES.find((choice) => choice.id === expiry) ?? EXPIRY_CHOICES[1]!;

  const submit = async () => {
    const trimmed = name.trim();
    const nextErrors: typeof errors = {};
    if (!trimmed) nextErrors.name = "Give the key a name.";
    else if (keys.some((key) => isLiveKey(key) && key.name.toLowerCase() === trimmed.toLowerCase()))
      nextErrors.name = `There's already an active key called ${trimmed}.`;
    if (permissions.length === 0) nextErrors.permissions = "Pick at least one permission.";
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.permissions) return false;
    await wait(800);
    const seed = keys.length + 7;
    const { token, prefix } = fakeToken(seed);
    const key: PreviewApiKey = {
      id: `key-new-${seed}`,
      name: trimmed,
      prefix,
      prefixLabel: `${prefix}…`,
      access: presets ? access : "custom",
      accessLabel: presets
        ? accessLabelFor(access, permissions)
        : `Custom (${permissions.length} scopes)`,
      permissions,
      lastUsedLabel: "Never",
      expiresLabel: presets && expiryChoice.dateLabel ? expiryChoice.dateLabel : "Never",
      status: "active",
      statusLabel: "Active",
      createdLabel: `Created ${dateLabel(KIT_NOW.toISOString())}`,
      createdBy: viewerPerson.name,
      createdAt: KIT_NOW.toISOString(),
      lastUsedAt: null,
      expiresAt: presets ? expiryChoice.iso : null,
      revokedAt: null,
      isNew: true,
    };
    setKeys((current) => [key, ...current]);
    setCreated({ key, token });
    if (presets) {
      setStep("secret");
    } else {
      toast(`Created ${key.name}`);
    }
    return true;
  };

  const fields = presets ? (
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
      <Field
        label="Access"
        hint={
          access === "custom"
            ? "Pick exactly what this key can do."
            : permissionSentence(presetPermissions(access))
        }
      >
        <FieldSelect
          options={ACCESS_OPTIONS}
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
          <CheckboxGroups
            groups={PERMISSION_GROUPS.map((group) => ({
              label: group.label,
              items: group.permissions,
            }))}
            selected={custom}
            onToggle={(item, checked) => {
              setErrors((current) => ({ ...current, permissions: undefined }));
              setCustom((current) =>
                checked ? [...current, item] : current.filter((each) => each !== item),
              );
            }}
          />
        </Field>
      ) : null}
      <Field
        label="Expires"
        hint={
          expiryChoice.dateLabel
            ? `On ${expiryChoice.dateLabel}. You can create a replacement before then.`
            : "The key works until someone revokes it."
        }
      >
        <FieldSelect
          options={EXPIRY_CHOICES.map((choice) => ({
            value: choice.id,
            label: choice.label,
            meta: choice.dateLabel ?? undefined,
          }))}
          value={expiry}
          onChange={setExpiry}
          className="w-48 max-w-full"
        />
      </Field>
    </FieldStack>
  ) : (
    <FieldStack>
      <Field label="Name" error={errors.name}>
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
      <Field label="Scopes" group error={errors.permissions}>
        <CheckboxGroups
          mono
          groups={RAW_SCOPE_GROUPS.map((group) => ({ label: group.label, items: group.scopes }))}
          selected={scopes}
          onToggle={(item, checked) => {
            setErrors((current) => ({ ...current, permissions: undefined }));
            setScopes((current) =>
              checked ? [...current, item] : current.filter((each) => each !== item),
            );
          }}
        />
      </Field>
    </FieldStack>
  );

  const secret = step === "secret" && created;
  const frame: Omit<FormFrameProps, "variant"> = secret
    ? {
        title: "API key created",
        description: [
          created.key.name,
          created.key.accessLabel,
          created.key.expiresAt ? `Expires ${dateLabel(created.key.expiresAt)}` : "Never expires",
        ].join(" · "),
        submitLabel: "I've saved it",
        cancelLabel: null,
        showClose: false,
        onSubmitted: () => {
          reset(null);
          onClose();
        },
        children: <SecretOnce value={created.token} />,
      }
    : {
        title: "Create API key",
        description: `For scripts, CI and your own apps that work in ${workspaceName}.`,
        submitLabel: "Create API key",
        pendingLabel: "Creating…",
        onSubmit: submit,
        onSubmitted: presets
          ? () => undefined
          : () => {
              onClose();
            },
        onCancel: () => {
          reset(null);
          onClose();
        },
        children: fields,
      };
  return { frame, reset, secret: Boolean(secret), created };
}

function CreateKeyDialog({
  open,
  onOpenChange,
  prefill,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill: { name: string; access: ApiKeyAccess; permissions: string[] } | null;
  onCreated: (created: CreatedKey) => void;
}) {
  const form = useCreateKeyForm({ onClose: () => onOpenChange(false), prefill });
  const secretRef = useRef<HTMLDivElement>(null);
  const { reset, created, secret } = form;
  useEffect(() => {
    if (open) reset(prefill);
    // Reset only when the dialog opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (created) onCreated(created);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [created]);
  useEffect(() => {
    // On the one-time step focus moves to Copy, so a second Enter can't close it unseen.
    if (secret) secretRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [secret]);
  return (
    <FormDialog
      open={open}
      // The token shows once: only "I've saved it" closes that step, not Escape.
      onOpenChange={(next) => {
        if (!next && secret) return;
        onOpenChange(next);
      }}
      size="md"
      dismissible={!secret}
      {...form.frame}
    >
      <div ref={secretRef}>{form.frame.children}</div>
    </FormDialog>
  );
}

function CreateKeyInPage({
  layout,
  onClose,
  prefill,
  onCreated,
}: {
  layout: "page" | "inline";
  onClose: () => void;
  prefill: { name: string; access: ApiKeyAccess; permissions: string[] } | null;
  onCreated: (created: CreatedKey) => void;
}) {
  const form = useCreateKeyForm({ onClose, prefill });
  const { created } = form;
  useEffect(() => {
    if (created) onCreated(created);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [created]);
  if (layout === "page") {
    return (
      <FormPage
        {...form.frame}
        back={form.secret ? undefined : { label: "API keys", onClick: onClose }}
        className={FORM_PAGE_IN_SETTINGS}
      />
    );
  }
  return <FormInline {...form.frame} className="mb-2" />;
}

/* ----------------------------------------------------------------------------
   Key detail: sheet, page or inline (detail sheet pick).
   -------------------------------------------------------------------------- */

function PermissionList({ permissions }: { permissions: string[] }) {
  return (
    <ul className="m-0 grid min-w-0 list-none gap-2 p-0 @[440px]/detail:grid-cols-2">
      {permissions.map((permission) => (
        <li key={permission} className="flex min-w-0 items-center gap-2 text-sm text-fg">
          <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-status-idle" />
          <span className="min-w-0 truncate">{permission}</span>
        </li>
      ))}
    </ul>
  );
}

function useRevoke(onDone: () => void) {
  const { setKeys } = useSettingsPreview();
  const revoke = (key: PreviewApiKey) => {
    const before = key;
    setKeys((current) =>
      current.map((each) =>
        each.id === key.id
          ? {
              ...each,
              status: "revoked",
              statusLabel: "Revoked 26 Sep",
              revokedAt: KIT_NOW.toISOString(),
              expiresLabel: "-",
              isNew: false,
            }
          : each,
      ),
    );
    return () => setKeys((current) => current.map((each) => (each.id === key.id ? before : each)));
  };
  return {
    revokeNow: async (key: PreviewApiKey) => {
      await wait(700);
      revoke(key);
      onDone();
      toast(`Revoked ${key.name}`, { description: "Requests using it are refused from now on." });
    },
    revokeWithUndo: (key: PreviewApiKey) => {
      const undo = revoke(key);
      onDone();
      showUndoToast({
        title: `Revoked ${key.name}`,
        description: "Requests using it are refused from now on.",
        onUndo: undo,
      });
    },
  };
}

function KeyDetail({
  apiKey,
  onClose,
  onReplace,
}: {
  apiKey: PreviewApiKey;
  onClose: () => void;
  onReplace: (key: PreviewApiKey) => void;
}) {
  const { canManage } = useSettingsPreview();
  const picks = useSettingsPicks();
  const [confirming, setConfirming] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const { revokeNow, revokeWithUndo } = useRevoke(onClose);
  const live = isLiveKey(apiKey);

  const startRevoke = () => {
    if (picks.destructive === "undo") revokeWithUndo(apiKey);
    else if (picks.destructive === "type") setTypeOpen(true);
    else setConfirming(true);
  };

  const footer =
    confirming && live ? (
      <DetailFooterConfirm
        title={`Revoke ${apiKey.name}?`}
        description="Scripts using it stop working right away. This can't be undone."
        confirmLabel={pending ? "Revoking…" : "Revoke key"}
        pending={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setPending(true);
          void revokeNow(apiKey).finally(() => setPending(false));
        }}
      />
    ) : (
      <DetailFooter
        start={
          live && canManage ? (
            <Button
              type="button"
              variant="ghost"
              onClick={startRevoke}
              className="-ml-3 text-danger hover:bg-danger/10 hover:text-danger pointer-coarse:h-11"
            >
              Revoke key
            </Button>
          ) : null
        }
      >
        {!live && canManage ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => onReplace(apiKey)}
            className="pointer-coarse:h-11"
          >
            <RotateCcwIcon aria-hidden="true" />
            Create a replacement
          </Button>
        ) : null}
        <Button
          type="button"
          variant={live ? "outline" : "ghost"}
          onClick={onClose}
          className="pointer-coarse:h-11"
        >
          Done
        </Button>
      </DetailFooter>
    );

  return (
    <>
      <DetailHeader
        leading={<LogoTile icon={<KeyRoundIcon />} />}
        title={apiKey.name}
        subtitle={
          <CopyField
            value={apiKey.prefix}
            display={apiKey.prefixLabel}
            label="key prefix"
            size="sm"
          />
        }
        status={<KeyStatus apiKey={apiKey} look="header" />}
      />
      <DetailBody>
        {apiKey.status === "expired" && apiKey.expiresAt ? (
          <div className="py-6">
            <Notice tone="muted">
              Expired on {dateLabel(apiKey.expiresAt)}. Requests using it are refused. Create a
              replacement to keep {apiKey.name} running.
            </Notice>
          </div>
        ) : null}
        <DetailSection title="Access" description={apiKey.accessLabel}>
          <PermissionList permissions={apiKey.permissions} />
        </DetailSection>
        <DetailSection title="Details">
          <DetailFacts>
            <DetailFact label="Last used">
              {apiKey.lastUsedAt ? (
                <RelativeTime date={apiKey.lastUsedAt} now={KIT_NOW} />
              ) : (
                "Never"
              )}
            </DetailFact>
            <DetailFact
              label={
                apiKey.status === "revoked"
                  ? "Revoked"
                  : apiKey.status === "expired"
                    ? "Expired"
                    : "Expires"
              }
            >
              {apiKey.status === "revoked" && apiKey.revokedAt
                ? absoluteTime(apiKey.revokedAt)
                : expiresText(apiKey)}
            </DetailFact>
            <DetailFact label="Created">
              {dateLabel(apiKey.createdAt)} by {apiKey.createdBy}
            </DetailFact>
          </DetailFacts>
        </DetailSection>
      </DetailBody>
      {footer}
      <DestructiveConfirm
        open={typeOpen}
        onOpenChange={setTypeOpen}
        variant="type-to-confirm"
        title={`Revoke ${apiKey.name}?`}
        consequences={[
          "Scripts and CI using this key stop working right away.",
          `Last used ${apiKey.lastUsedAt ? absoluteTime(apiKey.lastUsedAt) : "never"}.`,
          "This can't be undone.",
        ]}
        confirmText={apiKey.name}
        confirmPlaceholder="Key name"
        confirmLabel="Revoke key"
        pendingLabel="Revoking…"
        onConfirm={() => revokeNow(apiKey)}
      />
    </>
  );
}

/* ----------------------------------------------------------------------------
   The list.
   -------------------------------------------------------------------------- */

const COLUMNS: RowListColumn[] = [
  { id: "lastUsed", label: "Last used", width: 116 },
  { id: "expires", label: "Expires", width: 116 },
];

function KeyRows({
  keys,
  openId,
  onOpen,
  label,
  inlineDetail,
}: {
  keys: PreviewApiKey[];
  openId: string | null;
  onOpen: (key: PreviewApiKey) => void;
  label: string;
  inlineDetail?: (key: PreviewApiKey) => ReactNode;
}) {
  const picks = useSettingsPicks();
  const inline = picks.detail === "inline";
  return (
    <RowList variant={picks.list} label={label} columns={COLUMNS} nameLabel="Key">
      {keys.map((key) => (
        <ListRow
          key={key.id}
          leading={<LogoTile icon={<KeyRoundIcon />} />}
          title={key.name}
          titleAddon={
            key.isNew ? (
              <MetaChip variant="outline">New</MetaChip>
            ) : isLiveKey(key) ? null : (
              <KeyStatus apiKey={key} look="row" />
            )
          }
          description={
            <>
              <span className="font-mono">{key.prefixLabel}</span> · {accessShort(key)}
            </>
          }
          cells={{
            lastUsed: <LastUsed apiKey={key} />,
            // Revoked and expired keys say when in their status instead.
            expires: isLiveKey(key) ? (
              key.expiresAt ? (
                expiresText(key)
              ) : (
                <FactWord>Never</FactWord>
              )
            ) : null,
          }}
          indicator={inline ? "expand" : "open"}
          onOpen={() => onOpen(key)}
          selected={!inline && openId === key.id}
          expanded={inline ? openId === key.id : undefined}
          panel={inline && openId === key.id && inlineDetail ? inlineDetail(key) : undefined}
        />
      ))}
    </RowList>
  );
}

function OldKeys({
  keys,
  openId,
  onOpen,
  inlineDetail,
}: {
  keys: PreviewApiKey[];
  openId: string | null;
  onOpen: (key: PreviewApiKey) => void;
  inlineDetail: (key: PreviewApiKey) => ReactNode;
}) {
  const picks = useSettingsPicks();
  if (keys.length === 0) return null;
  const summary = keys.map((key) => key.name).join(", ");
  return (
    <Disclosure
      variant={picks.disclosure}
      title={`Revoked and expired (${keys.length})`}
      summary={summary}
      sheetDescription="Keys that no longer work. They stay here so you can see what used them."
    >
      <KeyRows
        keys={keys}
        openId={openId}
        onOpen={onOpen}
        label="Revoked and expired API keys"
        inlineDetail={inlineDetail}
      />
    </Disclosure>
  );
}

/** What a script needs next to its key: the workspace ID, and the docs. */
function WorkspaceIdLine() {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-xs leading-4.5 text-fg-muted">
      <span className="inline-flex max-w-full min-w-0 items-center gap-2">
        <span className="shrink-0">Workspace ID</span>
        <CopyField value={currentWorkspace.id} label="workspace ID" truncate="middle" />
      </span>
      <HelpLink href="#api-docs" className="inline-flex items-center gap-0.5">
        API docs
        <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
      </HelpLink>
    </div>
  );
}

const TEMPLATES: Array<{
  name: string;
  access: ApiKeyAccess;
  description: string;
  meta: string;
}> = [
  {
    name: "CI pipeline",
    access: "run_sessions",
    description: "Start sessions from GitHub Actions and read their results.",
    meta: "Run sessions · 90 days",
  },
  {
    name: "Read-only dashboard",
    access: "read_only",
    description: "Show session history in an internal dashboard.",
    meta: "Read only · 90 days",
  },
  {
    name: "Terraform runner",
    access: "full_automation",
    description: "Run plans with variable sets and manage schedules.",
    meta: "Full automation · 90 days",
  },
];

export function ApiKeysPage() {
  const base = useFrameBase();
  const { keys, data, setData, canManage, questions } = useSettingsPreview();
  const picks = useSettingsPicks();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<{
    name: string;
    access: ApiKeyAccess;
    permissions: string[];
  } | null>(null);
  const [tokenNotice, setTokenNotice] = useState<CreatedKey | null>(null);
  const noticeId = useId();

  const presets = questions.q9 === "yes";
  const live = keys.filter(isLiveKey);
  const old = keys.filter((key) => !isLiveKey(key));
  const shown = presets ? live : keys;
  const open = keys.find((key) => key.id === openId) ?? null;
  const empty = data["api-keys"] === "empty";
  const loading = data["api-keys"] === "loading";
  const failed = data["api-keys"] === "error";

  const startCreate = (next: typeof prefill = null) => {
    setPrefill(next);
    setOpenId(null);
    setCreating(true);
  };
  const onCreated = (created: CreatedKey) => {
    if (!presets) setTokenNotice(created);
    setData("api-keys", "filled");
  };
  const replace = (key: PreviewApiKey) =>
    startCreate({ name: key.name, access: key.access, permissions: key.permissions });

  const createButton = (
    <AdminOnly>
      <Button type="button" onClick={() => startCreate()}>
        <PlusIcon aria-hidden="true" />
        Create API key
      </Button>
    </AdminOnly>
  );

  const detail = (key: PreviewApiKey) => (
    <KeyDetail apiKey={key} onClose={() => setOpenId(null)} onReplace={replace} />
  );
  const inlineDetail = (key: PreviewApiKey) => (
    <DetailInline className="mt-1">{detail(key)}</DetailInline>
  );

  let takeover: ReactNode;
  if (creating && picks.form === "page") {
    takeover = (
      <CreateKeyInPage
        layout="page"
        prefill={prefill}
        onCreated={onCreated}
        onClose={() => setCreating(false)}
      />
    );
  } else if (open && picks.detail === "page") {
    takeover = (
      <DetailPage
        back={{ label: "API keys", onClick: () => setOpenId(null) }}
        className="max-w-none px-0 pt-0 pb-0 max-sm:px-0"
      >
        {detail(open)}
      </DetailPage>
    );
  }

  let body: ReactNode;
  if (loading) {
    body = (
      <RowList variant={picks.list} label="API keys" columns={COLUMNS} busy>
        <ListRowSkeleton count={3} />
      </RowList>
    );
  } else if (failed) {
    body = (
      <ErrorMessage
        variant="block"
        align="center"
        title="Couldn't load API keys."
        announce
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setData("api-keys", "filled")}
          >
            Try again
          </Button>
        }
      >
        Check your connection and try again. Your keys keep working.
      </ErrorMessage>
    );
  } else if (empty && creating && picks.form === "inline") {
    // With no keys yet, the inline form takes the empty state's place.
    body = (
      <CreateKeyInPage
        layout="inline"
        prefill={prefill}
        onCreated={onCreated}
        onClose={() => setCreating(false)}
      />
    );
  } else if (empty) {
    body = (
      <EmptyState
        variant={picks.empty}
        icon={<KeyRoundIcon />}
        title="No API keys yet"
        description="Create a key to start sessions from CI, scripts or your own app."
        action={
          picks.empty === "inline" ? (
            <HelpLink onClick={() => startCreate()}>Create API key</HelpLink>
          ) : (
            createButton
          )
        }
        templates={
          picks.emptyTemplates && canManage ? (
            <EmptyStateTemplates label="Start from a common setup">
              {TEMPLATES.map((template) => (
                <EmptyStateTemplate
                  key={template.name}
                  icon={<KeyRoundIcon />}
                  title={template.name}
                  description={template.description}
                  meta={template.meta}
                  onSelect={() =>
                    startCreate({
                      name: template.name,
                      access: template.access,
                      permissions: presetPermissions(template.access),
                    })
                  }
                />
              ))}
            </EmptyStateTemplates>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-6">
        {tokenNotice ? (
          <Notice
            tone="success"
            title={`Copy ${tokenNotice.key.name} now. It won't be shown again.`}
            onDismiss={() => setTokenNotice(null)}
            dismissLabel="I've saved it"
          >
            <div id={noticeId} className="mt-2">
              <CopyField variant="field" wrap value={tokenNotice.token} label="new API key" />
            </div>
          </Notice>
        ) : null}
        {creating && picks.form === "inline" ? (
          <CreateKeyInPage
            layout="inline"
            prefill={prefill}
            onCreated={onCreated}
            onClose={() => setCreating(false)}
          />
        ) : null}
        <KeyRows
          keys={shown}
          openId={openId}
          onOpen={(key) => setOpenId((current) => (current === key.id ? null : key.id))}
          label="API keys"
          inlineDetail={inlineDetail}
        />
        {presets ? (
          <OldKeys
            keys={old}
            openId={openId}
            onOpen={(key) => setOpenId((current) => (current === key.id ? null : key.id))}
            inlineDetail={inlineDetail}
          />
        ) : null}
      </div>
    );
  }

  // One primary per region: the empty state and an open inline form carry their own.
  const headerAction =
    (empty && picks.empty === "page") || (creating && picks.form === "inline")
      ? null
      : createButton;

  return (
    <SettingsFrame {...base} actions={headerAction} takeover={takeover}>
      <div className="flex min-w-0 flex-col gap-6">
        {empty ? null : <WorkspaceIdLine />}
        {body}
      </div>
      {picks.form === "dialog" ? (
        <CreateKeyDialog
          open={creating}
          onOpenChange={setCreating}
          prefill={prefill}
          onCreated={onCreated}
        />
      ) : null}
      {picks.detail === "sheet" ? (
        <DetailSheet open={open !== null} onOpenChange={(next) => (next ? null : setOpenId(null))}>
          {open ? <DetailSheetContent>{detail(open)}</DetailSheetContent> : null}
        </DetailSheet>
      ) : null}
    </SettingsFrame>
  );
}
