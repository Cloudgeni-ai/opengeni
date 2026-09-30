import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { CheckIcon, CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ModelsFormPage } from "@/components/models/models-ui";
import { RowButton } from "@/components/ui/page-actions";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SecretOnce } from "@/components/ui/secret-field";
import { Section, SectionStack } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  apiErrorDetails,
  isPermissionDenied,
  userErrorText,
  userErrorTextWithoutReference,
} from "@/lib/api-error";
import { apiKeyStatus } from "@/lib/api-key-status";
import type { ApiKey } from "@/types";

type CreateOrganizationApiKeyRequest = Parameters<
  OpenGeniBrowserClient["createOrganizationApiKey"]
>[1];
type CreateApiKeyResponse = Awaited<ReturnType<OpenGeniBrowserClient["createOrganizationApiKey"]>>;

export type OrganizationApiKeysSectionProps = {
  organizationId: string;
  canManage: boolean;
  listApiKeys: () => Promise<ApiKey[]>;
  createApiKey: (request: CreateOrganizationApiKeyRequest) => Promise<CreateApiKeyResponse>;
  deleteApiKey: (apiKeyId: string) => Promise<ApiKey>;
  /**
   * Optional URL state: "new-key" shows Create API key in place of the list.
   * Without it the page keeps the state itself.
   */
  view?: "new-key" | undefined;
  onViewChange?: (view: "new-key" | undefined) => void;
  /** This server accepts agent settings: the quick start shows `agent`. */
  agentSettings?: boolean;
};

const defaultKeyName = "Organization automation";

const COLUMNS: RowListColumn[] = [
  { id: "lastUsed", label: "Last used", width: 116 },
  { id: "created", label: "Created", width: 116 },
];

/**
 * Organization settings > Developer: the organization's API keys first, then
 * the integration guide, collapsed.
 */
