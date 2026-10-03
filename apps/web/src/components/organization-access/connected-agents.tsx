import { BotIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  OrganizationAccessFields,
  type AccessWorkspace,
} from "@/components/organization-access/organization-access-fields";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
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
import { Field, FieldStack } from "@/components/ui/field";
import { FLUSH_DETAIL_PAGE_CLASS, FLUSH_FORM_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { FormPage } from "@/components/ui/form-dialog";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiErrorDetails, userErrorText, userErrorTextWithoutReference } from "@/lib/api-error";
import {
  MCP_CLIENT_SETUPS,
  mcpClientHint,
  mcpClientSnippet,
  mcpConnectionStatus,
  type McpClientSetup,
  type McpConnection,
  type McpConnectionsApi,
} from "@/lib/mcp-connections";
import {
  policyBlockedReason,
  policySummary,
  scopeSummary,
  type OrganizationAccessPolicy,
} from "@/lib/organization-access";

/* ----------------------------------------------------------------------------
   Organization settings > Developer > Connected agents.

   An outside agent (Claude Code, Cursor, Codex, any MCP client) connects to
   the organization's one server URL and signs in in the browser, where the
   person chooses what it can do. This section lists those connections; each
   row opens the agent's page, where its access can be narrowed or widened and
   the agent disconnected.

     (none)                 the list
     view=connect-agent     Connect an agent: the URL and per-client setup
     agent=<id>             a connected agent's page
   -------------------------------------------------------------------------- */

export type ConnectedAgentsLocation = { view?: "connect-agent"; agent?: string };

export type ConnectedAgentsProps = {
  organizationName: string;
  /** The organization's MCP server URL. */
  mcpUrl: string;
  api: McpConnectionsApi;
  /** The signed-in person: only they change what their own agents can do. */
  currentSubjectId: string;
  workspaces: AccessWorkspace[] | null;
  workspacesError?: boolean;
  onRetryWorkspaces?: () => void;
  location: ConnectedAgentsLocation;
  onNavigate: (next: ConnectedAgentsLocation) => void;
  /** Opens Create API key, for agents that can't sign in through a browser. */
  onCreateApiKey?: () => void;
};

const COLUMNS: RowListColumn[] = [
  { id: "lastUsed", label: "Last used", width: 116 },
  { id: "connected", label: "Connected", width: 116 },
];

function AgentTile() {
  return <LogoTile icon={<BotIcon />} />;
}

function useConnections(api: McpConnectionsApi) {
  const [state, setState] = useState<{
    connections: McpConnection[] | null;
    canManageAll: boolean;
    error: Error | null;
  }>({ connections: null, canManageAll: false, error: null });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const { connections, canManageAll } = await api.list();
      if (sequence.current === current) setState({ connections, canManageAll, error: null });
    } catch (caught) {
      if (sequence.current === current)
        setState((previous) => ({
          ...previous,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        }));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh]);
  const replace = useCallback((next: McpConnection) => {
    setState((previous) => ({
      ...previous,
      connections: previous.connections?.map((each) => (each.id === next.id ? next : each)) ?? null,
    }));
  }, []);
  return { ...state, refresh, replace };
}

