import type {
  PrReviewAppRegistration,
  PrReviewManagedGitHubSetup,
  PrReviewProvider,
  PrReviewRepositoryBinding,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { OpenGeniPrReviewClient } from "@opengeni/sdk/pr-review";
import { BotIcon, CheckCircle2Icon, CopyIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function PrReviewSetupCard(props: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useMemo(() => new OpenGeniPrReviewClient(props.client), [props.client]);
  const [registrations, setRegistrations] = useState<PrReviewAppRegistration[]>([]);
  const [repositories, setRepositories] = useState<PrReviewRepositoryBinding[]>([]);
  const [managedGitHub, setManagedGitHub] = useState<PrReviewManagedGitHubSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<PrReviewProvider>("github");
  const [name, setName] = useState("OpenGeni Review Bot");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookUsername, setWebhookUsername] = useState("");
  const [selectedRegistration, setSelectedRegistration] = useState("");
  const [repositoryUri, setRepositoryUri] = useState("");
  const [repositoryFullName, setRepositoryFullName] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [projectId, setProjectId] = useState("");

  const refresh = useCallback(async () => {
    const [result, github] = await Promise.all([
      client.listConfiguration(props.workspaceId),
      client.getManagedGitHubSetup(props.workspaceId),
    ]);
    setRegistrations(result.registrations);
    setRepositories(result.repositories);
    setManagedGitHub(github);
    setSelectedRegistration(
      (current) =>
        current ||
        result.registrations.find(
          (registration) => registration.credentialKind !== "managed_github_app",
        )?.id ||
        "",
    );
  }, [client, props.workspaceId]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void refresh()
      .catch((reason) => live && setError(messageForError(reason)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [refresh]);

  async function registerApp() {
    setBusy(true);
    setError(null);
    try {
      const registration = await client.createAppRegistration(props.workspaceId, {
        name,
        provider,
        ...(providerBaseUrl ? { providerBaseUrl } : {}),
        credentialKind: provider === "github" ? "github_app" : "provider_token",
        ...(provider === "github" ? { appId, privateKey } : { accessToken }),
        webhookSecret,
        ...(provider === "azure_devops" ? { webhookUsername } : {}),
      });
      await refresh();
      setSelectedRegistration(registration.id);
      setPrivateKey("");
      setAccessToken("");
      setWebhookSecret("");
    } catch (reason) {
      setError(messageForError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function addRepository() {
    setBusy(true);
    setError(null);
    try {
      await client.createRepositoryBinding(props.workspaceId, {
        registrationId: selectedRegistration,
        repositoryUri,
        repositoryFullName,
        providerRepositoryId: repositoryId,
        ...(installationId ? { installationId } : {}),
        ...(projectId ? { projectId } : {}),
      });
      await refresh();
      setRepositoryUri("");
      setRepositoryFullName("");
      setRepositoryId("");
      setInstallationId("");
      setProjectId("");
    } catch (reason) {
      setError(messageForError(reason));
    } finally {
      setBusy(false);
    }
  }

  const selectedProvider = registrations.find(
    (registration) => registration.id === selectedRegistration,
  )?.provider;
  const manualRegistrations = registrations.filter(
    (registration) => registration.credentialKind !== "managed_github_app",
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/50 p-4 text-xs text-fg-muted">
        <Loader2Icon className="size-4 animate-spin" /> Loading OpenGeni Review Bot setup…
      </div>
    );
  }

  return (
    <section className="grid gap-4 rounded-xl border border-brand/30 bg-brand/5 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-surface text-brand">
          <BotIcon className="size-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">Configure OpenGeni Review Bot</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Install OpenGeni Lens on the repositories you want reviewed. Pull-request events start
            ordinary exact-head agent sessions through the generic trigger system.
          </p>
        </div>
      </div>

      {error ? <Notice tone="failed">{error}</Notice> : null}
      {!props.canManage ? (
        <Notice>
          Workspace administration and secret-write permission are required to change setup.
        </Notice>
      ) : null}

      <div className="grid gap-3 rounded-lg border border-border bg-surface/70 p-3">
        <div>
          <div className="text-xs font-medium">GitHub · OpenGeni Lens</div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            GitHub handles account authorization and repository selection. OpenGeni stores no App
            private key in this workspace.
          </p>
        </div>
        {managedGitHub?.status === "connected" ? (
          <div className="grid gap-2">
            {managedGitHub.installations.map((installation) => (
              <div
                key={installation.registrationId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
              >
                <CheckCircle2Icon className="size-4 text-status-completed" />
                <span className="font-medium">
                  {installation.accountLogin ?? `Installation ${installation.installationId}`}
                </span>
                <MetaChip>
                  {installation.repositoryCount} repositor
                  {installation.repositoryCount === 1 ? "y" : "ies"}
                </MetaChip>
                {installation.configureUrl ? (
                  <Button
                    className="ml-auto"
                    variant="ghost"
                    size="sm"
                    disabled={busy || !props.canManage}
                    onClick={() => window.location.assign(installation.configureUrl!)}
                  >
                    Change repositories
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {managedGitHub?.status === "unavailable" ? (
          <Notice>
            OpenGeni Lens is not configured for this deployment.
            {managedGitHub.missing.length > 0
              ? ` Missing: ${managedGitHub.missing.join(", ")}.`
              : " Contact the deployment operator."}
          </Notice>
        ) : null}
        <div>
          <Button
            size="sm"
            disabled={busy || !props.canManage || !managedGitHub?.connectUrl}
            onClick={() =>
              managedGitHub?.connectUrl && window.location.assign(managedGitHub.connectUrl)
            }
          >
            <BotIcon />
            {managedGitHub?.status === "connected"
              ? "Connect another account"
              : "Install on GitHub"}
          </Button>
        </div>
      </div>

      <details className="rounded-lg border border-border bg-surface/70 p-3">
        <summary className="cursor-pointer text-xs font-medium">
          Advanced: bring your own provider app or token
        </summary>
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2 md:grid-cols-2">
            <Select
              value={provider}
              onChange={(event) => setProvider(event.target.value as PrReviewProvider)}
            >
              <option value="github">GitHub App</option>
              <option value="gitlab">GitLab token</option>
              <option value="azure_devops">Azure DevOps token</option>
            </Select>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Registration name"
            />
            <Input
              value={providerBaseUrl}
              onChange={(event) => setProviderBaseUrl(event.target.value)}
              placeholder={
                provider === "azure_devops"
                  ? "https://dev.azure.com/organization"
                  : provider === "gitlab"
                    ? "Provider base URL (defaults to gitlab.com)"
                    : "Provider base URL (defaults to github.com)"
              }
            />
            {provider === "github" ? (
              <Input
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="Dedicated GitHub App ID"
              />
            ) : null}
            {provider === "github" ? (
              <Textarea
                className="min-h-24 font-mono text-xs md:col-span-2"
                value={privateKey}
                onChange={(event) => setPrivateKey(event.target.value)}
                placeholder="GitHub App private key (PEM)"
              />
            ) : null}
            {provider !== "github" ? (
              <Input
                type="password"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                placeholder={
                  provider === "gitlab" ? "GitLab project access token" : "Azure DevOps token"
                }
              />
            ) : null}
            {provider === "azure_devops" ? (
              <Input
                value={webhookUsername}
                onChange={(event) => setWebhookUsername(event.target.value)}
                placeholder="Service-hook Basic auth username"
              />
            ) : null}
            <Input
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              placeholder="Webhook secret"
            />
          </div>
          <div>
            <Button
              size="sm"
              disabled={
                busy ||
                !props.canManage ||
                !name ||
                !webhookSecret ||
                (provider === "github" && (!appId || !privateKey)) ||
                (provider !== "github" && !accessToken) ||
                (provider === "azure_devops" && !providerBaseUrl)
              }
              onClick={() => void registerApp()}
            >
              {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Register provider
            </Button>
          </div>
          {manualRegistrations.length > 0 ? (
            <div className="grid gap-2">
              {manualRegistrations.map((registration) => (
                <div key={registration.id} className="rounded-md border border-border px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{registration.name}</span>
                    <MetaChip>{registration.provider}</MetaChip>
                    <MetaChip dot={registration.status === "active" ? "running" : "idle"}>
                      {registration.status}
                    </MetaChip>
                  </div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-2xs text-fg-subtle">
                    <span className="min-w-0 truncate">{registration.webhookPath}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Copy webhook API path"
                      onClick={() => void navigator.clipboard.writeText(registration.webhookPath)}
                    >
                      <CopyIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </details>

      {manualRegistrations.length > 0 ? (
        <div className="grid gap-3 rounded-lg border border-border bg-surface/70 p-3">
          <div className="text-xs font-medium">2. Repository</div>
          <div className="grid gap-2 md:grid-cols-2">
            <Select
              value={selectedRegistration}
              onChange={(event) => setSelectedRegistration(event.target.value)}
            >
              {manualRegistrations.map((registration) => (
                <option key={registration.id} value={registration.id}>
                  {registration.name} · {registration.provider}
                </option>
              ))}
            </Select>
            <Input
              value={repositoryUri}
              onChange={(event) => setRepositoryUri(event.target.value)}
              placeholder="HTTPS clone URL"
            />
            <Input
              value={repositoryFullName}
              onChange={(event) => setRepositoryFullName(event.target.value)}
              placeholder="owner/repository"
            />
            <Input
              value={repositoryId}
              onChange={(event) => setRepositoryId(event.target.value)}
              placeholder="Provider repository ID"
            />
            <Input
              value={installationId}
              onChange={(event) => setInstallationId(event.target.value)}
              placeholder="GitHub installation ID (GitHub only)"
            />
            <Input
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder={
                selectedProvider === "azure_devops"
                  ? "Azure DevOps project ID"
                  : "Project ID (optional)"
              }
            />
          </div>
          <div>
            <Button
              size="sm"
              disabled={
                busy ||
                !props.canManage ||
                !selectedRegistration ||
                !repositoryUri ||
                !repositoryFullName ||
                !repositoryId ||
                (selectedProvider === "github" && !installationId) ||
                (selectedProvider === "azure_devops" && !projectId)
              }
              onClick={() => void addRepository()}
            >
              {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
              Enable repository
            </Button>
          </div>
          {repositories.length > 0 ? (
            <div className="grid gap-2">
              {repositories.map((repository) => (
                <div
                  key={repository.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
                >
                  <CheckCircle2Icon className="size-4 text-status-completed" />
                  <span className="min-w-0 flex-1 truncate">{repository.repositoryFullName}</span>
                  <MetaChip>{repository.provider}</MetaChip>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function messageForError(reason: unknown): string {
  return reason instanceof Error ? reason.message : "OpenGeni Review Bot setup failed";
}