export function OrganizationApiKeysSection(props: OrganizationApiKeysSectionProps) {
  const { canManage, listApiKeys } = props;
  const mountedRef = useRef(true);
  const readSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysError, setApiKeysError] = useState<Error | null>(null);
  const [apiKeysLoaded, setApiKeysLoaded] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [localView, setLocalView] = useState<"new-key" | undefined>(undefined);
  const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const view = props.onViewChange ? props.view : localView;
  const setView = props.onViewChange ?? setLocalView;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readSequenceRef.current += 1;
      mutationSequenceRef.current += 1;
    };
  }, []);

  const refreshApiKeys = useCallback(async () => {
    const sequence = readSequenceRef.current + 1;
    readSequenceRef.current = sequence;
    if (!canManage) {
      setApiKeys([]);
      setApiKeysError(null);
      setApiKeysLoaded(true);
      return;
    }
    try {
      const nextApiKeys = await listApiKeys();
      if (!mountedRef.current || readSequenceRef.current !== sequence) return;
      setApiKeys(nextApiKeys);
      setApiKeysError(null);
    } catch (error) {
      if (!mountedRef.current || readSequenceRef.current !== sequence) return;
      setApiKeysError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (mountedRef.current && readSequenceRef.current === sequence) {
        setApiKeysLoaded(true);
      }
    }
  }, [canManage, listApiKeys]);

  useEffect(() => {
    void refreshApiKeys();
  }, [refreshApiKeys]);

  async function createKey(request: CreateOrganizationApiKeyRequest): Promise<string | null> {
    const sequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = sequence;
    const result = await props.createApiKey(request);
    if (!mountedRef.current || mutationSequenceRef.current !== sequence) return null;
    setApiKeys((current) => [
      result.apiKey,
      ...current.filter((key) => key.id !== result.apiKey.id),
    ]);
    setStatusMessage("Organization API key created. Copy it before you leave this page.");
    return result.token;
  }

  async function revokeKey(apiKey: ApiKey): Promise<void> {
    const sequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = sequence;
    setBusyKeyId(apiKey.id);
    try {
      const revoked = await props.deleteApiKey(apiKey.id);
      if (!mountedRef.current || mutationSequenceRef.current !== sequence) return;
      setApiKeys((current) => current.map((key) => (key.id === revoked.id ? revoked : key)));
      setStatusMessage(`Revoked ${apiKey.name}.`);
      toast.success(`Revoked ${apiKey.name}`, {
        description: "Requests using it are refused from now on.",
      });
    } catch (error) {
      if (!mountedRef.current || mutationSequenceRef.current !== sequence) return;
      throw new Error(`Couldn't revoke ${apiKey.name}. ${userErrorText(error)}`, { cause: error });
    } finally {
      if (mountedRef.current && mutationSequenceRef.current === sequence) setBusyKeyId(null);
    }
  }

  const status = (
    <span role="status" aria-live="polite" className="sr-only">
      {statusMessage}
    </span>
  );

  if (view === "new-key" && canManage) {
    return (
      <>
        {status}
        <CreateApiKeyPage onClose={() => setView(undefined)} onCreate={createKey} />
      </>
    );
  }

  const openCreate = () => setView("new-key");
  const createButton = (
    <RowButton variant="default" onClick={openCreate}>
      <PlusIcon aria-hidden="true" />
      Create API key
    </RowButton>
  );
  const activeCount = apiKeys.filter((key) => apiKeyStatus(key) === "active").length;
  const listed = canManage && apiKeysLoaded && !(apiKeysError && apiKeys.length === 0);

  let body;
  // A permission refusal reads the same as not having it: say who can, no Try again.
  if (!canManage || (apiKeysError && apiKeys.length === 0 && isPermissionDenied(apiKeysError))) {
    body = (
      <Notice tone="muted" title="You can't manage organization API keys">
        Ask an organization owner to create or revoke them.
      </Notice>
    );
  } else if (apiKeysError && apiKeys.length === 0) {
    body = (
      <ErrorMessage
        variant="block"
        title="Couldn't load organization API keys."
        announce
        action={<RowButton onClick={() => void refreshApiKeys()}>Try again</RowButton>}
        {...apiErrorDetails(apiKeysError)}
      >
        {userErrorTextWithoutReference(apiKeysError)}
      </ErrorMessage>
    );
  } else if (!apiKeysLoaded) {
    body = (
      <RowList label="Organization API keys" columns={COLUMNS} busy flush>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  } else if (apiKeys.length === 0) {
    body = (
      <EmptyState
        variant="page"
        icon={<KeyRoundIcon />}
        title="No organization API keys yet"
        description="Create a key for a server that creates and runs workspaces for your product."
        action={
          <Button type="button" onClick={openCreate} className="pointer-coarse:h-11">
            <PlusIcon aria-hidden="true" />
            Create API key
          </Button>
        }
        className="pt-8 pb-6"
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-3">
        {apiKeysError ? (
          <ErrorMessage
            variant="inline"
            title="Couldn't refresh organization API keys."
            announce
            action={<RowButton onClick={() => void refreshApiKeys()}>Try again</RowButton>}
            {...apiErrorDetails(apiKeysError)}
          >
            {userErrorTextWithoutReference(apiKeysError)}
          </ErrorMessage>
        ) : null}
        <RowList label="Organization API keys" columns={COLUMNS} nameLabel="Key" flush>
          {apiKeys.map((apiKey) => {
            const keyStatus = apiKeyStatus(apiKey);
            return (
              <ListRow
                key={apiKey.id}
                leading={<LogoTile icon={<KeyRoundIcon />} />}
                title={apiKey.name}
                status={
                  keyStatus === "active" ? undefined : (
                    <StatusBadge variant="dot" status={keyStatus}>
                      {keyStatus === "revoked" ? "Revoked" : "Expired"}
                    </StatusBadge>
                  )
                }
                description={
                  <>
                    <span translate="no" className="font-mono">
                      {apiKey.prefix}…
                    </span>
                    {apiKey.description ? ` · ${apiKey.description}` : null}
                  </>
                }
                cells={{
                  lastUsed: apiKey.lastUsedAt ? (
                    <RelativeTime date={apiKey.lastUsedAt} />
                  ) : (
                    <span className="text-fg-subtle">Never</span>
                  ),
                  created: <RelativeTime date={apiKey.createdAt} format="date" />,
                }}
                control={
                  keyStatus === "revoked" ? undefined : (
                    <RowButton
                      aria-label={`Revoke organization API key ${apiKey.name}`}
                      disabled={busyKeyId !== null}
                      onClick={() => setRevokingKey(apiKey)}
                    >
                      Revoke
                    </RowButton>
                  )
                }
              />
            );
          })}
        </RowList>
      </div>
    );
  }

  return (
    <>
      {status}
      <SectionStack>
        <Section
          title="API keys"
          description={
            listed && apiKeys.length > 0
              ? `${activeCount === 0 ? "No active keys" : `${activeCount} active`}. Server credentials that create and run every shared workspace, never Personal ones.`
              : "Server credentials that create and run every shared workspace, never Personal ones."
          }
          action={listed && apiKeys.length > 0 ? createButton : undefined}
        >
          {body}
        </Section>
        <IntegrationGuide
          organizationId={props.organizationId}
          agentSettings={props.agentSettings === true}
        />
        <DestructiveConfirm
          open={revokingKey !== null}
          onOpenChange={(open) => {
            if (!open) setRevokingKey(null);
          }}
          title={`Revoke ${revokingKey?.name ?? "this key"}?`}
          consequences={
            revokingKey
              ? [
                  `Every request using ${revokingKey.prefix}… is refused right away.`,
                  "Anything using it needs a new key to keep working.",
                  "This can't be undone.",
                ]
              : []
          }
          confirmLabel="Revoke key"
          pendingLabel="Revoking…"
          onConfirm={async () => {
            if (revokingKey) await revokeKey(revokingKey);
          }}
        />
      </SectionStack>
    </>
  );
}