export function ConnectedAgents(props: ConnectedAgentsProps) {
  const { api, location, onNavigate } = props;
  const { connections, canManageAll, error, refresh, replace } = useConnections(api);

  if (location.view === "connect-agent") {
    return (
      <ConnectAgentPage
        organizationName={props.organizationName}
        mcpUrl={props.mcpUrl}
        onClose={() => onNavigate({})}
        {...(props.onCreateApiKey ? { onCreateApiKey: props.onCreateApiKey } : {})}
      />
    );
  }
  if (location.agent) {
    const connection = connections?.find((each) => each.id === location.agent) ?? null;
    return (
      <ConnectedAgentPage
        {...props}
        canManageAll={canManageAll}
        connection={connection}
        loading={connections === null && !error}
        onClose={() => onNavigate({})}
        onSaved={replace}
        onDisconnected={() => {
          void refresh();
          onNavigate({});
        }}
      />
    );
  }

  const connect = (
    <Button type="button" onClick={() => onNavigate({ view: "connect-agent" })}>
      <PlusIcon aria-hidden="true" />
      Connect an agent
    </Button>
  );
  const visible = connections?.filter((each) => mcpConnectionStatus(each) !== "revoked") ?? null;

  let body;
  if (error && visible === null) {
    body = (
      <ErrorMessage
        variant="block"
        title="Couldn't load connected agents."
        announce
        action={<RowButton onClick={() => void refresh()}>Try again</RowButton>}
        {...apiErrorDetails(error)}
      >
        {userErrorTextWithoutReference(error)}
      </ErrorMessage>
    );
  } else if (visible === null) {
    body = (
      <RowList label="Connected agents" columns={COLUMNS} busy flush>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        variant="page"
        icon={<BotIcon />}
        title="No agents connected yet"
        description={`Let Claude Code, Cursor, Codex or any MCP client work in ${props.organizationName}, with the access you choose.`}
        action={connect}
        className="pt-8 pb-6"
      />
    );
  } else {
    body = (
      <RowList label="Connected agents" columns={COLUMNS} nameLabel="Agent" flush>
        {visible.map((connection) => {
          const status = mcpConnectionStatus(connection);
          return (
            <ListRow
              key={connection.id}
              leading={<AgentTile />}
              title={connection.clientName}
              onOpen={() => onNavigate({ agent: connection.id })}
              indicator="open"
              status={
                status === "expired" ? (
                  <StatusBadge
                    variant="dot"
                    status="expired"
                    reason="Not used for 30 days. Sign in again from the agent to keep using it."
                  >
                    Signed out
                  </StatusBadge>
                ) : undefined
              }
              description={[
                ...(connection.connectedBy.subjectId === props.currentSubjectId
                  ? []
                  : [connection.connectedBy.name]),
                policySummary(connection.policy),
                scopeSummary(connection.policy.workspaceScope, props.workspaces),
              ].join(" · ")}
              cells={{
                lastUsed: connection.lastUsedAt ? (
                  <RelativeTime date={connection.lastUsedAt} />
                ) : (
                  <span className="text-fg-subtle">Never</span>
                ),
                connected: <RelativeTime date={connection.createdAt} format="date" />,
              }}
            />
          );
        })}
      </RowList>
    );
  }

  return (
    <Section
      title="Connected agents"
      description={
        canManageAll
          ? "Outside agents people connected to this organization."
          : "Outside agents you connected. Owners and admins see everyone's."
      }
      action={visible && visible.length > 0 ? connect : undefined}
    >
      {body}
    </Section>
  );
}

/** Connect an agent: the one URL, and what to paste into each client. */
export function ConnectAgentPage({
  organizationName,
  mcpUrl,
  onClose,
  onCreateApiKey,
}: {
  organizationName: string;
  mcpUrl: string;
  onClose: () => void;
  onCreateApiKey?: () => void;
}) {
  const [client, setClient] = useState<McpClientSetup["id"]>("claude");
  const snippet = mcpClientSnippet(client, mcpUrl);
  return (
    <FormPage
      className={FLUSH_FORM_PAGE_CLASS}
      back={{ label: "Developer", onClick: onClose }}
      title="Connect an agent"
      description={`The agent can do what a person can do in ${organizationName}: chats, workspaces, knowledge, schedules and settings. When it signs in, you choose its access.`}
      submitLabel="Done"
      cancelLabel={null}
      onSubmit={() => true}
      onSubmitted={onClose}
    >
      <FieldStack>
        <Field label="Server URL">
          <CopyField value={mcpUrl} label="server URL" variant="field" size="md" />
        </Field>
        <Field label="Set up" hint={mcpClientHint(client)}>
          <div className="flex min-w-0 flex-col gap-3">
            <SegmentedControl
              aria-label="Agent"
              options={MCP_CLIENT_SETUPS.map(({ id, label }) => ({ value: id, label }))}
              value={client}
              onValueChange={setClient}
              fullWidth
            />
            {client === "other" ? null : (
              <div className="flex min-w-0 flex-col gap-2">
                <pre
                  tabIndex={0}
                  className="m-0 max-w-full overflow-auto overscroll-contain rounded-[14px] border border-border bg-surface p-4 text-xs leading-[18px] text-fg"
                >
                  <code translate="no" className="font-mono">
                    {snippet}
                  </code>
                </pre>
                <div className="flex justify-end">
                  <CopySnippet text={snippet} />
                </div>
              </div>
            )}
          </div>
        </Field>
        {onCreateApiKey ? (
          <p className="m-0 text-sm leading-5 text-fg-muted">
            Agent can't sign in through a browser?{" "}
            <button
              type="button"
              onClick={onCreateApiKey}
              className="cursor-pointer font-medium text-fg underline decoration-border-strong underline-offset-4 hover:decoration-fg"
            >
              Create an API key
            </button>{" "}
            and send it as a bearer token instead.
          </p>
        ) : null}
      </FieldStack>
    </FormPage>
  );
}

function CopySnippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <RowButton
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          toast.error("Couldn't copy", { description: "Select the text and copy it by hand." });
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </RowButton>
  );
}

function samePolicy(a: OrganizationAccessPolicy, b: OrganizationAccessPolicy): boolean {
  const sameSet = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((each) => y.includes(each));
  return (
    a.preset === b.preset &&
    sameSet(a.permissions, b.permissions) &&
    a.workspaceScope.kind === b.workspaceScope.kind &&
    sameSet(
      a.workspaceScope.kind === "selected" ? a.workspaceScope.workspaceIds : [],
      b.workspaceScope.kind === "selected" ? b.workspaceScope.workspaceIds : [],
    )
  );
}

