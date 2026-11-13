import type { ChatClient, OrganizationAnthropicApiKey } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { Loader2Icon, MinusCircleIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { SecretInput } from "@/components/ui/secret-field";
import { providerRefusalText } from "@/components/organization-model-provider-connection";
import { useSharedQuery } from "@opengeni/react/app/lib/shared-query";
import { Button } from "@opengeni/react/ui/button";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { SettingRow, SettingRowGroup } from "@opengeni/react/ui/setting-row";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

/* ----------------------------------------------------------------------------
   The API keys of the organization's Anthropic API connection. Its own key is
   the first; an admin can add keys of other Anthropic organizations beside
   it. Each chat keeps one key, and moves to another only when Anthropic
   refuses its key for lack of credits. Key values are never shown.
   -------------------------------------------------------------------------- */

function keysQueryKey(organizationId: string) {
  return ["model-settings", "organization-provider", organizationId, "anthropic", "api-keys"];
}

function keyTitle(key: OrganizationAnthropicApiKey): string {
  return key.connectionKey ? "Connection key" : (key.label ?? "API key");
}

function keyDescription(key: OrganizationAnthropicApiKey): string {
  const parts = [
    key.connectionKey ? "Replace or disconnect it with the connection" : null,
    key.anthropicOrganizationId ? `Anthropic organization ${key.anthropicOrganizationId}` : null,
    key.creditRefusedAt
      ? `Out of credits since ${new Date(key.creditRefusedAt).toLocaleString()}`
      : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function OrganizationAnthropicApiKeys({
  client,
  organizationId,
  canManage,
}: {
  client: ChatClient<OpenGeniBrowserClient>;
  organizationId: string;
  canManage: boolean;
}) {
  const query = useSharedQuery(
    client,
    keysQueryKey(organizationId),
    async () => await client.listOrganizationAnthropicApiKeys(organizationId),
    { enabled: true, staleTimeMs: 60_000 },
  );
  const [adding, setAdding] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<OrganizationAnthropicApiKey | null>(null);
  const [renaming, setRenaming] = useState<OrganizationAnthropicApiKey | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const keys = query.data?.keys ?? [];

  async function serveAgain(key: OrganizationAnthropicApiKey) {
    setBusyKeyId(key.id);
    try {
      await client.serveOrganizationAnthropicApiKeyAgain(organizationId, key.id);
      await query.refresh();
      toast.success(`${keyTitle(key)} serves again`);
    } catch (error) {
      toast.error(providerRefusalText(error));
    } finally {
      setBusyKeyId(null);
    }
  }

  async function remove(key: OrganizationAnthropicApiKey): Promise<boolean> {
    setBusyKeyId(key.id);
    try {
      await client.removeOrganizationAnthropicApiKey(organizationId, key.id);
      await query.refresh();
      toast.success(`${keyTitle(key)} removed`);
      return true;
    } catch (error) {
      toast.error(providerRefusalText(error));
      return false;
    } finally {
      setBusyKeyId(null);
    }
  }

  return (
    <DetailSection
      title="API keys"
      description="Add keys of other Anthropic organizations to run these models on several. Each chat keeps one key, so its prompt cache stays warm, and moves to another only when its key runs out of credits. Claude subscription models never use these keys."
    >
      <div className="flex min-w-0 flex-col gap-4">
        {query.error ? (
          <ErrorMessage
            title="Couldn't load the API keys."
            action={
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void query.refresh()}
                className="rounded-[10px] pointer-coarse:h-11"
              >
                Try again
              </Button>
            }
          >
            {providerRefusalText(query.error)}
          </ErrorMessage>
        ) : null}
        {keys.length > 0 ? (
          <SettingRowGroup role="list" aria-label="Anthropic API keys" className="-mb-3">
            {keys.map((key) => (
              <SettingRow
                key={key.id}
                role="listitem"
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{keyTitle(key)}</span>
                    <StatusBadge
                      variant="outline"
                      status={key.creditRefusedAt ? "off" : "connected"}
                    >
                      {key.creditRefusedAt ? "Out of credits" : "Serving"}
                    </StatusBadge>
                  </span>
                }
                description={keyDescription(key)}
                control={
                  canManage ? (
                    <span className="flex items-center gap-1">
                      {key.creditRefusedAt ? (
                        <RowButton
                          disabled={busyKeyId !== null}
                          onClick={() => void serveAgain(key)}
                        >
                          Serve again
                        </RowButton>
                      ) : null}
                      {key.connectionKey ? null : (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="rounded-[10px] text-fg-subtle hover:text-fg pointer-coarse:size-11"
                          disabled={busyKeyId !== null}
                          aria-label={`Rename ${keyTitle(key)}`}
                          onClick={() => {
                            setNewLabel(key.label ?? "");
                            setRenameError(null);
                            setRenaming(key);
                          }}
                        >
                          <PencilIcon aria-hidden="true" />
                        </Button>
                      )}
                      {key.connectionKey ? null : (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="-mr-1.5 rounded-[10px] text-fg-subtle hover:text-danger pointer-coarse:size-11"
                          disabled={busyKeyId !== null}
                          aria-label={`Remove ${keyTitle(key)}`}
                          onClick={() => setPendingRemoval(key)}
                        >
                          {busyKeyId === key.id ? (
                            <Loader2Icon aria-hidden="true" className="motion-safe:animate-spin" />
                          ) : (
                            <MinusCircleIcon aria-hidden="true" />
                          )}
                        </Button>
                      )}
                    </span>
                  ) : null
                }
              />
            ))}
          </SettingRowGroup>
        ) : null}
        {canManage && query.data ? (
          <div>
            <RowButton onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" />
              Add API key
            </RowButton>
          </div>
        ) : null}
        {canManage && query.data ? (
          <FormDialog
            open={adding}
            onOpenChange={(open) => {
              setAdding(open);
              if (!open) {
                setApiKey("");
                setLabel("");
                setAddError(null);
              }
            }}
            size="sm"
            title="Add an Anthropic API key"
            description="A key of another Anthropic organization. It's checked with Anthropic first, stored encrypted and never shown again."
            submitLabel="Add key"
            pendingLabel="Checking…"
            error={addError}
            submitDisabled={!apiKey.trim() || !label.trim()}
            onSubmit={async () => {
              setAddError(null);
              try {
                await client.addOrganizationAnthropicApiKey(organizationId, {
                  apiKey: apiKey.trim(),
                  label: label.trim(),
                });
                await query.refresh();
                toast.success(`${label.trim()} added`);
                return true;
              } catch (error) {
                setAddError(providerRefusalText(error));
                return false;
              }
            }}
            onSubmitted={() => {
              setAdding(false);
              setApiKey("");
              setLabel("");
            }}
          >
            <FieldStack>
              <Field label="Name" hint="For example the Anthropic account it belongs to.">
                <TextInput
                  value={label}
                  maxLength={128}
                  autoComplete="off"
                  aria-label="Key name"
                  onChange={(event) => setLabel(event.target.value)}
                />
              </Field>
              <Field label="API key">
                <SecretInput
                  value={apiKey}
                  autoComplete="off"
                  aria-label="Anthropic API key"
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setAddError(null);
                  }}
                />
              </Field>
            </FieldStack>
          </FormDialog>
        ) : null}
      </div>
      <FormDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        size="sm"
        title="Rename API key"
        submitLabel="Save name"
        pendingLabel="Saving…"
        error={renameError}
        submitDisabled={!newLabel.trim()}
        onSubmit={async () => {
          const key = renaming;
          if (!key) return true;
          setRenameError(null);
          try {
            await client.updateOrganizationAnthropicApiKey(organizationId, key.id, {
              label: newLabel.trim(),
            });
            await query.refresh();
            return true;
          } catch (error) {
            setRenameError(providerRefusalText(error));
            return false;
          }
        }}
        onSubmitted={() => setRenaming(null)}
      >
        <FieldStack>
          <Field label="Name">
            <TextInput
              value={newLabel}
              maxLength={128}
              autoComplete="off"
              aria-label="New key name"
              onChange={(event) => setNewLabel(event.target.value)}
            />
          </Field>
        </FieldStack>
      </FormDialog>
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        title={`Remove ${pendingRemoval ? keyTitle(pendingRemoval) : "key"}?`}
        description="Chats on this key move to another key, starting a new prompt cache there."
        confirmLabel="Remove key"
        pendingLabel="Removing…"
        onConfirm={async () => {
          const key = pendingRemoval;
          if (!key) return;
          if (await remove(key)) setPendingRemoval(null);
        }}
      />
    </DetailSection>
  );
}
