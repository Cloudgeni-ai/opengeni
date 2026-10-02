// Developer > Credential provider: the settings card, the provider's page with
// Test connection, and the Connect / Edit form page.
import type {
  IntegrationWorkspaceFilter,
  WorkspaceInheritedIntegrationsResponse,
} from "@opengeni/sdk";
import {
  CalendarIcon,
  ClockIcon,
  KeyRoundIcon,
  KeySquareIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
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
import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { Disclosure } from "@/components/ui/disclosure";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { FLUSH_DETAIL_PAGE_CLASS, FLUSH_FORM_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { InlineHelp } from "@/components/ui/inline-help";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { SecretOnce } from "@/components/ui/secret-field";
import { Section } from "@/components/ui/section";
import { SettingRow, SettingRowSkeleton } from "@/components/ui/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { userErrorText } from "@/lib/api-error";

import type {
  DeveloperIntegrationsApi,
  IntegrationProvider,
  ProviderTest,
} from "./integrations-api";
import {
  actionFailed,
  dateLabel,
  displayUrl,
  ExternalLink,
  LoadFailure,
  Unavailable,
  urlHost,
  useLoad,
  workspaceFilterLabel,
  type Load,
} from "./shared";
import { CodeSample, CREDENTIAL_PROVIDER_GUIDE_URL, EndpointTestResult } from "./test-result";
import { WorkspaceFilterField } from "./workspace-filter-field";

type InheritedProvider = WorkspaceInheritedIntegrationsResponse["credentialProvider"];

const DEFAULT_TIMEOUT_MS = 10_000;

function ProviderTile() {
  return <LogoTile icon={<KeySquareIcon />} />;
}

/* ----------------------------------------------------------------------------
   The settings card.
   -------------------------------------------------------------------------- */

export function CredentialProviderSection({
  api,
  canManage,
  personal,
  inherited,
  onOpen,
  onConnect,
}: {
  api: DeveloperIntegrationsApi;
  canManage: boolean;
  personal: boolean;
  /** The organization's provider that reaches this workspace, if any. */
  inherited: InheritedProvider;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const read = useCallback(() => api.getProvider(), [api]);
  const [state, reload] = useLoad(read);
  const organization = api.scope === "organization";

  let rows: ReactNode;
  if (state.kind === "loading") {
    rows = <SettingRowSkeleton />;
  } else if (state.kind === "denied") {
    rows = personal ? (
      <Unavailable title="A credential provider isn't available in a Personal workspace.">
        Set one up in a shared workspace, where workspace admins manage it.
      </Unavailable>
    ) : (
      <Unavailable
        title={`Only ${organization ? "organization" : "workspace"} admins can manage the credential provider.`}
      >
        Ask {organization ? "an organization" : "a workspace"} admin for access.
      </Unavailable>
    );
  } else if (state.kind === "failed") {
    rows = (
      <LoadFailure
        title="Couldn't load the credential provider."
        error={state.error}
        onRetry={reload}
      />
    );
  } else if (state.value) {
    const provider = state.value;
    rows = (
      <RowList label="Credential provider" flush>
        <ListRow
          leading={<ProviderTile />}
          title={displayUrl(provider.url)}
          status={
            provider.enabled ? undefined : (
              <StatusBadge status="paused" variant="dot">
                Paused
              </StatusBadge>
            )
          }
          description={
            organization
              ? workspaceFilterLabel(provider.workspaceFilter)
              : inherited
                ? "Runs here use it instead of your organization's provider."
                : "Runs in this workspace ask it for credentials."
          }
          indicator="open"
          onOpen={onOpen}
        />
      </RowList>
    );
  } else if (inherited) {
    rows = (
      <RowList label="Credential provider" flush>
        <ListRow
          leading={<ProviderTile />}
          title={displayUrl(inherited.url)}
          titleAddon={<MetaChip>Organization</MetaChip>}
          description="Set by your organization. Runs in this workspace ask it for credentials."
          indicator="open"
          onOpen={onOpen}
        />
      </RowList>
    );
  } else {
    rows = (
      <SettingRow
        label="Not connected"
        description={
          organization
            ? "Shared workspaces get no credentials from your product unless they connect their own."
            : "Runs in this workspace get no credentials from your product."
        }
        control={
          canManage ? (
            <Button type="button" size="sm" onClick={onConnect}>
              <PlugIcon aria-hidden="true" />
              Connect provider
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <Section
      title="Credential provider"
      description={
        <>
          Optional. Your endpoint hands each run short-lived credentials, like cloud keys or Git
          tokens, and Opengeni renews them before they expire.{" "}
          <ExternalLink href={CREDENTIAL_PROVIDER_GUIDE_URL}>How it works</ExternalLink>
        </>
      }
    >
      {rows}
    </Section>
  );
}

/* ----------------------------------------------------------------------------
   How it works, shared by the page and the connect form.
   -------------------------------------------------------------------------- */

const EXAMPLE_REQUEST = `{
  "type": "credentials.request",
  "purpose": "provision",
  "workspaceId": "…",
  "sessionId": "…",
  "turnId": "…",
  "initiatingHuman": { "subjectId": "…", "externalIdentity": { "source": "…", "externalId": "…" } },
  "sandboxBackend": "modal",
  "sandboxOs": "linux"
}`;

const EXAMPLE_ANSWER = `{
  "status": "ok",
  "environment": { "AWS_ACCESS_KEY_ID": "…", "AWS_SECRET_ACCESS_KEY": "…" },
  "files": [{ "path": "gcp/key.json", "content": "…" }],
  "fileEnvironment": { "GOOGLE_APPLICATION_CREDENTIALS": "gcp/key.json" },
  "git": [{ "host": "github.com", "password": "ghs_…" }],
  "expiresAt": "2026-10-01T12:00:00Z"
}

// Or, when this workspace gets nothing from you:
{ "status": "not_applicable" }`;

const ENDPOINT_SNIPPET = `import { verifyCredentialProviderRequest } from "@opengeni/sdk";

const request = await verifyCredentialProviderRequest({
  body: await req.text(), // the raw body: verify before parsing
  headers: req.headers,
  secret: process.env.OPENGENI_PROVIDER_SECRET!,
});
// Map request.workspaceId to your own customer; never trust the body alone.
// request.purpose is "provision", "renewal" or "test" (the Test button).
return Response.json({ status: "ok", environment: { GITHUB_TOKEN: token } });`;

function HowItWorks({ withSnippet = true }: { withSnippet?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-5 text-fg-muted">
        <li>
          Before a run's first command, Opengeni sends your endpoint a signed POST: which workspace,
          which run, and who started it.
        </li>
        <li>
          Your endpoint answers with environment variables, files, Git or MCP credentials, or{" "}
          <code className="font-mono text-xs text-fg">not_applicable</code>.
        </li>
        <li>
          The agent's sandbox gets them. Opengeni asks again 5 minutes before{" "}
          <code className="font-mono text-xs text-fg">expiresAt</code>, or every 30 minutes.
        </li>
      </ol>
      {withSnippet ? <CodeSample label="Your endpoint" code={ENDPOINT_SNIPPET} /> : null}
      <Disclosure title="Example request and answer" summary="The JSON both sides send">
        <div className="flex min-w-0 flex-col gap-4 pt-2 pb-2">
          <CodeSample label="Opengeni sends" code={EXAMPLE_REQUEST} />
          <CodeSample label="Your endpoint answers" code={EXAMPLE_ANSWER} />
        </div>
      </Disclosure>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The provider's page.
   -------------------------------------------------------------------------- */

type ProviderState = { own: IntegrationProvider | null; inherited: InheritedProvider };

function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading credential provider" className="flex flex-col gap-8">
      <div className="flex items-start gap-4">
        <Skeleton className="size-10 rounded-[10px]" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-[14px]" />
    </div>
  );
}

export function CredentialProviderPage({
  api,
  canManage,
  backLabel,
  onBack,
  onEdit,
  onConnect,
}: {
  api: DeveloperIntegrationsApi;
  canManage: boolean;
  backLabel: string;
  onBack: () => void;
  /** Edit this scope's provider. */
  onEdit: () => void;
  /** Connect one: from nothing, or in place of the organization's. */
  onConnect: () => void;
}) {
  const read = useCallback(async (): Promise<ProviderState> => {
    const [own, inherited] = await Promise.all([
      api.getProvider(),
      api.inherited ? api.inherited().then((value) => value.credentialProvider) : null,
    ]);
    return { own, inherited };
  }, [api]);
  const [state, reload, setState] = useLoad(read);
  const [test, setTest] = useState<(ProviderTest & { at: Date }) | null>(null);
  const [testing, setTesting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const back = { label: backLabel, onClick: onBack };
  const organization = api.scope === "organization";

  if (state.kind === "loading") {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <PageSkeleton />
      </DetailPage>
    );
  }
  if (state.kind !== "ready") {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<KeySquareIcon />}
          title={
            state.kind === "denied"
              ? "Only admins can manage the credential provider"
              : "Couldn't load the credential provider"
          }
          description={
            state.kind === "failed"
              ? userErrorText(state.error, "Try again.")
              : "Ask an admin for access."
          }
          action={
            state.kind === "failed" ? (
              <Button type="button" variant="outline" onClick={() => void reload()}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </DetailPage>
    );
  }

  const { own, inherited } = state.value;
  const provider =
    own ?? (inherited ? { ...inherited, enabled: true, createdAt: inherited.updatedAt } : null);
  if (!provider) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<KeySquareIcon />}
          title="Not connected"
          description={
            organization
              ? "Shared workspaces get no credentials from your product."
              : "Runs in this workspace get no credentials from your product."
          }
          action={
            canManage ? (
              <Button type="button" onClick={onConnect}>
                <PlugIcon aria-hidden="true" />
                Connect a credential provider
              </Button>
            ) : undefined
          }
        />
      </DetailPage>
    );
  }
  const fromOrganization = !own;
  const paused = !provider.enabled;

  const runTest = async () => {
    if (!api.testProvider) return;
    setTesting(true);
    try {
      setTest({ ...(await api.testProvider()), at: new Date() });
    } catch (error) {
      actionFailed("Couldn't test the connection", error);
    } finally {
      setTesting(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    if (!own) return;
    setBusy(true);
    try {
      const response = await api.putProvider({
        url: own.url,
        enabled,
        timeoutMs: own.timeoutMs,
        ...(organization ? { workspaceFilter: own.workspaceFilter ?? null } : {}),
      });
      setState({ own: response.provider, inherited });
      toast(enabled ? "Credential provider resumed" : "Credential provider paused", {
        description: enabled ? "New runs ask it for credentials again." : undefined,
      });
    } catch (error) {
      actionFailed(enabled ? "Couldn't resume it" : "Couldn't pause it", error);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    try {
      setSecret(await api.rotateProviderSecret());
    } catch (error) {
      actionFailed("Couldn't create a new signing secret", error);
    }
  };

  const testButton = api.testProvider ? (
    <RowButton disabled={testing} onClick={() => void runTest()}>
      <RefreshCwIcon aria-hidden="true" className={testing ? "animate-spin" : undefined} />
      {testing ? "Testing…" : "Test connection"}
    </RowButton>
  ) : null;

  let actions: ReactNode = null;
  if (fromOrganization) {
    actions = (
      <>
        {testButton}
        {canManage ? (
          <MoreMenu label="More actions for the credential provider">
            <DropdownMenuItem onSelect={onConnect}>
              <PlugIcon aria-hidden="true" />
              Use a different endpoint here
            </DropdownMenuItem>
          </MoreMenu>
        ) : null}
      </>
    );
  } else if (canManage) {
    actions = (
      <>
        {paused ? (
          <Button type="button" size="sm" disabled={busy} onClick={() => void setEnabled(true)}>
            <PlayIcon aria-hidden="true" />
            Resume
          </Button>
        ) : (
          testButton
        )}
        <MoreMenu label="More actions for the credential provider">
          <DropdownMenuItem onSelect={onEdit}>
            <PencilIcon aria-hidden="true" />
            Edit
          </DropdownMenuItem>
          {paused && api.testProvider ? (
            <DropdownMenuItem onSelect={() => void runTest()}>
              <RefreshCwIcon aria-hidden="true" />
              Test connection
            </DropdownMenuItem>
          ) : null}
          {!paused ? (
            <DropdownMenuItem onSelect={() => void setEnabled(false)}>
              <PauseIcon aria-hidden="true" />
              Pause
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => void rotate()}>
            <KeyRoundIcon aria-hidden="true" />
            New signing secret
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
            <Trash2Icon aria-hidden="true" />
            Remove
          </DropdownMenuItem>
        </MoreMenu>
      </>
    );
  } else {
    actions = testButton;
  }

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<ProviderTile />}
        title="Credential provider"
        chips={
          <>
            {paused ? <StatusBadge status="paused">Paused</StatusBadge> : null}
            {fromOrganization || organization ? <MetaChip>Organization</MetaChip> : null}
          </>
        }
        meta={[
          <span key="url" className="break-all">
            {displayUrl(provider.url)}
          </span>,
          fromOrganization ? <span key="by">set by your organization</span> : null,
          organization ? (
            <span key="filter">{workspaceFilterLabel(provider.workspaceFilter)}</span>
          ) : null,
        ]}
        actions={actions}
      />
      <DetailPageBody
        aside={
          <DetailAside label="Credential provider details">
            <DetailAsideItem label="Endpoint">
              <CopyField value={provider.url} label="endpoint URL" truncate="middle" />
            </DetailAsideItem>
            <DetailAsideItem label="Waits for an answer" icon={<ClockIcon />}>
              {Math.round(provider.timeoutMs / 1000)} seconds
            </DetailAsideItem>
            {organization ? (
              <DetailAsideItem label="Workspaces">
                {workspaceFilterLabel(provider.workspaceFilter)}
              </DetailAsideItem>
            ) : null}
            {!fromOrganization ? (
              <>
                <DetailAsideItem label="Signing secret">
                  <span className="text-fg-muted">Shown once, when it was made.</span>
                </DetailAsideItem>
                <DetailAsideItem label="Connected" icon={<CalendarIcon />}>
                  {dateLabel(provider.createdAt)}
                </DetailAsideItem>
              </>
            ) : null}
          </DetailAside>
        }
      >
        {secret ? (
          <DetailSection>
            <SecretOnce
              value={secret}
              label="signing secret"
              details="The old secret stopped working. Update your endpoint now."
            />
          </DetailSection>
        ) : null}
        {test ? (
          <DetailSection>
            <EndpointTestResult
              kind="credential-provider"
              result={test.result}
              testedAt={test.at}
              onDismiss={() => setTest(null)}
            />
          </DetailSection>
        ) : api.testProvider ? (
          <DetailSection>
            <InlineHelp>
              Test connection sends a signed request with{" "}
              <code className="font-mono text-xs text-fg">purpose: "test"</code> and shows what a
              run would get, by name only.
            </InlineHelp>
          </DetailSection>
        ) : (
          <DetailSection>
            <InlineHelp>
              To test it, open Settings &gt; Developer in a workspace it applies to.
            </InlineHelp>
          </DetailSection>
        )}
        {fromOrganization ? (
          <DetailSection>
            <InlineHelp icon>
              Your organization set this up for its shared workspaces, and runs here use it. Only
              organization admins can change it.
            </InlineHelp>
          </DetailSection>
        ) : paused ? (
          <DetailSection>
            <InlineHelp icon>
              {organization
                ? "Paused. Shared workspaces without their own provider get no credentials from your product until you resume it."
                : "Paused. Runs in this workspace get no credentials from any provider, including your organization's, until you resume it."}
            </InlineHelp>
          </DetailSection>
        ) : inherited ? (
          <DetailSection>
            <InlineHelp icon>
              Runs here use this instead of your organization's provider ({urlHost(inherited.url)}
              ). Remove it to use the organization's again.
            </InlineHelp>
          </DetailSection>
        ) : null}
        <DetailSection title="How it works">
          <HowItWorks />
        </DetailSection>
      </DetailPageBody>
      <DestructiveConfirm
        open={removing}
        onOpenChange={setRemoving}
        variant="consequences"
        title="Remove the credential provider?"
        consequences={[
          organization
            ? "Shared workspaces without their own provider get no credentials from your product."
            : inherited
              ? `New runs here use your organization's provider (${urlHost(inherited.url)}) again.`
              : "New runs in this workspace get no credentials from your product.",
          "Runs already going keep what they have until it expires.",
          "Its signing secret is deleted. This can't be undone.",
        ]}
        confirmLabel="Remove provider"
        pendingLabel="Removing…"
        onConfirm={async () => {
          try {
            await api.deleteProvider();
          } catch (error) {
            throw new Error(`Couldn't remove the provider. ${userErrorText(error, "Try again.")}`, {
              cause: error,
            });
          }
          toast("Credential provider removed");
          onBack();
        }}
      />
    </DetailPage>
  );
}

/* ----------------------------------------------------------------------------
   Connect or edit.
   -------------------------------------------------------------------------- */

export function CredentialProviderFormPage({
  api,
  canManage,
  backLabel,
  onClose,
  onFinished,
}: {
  api: DeveloperIntegrationsApi;
  canManage: boolean;
  backLabel: string;
  onClose: () => void;
  onFinished: () => void;
}) {
  const read = useCallback(async (): Promise<ProviderState> => {
    const [own, inherited] = await Promise.all([
      api.getProvider(),
      api.inherited ? api.inherited().then((value) => value.credentialProvider) : null,
    ]);
    return { own, inherited };
  }, [api]);
  const [state] = useLoad(read);
  const back = { label: backLabel, onClick: onClose };
  if (!canManage) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<KeySquareIcon />}
          title="Only admins can connect a credential provider"
          description="Ask an admin to connect it for you."
        />
      </DetailPage>
    );
  }
  if (state.kind === "loading") {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <PageSkeleton />
      </DetailPage>
    );
  }
  return (
    <ProviderForm
      // Remount once the current values arrive.
      key={state.kind === "ready" ? (state.value.own?.updatedAt ?? "new") : "error"}
      api={api}
      state={state}
      back={back}
      onClose={onClose}
      onFinished={onFinished}
    />
  );
}

