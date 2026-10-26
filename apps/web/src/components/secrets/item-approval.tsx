import type { SecretUseGrant, VaultItemApproval, VaultsApi } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@opengeni/react/ui/button";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { SettingRow, SettingRowGroup, SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { Switch } from "@opengeni/react/ui/switch";
import { vaultErrorText } from "@opengeni/react/app/components/secrets/vault-model";

/* ----------------------------------------------------------------------------
   "Ask me each time" on an item's page: which fields an agent may use only
   after the person it works for allows that use, and the approvals in force.
   Agents still see the item and refer to it; a marked use stops before any
   value is read and asks in the chat (and on the person's phone).
   -------------------------------------------------------------------------- */

const SCOPE_TEXT: Record<SecretUseGrant["scope"], string> = {
  once: "Allowed once",
  session: "Allowed in one chat",
  window: "Allowed for an hour",
};

const SURFACE_TEXT: Record<string, string> = {
  browser: "Browser",
  desktop: "Desktop",
  shell: "Shell command",
  stdin: "Terminal input",
  file_write: "File",
  secretfile: "Secret file",
  view_image: "Image",
  run_on: "Command on a machine",
  mcp: "Connector call",
  codemode: "Tool call",
};

function whereText(grant: SecretUseGrant): string {
  const surface = SURFACE_TEXT[grant.surface] ?? grant.toolName;
  return grant.destination ? `${surface} on ${grant.destination}` : surface;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

type ApprovalField = { name: string; label: string };

export function ItemApprovalSection({
  api,
  vaultId,
  itemId,
  workspaceId,
  fields,
  archived,
}: {
  api: VaultsApi;
  vaultId: string;
  itemId: string;
  /** The workspace whose chats the approvals belong to, for chat links. */
  workspaceId: string | undefined;
  fields: readonly ApprovalField[];
  archived: boolean;
}) {
  const [approval, setApproval] = useState<VaultItemApproval | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // The switch or grant being saved: "item", a field name, or a grant id.
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoadError(null);
      api.getItemApproval(vaultId, itemId, signal).then(
        (next) => {
          if (!signal?.aborted) setApproval(next);
        },
        (error: unknown) => {
          if (!signal?.aborted) setLoadError(error);
        },
      );
    },
    [api, vaultId, itemId],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const save = async (next: { item: boolean; fields: string[] }, key: string, done: string) => {
    if (!approval) return;
    const previous = approval;
    setApproval({ ...approval, ...next });
    setPending(key);
    try {
      setApproval(await api.setItemApproval(vaultId, itemId, next));
      toast.success(done);
    } catch (error) {
      setApproval(previous);
      toast.error(vaultErrorText(error, "Couldn't save the change. Try again."));
    } finally {
      setPending(null);
    }
  };

  const revoke = async (grant: SecretUseGrant) => {
    setPending(grant.id);
    try {
      setApproval(await api.revokeItemGrant(vaultId, itemId, grant.id));
      toast.success("Approval revoked. Agents will ask again.");
    } catch (error) {
      toast.error(vaultErrorText(error, "Couldn't revoke the approval. Try again."));
    } finally {
      setPending(null);
    }
  };

  const description =
    "Agents still see this item and can refer to it. Before using a marked field, they wait until the person they work for allows it, in the chat or from their phone.";

  if (!approval) {
    return (
      <DetailSection title="Ask before each use" description={description}>
        {loadError ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0 text-sm leading-5 text-danger">
              {vaultErrorText(loadError, "Couldn't load these settings.")}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => load()}>
              Try again
            </Button>
          </div>
        ) : (
          <SettingRowGroup aria-busy="true" aria-label="Loading approval settings">
            <SettingRowSkeleton />
            <SettingRowSkeleton />
          </SettingRowGroup>
        )}
      </DetailSection>
    );
  }

  const locked = !approval.canChange || archived;
  const lockedReason = archived
    ? "Restore the item to change this."
    : "Only people who can change secrets in this workspace can change this.";
  const marked = new Set(approval.fields);
  const markedLabels = fields.filter((field) => marked.has(field.name)).map((field) => field.label);
  const fieldsOf = (grant: SecretUseGrant) =>
    joinNames(
      grant.fields.map((name) => fields.find((field) => field.name === name)?.label ?? name),
    );

  return (
    <DetailSection title="Ask before each use" description={description}>
      <SettingRowGroup>
        <SettingRow
          label="Every field"
          description={
            approval.item
              ? "Agents ask before any use of this item."
              : markedLabels.length > 0
                ? `Agents ask before using ${joinNames(markedLabels)}.`
                : "Agents use this item without asking."
          }
          control={
            <Switch
              checked={approval.item}
              pending={pending === "item"}
              disabled={locked}
              disabledReason={locked ? lockedReason : undefined}
              onCheckedChange={(checked) =>
                void save(
                  { item: checked, fields: approval.fields },
                  "item",
                  checked
                    ? "Agents will ask before using this item."
                    : markedLabels.length > 0
                      ? `Agents will ask only before using ${joinNames(markedLabels)}.`
                      : "Agents can use this item without asking.",
                )
              }
            />
          }
        />
        {approval.item
          ? null
          : fields.map((field) => (
              <SettingRow
                key={field.name}
                label={field.label}
                control={
                  <Switch
                    checked={marked.has(field.name)}
                    pending={pending === field.name}
                    disabled={locked || pending !== null}
                    disabledReason={locked ? lockedReason : undefined}
                    onCheckedChange={(checked) =>
                      void save(
                        {
                          item: false,
                          fields: checked
                            ? [...approval.fields, field.name]
                            : approval.fields.filter((name) => name !== field.name),
                        },
                        field.name,
                        checked
                          ? `Agents will ask before using ${field.label}.`
                          : `Agents can use ${field.label} without asking.`,
                      )
                    }
                  />
                }
              />
            ))}
      </SettingRowGroup>
      {approval.grants.length > 0 ? (
        <div className="mt-6 flex min-w-0 flex-col gap-2">
          <h3 className="m-0 text-sm leading-5 font-medium text-fg">Allowed now</h3>
          <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">
            {approval.grants.map((grant) => (
              <li
                key={grant.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm leading-5 text-fg">
                    {SCOPE_TEXT[grant.scope]}
                    {grant.fields.length > 0 ? ` · ${fieldsOf(grant)}` : null}
                  </span>
                  <span className="text-xs leading-4.5 text-fg-muted">
                    {whereText(grant)}
                    {grant.expiresAt ? (
                      <>
                        {" · ends "}
                        <RelativeTime date={grant.expiresAt} inSentence />
                      </>
                    ) : (
                      " · until revoked"
                    )}
                    {workspaceId && grant.scope !== "window" ? (
                      <>
                        {" · "}
                        <Link
                          to="/workspaces/$workspaceId/sessions/$sessionId"
                          params={{ workspaceId, sessionId: grant.sessionId }}
                          className="text-fg-muted underline decoration-border-strong underline-offset-2 hover:text-fg"
                        >
                          Open chat
                        </Link>
                      </>
                    ) : null}
                  </span>
                </div>
                {approval.canChange ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11"
                    disabled={pending === grant.id}
                    aria-label={`Revoke: ${SCOPE_TEXT[grant.scope]}${
                      grant.fields.length > 0 ? `, ${fieldsOf(grant)}` : ""
                    }`}
                    onClick={() => void revoke(grant)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </DetailSection>
  );
}
