import type { ApiKey, ConsoleApiKeyUsage } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { Field, FieldStack, TextInput } from "@opengeni/react/ui/field";
import { FlushFormPage } from "@opengeni/react/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

import { SecretOnce } from "@/components/ui/secret-field";
import { apiKeyStatus } from "@/lib/api-key-status";
import {
  ConsoleLoadError,
  ConsolePage,
  formatCount,
  formatMicros,
  useConsole,
  useConsoleQuery,
} from "./console-shared";

function accessLabel(apiKey: Pick<ApiKey, "access">): string {
  switch (apiKey.access) {
    case "full":
      return "Full";
    case "read":
      return "Read only";
    case "developer_setup":
      return "Developer setup";
    default:
      return "Custom";
  }
}

/** Member names by subject, for "Created by". */
function useMemberNames() {
  const { client, organizationId } = useConsole();
  const members = useConsoleQuery(
    () => client.listOrganizationAdministrationMembers(organizationId),
    [client, organizationId],
  );
  return useMemo(
    () =>
      new Map(
        (members.data?.members ?? []).map((member) => [
          member.subjectId,
          member.name ?? member.email ?? null,
        ]),
      ),
    [members.data],
  );
}

/** A key in the list: an organization key, or a key that belongs to one team workspace. */
export type ConsoleKey = { apiKey: ApiKey; workspace: { id: string; name: string } | null };

const WORKSPACE_KEY_LOOKUPS = 50;

/**
 * Organization keys, then each team workspace's own keys (older setups created
 * keys there). A workspace whose keys can't be read is left out.
 */
export async function loadConsoleKeys(
  client: ReturnType<typeof useConsole>["client"],
  organizationId: string,
  signal: AbortSignal,
): Promise<ConsoleKey[]> {
  const [organizationKeys, teams] = await Promise.all([
    client.listOrganizationApiKeys(organizationId),
    client
      .listConsoleWorkspaces(organizationId, { kind: "team", signal })
      .then((response) => response.workspaces.slice(0, WORKSPACE_KEY_LOOKUPS))
      .catch(() => []),
  ]);
  const workspaceKeys = await Promise.all(
    teams.map(async (workspace) => {
      try {
        const keys = await client.listApiKeys(workspace.id);
        return keys.map((apiKey) => ({
          apiKey,
          workspace: { id: workspace.id, name: workspace.name },
        }));
      } catch {
        return [];
      }
    }),
  );
  const all: ConsoleKey[] = [
    ...organizationKeys.map((apiKey) => ({ apiKey, workspace: null })),
    ...workspaceKeys.flat(),
  ];
  // Most recently used first, so the key in daily use is at the top.
  const used = (key: ConsoleKey) => (key.apiKey.lastUsedAt ? Date.parse(key.apiKey.lastUsedAt) : 0);
  return all.sort((a, b) => used(b) - used(a));
}

function scopeLabel({ apiKey, workspace }: ConsoleKey): string {
  if (workspace) return workspace.name;
  const scope = apiKey.workspaceScope;
  if (!scope || scope.kind === "all") return "All workspaces";
  return scope.workspaceIds.length === 1
    ? "1 workspace"
    : `${formatCount(scope.workspaceIds.length)} workspaces`;
}

