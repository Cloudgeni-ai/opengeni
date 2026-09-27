import { BookOpenIcon, Loader2Icon } from "lucide-react";
import type { PreferenceRegistryRevisionSummary, SkillRecord, SkillScope } from "@opengeni/sdk";

import {
  CapabilityAside,
  CapabilityMark,
  CapabilityPage,
  TechnicalDetails,
} from "@/components/capabilities/capability-page";
import {
  humanizeName,
  scopeAudience,
  scopeLabel,
  skillSummary,
} from "@/components/capabilities/skill-copy";
import { RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { Textarea } from "@/components/ui/textarea";

/* ----------------------------------------------------------------------------
   A workspace skill's page: what it does, its instructions (SKILL.md and any
   supporting files, editable in place for people who can manage it), who can
   use it and which version is live. Save and Discard appear once something
   changed; reviewing an older or pending version swaps the primary action to
   Approve or Restore. IDs and hashes sit in Technical details.
   -------------------------------------------------------------------------- */

const buttonClass = "rounded-[10px] pointer-coarse:h-11";

export function skillStatus(
  record: Pick<SkillRecord, "pendingRevisionIds" | "status">,
): "Pending changes" | "Installed" | "Inactive" {
  if (record.pendingRevisionIds.length) return "Pending changes";
  return record.status === "active" ? "Installed" : "Inactive";
}

export function SkillPage({
  record,
  files,
  path,
  newPath,
  history,
  error,
  notice,
  busy,
  dirty,
  isNew,
  editable,
  canManage,
  backLabel,
  onBack,
  onPathChange,
  onNewPathChange,
  onContentChange,
  onAddFile,
  onRemoveFile,
  onSave,
  onDiscard,
  onReviewRevision,
  onChangeScope,
  onOpenRevision,
}: {
  record: SkillRecord;
  files: SkillRecord["files"];
  path: string;
  newPath: string;
  history: PreferenceRegistryRevisionSummary[];
  error: string | null;
  notice: string | null;
  busy: boolean;
  dirty: boolean;
  isNew: boolean;
  editable: boolean;
  canManage: (scope: SkillScope) => boolean;
  backLabel: string;
  onBack: () => void;
  onPathChange: (path: string) => void;
  onNewPathChange: (path: string) => void;
  onContentChange: (content: string) => void;
  onAddFile: () => void;
  onRemoveFile: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onReviewRevision: (operation: "approve" | "restore") => void;
  onChangeScope: (scope: SkillScope) => void;
  onOpenRevision: (revisionId: string) => void;
}) {
  const skillFile = files.find((file) => file.path === "SKILL.md");
  const selected = files.find((file) => file.path === path);
  const title = isNew
    ? "New skill"
    : humanizeName(record.title || record.stableKey) || "Untitled skill";
  const summary = skillSummary(skillFile?.content) ?? record.description ?? null;
  const reviewing =
    canManage(record.scope) &&
    record.revisionId !== null &&
    record.revisionId !== record.activeRevisionId;
  const pending = reviewing && record.pendingRevisionIds.includes(record.revisionId!);
  const spinner = <Loader2Icon className="animate-spin" aria-hidden="true" />;
  const canSave = Boolean(skillFile?.content.trim());

  const actions = reviewing ? (
    <Button
      type="button"
      size="sm"
      className={buttonClass}
      disabled={busy}
      onClick={() => onReviewRevision(pending ? "approve" : "restore")}
    >
      {busy ? spinner : null}
      {pending
        ? record.removalOperationId
          ? "Permanently delete Skill and all revisions (cannot be undone)"
          : "Approve this revision"
        : "Restore as a new revision"}
    </Button>
  ) : editable && (dirty || isNew) ? (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={buttonClass}
        disabled={busy}
        onClick={isNew ? onBack : onDiscard}
      >
        {isNew ? "Cancel" : "Discard changes"}
      </Button>
      <Button
        type="button"
        size="sm"
        className={buttonClass}
        disabled={busy || !canSave}
        onClick={onSave}
      >
        {busy ? spinner : null}
        Save skill
      </Button>
    </>
  ) : undefined;

  const activeVersion = history.find((revision) => revision.id === record.activeRevisionId);

  return (
    <CapabilityPage
      onBack={onBack}
      backLabel={backLabel}
      mark={<CapabilityMark name={title} icon={<BookOpenIcon />} />}
      title={title}
      status={isNew ? undefined : skillStatus(record)}
      meta={[
        scopeLabel(record.scope),
        isNew ? null : record.source ? "Installed from a source" : "Written in this workspace",
        activeVersion ? `Version ${activeVersion.revision}` : null,
      ]}
      actions={actions}
      aside={
        isNew ? undefined : (
          <CapabilityAside
            name={title}
            items={[
              { label: "Available to", value: scopeAudience(record.scope) },
              {
                label: "Source",
                value: record.source ? "Installed from a source" : "Written in this workspace",
              },
              {
                label: "Files",
                value: `${files.length} ${files.length === 1 ? "file" : "files"}`,
              },
            ]}
          />
        )
      }
    >
      {error || notice ? (
        <DetailSection>
          {error ? (
            <p role="alert" className="m-0 text-sm leading-5 text-danger">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="m-0 text-sm leading-5 text-fg">
              {notice}
            </p>
          ) : null}
        </DetailSection>
      ) : null}

      {!isNew ? (
        <DetailSection title="About">
          <p className="m-0 text-sm leading-6 text-fg">
            {summary ?? "Instructions agents load when they need them."}
          </p>
          <p className="mt-3 mb-0 text-xs leading-4.5 text-fg-muted">
            Skills add instructions only. They never get credentials or connect accounts.
          </p>
          {reviewing ? (
            <p className="mt-3 mb-0 text-xs leading-4.5 text-fg-muted">
              {pending
                ? "You are looking at a proposed version. It is not active until someone approves it."
                : "You are looking at an older version. Restoring it saves it as a new version."}
            </p>
          ) : null}
        </DetailSection>
      ) : null}

      <DetailSection
        title="Instructions"
        description={
          editable
            ? "Edit the name and description at the top of SKILL.md."
            : "Only people who can manage this skill can change it."
        }
      >
        <div className="grid min-w-0 gap-3">
          {files.length > 1 || editable ? (
            <label className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
              File
              <Select
                aria-label="File"
                value={path}
                onChange={(event) => onPathChange(event.target.value)}
                className="h-8 w-auto min-w-[180px] rounded-[10px] bg-surface font-mono text-xs"
              >
                {files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.path}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <Textarea
            aria-label={`Contents of ${path}`}
            value={selected?.content ?? ""}
            disabled={!editable || busy}
            className="min-h-72 font-mono text-xs leading-5"
            onChange={(event) => onContentChange(event.target.value)}
          />
          {editable ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                aria-label="New relative file path"
                placeholder="references/example.md"
                value={newPath}
                onChange={(event) => onNewPathChange(event.target.value)}
                disabled={busy}
                className="h-8 min-w-0 basis-full rounded-[10px] font-mono text-xs sm:max-w-xs sm:flex-1 sm:basis-auto"
              />
              <RowButton
                disabled={busy || !newPath || files.some((file) => file.path === newPath)}
                onClick={onAddFile}
              >
                Add text file
              </RowButton>
              <RowButton
                disabled={busy || path === "SKILL.md"}
                onClick={onRemoveFile}
                className="text-fg-muted hover:text-danger"
              >
                Remove selected file
              </RowButton>
            </div>
          ) : null}
        </div>
      </DetailSection>

      <DetailSection title="Settings">
        <SettingRowGroup className="-my-3">
          <SettingRow
            label="Available to"
            description="Who can use this skill in their work."
            controlWidth="auto"
            control={
              <div className="w-[200px] max-w-full">
                <Select
                  aria-label="Skill scope"
                  value={record.scope}
                  disabled={busy || !canManage(record.scope)}
                  onChange={(event) => onChangeScope(event.target.value as SkillScope)}
                  className="h-8 w-full min-w-[180px] rounded-[10px] bg-surface"
                >
                  {(["user", "workspace", "organization"] as const)
                    .filter((scope) => scope === record.scope || canManage(scope))
                    .map((scope) => (
                      <option key={scope} value={scope}>
                        {scopeLabel(scope)}
                      </option>
                    ))}
                </Select>
              </div>
            }
          />
          {history.length ? (
            <SettingRow
              label="Version"
              description="Open an earlier or proposed version to review it."
              controlWidth="auto"
              control={
                <div className="w-[200px] max-w-full">
                  <Select
                    aria-label="History"
                    value={record.revisionId ?? ""}
                    disabled={busy}
                    onChange={(event) => onOpenRevision(event.target.value)}
                    className="h-8 w-full min-w-[180px] rounded-[10px] bg-surface"
                  >
                    {history.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        Version {revision.revision}
                        {revision.id === record.activeRevisionId ? " - active" : ""}
                        {record.pendingRevisionIds.includes(revision.id) ? " - pending" : ""}
                      </option>
                    ))}
                  </Select>
                </div>
              }
            />
          ) : null}
        </SettingRowGroup>
      </DetailSection>

      {!isNew ? (
        <TechnicalDetails
          facts={[
            { label: "Skill ID", value: record.id, mono: true },
            { label: "Key", value: record.stableKey || null, mono: true },
            { label: "Viewing version", value: record.revisionId, mono: true },
            { label: "Active version", value: record.activeRevisionId, mono: true },
            { label: "Content hash", value: record.contentHash, mono: true },
          ]}
        />
      ) : null}
    </CapabilityPage>
  );
}
