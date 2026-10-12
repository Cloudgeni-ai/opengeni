import type {
  VaultFieldVersionMeta,
  VaultItem,
  VaultItemField,
  VaultsApi,
  VaultSummary,
} from "@opengeni/react";
import { useVaultFieldVersions } from "@opengeni/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  DownloadIcon,
  FolderInputIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

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
import { Disclosure } from "@/components/ui/disclosure";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Notice } from "@/components/ui/notice";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import {
  CopyAction,
  CopyReferenceAction,
  copyWithToast,
  HIT_AREA,
  RevealAction,
  revealText,
} from "./secret-actions";
import { formatTotpCode, TotpRing, useTotp } from "./totp-code";
import { hostOf, ITEM_TYPE_LABEL, vaultErrorText } from "./vault-model";
import { ExpiryBadge, ItemTile } from "./vault-parts";

/* ----------------------------------------------------------------------------
   An item's page (S3). Concealed values show as dots; Reveal and Copy read
   them through the audited reveal route. Revealed plaintext lives only in
   this page's state and is dropped when the page unmounts (UI-6).
   -------------------------------------------------------------------------- */

const MASK = "••••••••";

export function fieldLabel(name: string): string {
  if (name === "one-time password") return "One-time password";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function previousReference(reference: string): string {
  return reference.endsWith("}}") ? `${reference.slice(0, -2)}#previous}}` : reference;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

/** The field the primary reference points at: the password of a login, else the first value. */
function primaryFieldName(item: VaultItem): string {
  const reference = item.references.primary ?? "";
  const name = Object.entries(item.references.byField).find(([, ref]) => ref === reference)?.[0];
  const field = item.fields.find((each) => each.id === name || each.name === name);
  return field?.name ?? "password";
}

function ReferenceLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs leading-4.5 text-fg-muted">{label}</span>
      <CopyField
        variant="field"
        value={value}
        label={label === "Reference" ? "reference" : `${label.toLowerCase()} reference`}
      />
    </div>
  );
}

export interface ItemPageActions {
  back: () => void;
  edit: () => void;
  archive: () => Promise<void>;
  restore: () => Promise<void>;
  deletePermanently: () => void;
  move: () => void;
  refresh: () => Promise<void>;
}

/* ------------------------------------------------------------- one field */

