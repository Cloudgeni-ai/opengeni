import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  FileCode2Icon,
  Loader2Icon,
  PackageCheckIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import { customApiConnectionLabel } from "@/components/capabilities/custom-api-flow";
import {
  pluginComponentConnections,
  sourceImportValidationError,
  type SourceImportState,
} from "@/components/capabilities/source-import-flow";
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
import type { ConnectionMetadata, PluginComponentPreview } from "@/types";

export function SourceImportDialog({
  state,
  connections,
  canManage,
  onOpenChange,
  onKindChange,
  onUrlChange,
  onPreview,
  onBindingChange,
  onInstall,
  onBack,
}: {
  state: SourceImportState;
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onKindChange: (kind: SourceImportState["kind"]) => void;
  onUrlChange: (url: string) => void;
  onPreview: () => void;
  onBindingChange: (componentKey: string, connectionId: string) => void;
  onInstall: () => void;
  onBack: () => void;
}) {
  const busy = state.phase === "previewing" || state.phase === "installing";
  const review = state.skillPreview || state.pluginPreview;
  const validationError = sourceImportValidationError(state);

  function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) onPreview();
  }

  return (
    <Dialog open={state.open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: "var(--container-2xl)" }}>
        <DialogHeader>
          <DialogTitle>
            {state.intent === "update"
              ? `Review ${state.kind === "skill" ? "Skill" : "Plugin"} update`
              : "Import Skill or Plugin"}
          </DialogTitle>
          <DialogDescription>
            OpenGeni resolves the source to an immutable commit or manifest digest, previews every
            file and component, and installs only the exact revision you approve.
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
            {state.intent === "create" ? (
              <fieldset className="grid gap-2">
                <legend className="text-xs font-medium text-fg-muted">
                  What are you importing?
                </legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <KindChoice
                    selected={state.kind === "skill"}
                    icon={<SparklesIcon className="size-4" />}
                    title="Skill folder"
                    description="GitHub folder, SKILL.md, repository, or skills.sh URL"
                    onClick={() => onKindChange("skill")}
                  />
                  <KindChoice
                    selected={state.kind === "plugin"}
                    icon={<PuzzleIcon className="size-4" />}
                    title="Plugin manifest"
                    description="A portable manifest containing Skills, Integrations, or MCP references"
                    onClick={() => onKindChange("plugin")}
                  />
                </div>
              </fieldset>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor="source-import-url">
                {state.kind === "skill" ? "GitHub or skills.sh URL" : "Plugin manifest URL"}
              </Label>
              <Input
                id="source-import-url"
                value={state.url}
                onChange={(event) => onUrlChange(event.target.value)}
                placeholder={
                  state.kind === "skill"
                    ? "https://github.com/acme/skills/tree/main/release-operator"
                    : "https://plugins.example.com/research.json"
                }
                inputMode="url"
                autoComplete="url"
                autoFocus
                disabled={state.intent === "update"}
                aria-describedby="source-import-help"
              />
              <p id="source-import-help" className="text-2xs leading-4 text-fg-subtle">
                Preview is read-only. Symlinks, submodules, unsafe paths, oversized content, source
                drift, and unsupported Plugin components fail before workspace mutation.
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canManage || busy || !state.url.trim()}>
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

        {review && state.skillPreview ? (
          <SkillReview
            state={state}
            canManage={canManage}
            busy={busy}
            validationError={validationError}
            onInstall={onInstall}
            onBack={onBack}
          />
        ) : null}

        {review && state.pluginPreview ? (
          <PluginReview
            state={state}
            connections={connections}
            canManage={canManage}
            busy={busy}
            validationError={validationError}
            onBindingChange={onBindingChange}
            onPreview={onPreview}
            onInstall={onInstall}
            onBack={onBack}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SkillReview({
  state,
  canManage,
  busy,
  validationError,
  onInstall,
  onBack,
}: {
  state: SourceImportState;
  canManage: boolean;
  busy: boolean;
  validationError: string | null;
  onInstall: () => void;
  onBack: () => void;
}) {
  const preview = state.skillPreview!;
  return (
    <div className="grid gap-5">
      <PreviewReady title="Immutable Skill preview ready" />

      <div className="grid gap-4 rounded-xl border border-border bg-bg/50 p-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <SparklesIcon className="size-4 text-brand" />
            <h3 className="text-sm font-semibold text-fg">{preview.name}</h3>
            <Badge variant="outline" className="text-2xs uppercase text-fg-subtle">
              {preview.source === "skills_sh" ? "skills.sh" : "GitHub"}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">{preview.description}</p>
        </div>
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <ReviewFact label="Repository" value={`${preview.owner}/${preview.repository}`} />
          <ReviewFact label="Folder" value={preview.sourcePath} mono />
          <ReviewFact label="Pinned commit" value={preview.sourceCommit} mono />
          <ReviewFact label="Content digest" value={preview.contentSha256} mono />
          <ReviewFact label="Files" value={String(preview.files.length)} />
          <ReviewFact label="Total size" value={formatBytes(preview.totalBytes)} />
        </dl>
      </div>

      {preview.warnings.length > 0 ? <Warnings warnings={preview.warnings} /> : null}

      <details className="group rounded-xl border border-border p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-semibold text-fg">
          <FileCode2Icon className="size-4 text-fg-subtle" />
          Review {preview.files.length} immutable files
        </summary>
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
          {preview.files.map((file) => (
            <div key={file.path} className="rounded-lg border border-border/80 bg-bg/50 p-3">
              <p className="break-all font-mono text-2xs text-fg-muted">{file.path}</p>
              <p className="mt-1 font-mono text-2xs text-fg-subtle">
                {formatBytes(file.byteSize)} · {file.contentSha256.slice(0, 16)}…
              </p>
            </div>
          ))}
        </div>
      </details>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon />
          Back
        </Button>
        <Button
          type="button"
          onClick={onInstall}
          disabled={!canManage || busy || !!validationError}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
          {preview.installed ? "Update this Skill" : "Install this Skill"}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function PluginReview({
  state,
  connections,
  canManage,
  busy,
  validationError,
  onBindingChange,
  onPreview,
  onInstall,
  onBack,
}: {
  state: SourceImportState;
  connections: ConnectionMetadata[] | null;
  canManage: boolean;
  busy: boolean;
  validationError: string | null;
  onBindingChange: (componentKey: string, connectionId: string) => void;
  onPreview: () => void;
  onInstall: () => void;
  onBack: () => void;
}) {
  const preview = state.pluginPreview!;
  const update = preview.installed;
  return (
    <div className="grid gap-5">
      <PreviewReady title="Immutable Plugin bill of materials ready" />

      <div className="grid gap-4 rounded-xl border border-border bg-bg/50 p-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <PuzzleIcon className="size-4 text-brand" />
            <h3 className="text-sm font-semibold text-fg">{preview.manifest.name}</h3>
            <Badge variant="outline" className="text-2xs text-fg-subtle">
              v{preview.manifest.version}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            {preview.manifest.description || "No Plugin description provided."}
          </p>
        </div>
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <ReviewFact label="Plugin identity" value={preview.manifest.pluginKey} mono />
          <ReviewFact label="Manifest digest" value={preview.manifestDigest} mono />
          <ReviewFact label="Components" value={String(preview.components.length)} />
          <ReviewFact
            label="Lifecycle"
            value={update ? `Update from ${preview.diff.fromVersion}` : "New installation"}
          />
        </dl>
      </div>

      {update ? <PluginDiff preview={preview} /> : null}

      <div className="grid gap-2">
        <h3 className="text-xs font-semibold text-fg">Component bill of materials</h3>
        {preview.components.map((component) => (
          <PluginComponentCard
            key={component.key}
            component={component}
            connections={connections}
            selectedConnectionId={state.pluginBindings[component.key] ?? ""}
            onBindingChange={(connectionId) => onBindingChange(component.key, connectionId)}
          />
        ))}
      </div>

      {validationError ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-fg-muted">
          {validationError}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon />
          Back
        </Button>
        {state.bindingsDirty ? (
          <Button type="button" onClick={onPreview} disabled={!canManage || busy}>
            {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
            Recheck selected accounts
          </Button>
        ) : (
          <Button
            type="button"
            onClick={onInstall}
            disabled={!canManage || busy || !!validationError}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <PackageCheckIcon />}
            {update ? "Update this Plugin" : "Install this Plugin"}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

function PluginComponentCard({
  component,
  connections,
  selectedConnectionId,
  onBindingChange,
}: {
  component: PluginComponentPreview;
  connections: ConnectionMetadata[] | null;
  selectedConnectionId: string;
  onBindingChange: (connectionId: string) => void;
}) {
  const compatible = pluginComponentConnections(connections, component);
  return (
    <article className="rounded-xl border border-border bg-bg/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-2xs uppercase text-fg-subtle">
              {component.kind}
            </Badge>
            <h4 className="text-xs font-semibold text-fg">{component.name}</h4>
          </div>
          <p className="mt-1 font-mono text-2xs text-fg-subtle">{component.key}</p>
        </div>
        <span className="font-mono text-2xs text-fg-subtle">{component.digest.slice(0, 12)}…</span>
      </div>
      <dl className="mt-3 grid gap-2 text-2xs sm:grid-cols-2">
        {Object.entries(component.facts).map(([label, value]) => (
          <ReviewFact key={label} label={humanize(label)} value={factValue(value)} />
        ))}
      </dl>
      {component.connectionRequired ? (
        <div className="mt-3 grid gap-1.5 border-t border-border/80 pt-3">
          <Label htmlFor={`plugin-connection-${component.key}`} className="text-xs">
            Exact Connection
          </Label>
          {connections === null ? (
            <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-2xs leading-4 text-fg-muted">
              Connection data is unavailable. Refresh Capabilities before choosing the exact account
              for this component.
            </p>
          ) : compatible.length > 0 ? (
            <select
              id={`plugin-connection-${component.key}`}
              value={selectedConnectionId}
              onChange={(event) => onBindingChange(event.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30"
            >
              <option value="">Choose an account…</option>
              {compatible.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {customApiConnectionLabel(connection)} ·{" "}
                  {connection.subjectId ? "Personal" : "Workspace"}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-2xs leading-4 text-fg-muted">
              No active exact-domain Connection exists. Connect that account in Connected services
              first, then retry this preview.
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}

function PluginDiff({ preview }: { preview: NonNullable<SourceImportState["pluginPreview"]> }) {
  return (
    <div className="rounded-xl border border-brand/30 bg-brand/5 p-4 text-xs">
      <h3 className="font-semibold text-fg">Update impact</h3>
      <p className="mt-1 leading-5 text-fg-muted">
        {preview.diff.added.length} added, {preview.diff.changed.length} changed,{" "}
        {preview.diff.removed.length} removed, and {preview.diff.unchanged.length} unchanged
        components.
      </p>
      {preview.diff.added.length > 0 ? (
        <p className="mt-2 break-words text-success">Added: {preview.diff.added.join(", ")}</p>
      ) : null}
      {preview.diff.changed.length > 0 ? (
        <p className="mt-1 break-words text-warning">Changed: {preview.diff.changed.join(", ")}</p>
      ) : null}
      {preview.diff.removed.length > 0 ? (
        <p className="mt-1 break-words text-destructive">
          Removed: {preview.diff.removed.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function PreviewReady({ title }: { title: string }) {
  return (
    <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
      <div className="flex items-start gap-3">
        <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-success" />
        <div>
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Review the exact provenance and contents below. Nothing is installed until the final
            action.
          </p>
        </div>
      </div>
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
      <h3 className="text-xs font-semibold text-fg">Review warnings</h3>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-fg-muted">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function KindChoice({
  selected,
  icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  icon: ReactNode;
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
      <span className="flex items-center gap-2 text-xs font-semibold text-fg">
        {icon}
        {title}
      </span>
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

function factValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  return "Available in immutable manifest";
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