export function ConsoleApiKeysRoute() {
  const { client, organizationId, search } = useConsole();
  const navigate = useNavigate();
  const [revoking, setRevoking] = useState<ConsoleKey | null>(null);
  const keys = useConsoleQuery(
    (signal) => loadConsoleKeys(client, organizationId, signal),
    [client, organizationId],
  );
  const usage = useConsoleQuery(
    (signal) => client.getConsoleApiKeyUsage(organizationId, { range: "30d", signal }),
    [client, organizationId],
  );
  const names = useMemberNames();
  const usageByKey = useMemo(
    () =>
      new Map<string, ConsoleApiKeyUsage>(
        (usage.data?.apiKeys ?? []).map((entry) => [entry.apiKeyId, entry]),
      ),
    [usage.data],
  );
  const rows = keys.data ?? [];
  const create = () => void navigate({ to: "/console/api-keys/new", search });

  return (
    <ConsolePage>
      <PageHeader
        title="API keys"
        icon={<KeyRoundIcon />}
        description="For your server. A key is shown once, when you create it."
        actions={
          rows.length > 0 ? (
            <Button onClick={create}>
              <PlusIcon aria-hidden="true" />
              Create key
            </Button>
          ) : undefined
        }
      />
      {keys.error ? (
        <ConsoleLoadError error={keys.error} onRetry={keys.reload} />
      ) : keys.loading && rows.length === 0 ? (
        <ListRowSkeleton count={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          variant="page"
          icon={<KeyRoundIcon />}
          title="No API keys yet"
          description="Your server uses a key to create managed workspaces and sessions."
          action={
            <Button onClick={create}>
              <PlusIcon aria-hidden="true" />
              Create key
            </Button>
          }
        />
      ) : (
        <RowList
          variant="table"
          label="API keys"
          nameLabel="Key"
          columns={[
            { id: "kind", label: "Kind", width: 100 },
            { id: "scope", label: "Scope", width: 128 },
            { id: "access", label: "Access", width: 96 },
            { id: "used", label: "Last used", width: 100 },
            { id: "creator", label: "Created by", width: 104 },
            { id: "spend", label: "Spend, 30 days", width: 104, align: "end" },
          ]}
        >
          {rows.map((key) => {
            const { apiKey } = key;
            const status = apiKeyStatus(apiKey);
            const keyUsage = usageByKey.get(apiKey.id);
            const creator = keyUsage?.createdBySubjectId
              ? (names.get(keyUsage.createdBySubjectId) ?? null)
              : null;
            return (
              <ListRow
                key={apiKey.id}
                title={apiKey.name}
                meta={[
                  <span key="prefix" translate="no" className="font-mono">
                    {apiKey.prefix}…
                  </span>,
                  apiKey.expiresAt && status === "active" ? (
                    <span key="expires">
                      Expires <RelativeTime date={apiKey.expiresAt} format="date" />
                    </span>
                  ) : null,
                  keyUsage && keyUsage.managedWorkspaces > 0
                    ? `${formatCount(keyUsage.managedWorkspaces)} managed ${
                        keyUsage.managedWorkspaces === 1 ? "workspace" : "workspaces"
                      }`
                    : null,
                ]}
                status={
                  status === "active" ? undefined : <StatusBadge variant="dot" status={status} />
                }
                cells={{
                  kind: key.workspace ? "Workspace" : "Organization",
                  scope: scopeLabel(key),
                  access: key.workspace ? "—" : accessLabel(apiKey),
                  used: apiKey.lastUsedAt ? (
                    <RelativeTime date={apiKey.lastUsedAt} />
                  ) : (
                    <span className="text-fg-subtle">Never</span>
                  ),
                  creator: creator ?? "—",
                  spend: keyUsage ? formatMicros(keyUsage.spendMicros) : "—",
                }}
                {...(status === "revoked"
                  ? {}
                  : {
                      menu: (
                        <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(key)}>
                          Revoke
                        </DropdownMenuItem>
                      ),
                    })}
              />
            );
          })}
        </RowList>
      )}
      <DestructiveConfirm
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.apiKey.name ?? "this key"}?`}
        consequences={
          revoking
            ? [
                `Every request using ${revoking.apiKey.prefix}… is refused right away.`,
                "Anything using it needs a new key to keep working.",
                "This can't be undone.",
              ]
            : []
        }
        confirmLabel="Revoke key"
        pendingLabel="Revoking…"
        onConfirm={async () => {
          if (!revoking) return;
          const { apiKey, workspace } = revoking;
          try {
            if (workspace) await client.deleteApiKey(workspace.id, apiKey.id);
            else await client.deleteOrganizationApiKey(organizationId, apiKey.id);
          } catch (error) {
            throw new Error(`Couldn't revoke ${apiKey.name}. ${userErrorText(error)}`, {
              cause: error,
            });
          }
          toast.success(`Revoked ${apiKey.name}`, {
            description: "Requests using it are refused from now on.",
          });
          keys.reload();
        }}
      />
    </ConsolePage>
  );
}

type Expiry = "never" | "30" | "90" | "365";

const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

export function expiryDate(expiry: Expiry, now: number = Date.now()): string | undefined {
  if (expiry === "never") return undefined;
  return new Date(now + Number(expiry) * 24 * 60 * 60 * 1000).toISOString();
}

/** Create key: name, access and expiry, then the token once on the same page. */
export function ConsoleNewApiKeyRoute() {
  const { client, organizationId, search } = useConsole();
  const navigate = useNavigate();
  const [name, setName] = useState("Production server");
  const [nameError, setNameError] = useState<string | null>(null);
  const [access, setAccess] = useState<"full" | "read">("full");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [token, setToken] = useState<string | null>(null);
  const close = () => void navigate({ to: "/console/api-keys", search });

  if (token) {
    return (
      <FlushFormPage
        backLabel="API keys"
        onClose={close}
        title="Key created"
        description={name.trim()}
        submitLabel="Done"
        cancelLabel={null}
        onSubmitted={close}
      >
        <SecretOnce
          value={token}
          label="API key"
          details={
            <>
              Store it on your server as{" "}
              <code translate="no" className="font-mono text-fg">
                OPENGENI_API_KEY
              </code>
              . Never ship it to a browser or app.
            </>
          }
        />
      </FlushFormPage>
    );
  }

  return (
    <FlushFormPage
      backLabel="API keys"
      onClose={close}
      title="Create key"
      submitLabel="Create key"
      pendingLabel="Creating…"
      onSubmit={async () => {
        const trimmed = name.trim();
        if (!trimmed) {
          setNameError("Name the key.");
          return false;
        }
        const expiresAt = expiryDate(expiry);
        try {
          const created = await client.createOrganizationApiKey(organizationId, {
            name: trimmed,
            access,
            ...(expiresAt ? { expiresAt } : {}),
          });
          setToken(created.token);
          return false;
        } catch (error) {
          throw new Error(`The key wasn't created. ${userErrorText(error)}`, { cause: error });
        }
      }}
    >
      <FieldStack>
        <Field label="Name" error={nameError ?? undefined}>
          <TextInput
            value={name}
            maxLength={200}
            suppressAutofill
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
        </Field>
        <ChoiceCards
          label="Access"
          variant="radio"
          value={access}
          onValueChange={(value) => setAccess(value === "read" ? "read" : "full")}
        >
          <ChoiceCard
            value="full"
            title="Full"
            description="Creates workspaces and runs sessions for your end users."
          />
          <ChoiceCard
            value="read"
            title="Read only"
            description="Reads workspaces, sessions and files. Changes nothing."
          />
        </ChoiceCards>
        <Field label="Expires">
          <SegmentedControl
            aria-label="Expires"
            options={EXPIRY_OPTIONS}
            value={expiry}
            onValueChange={(value) => setExpiry(value as Expiry)}
          />
        </Field>
      </FieldStack>
    </FlushFormPage>
  );
}