function FieldValue({
  item,
  field,
  api,
  canUse,
  revealed,
  onRevealed,
}: {
  item: VaultItem;
  field: VaultItemField;
  api: VaultsApi;
  canUse: boolean;
  revealed: string | undefined;
  onRevealed: (value: string | undefined) => void;
}) {
  const [pending, setPending] = useState(false);
  const label = fieldLabel(field.name).toLowerCase();
  const reveal = () => revealText(api, item.vaultId, item.id, field.id);
  const totp = useTotp(field.kind === "totp" ? (revealed ?? null) : null);

  const toggle = async () => {
    if (revealed !== undefined) {
      onRevealed(undefined);
      return;
    }
    setPending(true);
    try {
      onRevealed(await reveal());
    } catch (error) {
      toast.error(vaultErrorText(error, `Couldn't reveal ${label}.`));
    } finally {
      setPending(false);
    }
  };

  let value: ReactNode;
  let actions: ReactNode;
  if (field.kind === "text") {
    value = <span className="min-w-0 break-words text-fg">{field.value ?? ""}</span>;
    actions = <CopyAction name={label} value={field.value ?? ""} />;
  } else if (field.kind === "file") {
    value = (
      <span className="min-w-0 truncate text-fg">
        {field.fileName ?? "File"}
        {field.fileSize !== null ? (
          <span className="text-fg-muted"> · {formatBytes(field.fileSize)}</span>
        ) : null}
      </span>
    );
    actions = canUse ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Download ${field.fileName ?? "file"}`}
            className={cn("text-fg-muted hover:text-fg", HIT_AREA)}
            onClick={async () => {
              try {
                const result = await api.revealField(item.vaultId, item.id, field.id);
                const bytes =
                  result.encoding === "base64"
                    ? Uint8Array.from(atob(result.value), (char) => char.charCodeAt(0))
                    : new TextEncoder().encode(result.value);
                const url = URL.createObjectURL(new Blob([bytes]));
                const link = document.createElement("a");
                link.href = url;
                link.download = field.fileName ?? "file";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1_000);
              } catch (error) {
                toast.error(vaultErrorText(error, "Couldn't download the file."));
              }
            }}
          >
            <DownloadIcon aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
    ) : null;
  } else if (field.kind === "totp") {
    value = totp ? (
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="font-mono text-base leading-6 font-medium tracking-wide text-fg tabular-nums">
          {formatTotpCode(totp.code)}
        </span>
        <TotpRing remainingMs={totp.remainingMs} periodSeconds={totp.periodSeconds} />
      </span>
    ) : (
      <span className="font-mono tracking-widest text-fg-muted" aria-label="Hidden">
        ••• •••
      </span>
    );
    actions = canUse ? (
      <>
        <RevealAction
          name="one-time code"
          revealed={revealed !== undefined}
          pending={pending}
          onToggle={() => void toggle()}
        />
        <CopyAction
          name="one-time code"
          value={async () => {
            const result = await api.revealField(item.vaultId, item.id, field.id);
            return result.totp?.code ?? "";
          }}
        />
      </>
    ) : null;
  } else {
    const multiline = item.type === "note" || (revealed?.includes("\n") ?? false);
    value =
      revealed !== undefined ? (
        <span
          className={cn(
            "min-w-0 font-mono text-sm text-fg",
            multiline ? "whitespace-pre-wrap break-words" : "break-all",
          )}
        >
          {revealed}
        </span>
      ) : (
        <span className="font-mono tracking-widest text-fg-muted" aria-label="Hidden">
          {MASK}
        </span>
      );
    actions = canUse ? (
      <>
        <RevealAction
          name={label}
          revealed={revealed !== undefined}
          pending={pending}
          onToggle={() => void toggle()}
        />
        <CopyAction name={label} value={revealed ?? reveal} />
      </>
    ) : null;
  }

  return (
    <>
      <div className="flex min-h-8 min-w-0 items-center text-sm leading-5">{value}</div>
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        {actions}
        <CopyReferenceAction name={label} reference={field.reference} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------- history */

const CREATED_BY: Record<VaultFieldVersionMeta["createdByKind"], string> = {
  human: "by a person",
  agent: "by an agent",
  api_key: "by an API key",
  migration: "from a variable set",
  provider: "in 1Password",
  system: "by OpenGeni",
};

function FieldHistory({
  item,
  field,
  canWrite,
  onRestored,
  api,
}: {
  item: VaultItem;
  field: VaultItemField;
  canWrite: boolean;
  onRestored: () => Promise<void>;
  api: VaultsApi;
}) {
  const [open, setOpen] = useState(false);
  const history = useVaultFieldVersions(item.vaultId, item.id, field.id, { enabled: open });
  const [restoring, setRestoring] = useState<number | null>(null);
  const versions = history.versions ?? [];
  return (
    <Disclosure
      variant="row"
      title={`${fieldLabel(field.name)} history`}
      summary={field.currentVersion ? `Version ${field.currentVersion}` : undefined}
      open={open}
      onOpenChange={setOpen}
      loading={open && history.loading && !history.versions}
    >
      {history.error ? (
        <p className="m-0 text-sm text-danger">{vaultErrorText(history.error)}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {versions.map((version) => (
            <li
              key={version.version}
              className="flex min-h-10 items-center justify-between gap-3 border-b border-border py-1.5 last:border-b-0"
            >
              <span className="min-w-0 text-sm leading-5">
                <span className="font-medium text-fg">Version {version.version}</span>
                <span className="text-fg-muted">
                  {" · "}
                  {CREATED_BY[version.createdByKind]}{" "}
                  <RelativeTime date={version.createdAt} inSentence />
                </span>
                {version.current ? <span className="text-fg-muted"> · current</span> : null}
              </span>
              {!version.current && canWrite ? (
                <RowButton
                  disabled={restoring !== null}
                  onClick={async () => {
                    setRestoring(version.version);
                    try {
                      await api.restoreFieldVersion(
                        item.vaultId,
                        item.id,
                        field.id,
                        version.version,
                      );
                      toast.success(`Restored version ${version.version}`, {
                        description: "It's now the current value.",
                      });
                      await Promise.all([onRestored(), history.refresh()]);
                    } catch (error) {
                      toast.error(vaultErrorText(error, "Couldn't restore this version."));
                    } finally {
                      setRestoring(null);
                    }
                  }}
                >
                  {restoring === version.version ? "Restoring…" : "Restore"}
                </RowButton>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {versions.length > 1 ? (
        <div className="mt-3 flex min-w-0 flex-col gap-1">
          <span className="text-xs leading-4.5 text-fg-muted">
            The previous value stays usable for a while after a change:
          </span>
          <CopyField
            variant="field"
            value={previousReference(field.reference)}
            label="previous value reference"
          />
        </div>
      ) : null}
    </Disclosure>
  );
}

/* ------------------------------------------------------------- the page */

export function ItemPage({
  item,
  vault,
  api,
  canUse,
  actions,
}: {
  item: VaultItem;
  vault: VaultSummary;
  api: VaultsApi;
  /** Reveal and copy values ("use = reveal"). Viewers can't. */
  canUse: boolean;
  actions: ItemPageActions;
}) {
  // Plaintext by field id. Component state only; gone on unmount.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const itemId = item.id;
  const lastItem = useRef(itemId);
  useEffect(() => {
    if (lastItem.current !== itemId) {
      lastItem.current = itemId;
      setRevealed({});
    }
  }, [itemId]);
  useEffect(() => () => setRevealed({}), []);

  const archived = item.archivedAt !== null;
  const readOnly = vault.mode === "read_only";
  const canWrite = vault.canWrite && !archived;
  const fields = [...item.fields].sort((a, b) => a.position - b.position);
  const primaryReference = item.references.primary;

  const editButton = readOnly ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-[10px]">
          <RowButton disabled className="pointer-events-none">
            <PencilIcon aria-hidden="true" />
            Edit
          </RowButton>
        </span>
      </TooltipTrigger>
      <TooltipContent>Read-only: edit this item in 1Password.</TooltipContent>
    </Tooltip>
  ) : canWrite ? (
    <Button type="button" size="sm" onClick={actions.edit} className="pointer-coarse:h-11">
      <PencilIcon aria-hidden="true" />
      Edit
    </Button>
  ) : null;

  const menu: ReactNode[] = [];
  if (primaryReference)
    menu.push(
      <DropdownMenuItem
        key="ref"
        onSelect={() => void copyWithToast(primaryReference, "reference", "Reference copied")}
      >
        Copy reference
      </DropdownMenuItem>,
    );
  if (canWrite && !readOnly)
    menu.push(
      <DropdownMenuItem key="move" onSelect={actions.move}>
        <FolderInputIcon aria-hidden="true" />
        Move or copy…
      </DropdownMenuItem>,
    );
  if (canWrite && !readOnly) {
    menu.push(<DropdownMenuSeparator key="sep" />);
    menu.push(
      <DropdownMenuItem key="archive" onSelect={() => void actions.archive()}>
        <ArchiveIcon aria-hidden="true" />
        Archive
      </DropdownMenuItem>,
    );
  }

  const aside = (
    <DetailAside label={`About ${item.name}`}>
      {item.websites.length ? (
        <DetailAsideItem label={item.websites.length === 1 ? "Website" : "Websites"}>
          <ul className="m-0 flex min-w-0 list-none flex-col gap-1 p-0">
            {item.websites.map((site) => (
              <li key={site} className="min-w-0 truncate">
                <a
                  href={site.includes("://") ? site : `https://${site}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-fg underline decoration-border underline-offset-2 hover:decoration-fg"
                >
                  {hostOf(site)}
                </a>
              </li>
            ))}
          </ul>
        </DetailAsideItem>
      ) : null}
      <DetailAsideItem label="Last used by an agent">
        {item.lastUsedAt ? <RelativeTime date={item.lastUsedAt} /> : "Not used yet"}
      </DetailAsideItem>
      <DetailAsideItem label="Created">
        <RelativeTime date={item.createdAt} format="date" />
      </DetailAsideItem>
    </DetailAside>
  );

  return (
    <DetailPage
      back={{ label: vault.name, onClick: actions.back }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<ItemTile item={item} />}
        title={item.name}
        chips={
          <>
            {readOnly ? <span className="text-xs font-medium text-fg-muted">Read-only</span> : null}
            <ExpiryBadge expiresAt={item.expiresAt} variant="outline" />
          </>
        }
        meta={[
          <span key="type">{ITEM_TYPE_LABEL[item.type]}</span>,
          <span key="vault">in {vault.name}</span>,
          <span key="updated">
            updated <RelativeTime date={item.updatedAt} inSentence />
          </span>,
        ]}
        actions={
          editButton || menu.length ? (
            <div className="flex items-center gap-2">
              {editButton}
              {menu.length ? (
                <MoreMenu label={`More actions for ${item.name}`}>{menu}</MoreMenu>
              ) : null}
            </div>
          ) : undefined
        }
      />
      {archived ? (
        <Notice
          tone="muted"
          className="mt-6"
          icon={<ArchiveIcon aria-hidden="true" className="size-4" />}
          actionLayout="responsive"
          action={
            vault.canWrite ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void actions.restore()}
                >
                  <ArchiveRestoreIcon aria-hidden="true" />
                  Restore
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={actions.deletePermanently}
                  className="text-danger hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2Icon aria-hidden="true" />
                  Delete permanently
                </Button>
              </div>
            ) : undefined
          }
        >
          Archived <RelativeTime date={item.archivedAt!} inSentence />. Agents can't use it.
        </Notice>
      ) : null}
      <DetailPageBody aside={aside}>
        <div className="min-w-0">
          {item.passkey ? (
            <DetailSection title="Passkey">
              <dl className="m-0 grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm leading-5">
                <dt className="text-fg-muted">Site</dt>
                <dd className="m-0 min-w-0 truncate text-fg">{item.passkey.rpId}</dd>
                <dt className="text-fg-muted">User</dt>
                <dd className="m-0 min-w-0 truncate text-fg">{item.passkey.userName ?? "—"}</dd>
                <dt className="text-fg-muted">Credential</dt>
                <dd className="m-0 min-w-0 font-mono text-fg">
                  …{item.passkey.credentialIdSuffix}
                </dd>
                <dt className="text-fg-muted">Sign-ins</dt>
                <dd className="m-0 text-fg tabular-nums">{item.passkey.signCount}</dd>
                <dt className="text-fg-muted">Last used</dt>
                <dd className="m-0 text-fg">
                  {item.passkey.lastUsedAt ? (
                    <RelativeTime date={item.passkey.lastUsedAt} />
                  ) : (
                    "Never"
                  )}
                </dd>
              </dl>
              {item.passkey.leasedUntil && Date.parse(item.passkey.leasedUntil) > Date.now() ? (
                <Notice tone="waiting" className="mt-4">
                  An agent is signing in with this passkey until{" "}
                  <RelativeTime date={item.passkey.leasedUntil} format="absolute" inSentence />.
                </Notice>
              ) : null}
            </DetailSection>
          ) : null}
          {fields.length && item.type !== "passkey" ? (
            <DetailSection title={item.passkey ? "Fields" : undefined}>
              <div
                role="list"
                aria-label={`Fields of ${item.name}`}
                className="flex min-w-0 flex-col"
              >
                {fields.map((field) => (
                  <div
                    role="listitem"
                    key={field.id}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-b border-border py-2 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                  >
                    <span className="col-span-2 text-xs leading-4.5 text-fg-muted sm:col-span-1 sm:text-sm sm:leading-5">
                      {fieldLabel(field.name)}
                    </span>
                    <FieldValue
                      item={item}
                      field={field}
                      api={api}
                      canUse={canUse}
                      revealed={revealed[field.id]}
                      onRevealed={(value) =>
                        setRevealed((current) => {
                          const next = { ...current };
                          if (value === undefined) delete next[field.id];
                          else next[field.id] = value;
                          return next;
                        })
                      }
                    />
                  </div>
                ))}
              </div>
              {!canUse ? (
                <p className="mt-3 mb-0 text-xs leading-4.5 text-fg-muted">
                  You can see what's here but not the values. Ask a workspace admin for access.
                </p>
              ) : null}
            </DetailSection>
          ) : null}
          {primaryReference ? (
            <DetailSection
              title="Use in agents"
              description="Put a reference in a task or a tool's settings. Agents get the value when they run; it never appears in chat."
            >
              <div className="flex min-w-0 flex-col gap-3">
                <ReferenceLine
                  label={item.references.otp ? fieldLabel(primaryFieldName(item)) : "Reference"}
                  value={primaryReference}
                />
                {item.references.otp ? (
                  <ReferenceLine label="One-time code" value={item.references.otp} />
                ) : null}
              </div>
            </DetailSection>
          ) : null}
          {(() => {
            const versioned = fields.filter(
              (field) =>
                field.kind !== "text" && field.currentVersion !== null && field.currentVersion > 1,
            );
            if (versioned.length === 0 && item.aliases.length === 0) return null;
            return (
              <DetailSection>
                <div className="flex min-w-0 flex-col gap-1">
                  {versioned.map((field) => (
                    <FieldHistory
                      key={field.id}
                      item={item}
                      field={field}
                      canWrite={canWrite && !readOnly}
                      api={api}
                      onRestored={actions.refresh}
                    />
                  ))}
                  {item.aliases.length ? (
                    <Disclosure
                      variant="inline"
                      title="Also resolves as"
                      summary={item.aliases.join(", ")}
                    >
                      <p className="mt-0 mb-2 text-xs leading-4.5 text-fg-muted">
                        References that use an old name keep working.
                      </p>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {item.aliases.map((alias) => (
                          <li key={alias} className="font-mono text-xs leading-5 break-all text-fg">
                            {`{{secret:${vault.name}/${alias}}}`}
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  ) : null}
                </div>
              </DetailSection>
            );
          })()}
        </div>
      </DetailPageBody>
    </DetailPage>
  );
}

export function ItemPageLoading({ backLabel, onBack }: { backLabel: string; onBack: () => void }) {
  return (
    <DetailPage back={{ label: backLabel, onClick: onBack }} className={FLUSH_DETAIL_PAGE_CLASS}>
      <div role="status" aria-label="Loading item" className="min-w-0">
        <div aria-hidden="true" className="flex items-start gap-4">
          <Skeleton className="size-10 shrink-0 rounded-[10px] bg-surface-2" />
          <div className="min-w-0 flex-1 pt-1">
            <Skeleton className="h-5 w-40 rounded-full bg-surface-3" />
            <Skeleton className="mt-3 h-3.5 w-64 max-w-full rounded-full bg-surface-2" />
          </div>
        </div>
        <div aria-hidden="true" className="mt-8 flex flex-col gap-4">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-4">
              <Skeleton className="h-3.5 w-24 rounded-full bg-surface-2" />
              <Skeleton className="h-3.5 w-56 rounded-full bg-surface-2" />
            </div>
          ))}
        </div>
      </div>
    </DetailPage>
  );
}