/** One connected agent: what it can do (editable by its person), and Disconnect. */
export function ConnectedAgentPage({
  organizationName,
  api,
  workspaces,
  workspacesError,
  onRetryWorkspaces,
  currentSubjectId,
  canManageAll,
  connection,
  loading,
  onClose,
  onSaved,
  onDisconnected,
}: ConnectedAgentsProps & {
  canManageAll: boolean;
  connection: McpConnection | null;
  loading: boolean;
  onClose: () => void;
  onSaved: (next: McpConnection) => void;
  onDisconnected: () => void;
}) {
  const [draft, setDraft] = useState<OrganizationAccessPolicy | null>(connection?.policy ?? null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setDraft(connection?.policy ?? null);
  }, [connection]);
  const changed = useMemo(
    () => Boolean(connection && draft && !samePolicy(connection.policy, draft)),
    [connection, draft],
  );
  const back = { label: "Developer", onClick: onClose };

  if (!connection || !draft) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {loading ? (
          <RowList label="Connected agent" busy flush>
            <ListRowSkeleton count={1} />
          </RowList>
        ) : (
          <EmptyState
            variant="page"
            icon={<BotIcon />}
            title="This agent isn't connected"
            description="It was disconnected, or you can't see it. Owners and admins see every connected agent."
          />
        )}
      </DetailPage>
    );
  }

  const status = mcpConnectionStatus(connection);
  const blocked = policyBlockedReason(draft);
  const mine = connection.connectedBy.subjectId === currentSubjectId;

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<AgentTile />}
        title={connection.clientName}
        chips={
          status === "expired" ? (
            <StatusBadge
              variant="dot"
              status="expired"
              reason="Not used for 30 days. Sign in again from the agent to keep using it."
            >
              Signed out
            </StatusBadge>
          ) : undefined
        }
        meta={[mine ? "Acts as you" : `Acts as ${connection.connectedBy.name}`]}
        actions={
          mine || canManageAll ? (
            <MoreMenu label={`More for ${connection.clientName}`}>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                Disconnect
              </DropdownMenuItem>
            </MoreMenu>
          ) : undefined
        }
      />
      <DetailPageBody
        aside={
          <DetailAside>
            <DetailAsideItem label="Signs in from">
              <span translate="no">{connection.clientHost ?? "Unknown"}</span>
            </DetailAsideItem>
            <DetailAsideItem label="Last used">
              {connection.lastUsedAt ? <RelativeTime date={connection.lastUsedAt} /> : "Never"}
            </DetailAsideItem>
            <DetailAsideItem label="Connected">
              <RelativeTime date={connection.createdAt} />
            </DetailAsideItem>
          </DetailAside>
        }
      >
        <DetailSection
          title="What it can do"
          description={
            mine
              ? "Never more than you can do. Changes apply to its next request."
              : `Never more than ${connection.connectedBy.name} can do. Only they can change it.`
          }
        >
          {mine ? (
            <div className="flex min-w-0 flex-col gap-6">
              <OrganizationAccessFields
                organizationName={organizationName}
                policy={draft}
                onPolicyChange={(next) => {
                  setDraft(next);
                  setSaveError(null);
                }}
                workspaces={workspaces}
                workspacesError={workspacesError ?? false}
                {...(onRetryWorkspaces ? { onRetryWorkspaces } : {})}
                includesPersonal
                disabled={saving}
              />
              {saveError ? (
                <p role="alert" className="m-0 text-sm leading-5 text-danger">
                  {saveError}
                </p>
              ) : null}
              {changed ? (
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {blocked ? (
                    <span className="mr-auto text-sm leading-5 text-fg-muted">{blocked}</span>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setDraft(connection.policy);
                      setSaveError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={saving || blocked !== null}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        const next = await api.update(connection.id, { policy: draft });
                        onSaved(next);
                        toast.success(`${connection.clientName} updated`);
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
          ) : (
            <dl className="m-0 grid min-w-0 grid-cols-[max-content_1fr] gap-x-6 gap-y-3 text-sm leading-5">
              <dt className="text-fg-muted">Access</dt>
              <dd className="m-0 text-fg">{policySummary(connection.policy)}</dd>
              <dt className="text-fg-muted">Available in</dt>
              <dd className="m-0 text-fg">
                {scopeSummary(connection.policy.workspaceScope, workspaces)}
              </dd>
            </dl>
          )}
        </DetailSection>
      </DetailPageBody>
      <DestructiveConfirm
        open={confirming}
        onOpenChange={setConfirming}
        title={`Disconnect ${connection.clientName}?`}
        consequences={[
          "Its next request is refused, including work it's doing now.",
          "To use it again, connect it again and sign in.",
        ]}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          await api.disconnect(connection.id);
          toast.success(`${connection.clientName} disconnected`);
          onDisconnected();
        }}
      />
    </DetailPage>
  );
}
