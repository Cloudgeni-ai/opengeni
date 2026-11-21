import type { CapabilityCatalogItem, ToolGatewaySiteSetupItem } from "@opengeni/sdk";
import { useEffect, useMemo, useState } from "react";
import type { VaultItemSummary, VaultSummary } from "@opengeni/sdk";
import { OWNER_LABEL } from "../components/secrets/vault-model";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Field, TextInput } from "../../ui/field";
import { SelectMenu } from "../../ui/select-menu";
import type { AppApiHost } from "./app-api";

// "Add a shared key": a workspace admin connects a tool that takes an API key
// once for the workspace, with a key from a workspace or organization vault.
// Only the vault reference leaves this dialog; Opengeni reads the key when it
// calls the tool.

/** Vaults a shared key may come from: never anyone's Only me or a task's. */
export function sharedKeyVaults(vaults: readonly VaultSummary[]): VaultSummary[] {
  return vaults.filter((vault) => vault.ownerKind === "workspace" || vault.ownerKind === "organization");
}

/** The header the key goes in: the connector's own contract, else a bearer token. */
export function sharedKeyHeaderDefaults(capability: Pick<CapabilityCatalogItem, "metadata"> | null): {
  headerName: string;
  scheme: string;
} {
  const contract = capability?.metadata?.authContract;
  if (contract && typeof contract === "object" && !Array.isArray(contract)) {
    const { headerName, scheme } = contract as Record<string, unknown>;
    if (typeof headerName === "string" && headerName.trim())
      return {
        headerName: headerName.trim(),
        scheme:
          typeof scheme === "string" && !["none", "raw", ""].includes(scheme.trim().toLowerCase())
            ? scheme.trim()
            : "",
      };
  }
  return { headerName: "Authorization", scheme: "Bearer" };
}

/** The connection's headers: the reference in place of the key. */
export function sharedKeyHeaders(input: {
  headerName: string;
  scheme: string;
  reference: string;
}): Record<string, string> {
  const value = input.scheme ? `${input.scheme} ${input.reference}` : input.reference;
  return { [input.headerName.trim()]: value };
}

type Attempt = { id: string; revision: number; state: string; error?: { message?: string } | null };

/** Connect the tool for the workspace with the reference. Resolves once connected. */
export async function addSharedServiceKey(
  api: Pick<AppApiHost, "request">,
  input: {
    workspaceId: string;
    mcpUrl: string;
    headers: Record<string, string>;
    returnUrl: string;
    signal?: AbortSignal | undefined;
  },
): Promise<void> {
  const base = `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/connect/attempts`;
  const key = `shared-key:${crypto.randomUUID()}`;
  const begun = await api.request<Attempt>(base, {
    method: "POST",
    signal: input.signal ?? null,
    body: JSON.stringify({
      providerId: "mcp-headers",
      ownership: "workspace",
      returnUrl: input.returnUrl,
      idempotencyKey: `${key}:begin`,
    }),
  });
  const done = await api.request<Attempt>(`${base}/${encodeURIComponent(begun.id)}/advance`, {
    method: "POST",
    signal: input.signal ?? null,
    body: JSON.stringify({
      expectedRevision: begun.revision,
      idempotencyKey: `${key}:advance`,
      action: {
        type: "credentials",
        values: { mcpUrl: input.mcpUrl, headers: JSON.stringify(input.headers) },
      },
    }),
  });
  if (done.state !== "complete")
    throw new Error(done.error?.message ?? "Couldn't connect with that key.");
}