function ProviderForm({
  api,
  state,
  back,
  onClose,
  onFinished,
}: {
  api: DeveloperIntegrationsApi;
  state: Load<ProviderState>;
  back: { label: string; onClick: () => void };
  onClose: () => void;
  onFinished: () => void;
}) {
  const own = state.kind === "ready" ? state.value.own : null;
  const inherited = state.kind === "ready" ? state.value.inherited : null;
  const organization = api.scope === "organization";
  const [url, setUrl] = useState(own?.url ?? "");
  const [filter, setFilter] = useState<IntegrationWorkspaceFilter | null>(
    own?.workspaceFilter ?? null,
  );
  const [errors, setErrors] = useState<{ url?: string; filter?: string }>({});
  const [secret, setSecret] = useState<string | null>(null);

  if (secret) {
    return (
      <FormPage
        className={FLUSH_FORM_PAGE_CLASS}
        title="Credential provider connected"
        description={displayUrl(url.trim())}
        submitLabel="I've saved it"
        cancelLabel={null}
        onSubmit={() => true}
        onSubmitted={onFinished}
      >
        <SecretOnce
          value={secret}
          label="signing secret"
          details="Your endpoint uses it to check that each request comes from Opengeni. Next, test the connection from the provider's page."
        />
      </FormPage>
    );
  }

  const submit = async () => {
    const trimmed = url.trim();
    const nextErrors: typeof errors = {};
    if (!/^https?:\/\/\S+$/i.test(trimmed))
      nextErrors.url = "Enter the full URL, starting with https://.";
    if (organization && filter && !filter.externalSource.trim()) {
      nextErrors.filter = "Enter the external source, or use it for every shared workspace.";
    }
    setErrors(nextErrors);
    if (nextErrors.url || nextErrors.filter) return false;
    try {
      const response = await api.putProvider({
        url: trimmed,
        enabled: own?.enabled ?? true,
        timeoutMs: own?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(organization
          ? {
              workspaceFilter: filter ? { externalSource: filter.externalSource.trim() } : null,
            }
          : {}),
      });
      if (response.secret) {
        setSecret(response.secret);
        return true;
      }
      toast("Credential provider saved");
      onFinished();
      return true;
    } catch (error) {
      throw new Error(
        `Couldn't ${own ? "save" : "connect"} the provider. ${userErrorText(error, "Try again.")}`,
        { cause: error },
      );
    }
  };

  return (
    <FormPage
      className={FLUSH_FORM_PAGE_CLASS}
      back={back}
      title={own ? "Edit credential provider" : "Connect a credential provider"}
      description={
        organization
          ? "Opengeni calls your endpoint before each run in the shared workspaces you choose, and gives the agent what it returns."
          : "Opengeni calls your endpoint before each run in this workspace, and gives the agent what it returns."
      }
      submitLabel={own ? "Save" : "Connect"}
      pendingLabel={own ? "Saving…" : "Connecting…"}
      onSubmit={submit}
      onCancel={onClose}
    >
      <FieldStack>
        {!own && inherited ? (
          <Notice tone="muted">
            Runs here will use this endpoint instead of your organization's provider (
            {urlHost(inherited.url)}).
          </Notice>
        ) : null}
        <Field
          label="Endpoint URL"
          id="credential-provider-url"
          error={errors.url}
          hint="Opengeni sends a signed POST and waits up to 10 seconds for the answer."
        >
          <TextInput
            type="url"
            placeholder="https://your-product.example/opengeni/credentials"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setErrors((value) => ({ ...value, url: undefined }));
            }}
            suppressAutofill
          />
        </Field>
        {organization ? (
          <WorkspaceFilterField
            value={filter}
            error={errors.filter}
            onChange={(next) => {
              setFilter(next);
              setErrors((value) => ({ ...value, filter: undefined }));
            }}
          />
        ) : null}
        {!own ? (
          <div className="min-w-0">
            <h3 className="mb-2 text-sm leading-5 font-medium text-fg">How it works</h3>
            <HowItWorks withSnippet={false} />
          </div>
        ) : null}
      </FieldStack>
    </FormPage>
  );
}
