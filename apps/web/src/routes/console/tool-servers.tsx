// Console > Tool servers: the organization's MCP servers that agents use,
// referenced by key. A shared key's headers are write-only. One server's
// page edits it and previews the tools it offers right now.
import type {
  OrgToolServer,
  OrgToolServerAuthMode,
  OrgToolServerToolsResponse,
} from "@opengeni/contracts";
import { ORG_AGENT_KEY_PATTERN } from "@opengeni/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PlugIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { Disclosure } from "@opengeni/react/ui/disclosure";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { FlushFormPage } from "@opengeni/react/ui/flush-form-page";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { Notice } from "@opengeni/react/ui/notice";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { Skeleton } from "@opengeni/react/ui/skeleton";

import { agentKeyFromName, authModeLabel, type OrgAgentsApi } from "@/lib/organization-agents";
import {
  ConsoleLoadError,
  ConsolePage,
  useConsole,
  useConsoleQuery,
  useOrgAgentsApi,
  useOrgAgentsEnabled,
} from "./console-shared";

export function ConsoleToolServersRoute() {
  const enabled = useOrgAgentsEnabled();
  if (enabled === false) {
    return (
      <ConsolePage>
        <PageHeader title="Tool servers" icon={<PlugIcon />} />
        <EmptyState
          variant="page"
          icon={<PlugIcon />}
          title="Tool servers come with organization agents"
          description="They aren't on for this organization yet."
        />
      </ConsolePage>
    );
  }
  return <ToolServersList />;
}