/** The dialog's face: pick a vault and an item, then save. */
export function AppSharedKeyDialogView({
  connector,
  vaults,
  items,
  vaultId,
  itemId,
  headerName,
  busy = false,
  error = null,
  onVaultChange,
  onItemChange,
  onHeaderNameChange,
  onSave,
  onCancel,
}: {
  connector: string;
  vaults: readonly VaultSummary[] | null;
  items: readonly VaultItemSummary[] | null;
  vaultId: string | null;
  itemId: string | null;
  headerName: string;
  busy?: boolean;
  error?: string | null;
  onVaultChange: (vaultId: string) => void;
  onItemChange: (itemId: string) => void;
  onHeaderNameChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const usable = (items ?? []).filter((item) => item.references.primary);
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md" data-app-shared-key-dialog="">
        <DialogHeader>
          <DialogTitle className="text-base">Add a shared key for {connector}</DialogTitle>
          <DialogDescription>
            Everyone in the workspace uses {connector} with this key. Opengeni reads it only when it
            calls the tool.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="Vault">
            <SelectMenu
              variant="combobox"
              aria-label="Vault"
              placeholder="Choose a vault"
              loading={vaults === null}
              emptyMessage="No workspace or organization vaults yet."
              value={vaultId}
              onValueChange={onVaultChange}
              options={(vaults ?? []).map((vault) => ({
                value: vault.id,
                label: vault.name,
                meta: OWNER_LABEL[vault.ownerKind],
              }))}
            />
          </Field>
          <Field label="Key">
            <SelectMenu
              variant="combobox"
              aria-label="Key"
              placeholder="Choose an item"
              disabled={!vaultId}
              loading={!!vaultId && items === null}
              emptyMessage="No items in this vault."
              value={itemId}
              onValueChange={onItemChange}
              options={usable.map((item) => ({ value: item.id, label: item.name }))}
            />
          </Field>
          <Field label="Header">
            <TextInput
              value={headerName}
              onChange={(event) => onHeaderNameChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={busy || !itemId || !headerName.trim()}
            aria-busy={busy}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The working dialog for one card item: reads the vaults the admin can use
 * and the connector's address, then connects it for the workspace.
 * `onClose(true)` once connected.
 */
export function AppSharedKeyDialog({
  api,
  workspaceId,
  item,
  onClose,
}: {
  api: Pick<AppApiHost, "request">;
  workspaceId: string;
  item: Pick<ToolGatewaySiteSetupItem, "capabilityId" | "connector">;
  onClose: (connected: boolean) => void;
}) {
  const workspace = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [capability, setCapability] = useState<CapabilityCatalogItem | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [items, setItems] = useState<VaultItemSummary[] | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [headerName, setHeaderName] = useState("Authorization");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      api.request<{ vaults: VaultSummary[] }>(`${workspace}/vaults`, { signal: abort.signal }),
      api.request<{ items: CapabilityCatalogItem[] }>(`${workspace}/capabilities`, {
        signal: abort.signal,
      }),
    ]).then(
      ([vaultList, catalog]) => {
        if (abort.signal.aborted) return;
        const found = catalog.items.find((entry) => entry.id === item.capabilityId) ?? null;
        setCapability(found);
        setHeaderName(sharedKeyHeaderDefaults(found).headerName);
        setVaults(sharedKeyVaults(vaultList.vaults));
      },
      () => {
        if (abort.signal.aborted) return;
        setVaults([]);
        setError("Couldn't load the vaults.");
      },
    );
    return () => abort.abort();
  }, [api, item.capabilityId, workspace]);

  useEffect(() => {
    if (!vaultId) return;
    const abort = new AbortController();
    setItems(null);
    setItemId(null);
    void api
      .request<{ items: VaultItemSummary[] }>(
        `${workspace}/vaults/${encodeURIComponent(vaultId)}/items?limit=200`,
        { signal: abort.signal },
      )
      .then(
        (page) => {
          if (!abort.signal.aborted) setItems(page.items);
        },
        () => {
          if (!abort.signal.aborted) setItems([]);
        },
      );
    return () => abort.abort();
  }, [api, vaultId, workspace]);

  const reference = useMemo(
    () => items?.find((entry) => entry.id === itemId)?.references.primary ?? null,
    [itemId, items],
  );
  const save = () => {
    const mcpUrl = capability?.mcpUrl ?? capability?.endpointUrl ?? null;
    if (!reference || !mcpUrl) {
      setError(mcpUrl ? "Choose a key." : `Couldn't find ${item.connector}'s address.`);
      return;
    }
    setBusy(true);
    setError(null);
    const { scheme } = sharedKeyHeaderDefaults(capability);
    addSharedServiceKey(api, {
      workspaceId,
      mcpUrl,
      headers: sharedKeyHeaders({
        headerName,
        scheme: headerName.trim().toLowerCase() === "authorization" ? scheme || "Bearer" : scheme,
        reference,
      }),
      returnUrl: window.location.href,
    }).then(
      () => onClose(true),
      (failure: unknown) => {
        setBusy(false);
        setError(failure instanceof Error && failure.message ? failure.message : "Couldn't connect.");
      },
    );
  };
  return (
    <AppSharedKeyDialogView
      connector={item.connector}
      vaults={vaults}
      items={vaultId ? items : []}
      vaultId={vaultId}
      itemId={itemId}
      headerName={headerName}
      busy={busy}
      error={error}
      onVaultChange={setVaultId}
      onItemChange={setItemId}
      onHeaderNameChange={setHeaderName}
      onSave={save}
      onCancel={() => onClose(false)}
    />
  );
}
