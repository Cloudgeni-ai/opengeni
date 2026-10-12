import type {
  SessionSecretsView,
  VaultItemSummary,
  VaultPolicy,
  VaultSummary,
} from "@opengeni/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  UsersIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { ConnectorAction } from "@/components/ui/composer-menu-action";
import {
  ComposerMenuHeader,
  ComposerMenuRowsSkeleton,
  ComposerMenuSwitchIndicator,
} from "@/components/ui/composer-menu";
import {
  MENU_BACK_BUTTON_CLASS,
  MENU_CHECK_SLOT_CLASS,
  MENU_CHEVRON_CLASS,
  MENU_LABEL_CLASS,
  MENU_META_CLASS,
  MENU_NOTE_CLASS,
  MENU_SEPARATOR_CLASS,
} from "@/components/ui/menu-styles";
import { cn } from "@/lib/utils";

import { vaultErrorText } from "./vault-model";

/* ----------------------------------------------------------------------------
   The chat's Secrets (S10): a drill-in of the composer's "+" menu.
   - This task: items an agent saved for this task, each with "Save to…" so a
     person can keep it after the task (a copy into Only me or This workspace).
   - Vaults: which vaults agents in this chat may use. "All vaults" includes
     vaults added later; picking vaults narrows the chat (and its children).
   A parent session's narrowing can't be widened here: those rows are disabled.
   -------------------------------------------------------------------------- */

export type SessionSecretsVaultRow = VaultSummary & { selected: boolean; selectable: boolean };

/** The "+" row's value: "All", "2 vaults", "None". */
export function sessionSecretsSummary(
  policy: VaultPolicy | null | undefined,
  vaults: readonly { selected: boolean }[] | null | undefined,
): string {
  if (!policy || policy.mode === "all") return "All";
  const count = vaults ? vaults.filter((vault) => vault.selected).length : policy.vaultIds.length;
  return count === 0 ? "None" : count === 1 ? "1 vault" : `${count} vaults`;
}

/** Rows of a new chat's checklist from the workspace's vaults and a draft policy. */
export function draftSecretsRows(
  vaults: readonly VaultSummary[],
  policy: VaultPolicy,
): SessionSecretsVaultRow[] {
  return vaults
    .filter((vault) => vault.ownerKind !== "task")
    .map((vault) => ({
      ...vault,
      selected: policy.mode === "all" || policy.vaultIds.includes(vault.id),
      selectable: true,
    }));
}

type SaveTarget = { vault: VaultSummary; label: string; icon: ReactNode };

function saveTargets(vaults: readonly VaultSummary[]): SaveTarget[] {
  const mine = vaults.find(
    (vault) => vault.ownerKind === "user" && vault.isDefault && vault.canWrite,
  );
  const shared = vaults.find(
    (vault) => vault.ownerKind === "workspace" && vault.isDefault && vault.canWrite,
  );
  return [
    ...(mine
      ? [{ vault: mine, label: "Only me", icon: <LockKeyholeIcon className="size-4" /> }]
      : []),
    ...(shared
      ? [{ vault: shared, label: "This workspace", icon: <UsersIcon className="size-4" /> }]
      : []),
  ];
}

