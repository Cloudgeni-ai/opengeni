import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  KeyRoundIcon,
  Loader2Icon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { FormEvent } from "react";

import {
  customApiAuthenticationStepRequired,
  compatibleCustomApiConnections,
  customApiConnectionLabel,
  customApiPreviewDiff,
  type CustomApiFlowState,
} from "@/components/capabilities/custom-api-flow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ConnectionMetadata } from "@/types";

export function CustomApiSetupDialog({
  state,
  connections,
  canManage,
  onOpenChange,
  onDraftChange,
  onPreview,
  onAuthenticate,
  onInstall,
  onBack,
  onToggleTool,
}: {
  state: CustomApiFlowState;
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (patch: Partial<CustomApiFlowState["draft"]>) => void;
  onPreview: () => void;
  onAuthenticate: () => void;
  onInstall: () => void;
  onBack: () => void;
  onToggleTool: (toolId: string, selected: boolean) => void;
}) {
  const busy = ["previewing", "creating_connection", "installing"].includes(state.phase);
  const preview = state.preview;
  const authNeeded = customApiAuthenticationStepRequired(state);
  const providerDomain = preview?.providerDomain ?? domainFromDraft(state);
  const knownConnections = state.connection
    ? [
        ...(connections ?? []).filter((connection) => connection.id !== state.connection?.id),
        state.connection,
      ]
    : connections;
  const compatible = providerDomain
    ? compatibleCustomApiConnections(
        knownConnections,
        providerDomain,
        state.draft.ownership,
        preview,
        state.draft.authMethod,
      )
    : [];
  const diff = preview ? customApiPreviewDiff(state.editingInstance, preview) : null;

  function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) onPreview();
  }

  return (
    <Dialog open={state.open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto"
        style={{ maxWidth: "var(--container-2xl)" }}
      >
        <DialogHeader>
          <DialogTitle>
            {state.intent === "create"
              ? "Connect custom API"
              : state.intent === "reconnect"
                ? `Reconnect ${state.editingInstance?.displayName ?? "custom API"}`
                : `Review updates for ${state.editingInstance?.displayName ?? "custom API"}`}
          </DialogTitle>
          <DialogDescription>
            Detection and review never install anything. A Connection may be created only after
            authentication is required, and installation remains a separate final action.
          </DialogDescription>
        </DialogHeader>

        {state.error ? (
          <div
            role="alert"
            className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-5 text-fg-muted"
          >
            <div className="flex items-start gap-2">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{state.error}</span>
            </div>
          </div>
        ) : null}

        {state.phase === "source" || state.phase === "previewing" ? (
          <form className="grid gap-5" onSubmit={submitSource}>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-api-url">API URL or domain</Label>
              <Input
                id="custom-api-url"
                value={state.draft.url}
                onChange={(event) => onDraftChange({ url: event.target.value })}
                placeholder="api.example.com or https://api.example.com/graphql"
                inputMode="url"
                autoComplete="url"
                autoFocus
                aria-describedby="custom-api-url-help"
              />
              <p id="custom-api-url-help" className="text-2xs leading-4 text-fg-subtle">
                OpenGeni first tries a bounded OpenAPI document, then a GraphQL endpoint. No
                workspace mutation occurs during detection.
              </p>
            </div>

            <details
              open={state.draft.advanced}
              onToggle={(event) =>
                onDraftChange({ advanced: (event.currentTarget as HTMLDetailsElement).open })
              }
              className="group rounded-xl border border-border bg-bg/50 p-3"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-fg">
                Advanced protocol options
                <ChevronDownIcon className="size-4 text-fg-subtle transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-4 grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="custom-api-protocol">Protocol</Label>
                  <select
                    id="custom-api-protocol"
                    value={state.draft.protocol}
                    onChange={(event) =>
                      onDraftChange({
                        protocol: event.target.value as CustomApiFlowState["draft"]["protocol"],
                      })
                    }
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
                  >
                    <option value="auto">Detect automatically</option>
                    <option value="openapi">OpenAPI</option>
                    <option value="graphql">GraphQL</option>
                  </select>
                </div>
                {state.draft.protocol === "openapi" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      id="custom-openapi-url"
                      label="OpenAPI document URL"
                      value={state.draft.openApiUrl}
                      placeholder="https://api.example.com/openapi.json"
                      onChange={(openApiUrl) => onDraftChange({ openApiUrl })}
                    />
                    <Field
                      id="custom-openapi-base-url"
                      label="Base URL (optional override)"
                      value={state.draft.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(baseUrl) => onDraftChange({ baseUrl })}
                    />
                  </div>
                ) : null}
                {state.draft.protocol === "graphql" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      id="custom-graphql-endpoint"
                      label="GraphQL endpoint"
                      value={state.draft.graphqlEndpoint}
                      placeholder="https://api.example.com/graphql"
                      onChange={(graphqlEndpoint) => onDraftChange({ graphqlEndpoint })}
                    />
                    <Field
                      id="custom-graphql-name"
                      label="API name (optional)"
                      value={state.draft.graphqlName}
                      placeholder="Issue tracker API"
                      onChange={(graphqlName) => onDraftChange({ graphqlName })}
                    />
                  </div>
                ) : null}
              </div>
            </details>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canManage || busy || !state.draft.url.trim()}>
                {state.phase === "previewing" ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <SearchIcon />
                )}
                Detect and preview
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {authNeeded ? (
          <AuthenticationStep
            state={state}
            compatible={compatible}
            busy={busy}
            canManage={canManage}
            onDraftChange={onDraftChange}
            onAuthenticate={onAuthenticate}
            onBack={onBack}
          />
        ) : null}

        {preview && !authNeeded ? (
          <ReviewStep
            state={state}
            diff={diff}
            busy={busy}
            canManage={canManage}
            onDraftChange={onDraftChange}
            onToggleTool={onToggleTool}
            onInstall={onInstall}
            onBack={onBack}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AuthenticationStep({
  state,
  compatible,
  busy,
  canManage,
  onDraftChange,
  onAuthenticate,
  onBack,
}: {
  state: CustomApiFlowState;
  compatible: ConnectionMetadata[];
  busy: boolean;
  canManage: boolean;
  onDraftChange: (patch: Partial<CustomApiFlowState["draft"]>) => void;
  onAuthenticate: () => void;
  onBack: () => void;
}) {
  const preview = state.preview;
  const detected = preview
    ? authDescription(preview)
    : "Authentication is needed before GraphQL introspection can finish.";
  return (
    <div className="grid gap-5">
      <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
        <div className="flex items-start gap-3">
          <KeyRoundIcon className="mt-0.5 size-5 shrink-0 text-brand" />
          <div>
            <h3 className="text-sm font-semibold text-fg">Add only the missing authentication</h3>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{detected}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-xl border border-border p-4">
        <fieldset className="grid gap-2">
          <legend className="text-xs font-medium text-fg-muted">Connection ownership</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <Choice
              selected={state.draft.ownership === "personal"}
              title="Personal"
              description="Only you and explicitly delegated runs"
              onClick={() => onDraftChange({ ownership: "personal", existingConnectionId: "" })}
            />
            <Choice
              selected={state.draft.ownership === "workspace"}
              title="Workspace"
              description="Authorized workspace members"
              onClick={() => onDraftChange({ ownership: "workspace", existingConnectionId: "" })}
            />
          </div>
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="text-xs font-medium text-fg-muted">Credential source</legend>
          <Choice
            selected={state.draft.connectionMode === "new"}
            title="Create a new Connection"
            description="Default and safest: never overwrite or silently reuse a sibling account"
            onClick={() => onDraftChange({ connectionMode: "new", existingConnectionId: "" })}
          />
          {compatible.length > 0 ? (
            <Choice
              selected={state.draft.connectionMode === "existing"}
              title="Use a compatible existing Connection"
              description="Only after you explicitly choose the exact visible account below"
              onClick={() => onDraftChange({ connectionMode: "existing" })}
            />
          ) : null}
        </fieldset>

        {state.draft.connectionMode === "existing" && compatible.length > 0 ? (
          <div className="grid gap-1.5">
            <Label htmlFor="custom-existing-connection">Existing Connection</Label>
            <select
              id="custom-existing-connection"
              value={state.draft.existingConnectionId}
              onChange={(event) => onDraftChange({ existingConnectionId: event.target.value })}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
            >
              <option value="">Choose an exact account…</option>
              {compatible.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {customApiConnectionLabel(connection)} · {connection.providerDomain}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {state.draft.connectionMode === "new" ? (
          <NewCredentialFields state={state} onDraftChange={onDraftChange} />
        ) : null}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon />
          Back
        </Button>
        <Button
          type="button"
          onClick={onAuthenticate}
          disabled={
            !canManage ||
            busy ||
            (state.draft.connectionMode === "existing" && !state.draft.existingConnectionId)
          }
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
          {state.draft.connectionMode === "new"
            ? "Create Connection and retry preview"
            : "Retry preview with this Connection"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function NewCredentialFields({
  state,
  onDraftChange,
}: {
  state: CustomApiFlowState;
  onDraftChange: (patch: Partial<CustomApiFlowState["draft"]>) => void;
}) {
  const auth = state.preview?.auth;
  const fixedMethod = auth && auth.kind !== "none" ? detectedAuthMethod(auth) : null;
  const method = fixedMethod ?? state.draft.authMethod;
  return (
    <div className="grid gap-4 border-t border-border pt-4">
      <Field
        id="custom-account-label"
        label="Account label"
        value={state.draft.accountLabel}
        placeholder="e.g. Linear — Finance credential"
        onChange={(accountLabel) => onDraftChange({ accountLabel })}
      />
      {!fixedMethod ? (
        <div className="grid gap-1.5">
          <Label htmlFor="custom-auth-method">Authentication method</Label>
          <select
            id="custom-auth-method"
            value={state.draft.authMethod}
            onChange={(event) =>
              onDraftChange({
                authMethod: event.target.value as CustomApiFlowState["draft"]["authMethod"],
              })
            }
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
          >
            <option value="bearer">Bearer token</option>
            <option value="basic">HTTP Basic</option>
            <option value="api_key">API key</option>
          </select>
        </div>
      ) : null}

      {method === "basic" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="custom-basic-username"
            label="Username"
            value={state.draft.username}
            autoComplete="username"
            onChange={(username) => onDraftChange({ username })}
          />
          <Field
            id="custom-basic-password"
            label="Password"
            value={state.draft.password}
            type="password"
            autoComplete="new-password"
            onChange={(password) => onDraftChange({ password })}
          />
        </div>
      ) : (
        <div className="grid gap-4">
          {method === "api_key" && (!auth || auth.kind === "none") ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="custom-credential-carrier">Placement</Label>
                <select
                  id="custom-credential-carrier"
                  value={state.draft.credentialCarrier}
                  onChange={(event) =>
                    onDraftChange({
                      credentialCarrier: event.target
                        .value as CustomApiFlowState["draft"]["credentialCarrier"],
                    })
                  }
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
                >
                  <option value="header">Header</option>
                  <option value="query">Query parameter</option>
                  <option value="cookie">Cookie</option>
                </select>
              </div>
              <Field
                id="custom-credential-name"
                label="Credential name"
                value={state.draft.credentialName}
                placeholder="X-API-Key"
                onChange={(credentialName) => onDraftChange({ credentialName })}
              />
            </div>
          ) : null}
          <Field
            id="custom-credential-value"
            label={credentialValueLabel(auth, method)}
            value={state.draft.credentialValue}
            type="password"
            autoComplete="new-password"
            onChange={(credentialValue) => onDraftChange({ credentialValue })}
          />
        </div>
      )}
      <p className="text-2xs leading-4 text-fg-subtle">
        The value is encrypted in a new Connection. The Integration stores only the Connection
        reference and never embeds credentials in its definition or tool schema.
      </p>
    </div>
  );
}

function ReviewStep({
  state,
  diff,
  busy,
  canManage,
  onDraftChange,
  onToggleTool,
  onInstall,
  onBack,
}: {
  state: CustomApiFlowState;
  diff: ReturnType<typeof customApiPreviewDiff>;
  busy: boolean;
  canManage: boolean;
  onDraftChange: (patch: Partial<CustomApiFlowState["draft"]>) => void;
  onToggleTool: (toolId: string, selected: boolean) => void;
  onInstall: () => void;
  onBack: () => void;
}) {
  const preview = state.preview!;
  return (
    <div className="grid gap-5">
      <div className="rounded-xl border border-success/30 bg-success/5 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" />
          <div>
            <h3 className="text-sm font-semibold text-fg">Immutable preview ready</h3>
            <p className="mt-1 text-xs leading-5 text-fg-muted">
              Review this exact source, digest, tool set, permissions, ownership, and account before
              the install mutation.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-xl border border-border bg-bg/50 p-4">
        <Field
          id="custom-display-name"
          label="Instance label"
          value={state.draft.displayName}
          placeholder={preview.name}
          onChange={(displayName) => onDraftChange({ displayName })}
        />
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <ReviewFact
            label="Detected protocol"
            value={preview.protocol === "openapi" ? "OpenAPI" : "GraphQL"}
          />
          <ReviewFact label="Provider domain" value={preview.providerDomain} />
          <ReviewFact label="Source" value={preview.sourceUrl ?? preview.baseUrl} mono />
          <ReviewFact label="Base URL" value={preview.baseUrl} mono />
          <ReviewFact label="Revision" value={preview.revisionId} mono />
          <ReviewFact label="SHA-256 digest" value={preview.contentSha256} mono />
          <ReviewFact
            label="Ownership"
            value={
              state.connection
                ? state.connection.subjectId
                  ? "Personal"
                  : "Workspace"
                : "Workspace · no credential"
            }
          />
          <ReviewFact
            label="Account"
            value={
              state.connection
                ? customApiConnectionLabel(state.connection)
                : "Anonymous / no authentication"
            }
          />
          <ReviewFact label="Authentication" value={authDescription(preview)} />
          <ReviewFact
            label="Permissions"
            value={`${preview.tools.filter((tool) => tool.safety === "read").length} read · ${preview.tools.filter((tool) => tool.safety === "write").length} write · ${preview.tools.filter((tool) => tool.safety === "destructive").length} destructive`}
          />
        </dl>
      </div>

      {diff ? (
        <div
          className={cn(
            "rounded-xl border p-4 text-xs",
            diff.digestChanged || diff.addedTools.length || diff.removedTools.length
              ? "border-warning/40 bg-warning/10"
              : "border-border bg-bg/50",
          )}
        >
          <h3 className="font-semibold text-fg">Update review</h3>
          <p className="mt-1 leading-5 text-fg-muted">
            {diff.digestChanged
              ? "The immutable digest changed."
              : "The immutable digest is unchanged."}{" "}
            {diff.addedTools.length} added, {diff.removedTools.length} removed,{" "}
            {diff.unchangedTools} unchanged tools.
          </p>
          {diff.addedTools.length > 0 ? (
            <p className="mt-2 break-words text-success">Added: {diff.addedTools.join(", ")}</p>
          ) : null}
          {diff.removedTools.length > 0 ? (
            <p className="mt-1 break-words text-warning">Removed: {diff.removedTools.join(", ")}</p>
          ) : null}
        </div>
      ) : null}

      {preview.warnings.length > 0 ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
          <h3 className="text-xs font-semibold text-fg">Warnings</h3>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-fg-muted">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <fieldset className="grid gap-2">
        <legend className="text-xs font-semibold text-fg">
          Tools installed for this exact instance ({state.selectedTools.length}/
          {preview.tools.filter((tool) => !tool.deprecated).length})
        </legend>
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border p-2">
          {preview.tools.map((tool) => {
            const selected = state.selectedTools.includes(tool.id);
            return (
              <label
                key={tool.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3",
                  tool.deprecated ? "border-border/80 opacity-60" : "border-border bg-bg/50",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-brand"
                  checked={selected}
                  disabled={tool.deprecated}
                  onChange={(event) => onToggleTool(tool.id, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-xs font-semibold text-fg">
                    {tool.name}
                    <Badge variant="outline" className="text-2xs">
                      {tool.safety}
                    </Badge>
                    {tool.approvalMode === "ask" ? (
                      <Badge variant="outline" className="text-2xs">
                        asks approval
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-2xs leading-4 text-fg-muted">
                    {tool.description || tool.operationKey}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {state.selectedTools.length === 0 ? (
          <p className="text-xs leading-5 text-warning">
            Select at least one tool before installing. An empty selection is never treated as “all
            tools.”
          </p>
        ) : null}
      </fieldset>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon />
          Back
        </Button>
        <Button
          type="button"
          onClick={onInstall}
          disabled={
            !canManage ||
            busy ||
            !state.draft.displayName.trim() ||
            state.selectedTools.length === 0
          }
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
          {state.intent === "create" ? "Install this instance" : "Update this exact instance"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        autoComplete={autoComplete}
      />
    </div>
  );
}

function Choice({
  selected,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "rounded-xl border p-3 text-left",
        selected ? "border-brand bg-brand/5" : "border-border bg-bg/50 hover:border-border-strong",
      )}
    >
      <span className="block text-xs font-semibold text-fg">{title}</span>
      <span className="mt-1 block text-2xs leading-4 text-fg-muted">{description}</span>
    </button>
  );
}

function ReviewFact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="font-medium text-fg-subtle">{label}</dt>
      <dd
        className={
          mono
            ? "mt-1 break-all font-mono text-2xs text-fg-muted"
            : "mt-1 break-words text-fg-muted"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function authDescription(preview: NonNullable<CustomApiFlowState["preview"]>): string {
  if (preview.auth.kind === "none") return "None";
  if (preview.auth.kind === "oauth2")
    return `OAuth-compatible bearer token · ${preview.auth.scopes.length} declared scopes`;
  if (preview.auth.kind === "api_key")
    return `API key in ${preview.auth.carrier} “${preview.auth.name}”`;
  return `HTTP ${preview.auth.scheme}`;
}

function detectedAuthMethod(
  auth: Exclude<NonNullable<CustomApiFlowState["preview"]>["auth"], { kind: "none" }>,
): CustomApiFlowState["draft"]["authMethod"] {
  if (auth.kind === "api_key") return "api_key";
  if (auth.kind === "http" && /^basic$/i.test(auth.scheme)) return "basic";
  return "bearer";
}

function credentialValueLabel(
  auth: NonNullable<CustomApiFlowState["preview"]>["auth"] | undefined,
  method: CustomApiFlowState["draft"]["authMethod"],
): string {
  if (auth?.kind === "api_key") return `${auth.name} value`;
  if (auth?.kind === "oauth2") return "Bearer access token";
  if (auth?.kind === "http") return `${auth.scheme} credential`;
  return method === "api_key" ? "API credential value" : "Bearer token";
}

function domainFromDraft(state: CustomApiFlowState): string | null {
  const raw = state.draft.graphqlEndpoint || state.draft.openApiUrl || state.draft.url;
  if (!raw.trim()) return null;
  try {
    return new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
}