/** Create API key: its own page, and the key shown once on the same page. */
function CreateApiKeyPage({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (request: CreateOrganizationApiKeyRequest) => Promise<string | null>;
}) {
  const [name, setName] = useState(defaultKeyName);
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // On the one-time step focus moves to Copy, so the key isn't skipped unseen.
    if (token) pageRef.current?.querySelector<HTMLElement>("[data-slot=form-body] button")?.focus();
  }, [token]);

  if (token) {
    return (
      <div ref={pageRef} className="min-w-0">
        <ModelsFormPage
          backLabel="Developer"
          onClose={onClose}
          title="API key created"
          description={name.trim() || defaultKeyName}
          submitLabel="I've saved it"
          cancelLabel={null}
          onSubmitted={onClose}
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
        </ModelsFormPage>
      </div>
    );
  }

  return (
    <div ref={pageRef} className="min-w-0">
      <ModelsFormPage
        backLabel="Developer"
        onClose={onClose}
        title="Create API key"
        description="For a server that creates and runs shared workspaces for your product. It can't open Personal workspaces or read secret values."
        submitLabel="Create API key"
        pendingLabel="Creating…"
        onSubmit={async () => {
          const trimmed = name.trim();
          if (!trimmed) {
            setNameError("Name the key.");
            return false;
          }
          try {
            const created = await onCreate({
              name: trimmed,
              ...(description.trim() ? { description: description.trim() } : {}),
            });
            if (created === null) return false;
            setToken(created);
            return false;
          } catch (error) {
            throw new Error(
              `The key wasn't created. ${userErrorText(error, "Check your permission and plan limit, then try again.")}`,
              { cause: error },
            );
          }
        }}
      >
        <FieldStack>
          <Field label="Name" error={nameError ?? undefined}>
            <TextInput
              value={name}
              suppressAutofill
              maxLength={200}
              placeholder="Production automation"
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
          </Field>
          <Field label="Description" optional>
            <TextArea
              value={description}
              rows={3}
              maxLength={500}
              placeholder="What will use this key?"
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </FieldStack>
      </ModelsFormPage>
    </div>
  );
}

/** How an external product uses the key: collapsed, for the people who need it. */
function IntegrationGuide({
  organizationId,
  agentSettings,
}: {
  organizationId: string;
  agentSettings: boolean;
}) {
  const quickStart = organizationQuickStart(organizationId, agentSettings);
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-w-0">
      <Disclosure
        title="Integration guide"
        summary="Organization ID, what a key can reach, and a quick start"
      >
        <div className="flex min-w-0 flex-col gap-5 pt-2 pb-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-fg-muted">Organization ID</span>
            <CopyField value={organizationId} label="organization ID" size="md" />
          </div>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-5 text-fg-muted">
            <li>
              The key can create, configure and run every shared workspace, and manage their API
              keys.
            </li>
            <li>Each workspace holds one customer's settings, sessions, files and tools.</li>
            <li>Personal workspaces and personal resources stay with their person.</li>
          </ul>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <h3 className="text-sm leading-5 font-medium text-fg">Quick start</h3>
              <RowButton
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(quickStart);
                    setCopied(true);
                  } catch {
                    toast.error("Couldn't copy the code", {
                      description: "Select it and copy it by hand.",
                    });
                  }
                }}
              >
                {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                {copied ? "Copied" : "Copy code"}
              </RowButton>
            </div>
            <pre
              tabIndex={0}
              className="max-w-full overflow-auto overscroll-contain rounded-[14px] border border-border bg-surface p-4 text-xs leading-[18px] text-fg"
            >
              <code translate="no" className="font-mono">
                {quickStart}
              </code>
            </pre>
            <p className="text-xs leading-[18px] text-fg-muted">
              After an unclear result, send the same external source and tenant ID again. You get
              the original workspace back, with its settings unchanged.
            </p>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}

function organizationQuickStart(organizationId: string, agentSettings: boolean): string {
  if (agentSettings) {
    return `import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

const { workspace } = await client.ensureWorkspace({
  accountId: "${organizationId}",
  externalSource: "your-product",
  externalId: tenant.id,
  name: tenant.name,
});

const session = await client.createSession(workspace.id, {
  initialMessage: userMessage,
  idempotencyKey: productRequest.id,
  agent: {
    identity: "You are Acme's assistant. You help customers with their orders.",
    // Start from nothing and turn on what this agent needs.
    capabilities: { from: "none", webSearch: true, knowledge: true },
  },
  skills: selectedSkills,
});

// session.agent and session.effectiveTools show what it can do.`;
  }
  return `import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});

const { workspace } = await client.ensureWorkspace({
  accountId: "${organizationId}",
  externalSource: "your-product",
  externalId: tenant.id,
  name: tenant.name,
});

await client.updateWorkspaceSettings(workspace.id, {
  agentHumanInputEnabled: true,
});

const session = await client.createSession(workspace.id, {
  initialMessage: userMessage,
  idempotencyKey: productRequest.id,
  skills: selectedSkills,
});`;
}