export function SessionSecretsMenuBody({
  leading,
  presentation = "menu",
  vaults,
  policy,
  narrowedByParent,
  taskItems,
  canEdit,
  disabled,
  loading,
  error,
  onRetry,
  onPolicyChange,
  onSaveTo,
  onManage,
}: {
  leading?: ReactNode;
  presentation?: "menu" | "dialog";
  vaults: SessionSecretsVaultRow[] | null;
  policy: VaultPolicy;
  narrowedByParent: boolean;
  /** Present for a chat that exists; a new chat has no task items yet. */
  taskItems?: VaultItemSummary[] | undefined;
  canEdit: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onPolicyChange: (policy: VaultPolicy) => Promise<void> | void;
  onSaveTo?: (item: VaultItemSummary, target: VaultSummary) => Promise<void>;
  /** Opens Settings › Secrets. */
  onManage?: () => void;
}) {
  const [saving, setSaving] = useState<VaultItemSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const locked = !canEdit || disabled || busy;

  const run = async (operation: () => Promise<void> | void) => {
    setBusy(true);
    setFailure(null);
    try {
      await operation();
    } catch (caught) {
      setFailure(vaultErrorText((caught as { cause?: unknown })?.cause ?? caught));
    } finally {
      setBusy(false);
    }
  };

  if (saving && onSaveTo && vaults) {
    const targets = saveTargets(vaults);
    return (
      <>
        <ComposerMenuHeader
          title={`Save ${saving.name} to`}
          leading={
            <ConnectorAction
              presentation={presentation}
              keepOpen
              label="Back to Secrets"
              className={`${MENU_BACK_BUTTON_CLASS} w-8 gap-0 p-0`}
              onAction={() => setSaving(null)}
            >
              <ChevronLeftIcon aria-hidden="true" className="size-4" />
            </ConnectorAction>
          }
        />
        <div className="min-h-0 overflow-y-auto overscroll-contain pb-1">
          <p className={cn(MENU_NOTE_CLASS, "pt-0")}>
            A copy is kept after this task ends. Agents in later chats can use it.
          </p>
          {targets.length === 0 ? (
            <p className={MENU_NOTE_CLASS}>There's no vault here you can save to.</p>
          ) : (
            targets.map((target) => (
              <ConnectorAction
                key={target.vault.id}
                presentation={presentation}
                keepOpen
                disabled={busy}
                label={`${target.label} (${target.vault.name})`}
                className="flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1.5 pointer-coarse:min-h-11"
                onAction={() =>
                  void run(async () => {
                    await onSaveTo(saving, target.vault);
                    setSaving(null);
                  })
                }
              >
                {target.icon}
                <span className="min-w-0 flex-1 truncate">{target.label}</span>
                <span className={MENU_META_CLASS}>{target.vault.name}</span>
              </ConnectorAction>
            ))
          )}
          {failure ? (
            <p role="alert" className={cn(MENU_NOTE_CLASS, "text-danger")}>
              {failure}
            </p>
          ) : null}
        </div>
      </>
    );
  }

  const selectable = (vaults ?? []).filter((vault) => vault.selectable);
  const all = policy.mode === "all" && !narrowedByParent;
  const toggle = (vault: SessionSecretsVaultRow) => {
    const current = new Set(
      (vaults ?? []).filter((each) => each.selected && each.selectable).map((each) => each.id),
    );
    if (current.has(vault.id)) current.delete(vault.id);
    else current.add(vault.id);
    return { mode: "selected" as const, vaultIds: [...current] };
  };

  return (
    <>
      <ComposerMenuHeader title="Secrets" leading={leading} />
      <div className="min-h-0 overflow-y-auto overscroll-contain pb-1">
        {loading && !vaults ? (
          <ComposerMenuRowsSkeleton rows={4} label="Loading secrets" />
        ) : error && !vaults ? (
          <div className={MENU_NOTE_CLASS}>
            <p className="m-0">{vaultErrorText(error, "Couldn't load secrets.")}</p>
            {onRetry ? (
              <ConnectorAction
                presentation={presentation}
                keepOpen
                className="mt-1 -ml-2.5 rounded-md px-2.5 py-1.5 font-medium text-fg"
                onAction={onRetry}
              >
                Try again
              </ConnectorAction>
            ) : null}
          </div>
        ) : (
          <>
            {taskItems ? (
              <div role="group" aria-label="This task">
                <p aria-hidden className={MENU_LABEL_CLASS}>
                  This task
                </p>
                {taskItems.length === 0 ? (
                  <p className={cn(MENU_NOTE_CLASS, "pt-0")}>
                    Logins an agent creates during this task show up here.
                  </p>
                ) : (
                  taskItems.map((item) => (
                    <ConnectorAction
                      key={item.id}
                      presentation={presentation}
                      keepOpen
                      disabled={!onSaveTo || locked}
                      label={`Save ${item.name} to…`}
                      className="flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1.5 pointer-coarse:min-h-11"
                      onAction={() => setSaving(item)}
                    >
                      <KeyRoundIcon className="size-4 text-fg-muted" />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className={MENU_META_CLASS}>Save to…</span>
                      <ChevronRightIcon className={MENU_CHEVRON_CLASS} />
                    </ConnectorAction>
                  ))
                )}
                <div role="separator" className={MENU_SEPARATOR_CLASS} />
              </div>
            ) : null}
            <div role="group" aria-label="Vaults this chat can use">
              <p aria-hidden className={MENU_LABEL_CLASS}>
                Vaults this chat can use
              </p>
              {narrowedByParent ? (
                <p className={cn(MENU_NOTE_CLASS, "pt-0")}>
                  Narrowed by the parent session. Vaults it left out can't be added here.
                </p>
              ) : (
                <ConnectorAction
                  presentation={presentation}
                  keepOpen
                  checked={all}
                  disabled={locked}
                  label="All vaults"
                  className="flex min-h-11 items-center gap-3 rounded-md px-2.5 py-1.5"
                  onAction={() =>
                    void run(() =>
                      onPolicyChange(
                        all
                          ? { mode: "selected", vaultIds: selectable.map((vault) => vault.id) }
                          : { mode: "all" },
                      ),
                    )
                  }
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-fg">All vaults</span>
                    <span className="block text-xs leading-4.5 text-fg-muted">
                      {all ? "Including vaults added later" : "Only the vaults checked below"}
                    </span>
                  </span>
                  <ComposerMenuSwitchIndicator checked={all} />
                </ConnectorAction>
              )}
              {(vaults ?? []).map((vault) => (
                <ConnectorAction
                  key={vault.id}
                  presentation={presentation}
                  keepOpen
                  checked={vault.selected}
                  disabled={locked || all || !vault.selectable}
                  label={vault.name}
                  className="flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1.5 pointer-coarse:min-h-11"
                  onAction={() => void run(() => onPolicyChange(toggle(vault)))}
                >
                  <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                  {!vault.selectable ? (
                    <span className={MENU_META_CLASS}>Not in parent</span>
                  ) : null}
                  <span className={MENU_CHECK_SLOT_CLASS}>
                    {vault.selected ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
                  </span>
                </ConnectorAction>
              ))}
              {!canEdit ? (
                <p className={MENU_NOTE_CLASS}>
                  Only people who can control this chat change this.
                </p>
              ) : null}
              {failure ? (
                <p role="alert" className={cn(MENU_NOTE_CLASS, "text-danger")}>
                  {failure}
                </p>
              ) : null}
            </div>
            {onManage ? (
              <>
                <div role="separator" className={MENU_SEPARATOR_CLASS} />
                <ConnectorAction
                  presentation={presentation}
                  label="Manage secrets"
                  className="flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1.5 pointer-coarse:min-h-11"
                  onAction={onManage}
                >
                  <span className="min-w-0 flex-1">Manage secrets</span>
                  <ChevronRightIcon className={MENU_CHEVRON_CLASS} />
                </ConnectorAction>
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

/** The panel for a chat that exists, from its secrets view. */
export function sessionSecretsRows(
  view: SessionSecretsView | null,
): SessionSecretsVaultRow[] | null {
  return view ? view.reachableVaults : null;
}