function ToolServersList() {
  const { search } = useConsole();
  const api = useOrgAgentsApi();
  const navigate = useNavigate();
  const servers = useConsoleQuery((signal) => api.listToolServers(signal), [api]);
  const rows = servers.data?.toolServers ?? [];
  const create = () => void navigate({ to: "/console/tool-servers/new", search });
  return (
    <ConsolePage>
      <PageHeader
        title="Tool servers"
        icon={<PlugIcon />}
        description="Your MCP servers. Agents choose which of their tools to use."
        actions={
          rows.length > 0 ? (
            <Button onClick={create}>
              <PlusIcon aria-hidden="true" />
              Add tool server
            </Button>
          ) : undefined
        }
      />
      {servers.error ? (
        <ConsoleLoadError error={servers.error} onRetry={servers.reload} />
      ) : servers.loading && rows.length === 0 ? (
        <ListRowSkeleton count={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          variant="page"
          icon={<PlugIcon />}
          title="No tool servers yet"
          description="Add your product's MCP server so agents can act in it for each user."
          action={
            <Button onClick={create}>
              <PlusIcon aria-hidden="true" />
              Add tool server
            </Button>
          }
        />
      ) : (
        <RowList
          variant="table"
          label="Tool servers"
          nameLabel="Server"
          columns={[
            { id: "login", label: "Login", width: 144 },
            { id: "updated", label: "Updated", width: 112 },
          ]}
        >
          {rows.map((server) => (
            <ListRow
              key={server.id}
              title={server.name}
              meta={[
                <span key="key" translate="no" className="font-mono">
                  {server.key}
                </span>,
                <span key="url" translate="no">
                  {server.url}
                </span>,
              ]}
              cells={{
                login: authModeLabel(server.authMode),
                updated: <RelativeTime date={server.updatedAt} />,
              }}
              onOpen={() =>
                void navigate({
                  to: "/console/tool-servers/$serverKey",
                  params: { serverKey: server.key },
                  search,
                })
              }
            />
          ))}
        </RowList>
      )}
    </ConsolePage>
  );
}

/** "Authorization: Bearer abc" lines to headers; blank lines are skipped. */
export function parseHeaderLines(text: string): Record<string, string> | { error: string } {
  const headers: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return { error: `Write each header as Name: value ("${line.slice(0, 40)}").` };
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

type ServerForm = {
  name: string;
  key: string;
  url: string;
  authMode: OrgToolServerAuthMode;
  /** New shared key headers; empty keeps the stored ones. */
  headers: string;
  tokenUrl: string;
  clientId: string;
  /** New client secret; empty keeps the stored one. */
  clientSecret: string;
};

function formFor(server: OrgToolServer | null): ServerForm {
  return {
    name: server?.name ?? "",
    key: server?.key ?? "",
    url: server?.url ?? "",
    authMode: server?.authMode ?? "per_user",
    headers: "",
    tokenUrl: server?.oauthRefresh?.tokenUrl ?? "",
    clientId: server?.oauthRefresh?.clientId ?? "",
    clientSecret: "",
  };
}

const LOGIN_CHOICES: { value: OrgToolServerAuthMode; title: string; description: string }[] = [
  {
    value: "per_user",
    title: "Each user's login",
    description: "Tools act as the person in the chat. Your product supplies their login.",
  },
  {
    value: "shared_key",
    title: "Shared key",
    description: "One key for everyone. Only for tools that aren't about a person.",
  },
  { value: "none", title: "No login", description: "The server needs no login." },
];

function ToolServerFields({
  form,
  setForm,
  existing,
  errors,
}: {
  form: ServerForm;
  setForm: (update: (current: ServerForm) => ServerForm) => void;
  existing: OrgToolServer | null;
  errors: Partial<Record<keyof ServerForm, string>>;
}) {
  const [keyEdited, setKeyEdited] = useState(false);
  return (
    <FieldStack>
      <Field label="Name" error={errors.name}>
        <TextInput
          value={form.name}
          maxLength={120}
          suppressAutofill
          onChange={(event) => {
            const name = event.target.value;
            setForm((current) => ({
              ...current,
              name,
              ...(existing || keyEdited ? {} : { key: agentKeyFromName(name) }),
            }));
          }}
        />
      </Field>
      <Field
        label="Key"
        hint={
          existing
            ? "Agents refer to the server by its key."
            : "Agents refer to the server by this. It can't change later."
        }
        error={errors.key}
      >
        <TextInput
          value={form.key}
          maxLength={64}
          translate="no"
          className="font-mono"
          disabled={Boolean(existing)}
          suppressAutofill
          onChange={(event) => {
            setKeyEdited(true);
            setForm((current) => ({ ...current, key: event.target.value }));
          }}
        />
      </Field>
      <Field label="URL" error={errors.url}>
        <TextInput
          type="url"
          value={form.url}
          placeholder="https://"
          translate="no"
          suppressAutofill
          onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
        />
      </Field>
      <ChoiceCards
        label="Login"
        variant="radio"
        value={form.authMode}
        onValueChange={(value) =>
          setForm((current) => ({ ...current, authMode: value as OrgToolServerAuthMode }))
        }
      >
        {LOGIN_CHOICES.map((choice) => (
          <ChoiceCard key={choice.value} {...choice} />
        ))}
      </ChoiceCards>
      {form.authMode === "shared_key" ? (
        <Field
          label="Shared key headers"
          hint={
            existing?.hasSharedKey
              ? `Stored: ${existing.sharedHeaderNames.join(", ") || "headers"}. Leave empty to keep them.`
              : "One header per line, such as Authorization: Bearer … They can't be read back."
          }
          error={errors.headers}
        >
          <TextArea
            rows={3}
            translate="no"
            className="font-mono"
            autoComplete="off"
            value={form.headers}
            onChange={(event) =>
              setForm((current) => ({ ...current, headers: event.target.value }))
            }
          />
        </Field>
      ) : null}
      {form.authMode === "per_user" ? (
        <Disclosure
          title="OAuth refresh"
          summary={form.tokenUrl ? "On" : "Off"}
          defaultOpen={Boolean(form.tokenUrl)}
        >
          <FieldStack>
            <p className="m-0 text-sm text-fg-muted">
              Refreshes users' stored OAuth logins before they expire.
            </p>
            <Field label="Token URL" optional error={errors.tokenUrl}>
              <TextInput
                type="url"
                value={form.tokenUrl}
                translate="no"
                suppressAutofill
                onChange={(event) =>
                  setForm((current) => ({ ...current, tokenUrl: event.target.value }))
                }
              />
            </Field>
            <Field label="Client ID" optional>
              <TextInput
                value={form.clientId}
                translate="no"
                suppressAutofill
                onChange={(event) =>
                  setForm((current) => ({ ...current, clientId: event.target.value }))
                }
              />
            </Field>
            <Field
              label="Client secret"
              optional
              hint={
                existing?.oauthRefresh?.hasClientSecret
                  ? "Stored. Leave empty to keep it."
                  : undefined
              }
            >
              <TextInput
                type="password"
                autoComplete="off"
                value={form.clientSecret}
                onChange={(event) =>
                  setForm((current) => ({ ...current, clientSecret: event.target.value }))
                }
              />
            </Field>
          </FieldStack>
        </Disclosure>
      ) : null}
    </FieldStack>
  );
}

/** Checks the form and builds what the server stores. Errors are per field. */
export function toolServerChanges(form: ServerForm, existing: OrgToolServer | null) {
  const errors: Partial<Record<keyof ServerForm, string>> = {};
  if (!form.name.trim()) errors.name = "Name the server.";
  if (!existing && !ORG_AGENT_KEY_PATTERN.test(form.key)) {
    errors.key = "Use lowercase letters, digits, - or _, starting with a letter or digit.";
  }
  try {
    if (new URL(form.url.trim()).protocol !== "https:") errors.url = "Use an https:// URL.";
  } catch {
    errors.url = "Enter the server's https:// URL.";
  }
  let sharedHeaders: Record<string, string> | undefined;
  if (form.authMode === "shared_key" && form.headers.trim()) {
    const parsed = parseHeaderLines(form.headers);
    if ("error" in parsed && typeof parsed.error === "string") errors.headers = parsed.error;
    else sharedHeaders = parsed as Record<string, string>;
  } else if (form.authMode === "shared_key" && !existing?.hasSharedKey) {
    errors.headers = "Add the key's header, such as Authorization: Bearer …";
  }
  const oauth =
    form.authMode === "per_user" && form.tokenUrl.trim()
      ? {
          tokenUrl: form.tokenUrl.trim(),
          clientId: form.clientId.trim(),
          ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        }
      : null;
  if (oauth && !oauth.clientId) errors.tokenUrl = "Add the client ID too.";
  return { errors, sharedHeaders, oauth };
}

export function ConsoleNewToolServerRoute() {
  const { search } = useConsole();
  const api = useOrgAgentsApi();
  const navigate = useNavigate();
  const [form, setForm] = useState<ServerForm>(() => formFor(null));
  const [errors, setErrors] = useState<Partial<Record<keyof ServerForm, string>>>({});
  const close = () => void navigate({ to: "/console/tool-servers", search });
  return (
    <FlushFormPage
      backLabel="Tool servers"
      onClose={close}
      title="Add tool server"
      submitLabel="Add tool server"
      pendingLabel="Adding…"
      onSubmit={async () => {
        const { errors: next, sharedHeaders, oauth } = toolServerChanges(form, null);
        setErrors(next);
        if (Object.keys(next).length > 0) return false;
        try {
          const created = await api.createToolServer({
            key: form.key,
            name: form.name.trim(),
            url: form.url.trim(),
            authMode: form.authMode,
            ...(sharedHeaders ? { sharedHeaders } : {}),
            ...(oauth ? { oauthRefresh: oauth } : {}),
          });
          void navigate({
            to: "/console/tool-servers/$serverKey",
            params: { serverKey: created.key },
            search,
          });
          return false;
        } catch (error) {
          throw new Error(`The tool server wasn't added. ${userErrorText(error)}`, {
            cause: error,
          });
        }
      }}
    >
      <ToolServerFields form={form} setForm={setForm} existing={null} errors={errors} />
    </FlushFormPage>
  );
}

export function ConsoleToolServerRoute() {
  const { search } = useConsole();
  const api = useOrgAgentsApi();
  const navigate = useNavigate();
  const { serverKey = "" } = useParams({ strict: false }) as { serverKey?: string };
  const loaded = useConsoleQuery(
    (signal) => api.getToolServer(serverKey, signal),
    [api, serverKey],
  );
  const [form, setForm] = useState<ServerForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof ServerForm, string>>>({});
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (loaded.data) setForm(formFor(loaded.data));
  }, [loaded.data]);
  const close = () => void navigate({ to: "/console/tool-servers", search });
  const server = loaded.data;

  if (loaded.error) {
    return (
      <ConsolePage>
        <ConsoleLoadError error={loaded.error} onRetry={loaded.reload} />
      </ConsolePage>
    );
  }

  return (
    <>
      <FlushFormPage
        backLabel="Tool servers"
        onClose={close}
        title={server?.name ?? "Tool server"}
        submitLabel="Save"
        pendingLabel="Saving…"
        loading={!server || !form}
        onSubmit={async () => {
          if (!server || !form) return false;
          const { errors: next, sharedHeaders, oauth } = toolServerChanges(form, server);
          setErrors(next);
          if (Object.keys(next).length > 0) return false;
          try {
            await api.updateToolServer(server.key, {
              expectedVersion: server.rowVersion,
              name: form.name.trim(),
              url: form.url.trim(),
              authMode: form.authMode,
              ...(form.authMode !== "shared_key" && server.hasSharedKey
                ? { sharedHeaders: null }
                : sharedHeaders
                  ? { sharedHeaders }
                  : {}),
              ...(form.authMode === "per_user"
                ? oauth
                  ? { oauthRefresh: oauth }
                  : server.oauthRefresh
                    ? { oauthRefresh: null }
                    : {}
                : {}),
            });
            toast.success(`Saved ${form.name.trim()}`);
            loaded.reload();
            return false;
          } catch (error) {
            throw new Error(`Couldn't save the tool server. ${userErrorText(error)}`, {
              cause: error,
            });
          }
        }}
        footerStart={
          server ? (
            <Button
              type="button"
              variant="ghost"
              className="text-danger"
              onClick={() => setDeleting(true)}
            >
              <TrashIcon aria-hidden="true" />
              Delete
            </Button>
          ) : undefined
        }
      >
        {server && form ? (
          <div className="flex flex-col gap-8">
            <ToolServerFields
              form={form}
              setForm={(update) => setForm((current) => (current ? update(current) : current))}
              existing={server}
              errors={errors}
            />
            <LiveToolsPreview api={api} serverKey={server.key} />
          </div>
        ) : null}
      </FlushFormPage>
      <DestructiveConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${server?.name ?? "this tool server"}?`}
        consequences={[
          "Agents that use it lose its tools in new chats.",
          "Stored user logins for it are deleted.",
        ]}
        confirmLabel="Delete tool server"
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!server) return;
          try {
            await api.deleteToolServer(server.key);
          } catch (error) {
            throw new Error(`Couldn't delete ${server.name}. ${userErrorText(error)}`, {
              cause: error,
            });
          }
          toast.success(`Deleted ${server.name}`);
          close();
        }}
      />
    </>
  );
}

/** The tools the server offers right now, as Opengeni sees them. */
function LiveToolsPreview({ api, serverKey }: { api: OrgAgentsApi; serverKey: string }) {
  const tools = useConsoleQuery<OrgToolServerToolsResponse>(
    (signal) => api.listToolServerTools(serverKey, signal),
    [api, serverKey],
  );
  return (
    <section aria-labelledby="live-tools" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="live-tools" className="m-0 text-sm font-medium text-fg">
          Tools it offers now
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={tools.reload}
          disabled={tools.loading}
        >
          <RefreshCwIcon aria-hidden="true" />
          Check again
        </Button>
      </div>
      {tools.loading && !tools.data ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : tools.error ? (
        <Notice tone="failed">Couldn't reach the server: {userErrorText(tools.error)}</Notice>
      ) : tools.data?.error ? (
        <Notice tone="failed">Couldn't list its tools: {tools.data.error}</Notice>
      ) : (tools.data?.tools.length ?? 0) === 0 ? (
        <p className="m-0 text-sm text-fg-muted">It offers no tools.</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-border rounded-[12px] border border-border p-0">
          {tools.data?.tools.map((tool) => (
            <li key={tool.name} className="px-4 py-2.5">
              <p translate="no" className="m-0 font-mono text-[13px] text-fg">
                {tool.name}
              </p>
              {tool.description ? (
                <p className="m-0 line-clamp-2 text-xs text-fg-muted">{tool.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
